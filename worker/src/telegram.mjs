// Bot Telegram : une deuxième porte d'entrée sur le même Worker, à côté du site.
//
//  - Résumés planifiés (cron horaire, envoi aux heures TELEGRAM_HEURES, heure de Paris) : les nouvelles annonces
//    qui passent ses critères, une carte par annonce avec ♥ Garder / ✕ Écarter / 🔗 Voir. Une annonce n'est
//    envoyée qu'une fois (KV `envoyes` + entrée journal `telegram_envoye`).
//  - Messages libres de Tabatha → le MÊME agent que le chat du site (worker/src/agent.mjs). Ses propositions
//    arrivent sous la réponse avec un bouton « ✔ Appliquer » : la règle « le bot ne modifie jamais rien seul »
//    est inchangée, le bouton remplace le tap dans l'appli.
//  - Toute écriture passe par traiterEtat (index.mjs) : même état partagé, même journal que le site.
//
// Accès : le bot ne parle qu'à deux comptes. Le premier /start reçu devient l'administrateur (Sacha, qui le
// fait juste après le déploiement) ; toute autre personne qui fait /start déclenche une demande que
// l'administrateur accepte (« C'est Tabatha ») ou refuse. Les identifiants de chat, l'historique de
// conversation et les propositions en attente vivent dans KV (binding TG), jamais dans le dépôt public.
//
// Tout ce qui sort de l'extérieur (texte d'annonce, message reçu) est échappé avant d'être envoyé en HTML.
import { mergeCriteria, verdictScore } from '../../docs/score.mjs';
import { executerAgent, construireContexte, quartierDe } from './agent.mjs';

const MAX_HISTORIQUE = 12;
const TTL_HISTORIQUE = 7 * 864e2; // secondes
const TTL_PROPOSITION = 14 * 864e2;
const TTL_CARTE = 30 * 864e2;
const MAX_ENVOYES = 3000;
export const STATUTS_LIBELLES = { a_contacter: 'à contacter', contacte: 'contactée', reponse: 'réponse reçue', visite: 'visite prévue', refuse: 'refusé', sans_suite: 'sans suite' };

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const versHtml = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').slice(0, 4000);
const eur = (n) => `${Math.round(Number(n)).toLocaleString('fr-FR')} €`;
const aleatoire = () => Math.random().toString(36).slice(2, 10);

// --- Telegram & KV --------------------------------------------------------------------------------
async function tg(env, methode, params) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${methode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const d = await r.json().catch(() => ({ ok: false }));
    if (!d.ok) console.error(`telegram ${methode} : ${r.status} ${d.description ?? ''}`);
    return d;
  } catch (e) {
    console.error(`telegram ${methode}`, e);
    return { ok: false };
  }
}

const envoyer = (env, chat, text, extra = {}) => tg(env, 'sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

const kvLire = async (env, cle) => { try { return await env.TG.get(cle, 'json'); } catch { return null; } };
const kvEcrire = (env, cle, v, ttl) => env.TG.put(cle, JSON.stringify(v), ttl ? { expirationTtl: ttl } : undefined);

async function roles(env) {
  const [admin, tabatha] = await Promise.all([kvLire(env, 'role:admin'), kvLire(env, 'role:tabatha')]);
  return { admin: admin ?? null, tabatha: tabatha ?? null };
}
const roleDe = (r, chat) => (String(chat) === String(r.admin) ? 'sacha' : String(chat) === String(r.tabatha) ? 'tabatha' : null);

// callback_data est limité à 64 octets : au-delà (identifiant d'annonce très long), on passe par KV.
async function cb(env, prefixe, id) {
  const d = `${prefixe}:${id}`;
  if (new TextEncoder().encode(d).length <= 64) return d;
  const k = aleatoire();
  await kvEcrire(env, `cb:${k}`, d, TTL_CARTE);
  return `k:${k}`;
}

// --- Heure de Paris ----------------------------------------------------------------------------------
export function partiesParis(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { jour: `${p.year}-${p.month}-${p.day}`, heure: Number(p.hour), minute: Number(p.minute) };
}
// « 2026-10-05T18:30 » saisi à Paris → instant ISO (le Worker tourne en UTC).
export function parisVersISO(local) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) return null;
  const voulu = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]);
  let t = voulu;
  for (let i = 0; i < 2; i++) {
    const p = partiesParis(t);
    const [a, mo, j] = p.jour.split('-').map(Number);
    t += voulu - Date.UTC(a, mo - 1, j, p.heure, p.minute);
  }
  return new Date(t).toISOString();
}

