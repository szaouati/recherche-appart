import { CRITERES, mergeCriteria, rankListings, verdictScore } from './score.mjs';

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

// --- État ------------------------------------------------------------------
let criteria = mergeCriteria(store.get('criteria', {}));
let base = []; // annonces du bot
let meta = {};
let manuel = store.get('manuel', []);
let statut = store.get('statut', {}); // id -> 'fav' | 'ecarte'
let vuJusqua = store.get('vuJusqua', new Date(Date.now() - 864e5).toISOString());
let onglet = 'nouveautes';
let limite = 30;
let ranked = [];
let notes = store.get('notes', {}); // id -> texte libre (son carnet, partagé avec Sacha via le journal)
let config = {}; // docs/config.json : { botUrl, botToken }

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
  store.set('criteria', criteria);
  sorties();
  limite = 30;
  render();
  // On attend qu'elle arrête de bouger les curseurs avant de journaliser et de proposer un avis :
  // sinon un simple glissement de slider enverrait des dizaines d'événements et de bulles.
  clearTimeout(debounceCritere);
  debounceCritere = setTimeout(() => {
    envoyerEvenement('critere_change', { source: 'panel', criteria });
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

const actives = (l) => l.source === 'Manuel' || (!l.dupOf && (!meta.lastFullAt || new Date(l.last_seen) > new Date(new Date(meta.lastFullAt).getTime() - 48 * 36e5)));

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
  const ok = ranked.filter((l) => l.ok);
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

// --- Synchronisation des critères vers le dépôt (pour le bot) --------------
const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
function reglages() {
  const guess = location.hostname.endsWith('.github.io') ? `${location.hostname.split('.')[0]}/${location.pathname.split('/')[1] || ''}` : '';
  return { repo: guess, branch: 'main', token: '', ...store.get('sync', {}) };
}

async function synchroniser() {
  const { repo, branch, token } = reglages();
  const etat = $('#sync-etat');
  if (!repo || !token) { $('#dlg-settings').showModal(); return; }
  etat.textContent = 'Enregistrement…';
  const url = `https://api.github.com/repos/${repo}/contents/docs/criteria.json`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  try {
    const cur = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers });
    const sha = cur.ok ? (await cur.json()).sha : undefined;
    if (!cur.ok && cur.status !== 404) throw new Error(`lecture HTTP ${cur.status}`);
    const res = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ message: 'Mise à jour des critères', content: b64(JSON.stringify(criteria, null, 2) + '\n'), branch, sha }),
    });
    if (!res.ok) throw new Error(`écriture HTTP ${res.status}`);
    etat.textContent = `Enregistré ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}. Le bot les utilisera au prochain passage.`;
  } catch (e) {
    etat.textContent = `Échec de l'enregistrement (${e.message}). Vérifie le dépôt et le jeton dans ⚙.`;
  }
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
    const badge = e.target.closest('[data-mascotte-annonce]');
    if (badge) {
      const l = ranked.find((x) => x.id === badge.dataset.mascotteAnnonce);
      if (l) ouvrirBot(`À propos de cette annonce (${l.title ?? ''} · ${l.price != null ? eur(l.price) : '?'} · ${l.url}) : `);
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.closest('.card').dataset.id;
    const actif = statut[id] !== b.dataset.act;
    statut[id] = actif ? b.dataset.act : undefined;
    if (!statut[id]) delete statut[id];
    store.set('statut', statut);
    const l = ranked.find((x) => x.id === id) || manuel.find((x) => x.id === id);
    if (actif) envoyerEvenement(b.dataset.act, { listingId: id, url: l?.url, title: l?.title, price: l?.price });
    render();
  });
  $('#liste').addEventListener('focusout', (e) => {
    const ta = e.target.closest('.note-txt');
    if (!ta) return;
    const id = ta.dataset.id;
    const val = ta.value.trim();
    if (val) notes[id] = val; else delete notes[id];
    store.set('notes', notes);
    const l = ranked.find((x) => x.id === id) || manuel.find((x) => x.id === id);
    envoyerEvenement('note', { listingId: id, url: l?.url, title: l?.title, note: val });
  });
  $('#btn-more').addEventListener('click', () => { limite += 30; render(); });
  $('#btn-vu').addEventListener('click', () => { vuJusqua = new Date().toISOString(); store.set('vuJusqua', vuJusqua); render(); });
  $('#btn-sync').addEventListener('click', synchroniser);

  $('#btn-add').addEventListener('click', () => $('#dlg-add').showModal());
  $('#form-add').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'ok') return;
    const f = new FormData(e.target);
    const num = (k) => (f.get(k) === '' || f.get(k) == null ? null : Number(f.get(k)));
    const now = new Date().toISOString();
    const l = {
      id: `manuel:${Date.now()}`, source: 'Manuel', url: f.get('url'), title: f.get('title') || null,
      price: num('price'), surface: num('surface'), rooms: num('rooms'), arrondissement: num('arrondissement'), floor: num('floor'),
      elevator: f.get('elevator') ? true : null, dpe: f.get('dpe') || null, furnished: null,
      features: f.get('balcon') ? { balcon: true } : {}, first_seen: now, last_seen: now, publishedAt: now, photo: null,
    };
    manuel.unshift(l);
    store.set('manuel', manuel);
    envoyerEvenement('ajout_manuel', { url: l.url, title: l.title, price: l.price });
    e.target.reset();
    render();
  });

  $('#btn-settings').addEventListener('click', () => {
    const r = reglages();
    const f = $('#form-settings');
    f.repo.value = r.repo; f.branch.value = r.branch; f.token.value = r.token;
    $('#dlg-settings').showModal();
  });
  $('#form-settings').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'ok') return;
    const f = e.target;
    store.set('sync', { repo: f.repo.value.trim(), branch: f.branch.value.trim(), token: f.token.value.trim() });
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
    ? botChat.map((m) => `<div class="bot-msg ${m.role === 'user' ? 'user' : 'bot'}">${esc(m.content)}</div>`).join('')
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
    criteria = mergeCriteria(p);
    store.set('criteria', criteria);
    remplirFormulaire();
    limite = 30;
    render();
    box.hidden = true;
    envoyerEvenement('critere_change', { source: 'bot', diff, criteria });
    const r2 = reglages();
    if (r2.repo && r2.token) {
      $('#bot-etat').textContent = 'Appliqué sur le site. Envoi au bot…';
      await synchroniser();
    } else {
      $('#bot-etat').textContent = "Appliqué sur ce site. Ouvre ⚙ pour l'envoyer aussi au bot des alertes.";
    }
  });
}

