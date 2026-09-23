// Moteur de filtrage + score, partagé entre le site (navigateur) et le bot (Node).
// Une seule implémentation : le site et l'alerte Telegram classent donc toujours pareil.

// Valeurs de base = les derniers critères réels que Tabatha a transmis (22/09/2026 : 18e, ≤ 900 €,
// studio à partir de 10 m²), pas des valeurs génériques. Elles servent de repli (mergeCriteria) et de
// point de départ pour tout appareil qui n'a encore rien en mémoire locale — donc aussi pour ceux qui
// ne consultent le site que ponctuellement (ex. Sacha) sans avoir synchronisé ses réglages à elle.
// À maintenir à jour à la main si ses critères changent durablement (docs/criteria.json reste la
// source de vérité pour le bot ; ceci n'est que le filet de sécurité du code).
export const DEFAULT_CRITERIA = {
  budgetMax: 900, // € / mois, charges comprises
  surfaceMin: 10, // m²
  piecesMin: 1,
  arrondissements: [18],
  arrondissementsPref: [18],
  meuble: 'indifferent', // 'oui' | 'non' | 'indifferent'
  exclure: { rdc: true, dpeFG: true, coloc: true },
  poids: {
    prix: 3,
    prixM2: 2,
    surface: 2,
    arrondissementsPref: 2,
    balcon: 3,
    ascenseur: 2,
    etageEleve: 2,
    dpe: 2,
    lumineux: 2,
    calme: 1,
    traversant: 1,
    cave: 1,
    parking: 0,
    parquet: 1,
  },
  alerteActive: true,
  alerteScoreMin: 45,
};

// Libellés affichés dans le site pour chaque critère pondéré.
export const CRITERES = [
  ['prix', 'Prix bas (vs budget)'],
  ['prixM2', 'Prix au m² sous la médiane'],
  ['surface', 'Surface au-dessus du minimum'],
  ['arrondissementsPref', 'Arrondissement préféré'],
  ['balcon', 'Balcon / terrasse'],
  ['ascenseur', 'Ascenseur'],
  ['etageEleve', 'Étage élevé'],
  ['dpe', 'Bon DPE (A-C)'],
  ['lumineux', 'Lumineux'],
  ['calme', 'Calme'],
  ['traversant', 'Traversant'],
  ['cave', 'Cave'],
  ['parking', 'Parking'],
  ['parquet', 'Parquet'],
];

const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

export function mergeCriteria(c = {}) {
  return {
    ...DEFAULT_CRITERIA,
    ...c,
    exclure: { ...DEFAULT_CRITERIA.exclure, ...(c.exclure || {}) },
    poids: { ...DEFAULT_CRITERIA.poids, ...(c.poids || {}) },
  };
}

// --- Filtres stricts -------------------------------------------------------
// Une donnée absente ne disqualifie pas : l'annonce reste, marquée « à vérifier ».
export function checkHard(l, c) {
  const rejets = [];
  const aVerifier = [];

  if (l.price != null && l.price > c.budgetMax) rejets.push(`Loyer ${l.price} € > budget ${c.budgetMax} €`);
  if (l.surface != null) {
    if (l.surface < c.surfaceMin) rejets.push(`Surface ${l.surface} m² < ${c.surfaceMin} m²`);
  } else aVerifier.push('surface');
  if (l.rooms != null && l.rooms < c.piecesMin) rejets.push(`${l.rooms} pièce(s) < ${c.piecesMin}`);
  if (c.arrondissements.length && l.arrondissement != null && !c.arrondissements.includes(l.arrondissement))
    rejets.push(`Paris ${l.arrondissement}e hors zone`);

  if (c.meuble !== 'indifferent') {
    if (l.furnished == null) aVerifier.push('meublé');
    else if ((c.meuble === 'oui') !== l.furnished) rejets.push(l.furnished ? 'Meublé' : 'Non meublé');
  }
  if (c.exclure.rdc && (l.floor === 0 || l.features?.rdc)) rejets.push('Rez-de-chaussée');
  if (c.exclure.dpeFG && ['F', 'G'].includes(l.dpe)) rejets.push(`DPE ${l.dpe}`);
  if (c.exclure.coloc && (l.features?.coloc || l.features?.sousLocation)) rejets.push('Colocation / sous-location');

  return { ok: rejets.length === 0, rejets, aVerifier };
}

