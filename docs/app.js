import { CRITERES, mergeCriteria, rankListings } from './score.mjs';

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
let profil = store.get('profil', {});
let config = {}; // docs/config.json : { contactEmail, alertEmail } facultatifs

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
  const cls = l.score >= 75 ? 'haut' : l.score >= 55 ? 'moyen' : 'bas';
  const ppm = l.price != null && l.surface ? Math.round(l.price / l.surface) : null;
  const infos = [l.surface ? `${l.surface} m²` : null, l.rooms ? `${l.rooms} p.` : null, l.arrondissement ? `Paris ${l.arrondissement}e` : null, l.floor != null ? (l.floor === 0 ? 'RDC' : `${l.floor}e ét.`) : null, ppm ? `${ppm} €/m²` : null]
    .filter(Boolean).join(' · ');
  const detail = l.ok
    ? `<ul>${l.detail.filter((d) => d.poids).map((d) => `<li><span>${esc(d.label)}</span><span>${d.points}</span><div class="bar"><i style="width:${Math.round((d.valeur ?? 0) * 100)}%"></i></div></li>`).join('')}</ul>`
    : `<ul class="rejet">${l.rejets.map((r) => `<li><span>${esc(r)}</span><span></span></li>`).join('')}</ul>`;
  const pepite = l.ok && l.score >= 85;
  const badge = l.ok
    ? `<div class="score ${cls}" style="--s:${l.score}" title="Score ${l.score}/100"><span>${l.score}</span>${pepite ? '<span class="etoile" aria-hidden="true">✦</span>' : ''}</div>`
    : '';
  return `<li class="card ${l.first_seen > vuJusqua && l.source !== 'Manuel' ? 'nouveau' : ''} ${pepite ? 'pepite' : ''}" data-id="${esc(l.id)}">
    <div class="photo">${l.photo ? `<img src="${esc(safeUrl(l.photo))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}</div>
    <div class="body">
      <div class="prix">${l.price != null ? eur(l.price) : '—'}<small>CC</small></div>
      <div class="meta">${esc(infos)}</div>
      <div class="titre">${esc(l.title ?? l.district ?? '')}</div>
      <div class="chips">${chips(l)}</div>
      <details class="why"><summary>${l.ok ? 'Pourquoi ce score ?' : 'Pourquoi écartée ?'}</summary>${detail}</details>
      <div class="card-actions">
        <a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer">Voir l'annonce ↗</a>
        <button class="mini" data-act="fav" aria-pressed="${statut[l.id] === 'fav'}">♥ Garder</button>
        <button class="mini" data-act="ecarte" aria-pressed="${statut[l.id] === 'ecarte'}">✕ Écarter</button>
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
  pills.push('<span class="pill todo" title="Alertes e-mail PAP / SeLoger / Leboncoin : à brancher">PAP, SeLoger, Leboncoin · via alertes e-mail (à venir)</span>');
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
    meilleure ? `meilleure trouvaille : ${meilleure.score}/100 à ${eur(meilleure.price)}` : null,
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
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.closest('.card').dataset.id;
    statut[id] = statut[id] === b.dataset.act ? undefined : b.dataset.act;
    if (!statut[id]) delete statut[id];
    store.set('statut', statut);
    render();
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
    manuel.unshift({
      id: `manuel:${Date.now()}`, source: 'Manuel', url: f.get('url'), title: f.get('title') || null,
      price: num('price'), surface: num('surface'), rooms: num('rooms'), arrondissement: num('arrondissement'), floor: num('floor'),
      elevator: f.get('elevator') ? true : null, dpe: f.get('dpe') || null, furnished: null,
      features: f.get('balcon') ? { balcon: true } : {}, first_seen: now, last_seen: now, publishedAt: now, photo: null,
    });
    store.set('manuel', manuel);
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


