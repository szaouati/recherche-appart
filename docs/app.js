import { CRITERES, mergeCriteria, rankListings, verdictScore, estVisible } from './score.mjs';
import { STATUTS_LIBELLES, MARQUEURS, remplirMarqueurs, construireIcs, relanceDue, libelleRelance, formaterReponse, IDEES_QUESTIONS } from './agent-ui.mjs';

const $ = (s, r = document) => r.querySelector(s);
const store = {
  get(k, d) {
    try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* navigation privée : on continue sans mémoire */ }
  },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : '#');
const eur = (n) => `${Math.round(Number(n)).toLocaleString('fr-FR')} €`;
const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
function depuis(iso) {
  const min = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (Math.abs(min) < 60) return rtf.format(min, 'minute');
  if (Math.abs(min) < 60 * 36) return rtf.format(Math.round(min / 60), 'hour');
  return rtf.format(Math.round(min / 1440), 'day');
}

// --- État partagé ------------------------------------------------------------------
// Un seul « compte » pour tous les appareils : critères, favoris/écartés, notes et annonces
// ajoutées à la main vivent sur le Worker (qui les écrit dans le dépôt), pas dans le localStorage
// de CET appareil. Les clés *Cache ci-dessous ne sont qu'un cache de secours (affichage instantané
// au chargement, et repli si le Worker est injoignable) — la vérité vient toujours de GET /etat.
// D'anciennes clés (avant le 23/09/2026 : criteria/manuel/statut/vuJusqua/notes) servaient de seul
// stockage par appareil ; on les reprend une fois comme point de départ si ce cache-ci est vide,
// pour ne rien perdre de ce qu'un appareil avait déjà, puis on les laisse orphelines.
let criteria = mergeCriteria(store.get('criteriaCache', store.get('criteria', {})));
let base = []; // annonces du bot
let meta = {};
let manuel = store.get('manuelCache', store.get('manuel', []));
let statut = store.get('statutCache', store.get('statut', {})); // id -> 'fav' | 'ecarte'
let vuJusqua = store.get('vuJusquaCache', store.get('vuJusqua', new Date(Date.now() - 864e5).toISOString()));
let onglet = 'nouveautes';
let limite = 30;
let ranked = [];
let notes = store.get('notesCache', store.get('notes', {})); // id -> texte libre (son carnet, partagé avec Sacha via le journal)
let config = {}; // docs/config.json : { botUrl, botToken }
let etatSnapshot = null; // dernier état partagé connu (comparaison pour éviter un rendu inutile)
let contacts = store.get('contactsCache', {}); // id -> { statut, maj, relance, visite, note, canal } (suivi partagé)
// « Mon dossier » (prénom, situation, téléphone, disponibilités) : UNIQUEMENT sur cet appareil, jamais envoyé
// au Worker ni au journal public — le bot n'écrit que des marqueurs {{prenom}}… que l'on remplit ici.
const dossier = () => store.get('dossier', {});

function sauverCacheLocal() {
  store.set('criteriaCache', criteria);
  store.set('manuelCache', manuel);
  store.set('statutCache', statut);
  store.set('vuJusquaCache', vuJusqua);
  store.set('notesCache', notes);
  store.set('contactsCache', contacts);
}
function chaineEtat(etat) { return JSON.stringify([etat.criteria, etat.statut, etat.notes, etat.manuel, etat.vuJusqua, etat.contacts]); }
function adopterEtat(etat) {
  criteria = mergeCriteria(etat.criteria || {});
  statut = etat.statut && typeof etat.statut === 'object' ? etat.statut : {};
  notes = etat.notes && typeof etat.notes === 'object' ? etat.notes : {};
  manuel = Array.isArray(etat.manuel) ? etat.manuel : [];
  vuJusqua = etat.vuJusqua || vuJusqua;
  contacts = etat.contacts && typeof etat.contacts === 'object' ? etat.contacts : {};
  sauverCacheLocal();
}

