// Fonctions pures d'affichage d'une annonce (testées dans test/annonce-ui.test.mjs) : le vocabulaire
// commun aux cartes, à la page détail et, plus tard, au comparateur.

/** Source affichée : les imports manuels (PDF/e-mail) gardent la vraie source dans l'URL de l'annonce. */
export function sourceAffichee(l) {
  const u = String(l.url ?? '');
  if (/leboncoin\.fr/i.test(u)) return 'Leboncoin';
  if (/seloger\.com/i.test(u)) return 'SeLoger';
  if (/pap\.fr/i.test(u)) return 'PAP';
  if (/bienici\.com/i.test(u)) return "Bien'ici";
  return l.source === 'Manuel' ? 'Ajout manuel' : (l.source || '');
}

/** Quartier lisible : celui de l'API, sinon la fin d'un titre généré « Source — prix — quartier », sinon l'arrondissement. */
export function quartier(l) {
  if (l.district) return l.district;
  const parts = String(l.title ?? '').split(' — ');
  if (parts.length >= 3) {
    const q = parts.slice(2).join(' — ').replace(/\s*\(.*$/, '').trim();
    if (q && !/^détails? non/i.test(q) && !/^étage/i.test(q)) return q;
  }
  return l.arrondissement ? `Paris ${l.arrondissement}e` : 'Paris';
}

export function typeLogement(l) {
  if (l.rooms === 1 || (!l.rooms && l.surface && l.surface < 30)) return 'Studio';
  if (l.rooms) return `${l.rooms} pièces`;
  return 'Logement';
}

export const etageLibelle = (l) => (l.floor == null ? null : l.floor === 0 ? 'RDC' : l.floor === 1 ? '1er étage' : `${l.floor}e étage`);
export const prixM2 = (l) => (l.price != null && l.surface ? Math.round(l.price / l.surface) : null);
export const surfaceLibelle = (l) => (l.surface ? `${String(l.surface).replace('.', ',')} m²` : null);

/** Ligne d'infos sous le prix : type · étage · €/m² (sans trous, sans doublon avec la tuile de surface). */
export function ligneInfos(l) {
  const ppm = prixM2(l);
  return [typeLogement(l), etageLibelle(l), ppm ? `${ppm} €/m²` : null].filter(Boolean).join(' · ');
}

/** Baisse de prix récente (en €) ou 0. */
export function baissePrix(l) {
  const h = l.price_history;
  return h && h.length > 1 && h.at(-1)[1] < h.at(-2)[1] ? h.at(-2)[1] - h.at(-1)[1] : 0;
}

/** Petite variation de teinte, stable par annonce, pour la tuile de remplacement (évite un mur uniforme). */
export function teinte(l) {
  const s = `${l.arrondissement ?? ''}${quartier(l)}`;
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 41;
  return h - 20;
}

/** Badges d'équipement, dans l'ordre d'affichage. Renvoie [{k, t}] (k = clé de style). */
export function badgesEquipements(l) {
  const b = [];
  if (l.furnished === true) b.push({ k: 'meuble', t: 'Meublé' });
  if (l.features?.balcon) b.push({ k: 'balcon', t: 'Balcon' });
  if (l.features?.terrasse) b.push({ k: 'terrasse', t: 'Terrasse' });
  if (l.elevator) b.push({ k: 'ascenseur', t: 'Ascenseur' });
  if (l.dpe) b.push({ k: 'dpe', t: `DPE ${l.dpe}` });
  for (const [k, t] of [['lumineux', 'Lumineux'], ['calme', 'Calme'], ['traversant', 'Traversant'], ['cave', 'Cave'], ['parking', 'Parking'], ['parquet', 'Parquet']]) if (l.features?.[k]) b.push({ k, t });
  return b;
}
