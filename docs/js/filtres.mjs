// Filtres et tri d'AFFICHAGE de la liste d'annonces (fonctions pures, testées dans test/filtres.test.mjs).
// Ce ne sont PAS les critères de recherche : ceux-là sont partagés, écrits par le Worker et appliqués par score.mjs.
// Ici on ne fait que resserrer ce qui est déjà retenu, sur cet appareil, le temps de la session (rien n'est sauvegardé,
// pour qu'un filtre oublié ne cache jamais silencieusement des annonces au prochain lancement).
// Une donnée absente ne satisfait jamais un filtre (« Ascenseur » ne garde que les annonces où l'ascenseur est connu).
import { baissePrix, prixM2 } from './annonce-ui.mjs';

const feat = (k) => (l) => !!l.features?.[k];
export const PASTILLES = [
  { k: 'meuble', t: 'Meublé', test: (l) => l.furnished === true },
  { k: 'balcon', t: 'Balcon / terrasse', test: (l) => !!(l.features?.balcon || l.features?.terrasse) },
  { k: 'ascenseur', t: 'Ascenseur', test: (l) => l.elevator === true },
  { k: 'dpe', t: 'Bon DPE (A–C)', test: (l) => ['A', 'B', 'C'].includes(l.dpe) },
  { k: 'baisse', t: 'Baisse de prix', test: (l) => baissePrix(l) > 0 },
  { k: 'nonContacte', t: 'Pas encore contactée', test: (l, ctx) => !ctx.contacts?.[l.id] },
  { k: 'photo', t: 'Avec photo', test: (l) => !!l.photo },
  // Réservées à la feuille « Filtres » (peu utiles en raccourci) :
  { k: 'lumineux', t: 'Lumineux', test: feat('lumineux'), extra: true },
  { k: 'calme', t: 'Calme', test: feat('calme'), extra: true },
  { k: 'traversant', t: 'Traversant', test: feat('traversant'), extra: true },
  { k: 'cave', t: 'Cave', test: feat('cave'), extra: true },
  { k: 'parquet', t: 'Parquet', test: feat('parquet'), extra: true },
];
const parCle = Object.fromEntries(PASTILLES.map((p) => [p.k, p]));

export const TRIS = [
  ['pertinence', 'Pertinence'], ['prix', 'Prix croissant'], ['prix-desc', 'Prix décroissant'],
  ['surface', 'Surface décroissante'], ['prixm2', 'Prix au m² croissant'], ['recent', 'Plus récentes'],
];

export const filtresVides = () => ({ actifs: new Set(), prixMax: null, surfaceMin: null, etageMin: null, tri: 'pertinence' });

/** Nombre de filtres actifs (hors tri) : pastilles cochées + bornes posées. */
export const nbFiltres = (F) => F.actifs.size + (F.prixMax != null) + (F.surfaceMin != null) + (F.etageMin != null);

function passeBornes(l, F) {
  if (F.prixMax != null && !(l.price != null && l.price <= F.prixMax)) return false;
  if (F.surfaceMin != null && !(l.surface != null && l.surface >= F.surfaceMin)) return false;
  if (F.etageMin != null && !(l.floor != null && l.floor >= F.etageMin)) return false;
  return true;
}

/** `sauf` : ignore ce filtre-là (pour compter « combien y aurait-il si je l'activais » sans le compter deux fois). */
export function passe(l, F, ctx = {}, sauf = null) {
  if (!passeBornes(l, F)) return false;
  for (const k of F.actifs) if (k !== sauf && !parCle[k]?.test(l, ctx)) return false;
  return true;
}
export const appliquer = (liste, F, ctx = {}) => liste.filter((l) => passe(l, F, ctx));

/** Nombre d'annonces affichées si la pastille `k` est (ou reste) active, les autres filtres restant en place. */
export const compter = (liste, F, ctx, k) => liste.filter((l) => passe(l, F, ctx, k) && parCle[k].test(l, ctx)).length;

const nul = (x, dir) => (x == null ? (dir === 'asc' ? Infinity : -Infinity) : x);
const date = (l) => new Date(l.publishedAt ?? l.first_seen ?? 0).getTime();
export function trier(liste, F) {
  const t = F.tri;
  if (t === 'pertinence') return liste; // déjà classée par score (rankListings)
  const cle = { prix: (l) => nul(l.price, 'asc'), 'prix-desc': (l) => -nul(l.price, 'desc'), surface: (l) => -nul(l.surface, 'desc'), prixm2: (l) => nul(prixM2(l), 'asc'), recent: (l) => -date(l) }[t];
  if (!cle) return liste;
  return [...liste].sort((a, b) => cle(a) - cle(b)); // tri stable : à égalité, l'ordre de pertinence est conservé
}

/** Bornes utiles aux curseurs de la feuille, d'après la liste courante (avant filtres). */
export function bornes(liste, budgetMax) {
  const prix = liste.map((l) => l.price).filter((x) => x != null);
  const surf = liste.map((l) => l.surface).filter((x) => x != null);
  const arrondi = (x, pas, f) => f(x / pas) * pas;
  return {
    prixMin: prix.length ? Math.max(0, arrondi(Math.min(...prix), 25, Math.floor)) : 0,
    prixMax: prix.length ? arrondi(Math.max(...prix, budgetMax ?? 0), 25, Math.ceil) : budgetMax ?? 1500,
    surfMax: surf.length ? Math.ceil(Math.max(...surf)) : 60,
  };
}