async function chargerEtatPartage() {
  if (!config.botUrl || !config.botToken) return null;
  const r = await fetch(`${config.botUrl}/etat`, { headers: { 'X-App-Token': config.botToken } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Envoie un changement (fav/écarte, note, critères, ajout manuel, vu) : appliqué tout de suite en
// local pour rester réactif, puis au Worker qui fait foi — sa réponse remplace l'état local, ce qui
// règle de lui-même le cas de deux appareils modifiant la même chose presque en même temps.
async function appliquerEtat(action, params = {}) {
  if (action === 'set_statut') { if (params.valeur) statut[params.id] = params.valeur; else delete statut[params.id]; }
  else if (action === 'set_note') { if (params.texte) notes[params.id] = params.texte; else delete notes[params.id]; }
  else if (action === 'set_vu') { if (!vuJusqua || params.ts > vuJusqua) vuJusqua = params.ts; }
  else if (action === 'ajouter_manuel') { manuel.unshift(params.listing); }
  else if (action === 'set_criteria') { criteria = mergeCriteria(params.criteria); }
  else if (action === 'set_contact') {
    if (!params.statut) delete contacts[params.id];
    else contacts[params.id] = { ...(contacts[params.id] || {}), statut: params.statut, maj: new Date().toISOString(), relance: params.relance_jours ? new Date(Date.now() + params.relance_jours * 864e5).toISOString() : (['reponse', 'refuse', 'sans_suite', 'visite'].includes(params.statut) ? null : contacts[params.id]?.relance ?? null) };
  }
  sauverCacheLocal();
  if (!config.botUrl || !config.botToken) return;
  try {
    const r = await fetch(`${config.botUrl}/etat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Token': config.botToken },
      body: JSON.stringify({ kind: 'etat', action, ...params, criteria }),
    });
    const etat = await r.json().catch(() => null);
    if (r.ok && etat && !etat.error) {
      adopterEtat(etat);
      etatSnapshot = chaineEtat(etat);
      remplirFormulaire();
      render();
    }
  } catch {
    // best-effort : le changement reste appliqué en local, la prochaine synchro le réconciliera
  }
}

// Migration ponctuelle : si CET appareil avait déjà des favoris/notes/annonces manuelles (ancien
// stockage 100% local) et que l'état partagé est encore vierge (personne n'a encore rien envoyé),
// on les pousse une fois vers le Worker plutôt que de les laisser disparaître silencieusement.
// Si l'état partagé a déjà du contenu, c'est lui qui fait foi : on ne réimpose pas un vieux local.
async function migrerVersEtatPartage(etatServeur) {
  const localVide = !Object.keys(statut).length && !Object.keys(notes).length && !manuel.length;
  const serveurVide = !Object.keys(etatServeur.statut || {}).length && !Object.keys(etatServeur.notes || {}).length && !(etatServeur.manuel || []).length;
  if (localVide || !serveurVide) return false;
  // Chaque appliquerEtat() adopte la réponse du serveur (encore partielle en pleine migration) et
  // remplace donc statut/notes/manuel en direct : on fige d'abord une copie de ce qu'il faut migrer,
  // pour ne pas boucler sur des données déjà écrasées par l'étape précédente.
  const statutInitial = { ...statut };
  const notesInitiales = { ...notes };
  const manuelInitial = [...manuel];
  for (const [id, valeur] of Object.entries(statutInitial)) await appliquerEtat('set_statut', { id, valeur });
  for (const [id, texte] of Object.entries(notesInitiales)) await appliquerEtat('set_note', { id, texte });
  for (const listing of manuelInitial.reverse()) await appliquerEtat('ajouter_manuel', { listing }); // reverse : unshift restaure l'ordre
  return true;
}

async function synchroniserEtat({ silencieux = false } = {}) {
  try {
    const etat = await chargerEtatPartage();
    if (!etat) return;
    const nouveau = chaineEtat(etat);
    if (nouveau === etatSnapshot) return; // rien de changé ailleurs depuis la dernière fois
    adopterEtat(etat);
    etatSnapshot = nouveau;
    remplirFormulaire();
    limite = 30;
    entete();
    render();
  } catch (e) {
    if (!silencieux) console.error('Synchronisation impossible', e);
  }
}

// --- Critères : formulaire <-> objet --------------------------------------
const ETATS = ['neutre', 'pref', 'exclu'];
let etatsArr = {};

function arrDepuisCriteres() {
  etatsArr = {};
  for (let i = 1; i <= 20; i++) {
    etatsArr[i] = criteria.arrondissementsPref.includes(i) ? 'pref' : criteria.arrondissements.length && !criteria.arrondissements.includes(i) ? 'exclu' : 'neutre';
  }
}
function criteresDepuisArr() {
  const exclus = Object.keys(etatsArr).filter((i) => etatsArr[i] === 'exclu').map(Number);
  criteria.arrondissementsPref = Object.keys(etatsArr).filter((i) => etatsArr[i] === 'pref').map(Number);
  criteria.arrondissements = exclus.length ? Array.from({ length: 20 }, (_, i) => i + 1).filter((i) => !exclus.includes(i)) : [];
}

function remplirFormulaire() {
  $('#budgetMax').value = criteria.budgetMax;
  $('#surfaceMin').value = criteria.surfaceMin;
  $('#piecesMin').value = criteria.piecesMin;
  $(`input[name=meuble][value=${criteria.meuble}]`).checked = true;
  for (const k of ['rdc', 'dpeFG', 'coloc']) $(`#ex-${k}`).checked = criteria.exclure[k];
  $('#alerteActive').checked = criteria.alerteActive;
  $('#alerteScoreMin').value = criteria.alerteScoreMin;
  arrDepuisCriteres();
  dessinerArr();
  $('#poids-list').innerHTML = CRITERES.map(
    ([k, label]) => `<div class="poids-row"><label for="w-${k}">${esc(label)}</label><output id="ow-${k}">${criteria.poids[k]}</output>
      <input type="range" id="w-${k}" data-poids="${k}" min="0" max="5" step="1" value="${criteria.poids[k]}"></div>`,
  ).join('');
  sorties();
}

function sorties() {
  $('#o-budget').textContent = eur(criteria.budgetMax);
  $('#o-surface').textContent = `${criteria.surfaceMin} m²`;
  $('#o-alerte').textContent = `${criteria.alerteScoreMin}/100`;
  $('#resume-criteres').textContent = `· ${eur(criteria.budgetMax)} · ${criteria.surfaceMin} m²+`;
}

function dessinerArr() {
  $('#arr-grid').innerHTML = Object.entries(etatsArr)
    .map(([i, e]) => `<button type="button" class="arr" data-arr="${i}" data-etat="${e}" aria-label="${i}e arrondissement : ${e}">${e === 'pref' ? '★' : e === 'exclu' ? '✕' : ''}${i}</button>`)
    .join('');
}

let debounceCritere = null;
function lireFormulaire() {
  criteria.budgetMax = Number($('#budgetMax').value);
  criteria.surfaceMin = Number($('#surfaceMin').value);
  criteria.piecesMin = Number($('#piecesMin').value);
  criteria.meuble = $('input[name=meuble]:checked').value;
  for (const k of ['rdc', 'dpeFG', 'coloc']) criteria.exclure[k] = $(`#ex-${k}`).checked;
  criteria.alerteActive = $('#alerteActive').checked;
  criteria.alerteScoreMin = Number($('#alerteScoreMin').value);
  for (const el of document.querySelectorAll('[data-poids]')) {
    criteria.poids[el.dataset.poids] = Number(el.value);
    $(`#ow-${el.dataset.poids}`).textContent = el.value;
  }
  criteresDepuisArr();
  store.set('criteriaCache', criteria);
  sorties();
  limite = 30;
  render();
  // On attend qu'elle arrête de bouger les curseurs avant d'envoyer au Worker et de proposer un
  // avis : sinon un simple glissement de slider enverrait des dizaines d'écritures et de bulles.
  clearTimeout(debounceCritere);
  debounceCritere = setTimeout(() => {
    appliquerEtat('set_criteria', { criteria, source: 'panel' });
    proposerBulleCriteres();
  }, 4000);
}

// --- Données ---------------------------------------------------------------
function toutes() {
  return [...manuel, ...base];
}

function calculer() {
  ranked = rankListings(toutes(), criteria).listings;
}

const actives = (l) => estVisible(l, meta);

function filtrer() {
  const ok = ranked.filter((l) => l.ok && actives(l));
  switch (onglet) {
    case 'nouveautes': return ok.filter((l) => statut[l.id] !== 'ecarte' && l.first_seen > vuJusqua);
    case 'meilleures': return ok.filter((l) => statut[l.id] !== 'ecarte');
    case 'favoris': return ranked.filter((l) => statut[l.id] === 'fav');
    case 'ecartees': return ranked.filter((l) => statut[l.id] === 'ecarte');
    default: return [];
  }
}

// --- Rendu -----------------------------------------------------------------
function compteurs() {
  const ok = ranked.filter((l) => l.ok && actives(l) && statut[l.id] !== 'ecarte');
  return {
    nouveautes: ok.filter((l) => l.first_seen > vuJusqua).length,
    meilleures: ok.length,
    favoris: ranked.filter((l) => statut[l.id] === 'fav').length,
    ecartees: ranked.filter((l) => statut[l.id] === 'ecarte').length,
  };
}

function dessinerOnglets() {
  const n = compteurs();
  const defs = [['nouveautes', 'Nouveautés'], ['meilleures', 'Meilleures'], ['favoris', 'Favoris'], ['ecartees', 'Écartées']];
  $('#tabs').innerHTML = defs
    .map(([k, label]) => `<button class="tab" role="tab" data-tab="${k}" aria-selected="${k === onglet}">${label}<span class="n">${n[k]}</span></button>`)
    .join('');
}

function chips(l) {
  const c = [];
  const ct = contacts[l.id];
  if (ct) c.push(`<span class="chip contact${relanceDue(ct) ? ' due' : ''}">✉️ ${esc(STATUTS_LIBELLES[ct.statut] ?? ct.statut)}${libelleRelance(ct) ? ' · ' + esc(libelleRelance(ct)) : ''}${ct.visite ? ' · ' + esc(new Date(ct.visite).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) : ''}</span>`);
  if (l.first_seen > vuJusqua && l.source !== 'Manuel') c.push('<span class="chip flag">Nouveau</span>');
  const h = l.price_history;
  if (h && h.length > 1 && h.at(-1)[1] < h.at(-2)[1]) c.push(`<span class="chip drop">↓ ${eur(h.at(-2)[1] - h.at(-1)[1])}</span>`);
  if (l.features?.balcon) c.push('<span class="chip">Balcon</span>');
  if (l.features?.terrasse) c.push('<span class="chip">Terrasse</span>');
  if (l.elevator) c.push('<span class="chip">Ascenseur</span>');
  if (l.dpe) c.push(`<span class="chip">DPE ${esc(l.dpe)}</span>`);
  for (const [k, t] of [['lumineux', 'Lumineux'], ['calme', 'Calme'], ['traversant', 'Traversant'], ['cave', 'Cave'], ['parking', 'Parking'], ['parquet', 'Parquet']]) if (l.features?.[k]) c.push(`<span class="chip">${t}</span>`);
  if (l.furnished === true) c.push('<span class="chip">Meublé</span>');
  if (l.agencyFee) c.push(`<span class="chip">Frais d'agence ${eur(Math.round(l.agencyFee))}</span>`);
  if (l.aVerifier?.length) c.push(`<span class="chip warn">À vérifier : ${esc(l.aVerifier.join(', '))}</span>`);
  return c.join('');
}

function carte(l) {
  const verdict = l.ok ? verdictScore(l.rangOk, l.totalOk) : null;
  const ppm = l.price != null && l.surface ? Math.round(l.price / l.surface) : null;
  const infos = [l.surface ? `${l.surface} m²` : null, l.rooms ? `${l.rooms} p.` : null, l.arrondissement ? `Paris ${l.arrondissement}e` : null, l.floor != null ? (l.floor === 0 ? 'RDC' : `${l.floor}e ét.`) : null, ppm ? `${ppm} €/m²` : null]
    .filter(Boolean).join(' · ');
  const detail = l.ok
    ? `<ul>${l.detail.filter((d) => d.poids).map((d) => `<li><span>${esc(d.label)}</span><span>${d.points}</span><div class="bar"><i style="width:${Math.round((d.valeur ?? 0) * 100)}%"></i></div></li>`).join('')}</ul>`
    : `<ul class="rejet">${l.rejets.map((r) => `<li><span>${esc(r)}</span><span></span></li>`).join('')}</ul>`;
  const pepite = l.ok && l.rangOk === 0 && l.totalOk > 1;
  const badge = verdict
    ? `<div class="score ${verdict.tier}" style="--s:${l.score}" title="${esc(verdict.label)} (détail : ${l.score}/100)"><span class="score-icone" aria-hidden="true">${verdict.icone}</span></div>`
    : '';
  const note = notes[l.id] || '';
  return `<li class="card ${l.first_seen > vuJusqua && l.source !== 'Manuel' ? 'nouveau' : ''} ${pepite ? 'pepite' : ''}" data-id="${esc(l.id)}">
    <div class="photo">${l.photo ? `<img src="${esc(safeUrl(l.photo))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}</div>
    <div class="body">
      <div class="prix">${l.price != null ? eur(l.price) : '—'}<small>CC</small></div>
      ${verdict ? `<div class="verdict verdict-${verdict.tier}">${esc(verdict.icone)} ${esc(verdict.label)}</div>` : ''}
      <div class="meta">${esc(infos)}</div>
      <div class="titre">${esc(l.title ?? l.district ?? '')}</div>
      <div class="chips">${chips(l)}</div>
      <details class="why"><summary>${l.ok ? 'Pourquoi cet avis ?' : 'Pourquoi écartée ?'}</summary>${detail}</details>
      <details class="note-bloc"${note ? ' open' : ''}><summary>${note ? '🖊 Ma note' : '🖊 Ajouter une note'}</summary>
        <textarea class="note-txt" data-id="${esc(l.id)}" placeholder="Ce que j'en pense, une question, un doute… (Sacha la voit aussi)">${esc(note)}</textarea>
      </details>
      <div class="card-actions">
        <a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer">Voir l'annonce ↗</a>
        <button class="mini" data-act="fav" aria-pressed="${statut[l.id] === 'fav'}">♥ Garder</button>
        <button class="mini" data-act="ecarte" aria-pressed="${statut[l.id] === 'ecarte'}">✕ Écarter</button>
        <button class="mini mascotte-mini" data-mascotte-annonce="${esc(l.id)}" type="button" title="En discuter avec le bot">
          <img src="mascotte.webp" width="18" height="18" alt=""></button>
        <button class="mini" data-contact-annonce="${esc(l.id)}" type="button" title="Faire rédiger un message de contact par le bot">✉️ Contacter</button>
        <select class="suivi" data-id="${esc(l.id)}" aria-label="Suivi de contact">
          <option value="">Suivi…</option>${Object.entries(STATUTS_LIBELLES).map(([k, v]) => `<option value="${k}"${contacts[l.id]?.statut === k ? ' selected' : ''}>${esc(v)}</option>`).join('')}<option value="__aucun">— Retirer le suivi</option>
        </select>
        <span class="hint">${esc(l.source)} · ${l.publishedAt ? 'publiée ' + depuis(l.publishedAt) : 'vue ' + depuis(l.first_seen)}</span>
      </div>
    </div>
    ${badge}
  </li>`;
}

function render() {
  calculer();
  $('#statut-recherche').textContent = statutRecherche();
  dessinerOnglets();
  const dues = Object.values(contacts).filter((c) => relanceDue(c)).length;
  $('#relances').hidden = !dues;
  $('#relances').textContent = `⏰ ${dues} relance${dues > 1 ? 's' : ''} à faire`;
  const liste = filtrer();
  $('#compte').textContent = `${liste.length} annonce${liste.length > 1 ? 's' : ''}`;
  $('#btn-vu').hidden = onglet !== 'nouveautes' || !liste.length;
  const vide = { nouveautes: 'Rien de nouveau depuis ta dernière visite. Regarde les « Meilleures » en attendant.', meilleures: 'Aucune annonce ne passe tes critères. Essaie d\'élargir le budget ou les arrondissements.', favoris: 'Aucun favori pour l\'instant.', ecartees: 'Rien d\'écarté.' }[onglet];
  $('#liste').innerHTML = liste.length ? liste.slice(0, limite).map(carte).join('') : `<li class="vide">${vide}</li>`;
  $('#btn-more').hidden = liste.length <= limite;
}

function dessinerSources() {
  const pills = (meta.sources || []).map((s) => `<span class="pill ${esc(s.status)}" title="${esc(s.error ?? '')}">${esc(s.name)} · ${s.status === 'erreur' ? 'en panne' : `${s.count} annonces`}</span>`);
  pills.push('<span class="pill todo" title="Les alertes e-mail PAP / SeLoger arrivent déjà dans sa boîte dédiée ; leur lecture automatique par le bot reste à brancher">PAP, SeLoger, Leboncoin · alertes reçues, pas encore lues par le bot</span>');
  $('#sources').innerHTML = pills.join('');
}

function statutRecherche() {
  const c = criteria;
  const ok = ranked.filter((l) => l.ok && actives(l));
  const nouvelles = ok.filter((l) => l.first_seen > vuJusqua && statut[l.id] !== 'ecarte').length;
  const zone = c.arrondissements.length === 1 ? `le ${c.arrondissements[0]}e` : c.arrondissements.length ? `${c.arrondissements.length} arrondissements` : 'tout Paris';
  const meilleure = ok.find((l) => statut[l.id] !== 'ecarte');
  const bits = [
    `Recherche : ${zone} · ≤ ${eur(c.budgetMax)} · ${c.surfaceMin} m²+`,
    `${ok.length} annonce${ok.length > 1 ? 's' : ''} correspond${ok.length > 1 ? 'ent' : ''} en ce moment`,
    nouvelles ? `${nouvelles} nouvelle${nouvelles > 1 ? 's' : ''} depuis ta dernière visite` : 'rien de nouveau depuis ta dernière visite',
    meilleure ? `${verdictScore(meilleure.rangOk, meilleure.totalOk).label} à ${eur(meilleure.price)}` : null,
  ].filter(Boolean);
  return bits.join(' · ');
}

function entete() {
  if (!meta.generatedAt) return;
  $('#maj').textContent = `${meta.count?.toLocaleString('fr-FR')} annonces suivies · mise à jour ${depuis(meta.generatedAt)}`;
  const ageH = (Date.now() - new Date(meta.generatedAt).getTime()) / 36e5;
  const ban = $('#banniere');
  const panne = (meta.sources || []).filter((s) => s.status === 'erreur');
  if (ageH > 6) { ban.textContent = `Les données ont ${Math.round(ageH)} h : le bot semble à l'arrêt. Préviens Sacha.`; ban.hidden = false; }
  else if (panne.length) { ban.textContent = `Source en panne : ${panne.map((s) => s.name).join(', ')}. Les annonces affichées peuvent ne pas être à jour.`; ban.hidden = false; }
  else ban.hidden = true;
}

// --- Événements ------------------------------------------------------------
function brancher() {
  $('#criteres').addEventListener('input', lireFormulaire);
  $('#arr-grid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-arr]');
    if (!b) return;
    const i = b.dataset.arr;
    etatsArr[i] = ETATS[(ETATS.indexOf(etatsArr[i]) + 1) % 3];
    dessinerArr();
    lireFormulaire();
  });
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) { onglet = b.dataset.tab; limite = 30; render(); }
  });
  $('#liste').addEventListener('click', (e) => {
    const bc = e.target.closest('[data-contact-annonce]');
    if (bc) {
      const l = ranked.find((x) => x.id === bc.dataset.contactAnnonce) || manuel.find((x) => x.id === bc.dataset.contactAnnonce);
      if (l) { ouvrirBot(); envoyerBot(`Rédige-moi un message de contact pour cette annonce : ${eur(l.price)}${l.surface ? ` · ${l.surface} m²` : ''} · ${l.title ?? ''} (réf ${l.id}).`); }
      return;
    }
    const badge = e.target.closest('[data-mascotte-annonce]');
    if (badge) {
      const l = ranked.find((x) => x.id === badge.dataset.mascotteAnnonce);
      if (l) ouvrirBot(`À propos de cette annonce (${l.title ?? ''} · ${l.price != null ? eur(l.price) : '?'} · réf ${l.id}) : `);
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.closest('.card').dataset.id;
    const actif = statut[id] !== b.dataset.act;
    const l = ranked.find((x) => x.id === id) || manuel.find((x) => x.id === id);
    appliquerEtat('set_statut', { id, valeur: actif ? b.dataset.act : null, url: l?.url, title: l?.title, price: l?.price });
    render();
  });
  $('#liste').addEventListener('change', (e) => {
    const sel = e.target.closest('select.suivi');
    if (!sel) return;
    const id = sel.dataset.id;
    const l = ranked.find((x) => x.id === id) || manuel.find((x) => x.id === id);
    const v = sel.value;
    if (!v) return;
    const statutContact = v === '__aucun' ? null : v;
    appliquerEtat('set_contact', { id, statut: statutContact, relance_jours: statutContact === 'contacte' ? 3 : null, url: l?.url, title: l?.title });
    render();
  });
  $('#liste').addEventListener('focusout', (e) => {
    const ta = e.target.closest('.note-txt');
    if (!ta) return;
    const id = ta.dataset.id;
    const val = ta.value.trim();
    const l = ranked.find((x) => x.id === id) || manuel.find((x) => x.id === id);
    appliquerEtat('set_note', { id, texte: val, url: l?.url, title: l?.title });
  });
  $('#btn-more').addEventListener('click', () => { limite += 30; render(); });
  $('#btn-vu').addEventListener('click', () => { const ts = new Date().toISOString(); appliquerEtat('set_vu', { ts }); render(); });

  $('#btn-add').addEventListener('click', () => $('#dlg-add').showModal());
  $('#form-add').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'ok') return;
    const f = new FormData(e.target);
    const num = (k) => (f.get(k) === '' || f.get(k) == null ? null : Number(f.get(k)));
    const now = new Date().toISOString();
    const listing = {
      id: `manuel:${Date.now()}`, source: 'Manuel', url: f.get('url'), title: f.get('title') || null,
      price: num('price'), surface: num('surface'), rooms: num('rooms'), arrondissement: num('arrondissement'), floor: num('floor'),
      elevator: f.get('elevator') ? true : null, dpe: f.get('dpe') || null, furnished: null,
      features: f.get('balcon') ? { balcon: true } : {}, first_seen: now, last_seen: now, publishedAt: now, photo: null,
    };
    appliquerEtat('ajouter_manuel', { listing });
    e.target.reset();
    render();
  });

  // Simple recharge de la page : utile quand l'onglet reste ouvert longtemps et qu'on veut être
  // sûr de voir tout de suite les derniers changements (annonces, critères, favoris d'un autre appareil).
  $('#btn-recharger-page').addEventListener('click', () => location.reload());

  $('#relances').addEventListener('click', () => { ouvrirBot(); envoyerBot('Qui dois-je relancer, et avec quel message ?'); });

  $('#btn-dossier').addEventListener('click', () => {
    const d = dossier();
    const f = $('#form-dossier');
    for (const k of Object.keys(MARQUEURS)) f.elements[k].value = d[k] || '';
    $('#dlg-dossier').showModal();
  });
  $('#form-dossier').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'ok') return;
    const f = e.target;
    store.set('dossier', Object.fromEntries(Object.keys(MARQUEURS).map((k) => [k, f.elements[k].value.trim()])));
  });
}