// --- Cartes d'annonce ------------------------------------------------------------------------------------
function prixSuspect(l, c) {
  const ppm = l.price != null && l.surface ? l.price / l.surface : null;
  if (!ppm || !c.medianPpm) return false;
  return ppm < 0.65 * c.medianPpm || (['Leboncoin', 'Manuel'].includes(l.source) && l.pro === false && ppm < 0.8 * c.medianPpm);
}

export function texteCarte(l, c, n) {
  const etage = l.floor == null ? '' : l.floor === 0 ? ' · RDC' : ` · ${l.floor}${l.floor === 1 ? 'er' : 'e'} étage`;
  const tete = `<b>${n}. ${l.price != null ? eur(l.price) : '? €'}${l.surface ? ` · ${l.surface} m²` : ''}${l.rooms ? ` · ${l.rooms} p.` : ''}</b>${etage}`;
  const q = quartierDe(l);
  const lieu = q || l.arrondissement ? `📍 ${esc(q ?? 'Paris')}${l.arrondissement ? ` (${l.arrondissement}e)` : ''}` : '';
  const baisse = Array.isArray(l.price_history) && l.price_history.length > 1 && l.price_history.at(-1)[1] < l.price_history.at(-2)[1];
  const traits = [
    l.ok ? verdictScore(l.rangOk, l.totalOk).label : null,
    l.furnished === true ? 'meublé' : l.furnished === false ? 'non meublé' : null,
    l.dpe ? `DPE ${l.dpe}` : null,
    l.features?.balcon || l.features?.terrasse ? 'balcon' : null,
    l.elevator ? 'ascenseur' : null,
    baisse ? '📉 prix en baisse' : null,
    l.source,
  ].filter(Boolean);
  const alertes = [
    prixSuspect(l, c) ? 'prix très bas pour la surface : à vérifier avant de s’emballer' : null,
    ...(l.aVerifier ?? []),
  ].filter(Boolean);
  return [tete, lieu, `✨ ${esc(traits.join(' · '))}`, alertes.length ? `⚠️ ${esc(alertes.join(' ; '))}` : ''].filter(Boolean).join('\n');
}

async function claviersCarte(env, l, statut) {
  const lien = l.url ? [{ text: '🔗 Voir l’annonce', url: l.url }] : [];
  if (statut === 'fav') return { inline_keyboard: [[{ text: '♥ Gardée · annuler', callback_data: await cb(env, 's:0', l.id) }], lien].filter((r) => r.length) };
  if (statut === 'ecarte') return { inline_keyboard: [[{ text: '✕ Écartée · annuler', callback_data: await cb(env, 's:0', l.id) }], lien].filter((r) => r.length) };
  return { inline_keyboard: [[{ text: '♥ Garder', callback_data: await cb(env, 's:f', l.id) }, { text: '✕ Écarter', callback_data: await cb(env, 's:e', l.id) }], lien].filter((r) => r.length) };
}

async function envoyerCarte(env, chat, l, c, n) {
  const texte = texteCarte(l, c, n);
  const reply_markup = await claviersCarte(env, l, c.e.statut[l.id]);
  let r = l.photo ? await tg(env, 'sendPhoto', { chat_id: chat, photo: l.photo, caption: texte, parse_mode: 'HTML', reply_markup }) : null;
  if (!r?.ok) r = await envoyer(env, chat, texte, { reply_markup }); // photo tierce refusée : la carte part quand même
  if (r?.ok) await kvEcrire(env, `msg:${chat}:${r.result.message_id}`, l.id, TTL_CARTE);
  return r;
}

// --- Résumé des nouvelles annonces ---------------------------------------------------------------------------
/**
 * Envoie à `chat` les meilleures annonces visibles, non écartées/gardées et jamais envoyées.
 * marquer : les compter comme envoyées (vrai pour Tabatha ; faux quand Sacha prévisualise).
 */
