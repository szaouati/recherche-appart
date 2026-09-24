// Génère les deux maquettes autonomes (design/maquette-a-vanille.html et maquette-b-bordeaux.html)
// avec de vraies annonces tirées de docs/data. Usage : node design/build-maquettes.mjs
import fs from 'node:fs';
import { mergeCriteria, rankListings, verdictScore, estVisible } from '../docs/score.mjs';

const lire = (p) => JSON.parse(fs.readFileSync(new URL(`../${p}`, import.meta.url)));
const d = lire('docs/data/listings.json');
const e = lire('docs/data/etat.json');
const c = mergeCriteria(lire('docs/criteria.json'));

const source = (l) => (/leboncoin/.test(l.url) ? 'Leboncoin' : /seloger/.test(l.url) ? 'SeLoger' : /pap\.fr/.test(l.url) ? 'PAP' : l.source);
const quartier = (l) => l.district || (l.title || '').split(' — ').slice(2).join(' — ').replace(/\s*\(.*$/, '').trim() || null;
const type = (l) => (l.rooms === 1 || (!l.rooms && l.surface && l.surface < 30) ? 'Studio' : l.rooms ? `${l.rooms} pièces` : 'Logement');

const tous = rankListings([...e.manuel, ...d.listings], c).listings;
const visibles = tous.filter((l) => l.ok && estVisible(l, d.meta));
// Quelques annonces AVEC photo (hors critères de budget) pour montrer l'autre variante de carte : indiqué dans la maquette.
const avecPhoto = tous.filter((l) => l.photo && !visibles.includes(l) && l.arrondissement === 18 && l.price <= 1100 && !l.dupOf).slice(0, 3);

const choisies = [visibles.find((l) => l.photo), ...visibles.filter((l) => !l.photo).slice(0, 7), ...avecPhoto].filter(Boolean);
const donnees = choisies.map((l) => {
  const v = visibles.includes(l) ? verdictScore(l.rangOk, l.totalOk) : { tier: 'moyen', icone: '◆', label: 'Hors budget (exemple avec photo)' };
  const h = l.price_history;
  return {
    id: l.id, src: source(l), url: l.url, prix: l.price, surface: l.surface, pieces: l.rooms, arr: l.arrondissement, etage: l.floor,
    quartier: quartier(l), titre: type(l), photo: l.photo || null, dpe: l.dpe, meuble: l.furnished, ascenseur: l.elevator,
    balcon: !!(l.features?.balcon || l.features?.terrasse), vu: l.first_seen, verdict: v, score: l.score,
    detail: (l.detail || []).filter((x) => x.poids).slice(0, 6).map((x) => ({ label: x.label, v: x.valeur })),
    baisse: h && h.length > 1 && h.at(-1)[1] < h.at(-2)[1] ? h.at(-2)[1] - h.at(-1)[1] : 0,
    nouveau: l.first_seen > e.vuJusqua && l.source !== 'Manuel',
    exemple: !visibles.includes(l),
  };
});
const contexte = { total: visibles.length, nouveautes: visibles.filter((l) => l.first_seen > e.vuJusqua).length, budget: c.budgetMax, surfaceMin: c.surfaceMin, zone: 'Paris 18e' };

const moteur = fs.readFileSync(new URL('./moteur-maquette.js', import.meta.url), 'utf8');
for (const [nom, titre] of [['a-vanille', 'Direction A · Vanille'], ['b-bordeaux', 'Direction B · Bordeaux']]) {
  const css = fs.readFileSync(new URL(`./maquette-${nom}.css`, import.meta.url), 'utf8');
  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Maquette — ${titre}</title><meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>${css}</style></head>
<body data-direction="${nom}"><div id="app"></div>
<script>window.DONNEES=${JSON.stringify(donnees)};window.CTX=${JSON.stringify(contexte)};</script>
<script>${moteur}</script></body></html>`;
  fs.writeFileSync(new URL(`./maquette-${nom}.html`, import.meta.url), html);
}
console.log(`${donnees.length} annonces (${donnees.filter((x) => x.photo).length} avec photo) → design/maquette-*.html`);