// --- Journal partagé : tout ce qu'elle fait d'important part vers Sacha, en silence -----------
// Remplace l'ancien « Ma recherche en détail » (formulaire + envoi manuel) : elle ne parle plus
// qu'au bot, et chaque signal utile (favori, écarté, note, changement de critères) est journalisé
// côté serveur pour que Sacha puisse suivre où elle en est sans qu'elle ait à lui envoyer quoi que ce soit.
async function envoyerEvenement(type, payload) {
  if (!config.botUrl || !config.botToken) return;
  try {
    await fetch(config.botUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Token': config.botToken },
      body: JSON.stringify({ kind: 'event', type, payload, criteria }),
    });
  } catch {
    // best-effort : un journal qui rate une fois ne doit jamais gêner son usage du site
  }
}

// --- Bot Claude : ajuster les critères en discutant --------------------------
let botChat = store.get('botChat', []); // [{role:'user'|'assistant', content}]
let botEnvoi = false;
let derniereProposition = null;

function dessinerBotLog() {
  const log = $('#bot-log');
  log.innerHTML = botChat.length
    ? botChat.map((m) => `<div class="bot-msg ${m.role === 'user' ? 'user' : 'bot'}">${m.role === 'user' ? esc(m.content) : formaterReponse(m.content)}</div>`).join('')
    : '<p class="hint">Dis-moi ce que tu veux changer : « baisse le budget à 850 », « ajoute le 19e en préféré », « le parquet ne compte plus »…</p>';
  log.scrollTop = log.scrollHeight;
}

