// Formulaire de relecture : Sacha donne son avis sur chaque annonce avant que Tabatha les voie.
// Les réponses partent dans le journal partagé (événement « avis », via le Worker) : Claude les relit ensuite
// dans docs/data/journal.json. Rien n'est modifié dans l'appli par ce formulaire — c'est un simple retour.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const eur = (n) => `${Math.round(Number(n)).toLocaleString('fr-FR')} €`;
const RAISONS = ['Recherche d\'appart', 'Sous-loc courte', 'Échange', 'Occupant présent', 'Désactivée / louée', 'Prix suspect', 'Coloc', 'Bail étudiant', 'Mal renseignée', 'Autre'];
const MANQUE = ['Photos', 'Lien direct vers l\'annonce', 'Date de publication', 'Texte de l\'annonce', 'Signal « arnaque probable »', 'Étage / DPE fiables', 'Autre'];
const CLE = 'avisLot';

let lot = { items: [], genereLe: null };
let rep = {}; // id -> { v, r: [], c }
let manque = [];
try { ({ rep = {}, manque = [], remarque: window.__rem = '' } = JSON.parse(localStorage.getItem(CLE) || '{}')); } catch { /* pas de mémoire locale */ }

const sauver = () => { try { localStorage.setItem(CLE, JSON.stringify({ rep, manque, remarque: $('#remarque').value })); } catch { /* navigation privée */ } };

function titreAffiche(t) {
  if (!t) return '';
  const p = t.split(' — ');
  return p.length >= 3 ? p.slice(2).join(' — ') : p.length === 2 ? p[1] : t;
}
function etage(f) { return f == null ? null : f === 0 ? 'RDC' : `${f}e ét.`; }

function carte(it) {
  const r = rep[it.id] || {};
  const meta = [it.surface != null ? `${it.surface} m²` : null, it.rooms ? `${it.rooms} p.` : null, etage(it.floor), it.dpe ? `DPE ${it.dpe}` : null].filter(Boolean).join(' · ');
  return `<section class="item" data-id="${esc(it.id)}" data-v="${esc(r.v || '')}">
    <div class="tete"><span class="prix">${eur(it.price)}</span><span class="src">${esc(it.source)}</span></div>
    <div class="meta">${esc(meta || 'détails non disponibles')}</div>
    <p class="titre">${esc(titreAffiche(it.title))}</p>
    ${(it.hints || []).map((h) => `<div class="hint">⚠️ ${esc(h)}</div>`).join('')}
    <a class="lien" href="${esc(/^https?:\/\//.test(it.url) ? it.url : '#')}" target="_blank" rel="noopener noreferrer">Voir l'annonce ↗</a>
    <div class="verdicts">
      <button type="button" data-v="ok" aria-pressed="${r.v === 'ok'}">👍 OK</button>
      <button type="button" data-v="bof" aria-pressed="${r.v === 'bof'}">🤔 Bof</button>
      <button type="button" data-v="non" aria-pressed="${r.v === 'non'}">🚫 À écarter</button>
    </div>
    <div class="detail" ${r.v === 'bof' || r.v === 'non' ? '' : 'hidden'}>
      <div class="raisons">${RAISONS.map((x) => `<button type="button" data-r="${esc(x)}" aria-pressed="${(r.r || []).includes(x)}">${esc(x)}</button>`).join('')}</div>
      <input class="com" maxlength="200" placeholder="Un mot (facultatif)" value="${esc(r.c || '')}">
    </div>
  </section>`;
}

function progres() {
  const n = lot.items.filter((i) => rep[i.id]?.v).length;
  $('#prog').textContent = `${n} / ${lot.items.length} relues`;
}

function dessiner() {
  $('#liste').innerHTML = lot.items.map(carte).join('');
  $('#manque').innerHTML = MANQUE.map((x) => `<button type="button" data-m="${esc(x)}" aria-pressed="${manque.includes(x)}">${esc(x)}</button>`).join('');
  $('#remarque').value = window.__rem || '';
  progres();
}