async function envoyerBot(message) {
  if (!config.botUrl || !config.botToken) { $('#bot-etat').textContent = "Le bot n'est pas encore configuré (docs/config.json)."; return; }
  botChat.push({ role: 'user', content: message });
  store.set('botChat', botChat.slice(-24));
  dessinerBotLog();
  botEnvoi = true;
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
    if (data.proposal) afficherProposition(data.proposal);
  } catch (e) {
    dessinerBotLog();
    $('#bot-etat').textContent = `Erreur : ${e.message}`;
  } finally {
    botEnvoi = false;
  }
}

function ouvrirBot(prefill) {
  cacherBulle();
  dessinerBotLog();
  $('#dlg-bot').showModal();
  const ta = $('#bot-input');
  if (prefill) ta.value = prefill;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function brancherBot() {
  $('#btn-bot').addEventListener('click', () => ouvrirBot());
  $('#bot-close').addEventListener('click', () => $('#dlg-bot').close());
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

function brancherMascotte() {
  $('#mascotte-flottante').addEventListener('click', () => ouvrirBot());
  $('#criteres-mascotte').addEventListener('click', (e) => { e.preventDefault(); ouvrirBot('Sur mes critères, je voudrais '); });
  // Premher contact : une seule fois, on se présente et on explique la transparence avec Sacha.
  if (!store.get('bulleAccueilVue', false)) {
    store.set('bulleAccueilVue', true);
    setTimeout(() => montrerBulle(
      "Coucou, c'est moi ! Tu peux tout me demander pour ajuster tes critères. Ce qu'on se dit ici, et tes ♥/✕/notes, Sacha les voit aussi pour adapter le site pour toi.",
      [{ texte: 'Compris, on discute', primaire: true, action: () => ouvrirBot() }, { texte: 'Plus tard', action: () => {} }],
    ), 1200);
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
  fetch('config.json').then((r) => (r.ok ? r.json() : {})).then((c) => { config = c || {}; }).catch(() => {});
  try {
    const [d, c] = await Promise.all([
      fetch(`data/listings.json?t=${Date.now()}`).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
      // Premier passage sur cet appareil : on part des critères publiés dans le dépôt.
      store.get('criteria', null) ? null : fetch('criteria.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    base = d.listings;
    meta = d.meta;
    if (c) { criteria = mergeCriteria(c); store.set('criteria', criteria); remplirFormulaire(); }
  } catch (e) {
    $('#maj').textContent = 'Impossible de charger les annonces (data/listings.json).';
  }
  entete();
  dessinerSources();
  render();
  if (!compteurs().nouveautes) { onglet = 'meilleures'; render(); }
}

demarrer();