// --- Score pondéré 0-100 ---------------------------------------------------
// Chaque critère vaut 0..1 ; ce qui n'apparaît pas dans l'annonce vaut 0 (on ne devine pas).
// score = 100 × Σ(poids × valeur) / Σ(poids)
const COMPOSANTS = {
  prix: (l, c) => (l.price == null ? null : clamp((c.budgetMax - l.price) / (c.budgetMax * 0.3))),
  prixM2: (l, c, ctx) => {
    const ppm = l.price != null && l.surface ? l.price / l.surface : null;
    if (ppm == null || !ctx.medianPpm) return null;
    return clamp(0.5 + (ctx.medianPpm - ppm) / ctx.medianPpm);
  },
  surface: (l, c) => (l.surface == null ? null : clamp((l.surface - c.surfaceMin) / (c.surfaceMin * 0.5))),
  arrondissementsPref: (l, c) => (l.arrondissement == null ? null : c.arrondissementsPref.includes(l.arrondissement) ? 1 : 0),
  balcon: (l) => (l.features?.balcon || l.features?.terrasse ? 1 : 0),
  ascenseur: (l) => (l.elevator === true ? 1 : l.floor != null && l.floor <= 2 ? 0.5 : l.elevator == null ? null : 0),
  etageEleve: (l) => (l.floor == null ? null : l.floor >= 4 ? 1 : l.floor === 3 ? 0.7 : l.floor === 2 ? 0.4 : 0),
  dpe: (l) => (l.dpe == null ? null : { A: 1, B: 1, C: 0.8, D: 0.5, E: 0.2 }[l.dpe] ?? 0),
  lumineux: (l) => (l.features?.lumineux ? 1 : 0),
  calme: (l) => (l.features?.calme ? 1 : 0),
  traversant: (l) => (l.features?.traversant ? 1 : 0),
  cave: (l) => (l.features?.cave ? 1 : 0),
  parking: (l) => (l.features?.parking ? 1 : 0),
  parquet: (l) => (l.features?.parquet ? 1 : 0),
};

export function scoreListing(l, c, ctx = {}) {
  let num = 0;
  let den = 0;
  const detail = [];
  for (const [cle, label] of CRITERES) {
    const w = c.poids[cle] || 0;
    if (!w) continue;
    if (cle === 'arrondissementsPref' && !c.arrondissementsPref.length) continue;
    const v = COMPOSANTS[cle](l, c, ctx);
    den += w;
    num += w * (v ?? 0);
    detail.push({ cle, label, poids: w, valeur: v, points: 0 });
  }
  for (const d of detail) d.points = den ? Math.round((100 * d.poids * (d.valeur ?? 0)) / den) : 0;
  return { score: den ? Math.round((100 * num) / den) : 0, detail };
}

// --- Classement ------------------------------------------------------------
export function median(xs) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function rankListings(listings, criteria) {
  const c = mergeCriteria(criteria);
  const hard = listings.map((l) => ({ l, h: checkHard(l, c) }));
  const retenues = hard.filter((x) => x.h.ok);
  const medianPpm = median(retenues.filter((x) => x.l.price != null && x.l.surface).map((x) => x.l.price / x.l.surface));
  const ctx = { medianPpm };

  const out = hard.map(({ l, h }) => ({ ...l, ...h, ...(h.ok ? scoreListing(l, c, ctx) : { score: null, detail: [] }) }));
  out.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || String(b.first_seen).localeCompare(String(a.first_seen)));

  // Rang parmi les annonces retenues (0 = meilleure), pour un avis relatif au marché disponible
  // plutôt qu'à une note absolue : une même annonce peut être « sa meilleure option » dans un
  // marché tendu (18e, petit budget) sans pour autant afficher un score brut impressionnant.
  let i = 0;
  const totalOk = out.filter((l) => l.ok).length;
  for (const l of out) if (l.ok) { l.rangOk = i++; l.totalOk = totalOk; }

  return { c, ctx, listings: out };
}

// --- Avis en clair, relatif au reste du lot retenu (pas une note abstraite) -----------------
// rang : position parmi les annonces retenues (0 = meilleure). total : nombre d'annonces retenues.
export function verdictScore(rang, total) {
  if (rang == null || total == null || total <= 0) return { tier: 'bas', icone: '·', label: 'Ne correspond pas' };
  if (total <= 1) return { tier: 'haut', icone: '♥', label: 'Lui correspond bien' };
  if (rang === 0) return { tier: 'haut', icone: '✦', label: 'Sa meilleure option pour l’instant' };
  const p = rang / (total - 1);
  if (p <= 0.15) return { tier: 'haut', icone: '♥', label: 'Lui correspond très bien' };
  if (p <= 0.45) return { tier: 'moyen', icone: '◆', label: 'Un bon compromis' };
  if (p <= 0.75) return { tier: 'moyen', icone: '–', label: 'Passable pour elle' };
  return { tier: 'bas', icone: '·', label: 'Assez loin de ses critères' };
}