document.addEventListener('click', (e) => {
  const sec = e.target.closest('.item');
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.m) {
    manque = manque.includes(b.dataset.m) ? manque.filter((x) => x !== b.dataset.m) : [...manque, b.dataset.m];
    b.setAttribute('aria-pressed', String(manque.includes(b.dataset.m)));
    return sauver();
  }
  if (!sec) return;
  const id = sec.dataset.id;
  rep[id] = rep[id] || {};
  if (b.dataset.v) {
    rep[id].v = rep[id].v === b.dataset.v ? '' : b.dataset.v; // un second tap annule
    sec.dataset.v = rep[id].v;
    sec.querySelectorAll('.verdicts button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.v === rep[id].v)));
    sec.querySelector('.detail').hidden = !(rep[id].v === 'bof' || rep[id].v === 'non');
    progres();
  } else if (b.dataset.r) {
    const r = rep[id].r || [];
    rep[id].r = r.includes(b.dataset.r) ? r.filter((x) => x !== b.dataset.r) : [...r, b.dataset.r];
    b.setAttribute('aria-pressed', String(rep[id].r.includes(b.dataset.r)));
  }
  sauver();
});
document.addEventListener('input', (e) => {
  const sec = e.target.closest('.item');
  if (e.target.classList.contains('com') && sec) { (rep[sec.dataset.id] = rep[sec.dataset.id] || {}).c = e.target.value; }
  window.__rem = $('#remarque').value;
  sauver();
});

// Format compact : uniquement les annonces relues, ids courts. Découpé pour tenir sous la limite d'un événement (4000 car.).
function reponses() {
  return lot.items.filter((i) => rep[i.id]?.v).map((i) => {
    const r = rep[i.id];
    const o = { id: i.id, p: i.price, v: r.v };
    if (r.r?.length) o.r = r.r;
    if (r.c) o.c = r.c.slice(0, 200);
    return o;
  });
}
function texte() {
  const l = reponses().map((o) => `${o.v === 'ok' ? '👍' : o.v === 'bof' ? '🤔' : '🚫'} ${o.p} € (${o.id})${o.r ? ' — ' + o.r.join(', ') : ''}${o.c ? ' — ' + o.c : ''}`);
  return `Avis Sacha (${new Date().toLocaleDateString('fr-FR')})\n${l.join('\n')}\nManque : ${manque.join(', ') || '—'}\nRemarque : ${$('#remarque').value || '—'}`;
}

$('#copier').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(texte()); $('#etat').textContent = 'Copié : tu peux le coller dans la conversation.'; }
  catch { $('#etat').textContent = 'Copie impossible ici — utilise « Envoyer ».'; }
});

$('#envoyer').addEventListener('click', async () => {
  const etat = $('#etat');
  const liste = reponses();
  if (!liste.length && !manque.length && !$('#remarque').value.trim()) { etat.textContent = 'Rien à envoyer pour l\'instant.'; return; }
  const parts = [];
  let cur = [];
  for (const o of liste) {
    if (JSON.stringify([...cur, o]).length > 3000) { parts.push(cur); cur = []; }
    cur.push(o);
  }
  if (cur.length || !parts.length) parts.push(cur);
  etat.textContent = 'Envoi…';
  try {
    const cfg = await fetch('config.json').then((r) => r.json());
    for (let i = 0; i < parts.length; i++) {
      const payload = { sujet: 'relecture_lot', lot: lot.genereLe, partie: `${i + 1}/${parts.length}`, reponses: parts[i] };
      if (i === parts.length - 1) { payload.manque = manque; payload.remarque = $('#remarque').value.slice(0, 600); }
      const r = await fetch(cfg.botUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Token': cfg.botToken }, body: JSON.stringify({ kind: 'event', type: 'avis', payload }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    }
    etat.textContent = `Reçu ✅ (${liste.length} annonces). Merci !`;
  } catch (e) {
    etat.textContent = `Échec de l'envoi (${e.message}). Utilise « Copier » et colle dans la conversation.`;
  }
});

fetch(`data/avis-lot.json?t=${Date.now()}`).then((r) => r.json()).then((j) => {
  lot = j;
  $('#intro').textContent = `${lot.items.length} annonces que Tabatha verra dans l'appli et que tu n'as pas encore relues. Un tap par annonce : 👍 OK, 🤔 Bof ou 🚫 À écarter (avec le motif). Ce que tu ne touches pas = pas relu.`;
  dessiner();
}).catch(() => { $('#intro').textContent = 'Impossible de charger la liste.'; });