// --- Ma recherche en détail : questionnaire, récapitulatif à envoyer, alertes e-mail ---
const CHAMPS_PROFIL = [
  ['redhibitoires', 'Ce que je ne veux absolument pas', 'textarea', 'Ex. : rez-de-chaussée sur cour, 5e étage sans ascenseur, cuisine ouverte…'],
  ['quartiers', 'Quartiers ou rues que j\'aime / que j\'évite, et pourquoi', 'textarea', ''],
  ['trajet', 'Mon trajet quotidien (lieu de travail ou d\'études, durée maximale)', 'text', ''],
  ['emmenagement', 'Date d\'emménagement souhaitée et durée prévue', 'text', ''],
  ['occupants', 'Nombre d\'occupants', 'text', ''],
  ['animaux', 'Animaux', 'text', ''],
  ['garant', 'Dossier : garant, Visale, revenus (facultatif)', 'text', ''],
  ['budgetPerle', 'Budget maximal exceptionnel pour un vrai coup de cœur (€)', 'number', ''],
  ['remarques', 'Autre chose à savoir', 'textarea', ''],
];

function recapTexte() {
  const c = criteria;
  const nom = Object.fromEntries(CRITERES);
  const pref = c.arrondissementsPref;
  const exclus = c.arrondissements.length ? Array.from({ length: 20 }, (_, i) => i + 1).filter((i) => !c.arrondissements.includes(i)) : [];
  const niveau = (min, max) => CRITERES.filter(([k]) => c.poids[k] >= min && c.poids[k] <= max).map(([k]) => `${nom[k]} (${c.poids[k]}/5)`);
  const ligne = (t, v) => (v && String(v).trim() ? `- ${t} : ${String(v).trim()}` : null);
  const perle = profil.budgetPerle ? ` (jusqu'à ${eur(profil.budgetPerle)} pour un coup de cœur)` : '';
  const l = [
    "MA RECHERCHE D'APPART À PARIS",
    '',
    'CRITÈRES CHIFFRÉS',
    `- Budget max : ${eur(c.budgetMax)} charges comprises${perle}`,
    `- Surface min : ${c.surfaceMin} m² · ${c.piecesMin} pièce(s) min · meublé : ${{ indifferent: 'peu importe', oui: 'oui', non: 'non' }[c.meuble]}`,
    `- Arrondissements préférés : ${pref.length ? pref.map((i) => `${i}e`).join(', ') : 'aucun en particulier'}`,
    `- Arrondissements exclus : ${exclus.length ? exclus.map((i) => `${i}e`).join(', ') : 'aucun'}`,
    `- Écartées automatiquement : ${[c.exclure.rdc && 'rez-de-chaussée', c.exclure.dpeFG && 'DPE F/G', c.exclure.coloc && 'colocation'].filter(Boolean).join(', ') || 'rien'}`,
    `- Essentiel (4-5) : ${niveau(4, 5).join(', ') || '—'}`,
    `- Important (2-3) : ${niveau(2, 3).join(', ') || '—'}`,
    `- Bonus (1) : ${niveau(1, 1).join(', ') || '—'}`,
    `- Indifférent (0) : ${niveau(0, 0).join(', ') || '—'}`,
    `- Alerte Telegram : ${c.alerteActive ? `oui, à partir de ${c.alerteScoreMin}/100` : 'non'}`,
    '',
    'EN CLAIR',
    ...CHAMPS_PROFIL.filter(([k]) => k !== 'budgetPerle').map(([k, label]) => ligne(label, profil[k])).filter(Boolean),
  ];
  if (l.at(-1) === 'EN CLAIR') l.push('(rien de renseigné)');
  l.push('', '--- pour le bot (docs/criteria.json) ---', JSON.stringify(c));
  return l.join('\n');
}

function dessinerProfil() {
  $('#profil-champs').innerHTML = CHAMPS_PROFIL.map(([k, label, type, ph]) => {
    const v = esc(profil[k] ?? '');
    const champ = type === 'textarea' ? `<textarea rows="3" data-profil="${k}" placeholder="${esc(ph)}">${v}</textarea>` : `<input type="${type}" data-profil="${k}" value="${v}" placeholder="${esc(ph)}">`;
    return `<label>${esc(label)}${champ}</label>`;
  }).join('');
  majRecap();
}

function majRecap() {
  const texte = recapTexte();
  $('#recap').value = texte;
  const mail = $('#btn-mail');
  if (config.contactEmail) {
    mail.hidden = false;
    // Le corps d'un mailto: est limité en taille : on n'y met que la partie lisible, sans le JSON.
    mail.href = `mailto:${encodeURIComponent(config.contactEmail)}?subject=${encodeURIComponent("Ma recherche d'appart")}&body=${encodeURIComponent(texte.split('\n--- pour le bot')[0])}`;
  }
  dessinerAlertes();
}