export async function envoyerResume(env, o, chat, { marquer, moment = 'maintenant', silencieuxSiVide = false, maintenant = Date.now() }) {
  const c = construireContexte(await o.chargerDonnees(), maintenant);
  const deja = new Set((await kvLire(env, 'envoyes')) ?? []);
  const max = Math.max(1, Math.min(10, Number(env.TELEGRAM_MAX_PAR_RESUME) || 5));
  const choix = c.ok.filter((l) => !c.e.statut[l.id] && !deja.has(l.id)).slice(0, max);
  if (!choix.length) {
    if (!silencieuxSiVide) await envoyer(env, chat, 'Rien de neuf depuis le dernier envoi ✨ Je te préviens dès qu’une annonce tombe.');
    return [];
  }
  const s = choix.length > 1 ? 's' : '';
  const intro = { matin: `☀️ <b>${choix.length} nouvelle${s} annonce${s}</b> ce matin pour toi`, soir: `🌙 <b>${choix.length} nouvelle${s} annonce${s}</b> ce soir`, maintenant: `🍫 <b>${choix.length} annonce${s}</b> pas encore vue${s}` }[moment];
  await envoyer(env, chat, `${intro}\n<i>♥ pour garder, ✕ pour écarter, ou dis-moi ce que tu en penses (« la 2 me plaît », « trop cher »…).</i>${marquer ? '' : '\n<i>(aperçu : non compté comme envoyé)</i>'}`);
  for (const [i, l] of choix.entries()) await envoyerCarte(env, chat, l, c, i + 1);
  await kvEcrire(env, `dernier_envoi:${chat}`, choix.map((l, i) => `${i + 1}. réf ${l.id} — ${l.price != null ? eur(l.price) : '?'}${l.surface ? ` · ${l.surface} m²` : ''}${quartierDe(l) ? ` · ${quartierDe(l)}` : ''}`), TTL_HISTORIQUE);
  if (marquer) {
    await kvEcrire(env, 'envoyes', [...deja, ...choix.map((l) => l.id)].slice(-MAX_ENVOYES));
    await o.appendJournal({ kind: 'telegram_envoye', ids: choix.map((l) => l.id), moment });
  }
  return choix.map((l) => l.id);
}

// Appelée par le cron horaire du Worker : n'agit qu'aux heures prévues (heure de Paris), une fois par créneau.
export async function tacheHoraire(env, o, maintenant = Date.now()) {
  if (!env.TG || !env.TELEGRAM_BOT_TOKEN) return;
  const { jour, heure } = partiesParis(maintenant);
  const heures = String(env.TELEGRAM_HEURES || '9,19').split(',').map(Number);
  if (!heures.includes(heure)) return;
  const cle = `resume:${jour}-${heure}`;
  if (await kvLire(env, cle)) return;
  await kvEcrire(env, cle, 1, 2 * 86400);
  const r = await roles(env);
  const d = await o.chargerDonnees();
  // Données de plus de 12 h : la collecte semble à l'arrêt. On prévient Sacha (une fois par jour) plutôt que
  // d'envoyer à Tabatha un résumé sur des données mortes.
  const age = maintenant - Date.parse(d.meta?.generatedAt ?? 0);
  if (!(age < 12 * 36e5)) {
    if (r.admin && !(await kvLire(env, `alerte_collecte:${jour}`))) {
      await kvEcrire(env, `alerte_collecte:${jour}`, 1, 2 * 86400);
      await envoyer(env, r.admin, `⚠️ Résumé de ${heure} h non envoyé : la dernière collecte date de ${Number.isFinite(age) ? Math.round(age / 36e5) + ' h' : 'je ne sais quand'}. Le cron GitHub Actions est peut-être à l'arrêt.`);
    }
    return;
  }
  if (!r.tabatha) return;
  await envoyerResume(env, { ...o, chargerDonnees: async () => d }, r.tabatha, { marquer: true, moment: heure < 12 ? 'matin' : 'soir', silencieuxSiVide: true, maintenant });
}