function diffCriteria(actuel, propose) {
  const nom = Object.fromEntries(CRITERES);
  const lignes = [];
  const cmp = (label, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) lignes.push(`${label} : ${a} → ${b}`); };
  cmp('Budget max', eur(actuel.budgetMax), eur(propose.budgetMax));
  cmp('Surface min', `${actuel.surfaceMin} m²`, `${propose.surfaceMin} m²`);
  cmp('Pièces min', actuel.piecesMin, propose.piecesMin);
  cmp('Arrondissements', actuel.arrondissements.join(', ') || 'tout Paris', propose.arrondissements.join(', ') || 'tout Paris');
  cmp('Préférés', actuel.arrondissementsPref.join(', ') || '—', propose.arrondissementsPref.join(', ') || '—');
  cmp('Meublé', actuel.meuble, propose.meuble);
  for (const k of ['rdc', 'dpeFG', 'coloc']) cmp(`Écarter ${k}`, actuel.exclure[k], propose.exclure[k]);
  for (const [k, label] of CRITERES) if (actuel.poids[k] !== propose.poids[k]) lignes.push(`${label} : ${actuel.poids[k]}/5 → ${propose.poids[k]}/5`);
  cmp('Alerte active', actuel.alerteActive, propose.alerteActive);
  cmp('Seuil alerte', actuel.alerteScoreMin, propose.alerteScoreMin);
  return lignes;
}