function dessinerAlertes() {
  const c = criteria;
  const adresse = config.alertEmail ? `<strong>${esc(config.alertEmail)}</strong>` : "l'adresse dédiée que Sacha t'a donnée";
  const zone = `Paris · ≤ ${eur(c.budgetMax)} · ≥ ${c.surfaceMin} m² · ${c.piecesMin} pièce(s) et plus`;
  const pap = `https://www.pap.fr/annonce/location-appartement-paris-75-g439-jusqu-a-${c.budgetMax}-euros-a-partir-de-${c.surfaceMin}-m2-a-partir-de-${c.piecesMin}-pieces`;
  const etapes = (liste) => `<ol>${liste.map((e) => `<li>${e}</li>`).join('')}</ol>`;
  $('#alertes').innerHTML = `
    <p class="hint">Sur chaque site, crée une alerte avec ${adresse}. Ne mets que l'indispensable : ${zone}. Ce site fait ensuite le tri fin avec tes préférences, donc mieux vaut une alerte un peu large.</p>
    <div class="site-card"><h4>PAP <span class="hint">(particuliers, sans frais d'agence)</span></h4>
      ${etapes(['Ouvre la recherche déjà préfiltrée ci-dessous.', 'Clique sur « Créer une alerte e-mail » et saisis l\'adresse dédiée.'])}
      <a class="btn" href="${esc(pap)}" target="_blank" rel="noopener noreferrer">Ouvrir la recherche PAP ↗</a></div>
    <div class="site-card"><h4>SeLoger</h4>
      ${etapes(['Ouvre SeLoger, choisis Louer → Appartement → Paris.', `Règle le budget max (${eur(c.budgetMax)}), la surface min (${c.surfaceMin} m²) et les pièces.`, 'Clique sur « Créer une alerte » (compte gratuit).'])}
      <a class="btn" href="https://www.seloger.com/" target="_blank" rel="noopener noreferrer">Ouvrir SeLoger ↗</a></div>
    <div class="site-card"><h4>Leboncoin</h4>
      ${etapes(['Ouvre Leboncoin → Locations → Paris.', `Règle le prix max (${eur(c.budgetMax)}), la surface min (${c.surfaceMin} m²) et les pièces.`, 'Clique sur « Sauvegarder la recherche » et active l\'alerte e-mail.'])}
      <a class="btn" href="https://www.leboncoin.fr/" target="_blank" rel="noopener noreferrer">Ouvrir Leboncoin ↗</a></div>`;
}

async function copierRecap() {
  const texte = $('#recap').value;
  try { await navigator.clipboard.writeText(texte); }
  catch { $('#recap').select(); document.execCommand('copy'); }
  $('#recap-etat').textContent = 'Copié. Colle-le dans un message à Sacha.';
}

function brancherProfil() {
  $('#btn-profil').addEventListener('click', () => { dessinerProfil(); $('#dlg-profil').showModal(); });
  $('#profil-close').addEventListener('click', () => $('#dlg-profil').close());
  $('#profil-champs').addEventListener('input', (e) => {
    const k = e.target.dataset.profil;
    if (!k) return;
    profil[k] = e.target.value;
    store.set('profil', profil);
    majRecap();
  });
  $('#btn-copy').addEventListener('click', copierRecap);
  if (navigator.share) {
    $('#btn-share').hidden = false;
    $('#btn-share').addEventListener('click', async () => {
      try { await navigator.share({ title: "Ma recherche d'appart", text: $('#recap').value }); $('#recap-etat').textContent = 'Envoyé.'; }
      catch (e) { if (e.name !== 'AbortError') copierRecap(); }
    });
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

function brancherBot() {
  $('#btn-bot').addEventListener('click', () => { dessinerBotLog(); $('#dlg-bot').showModal(); $('#bot-input').focus(); });
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

async function demarrer() {
  // Large écran : panneau toujours ouvert (son titre est masqué). Mobile : replié pour laisser place aux annonces.
  const large = matchMedia('(min-width: 900px)');
  const ajuster = () => { $('#criteres').open = large.matches; };
  ajuster();
  large.addEventListener('change', ajuster);
  remplirFormulaire();
  brancher();
  brancherProfil();
  brancherBot();
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
