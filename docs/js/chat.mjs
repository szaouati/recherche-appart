// Chat « Demander à Claude » et cartes de propositions. Le bot ne modifie JAMAIS rien seul : chaque proposition
// est validée côté serveur puis appliquée d'un tap par Tabatha (via appliquerEtat → Worker).
import { CRITERES } from '../score.mjs';
import { STATUTS_LIBELLES, MARQUEURS, remplirMarqueurs, construireIcs, formaterReponse, IDEES_QUESTIONS } from '../agent-ui.mjs';
import { $, esc, eur, safeUrl, store } from './util.mjs';
import { S, appliquerEtat, annonceParId } from './etat.mjs';

// « Mon dossier » (prénom, situation, téléphone, disponibilités) : UNIQUEMENT sur cet appareil, jamais envoyé
// au Worker ni au journal public — le bot n'écrit que des marqueurs {{prenom}}… que l'on remplit ici.
export const dossier = () => store.get('dossier', {});

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
  const diff = diffCriteria(S.criteria, p);
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
    $('#bot-etat').textContent = 'Appliqué pour tout le monde.';
  });
}

// --- Propositions du bot (tout est à valider d'un tap : le bot ne modifie rien seul) ------------------------
const CANAUX = { messagerie_annonce: "messagerie de l'annonce", email: 'e-mail', sms: 'SMS', telephone: 'téléphone' };

// Copie dans le presse-papiers ; renvoie false si le navigateur refuse (permission, iOS…) pour que l'appelant
// puisse le dire à Tabatha au lieu d'échouer en silence.
export async function copier(texte, source) {
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
      termine(`✔ Appliqué (${p.actions.length}).`);
    };
  } else if (p.type === 'ajout') {
    div.innerHTML = `<h4>Ajouter cette annonce ?</h4><p>${esc(p.libelle)}</p>${boutons('<button class="btn ghost small" data-ign type="button">Ignorer</button>', '<button class="btn primary small" data-ok type="button">Ajouter</button>')}`;
    div.querySelector('[data-ign]').onclick = () => div.remove();
    div.querySelector('[data-ok]').onclick = async () => {
      const now = new Date().toISOString();
      const x = p.listing;
      await appliquerEtat('ajouter_manuel', { listing: { id: `manuel:${Date.now()}`, source: 'Manuel', url: x.url, title: x.title, price: x.price, surface: x.surface, rooms: x.rooms, arrondissement: x.arrondissement, floor: x.floor, elevator: null, dpe: x.dpe, furnished: null, features: x.balcon ? { balcon: true } : {}, first_seen: now, last_seen: now, publishedAt: now, photo: null }, balcon: x.balcon });
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
      termine('✔ Noté : contacté. Je te rappellerai de relancer dans 3 jours si personne ne répond.');
    };
  } else if (p.type === 'contact') {
    div.innerHTML = `<h4>Suivi — ${esc(p.libelle)}</h4><p><b>${esc(STATUTS_LIBELLES[p.statut])}</b>${p.note ? ` — ${esc(p.note)}` : ''}${p.relance_jours ? ` · relance dans ${p.relance_jours} j` : ''}</p>${boutons('<button class="btn ghost small" data-ign type="button">Ignorer</button>', '<button class="btn primary small" data-ok type="button">Enregistrer</button>')}`;
    div.querySelector('[data-ign]').onclick = () => div.remove();
    div.querySelector('[data-ok]').onclick = async () => { await appliquerEtat('set_contact', { id: p.id, statut: p.statut, note: p.note, relance_jours: p.relance_jours, url: annonceParId(p.id)?.url }); termine('✔ Suivi enregistré.'); };
  } else if (p.type === 'visite') {
    const quand = new Date(p.debut).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `<h4>📅 Visite — ${esc(p.libelle)}</h4><p>${esc(quand)} (${p.duree_min} min)${p.lieu ? ` · ${esc(p.lieu)}` : ''}</p>${boutons('<button class="btn ghost small" data-ign type="button">Ignorer</button>', '<button class="btn primary small" data-ok type="button">Ajouter au calendrier</button>')}`;
    div.querySelector('[data-ign]').onclick = () => div.remove();
    div.querySelector('[data-ok]').onclick = async () => {
      telechargerIcs('visite.ics', construireIcs({ titre: `Visite — ${p.libelle}`, debut: p.debut, dureeMin: p.duree_min, lieu: p.lieu, description: `${p.note ? p.note + '\n' : ''}${p.lien}` }));
      await appliquerEtat('set_contact', { id: p.id, statut: 'visite', visite: new Date(p.debut).toISOString(), url: p.lien });
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

export async function envoyerBot(message) {
  if (!S.config.botUrl || !S.config.botToken) { $('#bot-etat').textContent = "Le bot n'est pas encore configuré (docs/config.json)."; return; }
  botChat.push({ role: 'user', content: message });
  store.set('botChat', botChat.slice(-24));
  dessinerBotLog();
  botEnvoi = true;
  $('#bot-propositions').hidden = true;
  $('#bot-proposal').hidden = true; // une proposition de critères de l'échange précédent n'est plus d'actualité
  $('#bot-etat').textContent = 'Claude réfléchit…';
  try {
    const res = await fetch(S.config.botUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Token': S.config.botToken },
      body: JSON.stringify({ message, history: botChat.slice(-12), criteria: S.criteria }),
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

export function ouvrirBot(prefill) {
  { const b = document.getElementById('mascotte-bulle'); if (b) b.hidden = true; }
  dessinerBotLog();
  dessinerIdees();
  $('#dlg-bot').showModal();
  const ta = $('#bot-input');
  if (prefill) ta.value = prefill;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

export function brancherBot() {
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

