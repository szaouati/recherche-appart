import test from 'node:test';
import assert from 'node:assert/strict';
import { PASTILLES, filtresVides, nbFiltres, passe, appliquer, compter, trier, bornes } from '../docs/js/filtres.mjs';

const A = { id: 'a', price: 700, surface: 20, floor: 3, elevator: true, furnished: true, dpe: 'C', features: { balcon: true }, photo: 'x', first_seen: '2026-09-20', publishedAt: '2026-09-20' };
const B = { id: 'b', price: 850, surface: 35, floor: 0, elevator: false, furnished: false, dpe: 'E', features: {}, first_seen: '2026-09-22', publishedAt: '2026-09-22' };
const C = { id: 'c', price: null, surface: null, floor: null, features: {}, first_seen: '2026-09-21' };
const liste = [A, B, C];
const F = (o = {}) => ({ ...filtresVides(), ...o });
const ctx = { contacts: { a: { statut: 'contacte' } } };

test('sans filtre, tout passe et l\'ordre est conservé', () => {
  assert.deepEqual(appliquer(liste, F(), ctx).map((l) => l.id), ['a', 'b', 'c']);
  assert.equal(nbFiltres(F()), 0);
});
test('une donnée absente ne satisfait jamais un filtre', () => {
  assert.deepEqual(appliquer(liste, F({ actifs: new Set(['ascenseur']) }), ctx).map((l) => l.id), ['a']);
  assert.deepEqual(appliquer(liste, F({ prixMax: 800 }), ctx).map((l) => l.id), ['a']);
  assert.deepEqual(appliquer(liste, F({ surfaceMin: 10 }), ctx).map((l) => l.id), ['a', 'b']);
  assert.deepEqual(appliquer(liste, F({ etageMin: 1 }), ctx).map((l) => l.id), ['a']);
});
test('filtres combinés (ET) et compte de filtres actifs', () => {
  const f = F({ actifs: new Set(['meuble', 'balcon']), prixMax: 900 });
  assert.deepEqual(appliquer(liste, f, ctx).map((l) => l.id), ['a']);
  assert.equal(nbFiltres(f), 3);
});
test('pastille « pas encore contactée » lit le suivi partagé', () => {
  assert.deepEqual(appliquer(liste, F({ actifs: new Set(['nonContacte']) }), ctx).map((l) => l.id), ['b', 'c']);
});
test('compteur d\'une pastille : tient compte des AUTRES filtres seulement', () => {
  const f = F({ actifs: new Set(['meuble']) });
  assert.equal(compter(liste, f, ctx, 'meuble'), 1); // ne se compte pas deux fois
  assert.equal(compter(liste, f, ctx, 'balcon'), 1); // meublé ET balcon
  assert.equal(compter(liste, f, ctx, 'photo'), 1);
  assert.equal(compter(liste, F({ prixMax: 100 }), ctx, 'balcon'), 0);
});
test('passe(sauf) ignore un filtre précis', () => {
  const f = F({ actifs: new Set(['ascenseur']) });
  assert.equal(passe(B, f, ctx), false);
  assert.equal(passe(B, f, ctx, 'ascenseur'), true);
});
test('tris : les valeurs inconnues vont à la fin, sans perdre d\'annonce', () => {
  assert.deepEqual(trier(liste, F({ tri: 'prix' })).map((l) => l.id), ['a', 'b', 'c']);
  assert.deepEqual(trier(liste, F({ tri: 'prix-desc' })).map((l) => l.id), ['b', 'a', 'c']);
  assert.deepEqual(trier(liste, F({ tri: 'surface' })).map((l) => l.id), ['b', 'a', 'c']);
  assert.deepEqual(trier(liste, F({ tri: 'recent' })).map((l) => l.id), ['b', 'c', 'a']);
  assert.deepEqual(trier(liste, F({ tri: 'prixm2' })).map((l) => l.id), ['b', 'a', 'c']);
  assert.equal(trier(liste, F({ tri: 'inconnu' })), liste);
});
test('bornes des curseurs : arrondies, jamais en dessous du budget', () => {
  const b = bornes(liste, 900);
  assert.equal(b.prixMin, 700); assert.equal(b.prixMax, 900); assert.equal(b.surfMax, 35);
  assert.deepEqual(bornes([], 900), { prixMin: 0, prixMax: 900, surfMax: 60 });
});
test('chaque pastille a une clé unique et un libellé', () => {
  assert.equal(new Set(PASTILLES.map((p) => p.k)).size, PASTILLES.length);
  assert.ok(PASTILLES.every((p) => p.t && typeof p.test === 'function'));
});