// --- Propositions de l'agent → messages avec boutons -----------------------------------------------------------
export function resumeCriteres(avant, apres) {
  const a = mergeCriteria(avant);
  const b = mergeCriteria(apres);
  const arr = (x) => (x.length ? x.map((n) => `${n}e`).join(', ') : 'tout Paris');
  const lignes = [];
  if (a.budgetMax !== b.budgetMax) lignes.push(`budget max : ${eur(a.budgetMax)} → <b>${eur(b.budgetMax)}</b>`);
  if (a.surfaceMin !== b.surfaceMin) lignes.push(`surface min : ${a.surfaceMin} m² → <b>${b.surfaceMin} m²</b>`);
  if (a.piecesMin !== b.piecesMin) lignes.push(`pièces min : ${a.piecesMin} → <b>${b.piecesMin}</b>`);
  if (String(a.arrondissements) !== String(b.arrondissements)) lignes.push(`arrondissements : ${arr(a.arrondissements)} → <b>${arr(b.arrondissements)}</b>`);
  if (String(a.arrondissementsPref) !== String(b.arrondissementsPref)) lignes.push(`préférés : ${arr(b.arrondissementsPref)}`);
  if (a.meuble !== b.meuble) lignes.push(`meublé : ${a.meuble} → <b>${b.meuble}</b>`);
  for (const [k, lib] of [['rdc', 'exclure le RDC'], ['dpeFG', 'exclure DPE F/G'], ['coloc', 'exclure les colocs']]) {
    if (a.exclure[k] !== b.exclure[k]) lignes.push(`${lib} : <b>${b.exclure[k] ? 'oui' : 'non'}</b>`);
  }
  const poids = Object.keys(b.poids).filter((k) => a.poids[k] !== b.poids[k]);
  if (poids.length) lignes.push(`importance : ${poids.map((k) => `${esc(k)} ${a.poids[k]} → ${b.poids[k]}`).join(', ')}`);
  return lignes.length ? lignes.map((l) => `- ${l}`).join('\n') : '- (aucun changement visible)';
}

function texteProposition(p, criteresActuels) {
  switch (p.type) {
    case 'criteres': return `⚙️ <b>Nouveaux critères proposés</b>\n${resumeCriteres(criteresActuels, p.criteria)}`;
    case 'actions': return `📝 <b>Je te propose</b>\n${p.actions.map((x) => `- ${esc(x.libelle)}`).join('\n')}`;
    case 'ajout': return `➕ <b>Ajouter cette annonce</b>\n${esc(p.libelle)}`;
    case 'contact': return `📋 <b>Suivi</b> · ${esc(p.libelle)}\n→ ${STATUTS_LIBELLES[p.statut] ?? p.statut}${p.note ? ` : « ${esc(p.note)} »` : ''}${p.relance_jours ? `\n⏰ relance dans ${p.relance_jours} j` : ''}`;
    case 'visite': return `📅 <b>Visite</b> · ${esc(p.libelle)}\n${esc(new Date(parisVersISO(p.debut) ?? p.debut).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }))}${p.lieu ? `\n📍 ${esc(p.lieu)}` : ''}`;
    case 'message': return `✉️ <b>Brouillon de message</b> · ${esc(p.libelle)}${p.objet ? `\nObjet : ${esc(p.objet)}` : ''}\n<pre>${esc(p.message)}</pre>\n<i>Remplace les {{…}} par tes infos avant d’envoyer, ou copie-le depuis l’appli qui les remplit avec « Mon dossier ». C’est toi qui l’envoies.</i>`;
    default: return null;
  }
}

async function envoyerProposition(env, chat, p, criteresActuels) {
  const texte = texteProposition(p, criteresActuels);
  if (!texte) return;
  const k = aleatoire();
  await kvEcrire(env, `prop:${k}`, { chat: String(chat), p }, TTL_PROPOSITION);
  const boutons = p.type === 'message'
    ? [[...(p.lien ? [{ text: '🔗 Ouvrir l’annonce', url: p.lien }] : []), { text: '✔ J’ai envoyé', callback_data: `pa:${k}` }]]
    : [[{ text: '✔ Appliquer', callback_data: `pa:${k}` }, { text: 'Non merci', callback_data: `pn:${k}` }]];
  await envoyer(env, chat, texte, { reply_markup: { inline_keyboard: boutons } });
}