function afficherProposition(p) {
  const diff = diffCriteria(criteria, p);
  const box = $('#bot-proposal');
  if (!diff.length) { box.hidden = true; return; }
  derniereProposition = p;
  box.hidden = false;
  box.innerHTML = `<h4>Claude te propose :</h4><ul>${diff.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    <div class="dlg-actions"><button class="btn ghost small" id="bot-ignorer" type="button">Ignorer</button><button class="btn primary small" id="bot-appliquer" type="button">Appliquer</button></div>`;
  $('#bot-ignorer').addEventListener('click', () => { box.hidden = true; derniereProposition = null; });
  $('#bot-appliquer').addEventListener('click', async () => {
    box.hidden = true;
    $('#bot-etat').textContent = 'Application pour tout le monde…';
    await appliquerEtat('set_criteria', { criteria: p, source: 'bot', diff });
    remplirFormulaire();
    limite = 30;
    render();
    $('#bot-etat').textContent = 'Appliqué pour tout le monde.';
  });
}

// --- Propositions du bot (tout est à valider d'un tap : le bot ne modifie rien seul) ------------------------
const CANAUX = { messagerie_annonce: "messagerie de l'annonce", email: 'e-mail', sms: 'SMS', telephone: 'téléphone' };
const annonceParId = (id) => ranked.find((x) => x.id === id) || manuel.find((x) => x.id === id);

