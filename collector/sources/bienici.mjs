// Source : API JSON publique utilisée par le site bienici.com (agrège de nombreux réseaux d'agences).
// Non documentée officiellement : le format peut changer. Si c'est le cas, le statut de la source
// passe à « erreur » sur le site et dans le journal de l'Action, sans casser les autres sources.

import { extractFeatures } from '../lib/features.mjs';

const API = 'https://www.bienici.com/realEstateAds.json';
const PARIS_ZONE_ID = '-7444';
const PAGE = 100;
const MAX_PAGES = 24; // offset max ~2 400 accepté par l'API
// L'API renvoie des dizaines de milliers d'annonces fantômes (publicationDate = 1970). Comme le tri est
// par date décroissante, on s'arrête dès qu'une page atteint des annonces plus vieilles que ça.
const MAX_AGE_JOURS = 75;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arrondissement(cp, titre) {
  const n = Number(cp);
  if (n === 75116) return 16;
  if (n >= 75001 && n <= 75020) return n - 75000;
  // Certaines annonces n'ont pas de code postal : repli sur « PARIS 19ème » dans le titre.
  const m = /paris\s*(\d{1,2})\s*(?:e|è|ème|eme|er)\b/i.exec(titre ?? '');
  return m && +m[1] >= 1 && +m[1] <= 20 ? +m[1] : null;
}

export function normalise(a) {
  const dpe = /^[A-G]$/.test(a.energyClassification ?? '') ? a.energyClassification : null;
  const photo = a.photos?.[0]?.url_photo || a.photos?.[0]?.url || null;
  return {
    id: `bienici:${a.id}`,
    source: "Bien'ici",
    url: `https://www.bienici.com/annonce/${a.id}`,
    title: a.title ?? null,
    price: a.price ?? null, // loyer charges comprises
    rent: a.rentWithoutCharges ?? null,
    charges: a.charges ?? null,
    surface: a.surfaceArea ?? null,
    rooms: a.roomsQuantity ?? null,
    floor: a.floor ?? null,
    elevator: a.hasElevator ?? null,
    furnished: a.isFurnished ?? null,
    postalCode: a.postalCode ?? null,
    arrondissement: arrondissement(a.postalCode, a.title),
    district: a.district?.libelle ?? null,
    photo,
    dpe,
    agencyFee: a.agencyRentalFee ?? null,
    deposit: a.safetyDeposit ?? null,
    pro: a.adCreatedByPro ?? null,
    availableDate: a.availableDate ?? null,
    publishedAt: a.publicationDate ?? null,
    description: (a.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 320),
    features: extractFeatures(a.title, a.description),
  };
}

async function fetchPage(criteria, minPrice, maxPrice, from) {
  const filters = {
    size: PAGE,
    from,
    showAllModels: false,
    filterType: 'rent',
    propertyType: ['flat'],
    minPrice,
    maxPrice,
    minArea: criteria.surfaceMin,
    zoneIdsByTypes: { zoneIds: [PARIS_ZONE_ID] },
    sortBy: 'publicationDate',
    sortOrder: 'desc',
  };
  const res = await fetch(`${API}?${new URLSearchParams({ filters: JSON.stringify(filters) })}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; recherche-appart-perso/1.0)', Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} (prix ${minPrice}-${maxPrice} €, offset ${from})`);
  const ads = (await res.json()).realEstateAds;
  if (!Array.isArray(ads)) throw new Error('format de réponse inattendu (realEstateAds absent)');
  return ads;
}

// Parcourt une tranche de prix. L'API plafonne l'offset (~2 400) : si une tranche est plus dense,
// on la coupe en deux et on recommence, de sorte qu'aucune annonce n'est ignorée.
async function fetchBand(criteria, min, max, acc, { pages, log }) {
  for (let p = 0; p < pages; p++) {
    const ads = await fetchPage(criteria, min, max, p * PAGE);
    // Le filtre de zone garantit Paris (departmentCode est parfois absent : on ne s'en sert pas).
    const recentes = ads.filter((a) => Date.parse(a.publicationDate) > Date.now() - MAX_AGE_JOURS * 864e5);
    for (const a of recentes) acc.set(a.id, normalise(a));
    if (ads.length < PAGE || recentes.length < ads.length) return; // fin, ou début des annonces périmées
    await sleep(300);
  }
  if (pages === MAX_PAGES && max - min >= 2) {
    const mid = Math.floor((min + max) / 2);
    log(`  tranche ${min}-${max} € saturée, découpage`);
    await fetchBand(criteria, min, mid, acc, { pages, log });
    await fetchBand(criteria, mid, max, acc, { pages, log });
  }
}

/**
 * mode 'quick' : les ~500 annonces les plus récentes (détecte les nouveautés, ~5 requêtes).
 * mode 'full'  : tout le marché sous le budget, par tranches de 100 € contiguës (les loyers décimaux, ex. 999,50 €, ne tombent pas entre deux tranches ; rafraîchit prix et disponibilité).
 * Une tranche en échec n'annule pas les autres : on renvoie le partiel avec des avertissements.
 */
export async function fetchBienici(criteria, { mode = 'full', log = console.log } = {}) {
  const acc = new Map();
  const warnings = [];
  const tranches = [];
  if (mode === 'quick') tranches.push({ min: 0, max: criteria.budgetMax, pages: 5 });
  else for (let min = 0; min < criteria.budgetMax; min += 100) tranches.push({ min, max: Math.min(min + 100, criteria.budgetMax), pages: MAX_PAGES });

  for (const t of tranches) {
    try {
      await fetchBand(criteria, t.min, t.max, acc, { pages: t.pages, log });
      log(`  ${t.min}-${t.max} € : ${acc.size} annonces cumulées`);
    } catch (e) {
      warnings.push(e.message);
      log(`  ✗ ${e.message}`);
    }
  }
  if (acc.size === 0 && warnings.length) throw new Error(warnings[0]);
  return { items: [...acc.values()], warnings };
}

// --- Vérification ciblée de disponibilité -------------------------------------------------------
// Piège découvert le 23/09/2026 : une annonce peut rester dans les résultats de RECHERCHE de Bien'ici
// (realEstateAds.json, utilisé pour la collecte) plusieurs semaines après avoir été retirée par
// l'agence — leur index de recherche n'est pas synchronisé avec la fiche individuelle. Le champ
// `status.onTheMarket` de l'API de recherche est lui-même toujours à `false`, y compris pour des
// annonces fraîches (inutilisable). Seule l'API de FICHE (realEstateAd.json?id=...) donne un signal
// fiable et à jour — vérifié à la main sur une annonce retirée (false) et une toute fraîche (true).
// Coûteux à grande échelle (un appel par annonce) : on ne vérifie donc que les mieux classées,
// c'est-à-dire celles qu'elle verrait réellement (voir l'appel dans collect.mjs).
export async function verifierDisponibilite(id) {
  const res = await fetch(`https://www.bienici.com/realEstateAd.json?id=${encodeURIComponent(id)}&filters=%7B%7D`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; recherche-appart-perso/1.0)' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null; // on ne sait pas → on ne touche pas à l'annonce, par prudence
  const data = await res.json().catch(() => null);
  return typeof data?.status?.onTheMarket === 'boolean' ? data.status.onTheMarket : null;
}