// Traduit une proposition validée en écritures de l'état partagé (mêmes actions que l'appli, cf. docs/js/chat.mjs).
async function appliquerProposition(env, o, p, criteresActuels) {
  const ecrire = (body) => o.traiterEtat({ kind: 'etat', canal: 'telegram', ...body });
  const verifier = (r) => { if (r.status !== 200) throw new Error(r.data?.error ?? `état ${r.status}`); };
  switch (p.type) {
    case 'criteres': {
      const diff = resumeCriteres(criteresActuels, p.criteria).split('\n').map((l) => l.replace(/<\/?b>/g, '').replace(/^- /, ''));
      verifier(await ecrire({ action: 'set_criteria', criteria: p.criteria, source: 'bot', diff }));
      return '✔ Critères mis à jour.';
    }
    case 'actions':
      for (const x of p.actions) {
        if (x.action === 'note') verifier(await ecrire({ action: 'set_note', id: x.id, texte: x.note, url: x.url, title: x.title }));
        else verifier(await ecrire({ action: 'set_statut', id: x.id, valeur: x.action === 'retirer_statut' ? null : x.action, url: x.url, title: x.title, price: x.price }));
      }
      return '✔ C’est fait.';
    case 'ajout':
      verifier(await ecrire({ action: 'ajouter_manuel', listing: p.listing, balcon: p.listing.balcon }));
      return '✔ Annonce ajoutée.';
    case 'message':
      verifier(await ecrire({ action: 'set_contact', id: p.id, statut: 'contacte', relance_jours: 3, canal: p.canal, url: p.lien }));
      return '✔ Noté comme contactée. Je te rappellerai de relancer dans 3 jours sans réponse.';
    case 'contact':
      verifier(await ecrire({ action: 'set_contact', id: p.id, statut: p.statut, note: p.note, relance_jours: p.relance_jours }));
      return '✔ Suivi enregistré.';
    case 'visite':
      verifier(await ecrire({ action: 'set_contact', id: p.id, statut: 'visite', visite: parisVersISO(p.debut), url: p.lien }));
      return '✔ Visite enregistrée (l’appli peut l’ajouter à ton calendrier).';
    default:
      throw new Error('proposition inconnue');
  }
}

// --- Messages d'accueil -----------------------------------------------------------------------------------------
const accueilTabatha = (env) =>
  'Coucou 🐱🎀 Je suis le bot de ta recherche d’appart.\n\n' +
  `• Vers ${String(env.TELEGRAM_HEURES || '9,19').split(',').map((h) => `${h.trim()} h`).join(' et ')}, je t’envoie les nouvelles annonces qui collent à tes critères : ♥ pour garder, ✕ pour écarter.\n` +
  '• Tu peux m’écrire normalement : « la 2 me plaît », « trop loin du métro », « monte mon budget à 950 », « rédige un message pour celle-là »…\n' +
  '• Je ne change rien sans ton accord : chaque proposition a un bouton « ✔ Appliquer ».\n\n' +
  '👀 <b>Sacha peut lire nos échanges</b>, comme dans le chat de l’appli. N’écris pas ici ton numéro, ton adresse ou tes revenus.\n\n' +
  `L’appli reste là pour les photos et les détails : ${esc(env.SITE_URL || 'https://szaouati.github.io/recherche-appart/')}\n` +
  '/nouveautes : les annonces pas encore vues, tout de suite.';

const accueilAdmin =
  '✔ Tu es l’administrateur de ce bot.\n\n' +
  'Demande à Tabatha d’envoyer /start au bot : tu recevras ici un bouton pour l’autoriser. Personne d’autre ne peut l’utiliser.\n\n' +
  '/nouveautes : aperçu de ce qu’elle recevrait (sans le compter comme envoyé).\n' +
  'Tu peux aussi discuter avec le bot pour tester : tes messages sont notés « sacha » dans le journal.';

// --- Point d'entrée du webhook ------------------------------------------------------------------------------------
/**
 * @param {object} update - mise à jour Telegram
 * @param {object} o - { traiterEtat(body), appendJournal(entry), chargerDonnees(), lireCriteres(), appelerModele }
 */