// Copie dans le presse-papiers ; renvoie false si le navigateur refuse (permission, iOS…) pour que l'appelant
// puisse le dire à Tabatha au lieu d'échouer en silence.
async function copier(texte, source) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(texte); return true; }
  } catch { /* on tente le repli */ }
  try {
    const ta = source ?? Object.assign(document.createElement('textarea'), { value: texte });
    if (!source) document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    if (!source) ta.remove();
    return ok;
  } catch { return false; }
}
function telechargerIcs(nom, contenu) {
  const url = URL.createObjectURL(new Blob([contenu], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = nom; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function carteProposition(p) {
  const div = document.createElement('div');
  div.className = 'bot-proposal prop';
  const termine = (t) => { div.innerHTML = `<p class="hint">${esc(t)}</p>`; };
  const boutons = (...b) => `<div class="dlg-actions">${b.join('')}</div>`;
  if (p.type === 'actions') {
    div.innerHTML = `<h4>Claude te propose :</h4><ul>${p.actions.map((x) => `<li>${esc(x.libelle)}</li>`).join('')}</ul>${boutons('<button class="btn ghost small" data-ign type="button">Ignorer</button>', '<button class="btn primary small" data-ok type="button">Appliquer</button>')}`;
    div.querySelector('[data-ign]').onclick = () => div.remove();
    div.querySelector('[data-ok]').onclick = async () => {
      termine('Application…');
      for (const x of p.actions) {
        if (x.action === 'note') await appliquerEtat('set_note', { id: x.id, texte: x.note, url: x.url, title: x.title });
        else await appliquerEtat('set_statut', { id: x.id, valeur: x.action === 'retirer_statut' ? null : x.action, url: x.url, title: x.title, price: x.price });
      }
      render();
      termine(`✔ Appliqué (${p.actions.length}).`);
    };
  } else if (p.type === 'ajout') {
    div.innerHTML = `<h4>Ajouter cette annonce ?</h4><p>${esc(p.libelle)}</p>${boutons('<button class="btn ghost small" data-ign type="button">Ignorer</button>', '<button class="btn primary small" data-ok type="button">Ajouter</button>')}`;
    div.querySelector('[data-ign]').onclick = () => div.remove();
    div.querySelector('[data-ok]').onclick = async () => {
      const now = new Date().toISOString();
      const x = p.listing;
      await appliquerEtat('ajouter_manuel', { listing: { id: `manuel:${Date.now()}`, source: 'Manuel', url: x.url, title: x.title, price: x.price, surface: x.surface, rooms: x.rooms, arrondissement: x.arrondissement, floor: x.floor, elevator: null, dpe: x.dpe, furnished: null, features: x.balcon ? { balcon: true } : {}, first_seen: now, last_seen: now, publishedAt: now, photo: null }, balcon: x.balcon });
      render();
      termine('✔ Annonce ajoutée.');
    };
  } else if (p.type === 'message') {
    const { texte, manquants } = remplirMarqueurs(p.message, dossier());
    div.innerHTML = `<h4>✉️ Brouillon — ${esc(p.libelle)}</h4>
      <p class="hint">Canal : ${esc(CANAUX[p.canal] ?? p.canal)}. Relis-le, puis envoie-le toi-même : rien ne part tout seul.</p>
      ${p.objet ? `<p><b>Objet :</b> ${esc(p.objet)}</p>` : ''}
      ${manquants.length ? `<p class="hint avert">Il manque : ${esc(manquants.map((k) => MARQUEURS[k]).join(', '))}. Complète « 👤 Mon dossier » (en haut) ou corrige le texte.</p>` : ''}
      <textarea class="brouillon" rows="9">${esc(texte)}</textarea>
      ${boutons('<button class="btn ghost small" data-copier type="button">Copier</button>', `<a class="btn ghost small" href="${esc(safeUrl(p.lien))}" target="_blank" rel="noopener noreferrer">Ouvrir l'annonce ↗</a>`, '<button class="btn primary small" data-envoye type="button">J\'ai envoyé ✔</button>')}`;
    const ta = div.querySelector('textarea');
    div.querySelector('[data-copier]').onclick = async (e) => { const ok = await copier(ta.value, ta); e.target.textContent = ok ? 'Copié ✔' : 'Sélectionné : copie à la main'; if (!ok) { ta.focus(); ta.select(); } };
    div.querySelector('[data-envoye]').onclick = async () => {
      await appliquerEtat('set_contact', { id: p.id, statut: 'contacte', relance_jours: 3, canal: p.canal, url: p.lien });
      render();
      termine('✔ Noté : contacté. Je te rappellerai de relancer dans 3 jours si personne ne répond.');
    };
  } else if (p.type === 'contact') {
    div.innerHTML = `<h4>Suivi — ${esc(p.libelle)}</h4><p><b>${esc(STATUTS_LIBELLES[p.statut])}</b>${p.note ? ` — ${esc(p.note)}` : ''}${p.relance_jours ? ` · relance dans ${p.relance_jours} j` : ''}</p>${boutons('<button class="btn ghost small" data-ign type="button">Ignorer</button>', '<button class="btn primary small" data-ok type="button">Enregistrer</button>')}`;
    div.querySelector('[data-ign]').onclick = () => div.remove();
    div.querySelector('[data-ok]').onclick = async () => { await appliquerEtat('set_contact', { id: p.id, statut: p.statut, note: p.note, relance_jours: p.relance_jours, url: annonceParId(p.id)?.url }); render(); termine('✔ Suivi enregistré.'); };
  } else if (p.type === 'visite') {
    const quand = new Date(p.debut).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `<h4>📅 Visite — ${esc(p.libelle)}</h4><p>${esc(quand)} (${p.duree_min} min)${p.lieu ? ` · ${esc(p.lieu)}` : ''}</p>${boutons('<button class="btn ghost small" data-ign type="button">Ignorer</button>', '<button class="btn primary small" data-ok type="button">Ajouter au calendrier</button>')}`;
    div.querySelector('[data-ign]').onclick = () => div.remove();
    div.querySelector('[data-ok]').onclick = async () => {
      telechargerIcs('visite.ics', construireIcs({ titre: `Visite — ${p.libelle}`, debut: p.debut, dureeMin: p.duree_min, lieu: p.lieu, description: `${p.note ? p.note + '\n' : ''}${p.lien}` }));
      await appliquerEtat('set_contact', { id: p.id, statut: 'visite', visite: new Date(p.debut).toISOString(), url: p.lien });
      render();
      termine('✔ Fichier calendrier téléchargé, visite notée dans le suivi.');
    };
  } else return null;
  return div;
}

function afficherPropositions(props = []) {
  const zone = $('#bot-propositions');
  zone.innerHTML = '';
  for (const p of props) {
    if (p.type === 'criteres') afficherProposition(p.criteria);
    else { const c = carteProposition(p); if (c) zone.appendChild(c); }
  }
  zone.hidden = !zone.children.length;
  const log = $('#bot-log'); log.scrollTop = log.scrollHeight; // la zone de cartes réduit le journal : on recolle en bas
}

async function envoyerBot(message) {
  if (!config.botUrl || !config.botToken) { $('#bot-etat').textContent = "Le bot n'est pas encore configuré (docs/config.json)."; return; }
  botChat.push({ role: 'user', content: message });
  store.set('botChat', botChat.slice(-24));
  dessinerBotLog();
  botEnvoi = true;
  $('#bot-propositions').hidden = true;
  $('#bot-proposal').hidden = true; // une proposition de critères de l'échange précédent n'est plus d'actualité
  $('#bot-etat').textContent = 'Claude réfléchit…';
  try {
    const res = await fetch(config.botUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Token': config.botToken },
      body: JSON.stringify({ message, history: botChat.slice(-12), criteria }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    botChat.push({ role: 'assistant', content: data.reply || '…' });
    store.set('botChat', botChat.slice(-24));
    dessinerBotLog();
    $('#bot-etat').textContent = '';
    if (data.propositions?.length) afficherPropositions(data.propositions);
    else { afficherPropositions([]); if (data.proposal) afficherProposition(data.proposal); }
    { const log = $('#bot-log'); log.scrollTop = log.scrollHeight; }
  } catch (e) {
    dessinerBotLog();
    $('#bot-etat').textContent = `Erreur : ${e.message}`;
  } finally {
    botEnvoi = false;
  }
}

function dessinerIdees() {
  $('#bot-idees-liste').innerHTML = IDEES_QUESTIONS.map((g) => `<h5>${esc(g.titre)}</h5><div class="idee-liste">${g.questions.map((q) => `<button type="button" class="idee">${esc(q)}</button>`).join('')}</div>`).join('');
  $('#bot-idees').open = !botChat.length; // ouvertes au premier usage, repliées ensuite
}

function ouvrirBot(prefill) {
  cacherBulle();
  dessinerBotLog();
  dessinerIdees();
  $('#dlg-bot').showModal();
  const ta = $('#bot-input');
  if (prefill) ta.value = prefill;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function brancherBot() {
  $('#btn-bot').addEventListener('click', () => ouvrirBot());
  $('#bot-close').addEventListener('click', () => $('#dlg-bot').close());
  $('#bot-idees-liste').addEventListener('click', (e) => {
    const b = e.target.closest('.idee');
    if (!b || botEnvoi) return;
    $('#bot-idees').open = false;
    envoyerBot(b.textContent);
  });
  $('#bot-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (botEnvoi) return;
    const ta = $('#bot-input');
    const msg = ta.value.trim();
    if (!msg) return;
    ta.value = '';
    envoyerBot(msg);
  });
}

// --- La mascotte : présence discrète qui invite à tout modifier, et récolte ses avis ----------
// Illustration : docs/mascotte.webp (fournie par Sacha, recadrée/redimensionnée pour le web —
// voir avec lui l'origine et les droits d'usage avant toute réutilisation ailleurs).
// Elle flotte en bas de l'écran et ouvre le même chat que « Demander à Claude » ; elle sert surtout
// à montrer, dans l'appli, que tout est modifiable, et à glisser de temps en temps une question
// courte (👍/👎) qui part directement dans le journal partagé avec Sacha.
function montrerBulle(texte, boutons) {
  const bulle = $('#mascotte-bulle');
  bulle.innerHTML = `<p>${esc(texte)}</p><div class="mascotte-bulle-actions"></div>`;
  const zone = bulle.querySelector('.mascotte-bulle-actions');
  for (const b of boutons) {
    const btn = document.createElement('button');
    btn.className = 'btn small' + (b.primaire ? ' primary' : ' ghost');
    btn.textContent = b.texte;
    btn.addEventListener('click', () => { cacherBulle(); b.action?.(); });
    zone.appendChild(btn);
  }
  bulle.hidden = false;
}
function cacherBulle() { $('#mascotte-bulle').hidden = true; }

function proposerBulleCriteres() {
  if (store.get('bulleCriteresVue', false)) return; // une seule fois par appareil, pas à chaque réglage
  store.set('bulleCriteresVue', true);
  montrerBulle('Ces nouveaux critères, ça te va ?', [
    { texte: '👍 Oui', primaire: true, action: () => envoyerEvenement('avis', { sujet: 'criteres', avis: 'positif', criteria }) },
    { texte: '👎 Pas trop', action: () => envoyerEvenement('avis', { sujet: 'criteres', avis: 'negatif', criteria }) },
    { texte: 'Dis-m\'en plus', action: () => ouvrirBot('') },
  ]);
}

// iOS (Safari) ne propose aucun vrai popup natif d'installation déclenchable en JS (contrairement à
// Android/Chrome) : la seule option est d'expliquer nous-mêmes le geste « Partager → Sur l'écran
// d'accueil ». On ne le propose qu'à Safari lui-même (pas Chrome/Firefox iOS, ni les navigateurs
// intégrés d'apps tierces, où ce menu n'existe pas ou pas pareil), et jamais si déjà installée.
function estCandidatInstallationIOS() {
  const ua = navigator.userAgent || '';
  const iOS = /iP(hone|od|ad)/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
  const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  const dejaInstallee = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  return iOS && safari && !dejaInstallee;
}
function proposerBulleInstall() {
  if (!estCandidatInstallationIOS() || store.get('bulleInstallVue', false)) return;
  store.set('bulleInstallVue', true);
  montrerBulle(
    "Envie de l'avoir comme une vraie appli sur ton iPhone ? Appuie sur ⬆️ Partager en bas de Safari, puis « Sur l'écran d'accueil ».",
    [{ texte: 'Compris', primaire: true, action: () => {} }],
  );
}

function brancherMascotte() {
  $('#mascotte-flottante').addEventListener('click', () => ouvrirBot());
  $('#criteres-mascotte').addEventListener('click', (e) => { e.preventDefault(); ouvrirBot('Sur mes critères, je voudrais '); });
  // Si elle a filé discuter avec le bot (« Compris, on discute ») plutôt que de choisir « Plus
  // tard », on propose quand même l'installation à la fermeture du chat, sans quoi ça ne se
  // représente jamais de la session.
  $('#dlg-bot').addEventListener('close', () => setTimeout(proposerBulleInstall, 400));
  // Premher contact : une seule fois, on se présente et on explique la transparence avec Sacha.
  if (!store.get('bulleAccueilVue', false)) {
    store.set('bulleAccueilVue', true);
    setTimeout(() => montrerBulle(
      "Coucou, c'est moi ! Tu peux tout me demander pour ajuster tes critères. Ce qu'on se dit ici, et tes ♥/✕/notes, Sacha les voit aussi pour adapter le site pour toi.",
      [
        { texte: 'Compris, on discute', primaire: true, action: () => ouvrirBot() },
        { texte: 'Plus tard', action: () => setTimeout(proposerBulleInstall, 1000) },
      ],
    ), 1200);
  } else {
    setTimeout(proposerBulleInstall, 1500);
  }
}

async function demarrer() {
  // Large écran : panneau toujours ouvert (son titre est masqué). Mobile : replié pour laisser place aux annonces.
  const large = matchMedia('(min-width: 900px)');
  const ajuster = () => { $('#criteres').open = large.matches; };
  ajuster();
  large.addEventListener('change', ajuster);
  remplirFormulaire();
  brancher();
  brancherBot();
  brancherMascotte();
  // Il faut le jeton du Worker avant de pouvoir aller chercher l'état partagé : on l'attend ici,
  // contrairement à listings.json qui ne dépend de rien.
  config = await fetch('config.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  try {
    const [d, etat] = await Promise.all([
      fetch(`data/listings.json?t=${Date.now()}`).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
      chargerEtatPartage().catch((e) => { console.error('État partagé indisponible, on repart du cache local', e); return null; }),
    ]);
    base = d.listings;
    meta = d.meta;
    if (etat) {
      const migre = await migrerVersEtatPartage(etat);
      const definitif = migre ? await chargerEtatPartage() : etat;
      adopterEtat(definitif);
      etatSnapshot = chaineEtat(definitif);
      remplirFormulaire();
    } else if (!store.get('criteriaCache', null) && !store.get('criteria', null)) {
      // Ni état partagé joignable, ni aucun cache local (tout premier appareil, hors-ligne) :
      // repli sur la base publiée dans le dépôt pour ne pas rester sur des critères par défaut absurdes.
      const c = await fetch('criteria.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (c) { criteria = mergeCriteria(c); remplirFormulaire(); }
    }
  } catch (e) {
    $('#maj').textContent = 'Impossible de charger les annonces (data/listings.json).';
  }
  entete();
  dessinerSources();
  render();
  if (!compteurs().nouveautes) { onglet = 'meilleures'; render(); }
  // Un autre appareil peut avoir changé quelque chose entre-temps : on se resynchronise
  // régulièrement pendant que l'onglet est visible, et tout de suite en y revenant.
  setInterval(() => { if (document.visibilityState === 'visible') synchroniserEtat({ silencieux: true }); }, 25_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') synchroniserEtat({ silencieux: true }); });
  // Safari (iPhone et Mac) restaure très souvent un onglet déjà ouvert depuis son cache mémoire
  // (bfcache) en revenant dessus, sans la moindre requête réseau : ni le rechargement des données,
  // ni même « visibilitychange » ne se déclenchent alors de façon fiable. « pageshow » avec
  // persisted=true est le seul signal fiable de ce cas précis (retour sur l'appli après être allé
  // ailleurs) : on force une resynchronisation immédiate.
  window.addEventListener('pageshow', (e) => { if (e.persisted) synchroniserEtat({ silencieux: true }); });
}

demarrer();
