// État du site : critères, favoris/écartées, notes, contacts, annonces manuelles.
// UN SEUL « compte » pour tous les appareils : tout vit sur le Worker (qui l'écrit dans le dépôt) ; les clés
// *Cache du localStorage ne sont qu'un cache d'appoint (affichage instantané, repli hors-ligne) — la vérité
// vient toujours de GET /etat. Ne jamais réintroduire localStorage comme source de vérité.
// D'anciennes clés (avant le 23/09/2026 : criteria/manuel/statut/vuJusqua/notes) servaient de seul stockage par
// appareil ; on les reprend une fois si le cache est vide, pour ne rien perdre, puis on les laisse orphelines.
import { mergeCriteria, rankListings, estVisible } from '../score.mjs';
import { store } from './util.mjs';

export const S = {
  criteria: mergeCriteria(store.get('criteriaCache', store.get('criteria', {}))),
  base: [], // annonces du collecteur
  meta: {},
  manuel: store.get('manuelCache', store.get('manuel', [])),
  statut: store.get('statutCache', store.get('statut', {})), // id -> 'fav' | 'ecarte'
  notes: store.get('notesCache', store.get('notes', {})), // id -> texte libre (partagé avec Sacha via le journal)
  contacts: store.get('contactsCache', {}), // id -> { statut, maj, relance, visite, note, canal }
  vuJusqua: store.get('vuJusquaCache', store.get('vuJusqua', new Date(Date.now() - 864e5).toISOString())),
  config: {}, // docs/config.json : { botUrl, botToken }
  ranked: [],
  charge: false, // vrai une fois listings.json (ou son échec) traité
  erreurChargement: false,
};

let etatSnapshot = null;
const ecouteurs = new Set();
export const surChangement = (fn) => { ecouteurs.add(fn); return () => ecouteurs.delete(fn); };

export const toutes = () => [...S.manuel, ...S.base];
export const visible = (l) => estVisible(l, S.meta);
export const annonceParId = (id) => S.ranked.find((x) => x.id === id) || S.manuel.find((x) => x.id === id);

export function calculer() { S.ranked = rankListings(toutes(), S.criteria).listings; }
/** Recalcule le classement puis prévient les vues. motif : 'local' (changement immédiat), 'etat' (réponse du Worker / autre appareil), 'charge'. */
export function emit(motif = 'etat') {
  calculer();
  for (const fn of ecouteurs) fn(motif);
}

function sauverCacheLocal() {
  store.set('criteriaCache', S.criteria);
  store.set('manuelCache', S.manuel);
  store.set('statutCache', S.statut);
  store.set('vuJusquaCache', S.vuJusqua);
  store.set('notesCache', S.notes);
  store.set('contactsCache', S.contacts);
}
export const sauverCriteresCache = () => store.set('criteriaCache', S.criteria);

const chaineEtat = (etat) => JSON.stringify([etat.criteria, etat.statut, etat.notes, etat.manuel, etat.vuJusqua, etat.contacts]);
function adopterEtat(etat) {
  S.criteria = mergeCriteria(etat.criteria || {});
  S.statut = etat.statut && typeof etat.statut === 'object' ? etat.statut : {};
  S.notes = etat.notes && typeof etat.notes === 'object' ? etat.notes : {};
  S.manuel = Array.isArray(etat.manuel) ? etat.manuel : [];
  S.vuJusqua = etat.vuJusqua || S.vuJusqua;
  S.contacts = etat.contacts && typeof etat.contacts === 'object' ? etat.contacts : {};
  sauverCacheLocal();
}

const configure = () => S.config.botUrl && S.config.botToken;

