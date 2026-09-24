// Prépare le lot d'annonces que Sacha doit relire avant Tabatha → docs/data/avis-lot.json (page docs/avis.html).
// Usage : node scripts/avis/make-lot.mjs [--exclude=id1,id2,…]   (ids déjà relus par Sacha, à ne pas remontrer)
import fs from 'node:fs';
import { rankListings } from '../../docs/score.mjs';

const exclus = new Set((process.argv.find((a) => a.startsWith('--exclude=')) || '').replace('--exclude=', '').split(',').filter(Boolean));
const d = JSON.parse(fs.readFileSync('docs/data/listings.json', 'utf8'));
const e = JSON.parse(fs.readFileSync('docs/data/etat.json', 'utf8'));
const crit = JSON.parse(fs.readFileSync('docs/criteria.json', 'utf8'));
const lastFull = d.meta.lastFullAt;
// Même définition d'« annonce visible » que le site (docs/app.js, actives()).
const SOURCES_EMAIL = ['SeLoger', 'Leboncoin', 'PAP'];
const actives = (l) => l.source === 'Manuel' || (!l.dupOf && !l.retire && (SOURCES_EMAIL.includes(l.source)
  ? Date.now() - new Date(l.last_seen).getTime() < 10 * 864e5
  : !lastFull || new Date(l.last_seen) > new Date(new Date(lastFull).getTime() - 48 * 36e5)));
const { listings } = rankListings([...e.manuel, ...d.listings], crit);
const lot = listings.filter((l) => l.ok && actives(l) && !exclus.has(l.id) && e.statut[l.id] !== 'ecarte');

const indice = (l) => {
  const h = [];
  if (l.url?.includes('classified-search') || l.url?.includes('/recherche?')) h.push("le lien ouvre une page de RECHERCHE, pas l'annonce elle-même");
  if (l.surface == null) h.push("détails non chargés dans l'export : à ouvrir pour vérifier");
  if (/bail étudiant/i.test(l.title || '')) h.push('bail étudiant 9 mois (pas un bail classique)');
  return h;
};
const items = lot.map((l) => ({
  id: l.id, source: l.source, price: l.price, surface: l.surface, rooms: l.rooms, floor: l.floor, dpe: l.dpe || null,
  url: l.url, title: l.title || null, score: l.score, hints: indice(l),
}));
fs.writeFileSync('docs/data/avis-lot.json', JSON.stringify({ genereLe: new Date().toISOString(), items }));
console.log(`${items.length} annonces à relire → docs/data/avis-lot.json`);