export async function traiterUpdate(env, o, update) {
  if (update?.update_id != null) {
    const cle = `upd:${update.update_id}`;
    if (await kvLire(env, cle)) return; // Telegram renvoie une mise à jour s'il n'a pas eu sa réponse à temps
    await kvEcrire(env, cle, 1, 3600);
  }
  if (update.callback_query) return traiterBouton(env, o, update.callback_query);
  const m = update.message;
  if (!m?.chat || m.chat.type !== 'private') return;
  const chat = String(m.chat.id);
  const texte = String(m.text ?? m.caption ?? '').trim();
  const r = await roles(env);
  let role = roleDe(r, chat);

  if (!role) {
    if (!/^\/start\b/.test(texte)) return; // inconnu : silence
    if (!r.admin) {
      await kvEcrire(env, 'role:admin', chat);
      return envoyer(env, chat, accueilAdmin);
    }
    if ((await kvLire(env, `refuse:${chat}`)) || (await kvLire(env, `attente:${chat}`))) return envoyer(env, chat, 'Ta demande est déjà transmise.');
    const qui = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') + (m.from?.username ? ` (@${m.from.username})` : '');
    await kvEcrire(env, `attente:${chat}`, qui, 7 * 86400);
    await envoyer(env, r.admin, `🔔 Demande d’accès au bot : <b>${esc(qui || 'inconnu')}</b>`, {
      reply_markup: { inline_keyboard: [[{ text: '✔ C’est Tabatha', callback_data: `ok:${chat}` }, { text: '✕ Refuser', callback_data: `no:${chat}` }]] },
    });
    return envoyer(env, chat, 'Ce bot est privé : je demande à Sacha de t’ouvrir l’accès 🐾');
  }

  if (/^\/start\b/.test(texte)) return envoyer(env, chat, role === 'sacha' ? accueilAdmin : accueilTabatha(env));
  if (/^\/(nouveautes|nouveautés|annonces)\b/i.test(texte)) return envoyerResume(env, o, chat, { marquer: role === 'tabatha' });
  if (/^\/aide\b/.test(texte)) return envoyer(env, chat, role === 'sacha' ? accueilAdmin : accueilTabatha(env));
  if (!texte) return envoyer(env, chat, 'Je ne lis que les messages écrits pour l’instant 🙈');
  return discuter(env, o, chat, role, texte.slice(0, 1500), m.reply_to_message?.message_id);
}

async function discuter(env, o, chat, role, texte, repondA) {
  await tg(env, 'sendChatAction', { chat_id: chat, action: 'typing' });
  // Contexte qui n'est pas dans l'historique : à quelle carte elle répond, et la dernière liste envoyée.
  const [carte, dernierEnvoi, historique, critData] = await Promise.all([
    repondA ? kvLire(env, `msg:${chat}:${repondA}`) : null,
    kvLire(env, `dernier_envoi:${chat}`),
    kvLire(env, `hist:${chat}`),
    o.lireCriteres(),
  ]);
  const prefixe = [
    dernierEnvoi?.length ? `[Contexte automatique — dernières annonces envoyées par le bot : ${dernierEnvoi.join(' ; ')}]` : null,
    carte ? `[Elle répond à la carte de l'annonce réf ${carte}]` : null,
  ].filter(Boolean).join('\n');
  const message = prefixe ? `${prefixe}\n\n${texte}` : texte;
  const criteres = mergeCriteria(critData ?? {});

  let resultat;
  try {
    resultat = await executerAgent({
      message, history: Array.isArray(historique) ? historique : [], criteresClient: criteres, canal: 'telegram',
      deps: { chargerDonnees: o.chargerDonnees, appelerModele: o.appelerModele },
    });
  } catch (e) {
    console.error('telegram: agent', e);
    return envoyer(env, chat, 'Je n’ai pas pu réfléchir à ta demande là 😿 Réessaie dans une minute.');
  }

  await envoyer(env, chat, versHtml(resultat.reply));
  for (const p of resultat.propositions) await envoyerProposition(env, chat, p, criteres);
  const hist = [...(Array.isArray(historique) ? historique : []), { role: 'user', content: texte }, { role: 'assistant', content: resultat.reply }].slice(-MAX_HISTORIQUE);
  await kvEcrire(env, `hist:${chat}`, hist, TTL_HISTORIQUE);
  await o.appendJournal({
    kind: 'chat', canal: 'telegram', qui: role, message: texte, reply: resultat.reply, proposal: resultat.proposal,
    propositions: resultat.propositions.map((p) => p.type), outils: resultat.outils, criteria: criteres,
  });
}