async function chargerEtatPartage() {
  if (!configure()) return null;
  const r = await fetch(`${S.config.botUrl}/etat`, { headers: { 'X-App-Token': S.config.botToken } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Envoie un changement (fav/écarte, note, critères, ajout manuel, vu, contact) : appliqué tout de suite en local
// pour rester réactif, puis au Worker qui fait foi — sa réponse remplace l'état local, ce qui règle de lui-même
// le cas de deux appareils modifiant la même chose presque en même temps.
export async function appliquerEtat(action, params = {}) {
  if (action === 'set_statut') { if (params.valeur) S.statut[params.id] = params.valeur; else delete S.statut[params.id]; }
  else if (action === 'set_note') { if (params.texte) S.notes[params.id] = params.texte; else delete S.notes[params.id]; }
  else if (action === 'set_vu') { if (!S.vuJusqua || params.ts > S.vuJusqua) S.vuJusqua = params.ts; }
  else if (action === 'ajouter_manuel') { S.manuel.unshift(params.listing); }
  else if (action === 'set_criteria') { S.criteria = mergeCriteria(params.criteria); }
  else if (action === 'set_contact') {
    if (!params.statut) delete S.contacts[params.id];
    else S.contacts[params.id] = { ...(S.contacts[params.id] || {}), statut: params.statut, maj: new Date().toISOString(), relance: params.relance_jours ? new Date(Date.now() + params.relance_jours * 864e5).toISOString() : (['reponse', 'refuse', 'sans_suite', 'visite'].includes(params.statut) ? null : S.contacts[params.id]?.relance ?? null) };
  }
  sauverCacheLocal();
  emit('local');
  if (!configure()) return;
  try {
    const r = await fetch(`${S.config.botUrl}/etat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Token': S.config.botToken },
      body: JSON.stringify({ kind: 'etat', action, ...params, criteria: S.criteria }),
    });
    const etat = await r.json().catch(() => null);
    if (r.ok && etat && !etat.error) {
      adopterEtat(etat);
      etatSnapshot = chaineEtat(etat);
      emit('etat');
    }
  } catch {
    // best-effort : le changement reste appliqué en local, la prochaine synchro le réconciliera
  }
}

// Migration ponctuelle : si CET appareil avait déjà des favoris/notes/annonces manuelles (ancien stockage 100 %
// local) et que l'état partagé est encore vierge, on les pousse une fois vers le Worker plutôt que de les laisser
// disparaître. Si l'état partagé a déjà du contenu, c'est lui qui fait foi.
async function migrerVersEtatPartage(etatServeur) {
  const localVide = !Object.keys(S.statut).length && !Object.keys(S.notes).length && !S.manuel.length;
  const serveurVide = !Object.keys(etatServeur.statut || {}).length && !Object.keys(etatServeur.notes || {}).length && !(etatServeur.manuel || []).length;
  if (localVide || !serveurVide) return false;
  // Chaque appliquerEtat() adopte la réponse (encore partielle en pleine migration) : on fige d'abord une copie.
  const statutInitial = { ...S.statut };
  const notesInitiales = { ...S.notes };
  const manuelInitial = [...S.manuel];
  for (const [id, valeur] of Object.entries(statutInitial)) await appliquerEtat('set_statut', { id, valeur });
  for (const [id, texte] of Object.entries(notesInitiales)) await appliquerEtat('set_note', { id, texte });
  for (const listing of manuelInitial.reverse()) await appliquerEtat('ajouter_manuel', { listing }); // reverse : unshift restaure l'ordre
  return true;
}

export async function synchroniserEtat({ silencieux = false } = {}) {
  try {
    const etat = await chargerEtatPartage();
    if (!etat) return;
    const nouveau = chaineEtat(etat);
    if (nouveau === etatSnapshot) return; // rien de changé ailleurs depuis la dernière fois
    adopterEtat(etat);
    etatSnapshot = nouveau;
    emit('etat');
  } catch (e) {
    if (!silencieux) console.error('Synchronisation impossible', e);
  }
}

/** Journal partagé : chaque signal utile part vers Sacha, en silence (best-effort). */
export async function envoyerEvenement(type, payload) {
  if (!configure()) return;
  try {
    await fetch(S.config.botUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Token': S.config.botToken },
      body: JSON.stringify({ kind: 'event', type, payload, criteria: S.criteria }),
    });
  } catch {
    // un journal qui rate une fois ne doit jamais gêner son usage du site
  }
}

/** Chargement initial : config, annonces du collecteur et état partagé (en parallèle). */
export async function chargerTout() {
  // Il faut le jeton du Worker avant d'aller chercher l'état partagé : on l'attend ici, contrairement à listings.json.
  S.config = await fetch('config.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  try {
    const [d, etat] = await Promise.all([
      fetch(`data/listings.json?t=${Date.now()}`).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
      chargerEtatPartage().catch((e) => { console.error('État partagé indisponible, on repart du cache local', e); return null; }),
    ]);
    S.base = d.listings;
    S.meta = d.meta;
    if (etat) {
      const migre = await migrerVersEtatPartage(etat);
      const definitif = migre ? await chargerEtatPartage() : etat;
      adopterEtat(definitif);
      etatSnapshot = chaineEtat(definitif);
    } else if (!store.get('criteriaCache', null) && !store.get('criteria', null)) {
      // Ni état partagé joignable, ni aucun cache local (tout premier appareil, hors-ligne) : repli sur la base
      // publiée dans le dépôt pour ne pas rester sur des critères par défaut absurdes.
      const c = await fetch('criteria.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (c) S.criteria = mergeCriteria(c);
    }
  } catch {
    S.erreurChargement = true;
  }
  S.charge = true;
  emit('charge');
}

/** Resynchronisation régulière pendant que l'onglet est visible, et tout de suite en y revenant. */
export function demarrerSynchro() {
  setInterval(() => { if (document.visibilityState === 'visible') synchroniserEtat({ silencieux: true }); }, 25_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') synchroniserEtat({ silencieux: true }); });
  // Safari restaure très souvent un onglet depuis son cache mémoire (bfcache) sans requête réseau : « pageshow »
  // avec persisted=true est le seul signal fiable de ce cas précis (retour sur l'appli) → resynchronisation immédiate.
  window.addEventListener('pageshow', (e) => { if (e.persisted) synchroniserEtat({ silencieux: true }); });
}