async function traiterBouton(env, o, q) {
  const chat = String(q.message?.chat?.id ?? q.from?.id ?? '');
  const mid = q.message?.message_id;
  const r = await roles(env);
  const role = roleDe(r, chat);
  const repondre = (text) => tg(env, 'answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text } : {}) });
  if (!role) return repondre('Accès non autorisé.');

  let data = String(q.data ?? '');
  if (data.startsWith('k:')) data = (await kvLire(env, `cb:${data.slice(2)}`)) ?? '';
  const [type, ...reste] = data.split(':');

  // Accès : réservé à l'administrateur.
  if (type === 'ok' || type === 'no') {
    if (role !== 'sacha') return repondre('Réservé à Sacha.');
    const cible = reste.join(':');
    if (type === 'ok') {
      await kvEcrire(env, 'role:tabatha', cible);
      await env.TG.delete(`attente:${cible}`);
      await envoyer(env, cible, accueilTabatha(env));
      await tg(env, 'editMessageText', { chat_id: chat, message_id: mid, text: '✔ Accès ouvert à Tabatha. Elle recevra les résumés aux heures prévues.' });
    } else {
      await kvEcrire(env, `refuse:${cible}`, 1, 30 * 86400);
      await env.TG.delete(`attente:${cible}`);
      await tg(env, 'editMessageText', { chat_id: chat, message_id: mid, text: '✕ Demande refusée.' });
    }
    return repondre();
  }

  // ♥ / ✕ / annuler sur une carte d'annonce.
  if (type === 's') {
    const [v, ...idParts] = reste;
    const id = idParts.join(':');
    const valeur = v === 'f' ? 'fav' : v === 'e' ? 'ecarte' : null;
    const res = await o.traiterEtat({ kind: 'etat', canal: 'telegram', action: 'set_statut', id, valeur });
    if (res.status !== 200) return repondre('Oups, pas enregistré. Réessaie.');
    const l = (res.data.manuel ?? []).find((x) => x.id === id) ?? { id, url: (q.message?.reply_markup?.inline_keyboard ?? []).flat().find((b) => b.url)?.url };
    await tg(env, 'editMessageReplyMarkup', { chat_id: chat, message_id: mid, reply_markup: await claviersCarte(env, l, valeur) });
    return repondre(valeur === 'fav' ? '♥ Gardée' : valeur === 'ecarte' ? '✕ Écartée' : '↩︎ Annulé');
  }

  // Proposition de l'agent : appliquer ou ignorer.
  if (type === 'pa' || type === 'pn') {
    const k = reste.join(':');
    const enAttente = await kvLire(env, `prop:${k}`);
    if (!enAttente || enAttente.chat !== chat) {
      await tg(env, 'editMessageReplyMarkup', { chat_id: chat, message_id: mid, reply_markup: { inline_keyboard: [] } });
      return repondre('Cette proposition a expiré : redemande-moi.');
    }
    await env.TG.delete(`prop:${k}`);
    let bilan = 'Ignoré.';
    if (type === 'pa') {
      try {
        bilan = await appliquerProposition(env, o, enAttente.p, mergeCriteria((await o.lireCriteres()) ?? {}));
      } catch (e) {
        console.error('telegram: application', e);
        await kvEcrire(env, `prop:${k}`, enAttente, TTL_PROPOSITION); // on la garde pour un nouvel essai
        return repondre('Oups, pas enregistré. Réessaie.');
      }
    }
    await tg(env, 'editMessageReplyMarkup', { chat_id: chat, message_id: mid, reply_markup: { inline_keyboard: [] } });
    await envoyer(env, chat, bilan, { reply_parameters: { message_id: mid, allow_sending_without_reply: true } });
    return repondre();
  }

  return repondre();
}

// --- Branchement du webhook (appelé une fois après déploiement) ---------------------------------------------------
// Sans risque même si quelqu'un d'autre l'appelle : il ne peut que re-pointer le bot vers CE Worker, avec la clé
// que seul ce Worker connaît. Ne renvoie aucune information sensible.
export async function configurerWebhook(env, origine) {
  const hook = await tg(env, 'setWebhook', {
    url: `${origine}/telegram`,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  await tg(env, 'setMyCommands', { commands: [{ command: 'nouveautes', description: 'Les annonces pas encore vues' }, { command: 'aide', description: 'Comment ça marche' }] });
  const moi = await tg(env, 'getMe', {});
  const r = env.TG ? await roles(env) : {};
  return { ok: Boolean(hook.ok), bot: moi.result?.username ? `@${moi.result.username}` : null, administrateur: Boolean(r.admin), tabatha: Boolean(r.tabatha) };
}
