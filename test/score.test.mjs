import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCriteria, checkHard, scoreListing, rankListings } from '../docs/score.mjs';
import { extractFeatures } from '../collector/lib/features.mjs';

const c = mergeCriteria({ budgetMax: 1500, surfaceMin: 30, piecesMin: 2 });
const base = { id: 'a', price: 1200, surface: 40, rooms: 2, floor: 4, elevator: true, dpe: 'C', arrondissement: 11, features: { balcon: true, lumineux: true }, first_seen: '2026-09-21' };

test('filtre : budget dépassé', () => {
  const r = checkHard({ ...base, price: 1600 }, c);
  assert.equal(r.ok, false);
  assert.match(r.rejets[0], /budget/);
});
test('filtre : surface inconnue → gardée mais à vérifier', () => {
  const r = checkHard({ ...base, surface: null }, c);
  assert.equal(r.ok, true);
  assert.deepEqual(r.aVerifier, ['surface']);
});
test('filtre : RDC et DPE G écartés par défaut', () => {
  assert.equal(checkHard({ ...base, floor: 0 }, c).ok, false);
  assert.equal(checkHard({ ...base, dpe: 'G' }, c).ok, false);
});
test('filtre : arrondissements autorisés', () => {
  const c2 = mergeCriteria({ arrondissements: [10, 11] });
  assert.equal(checkHard({ ...base, arrondissement: 11 }, c2).ok, true);
  assert.equal(checkHard({ ...base, arrondissement: 16 }, c2).ok, false);
});
test('score : borné 0-100, et meilleur avec balcon+ascenseur', () => {
  const bon = scoreListing(base, c, { medianPpm: 35 }).score;
  const nu = scoreListing({ ...base, features: {}, elevator: false, floor: 1, dpe: 'E' }, c, { medianPpm: 35 }).score;
  assert.ok(bon > nu && bon <= 100 && nu >= 0);
});
test('score : poids à 0 = critère ignoré', () => {
  const sans = mergeCriteria({ poids: { balcon: 0 } });
  const a = scoreListing(base, sans, {});
  assert.ok(!a.detail.some((d) => d.cle === 'balcon'));
});
test('classement : les rejetées n\'ont pas de score et passent en dernier', () => {
  const { listings } = rankListings([{ ...base, id: 'x', price: 9999 }, base], c);
  assert.equal(listings[0].id, 'a');
  assert.equal(listings[1].score, null);
});
test('features : négation et accents', () => {
  assert.equal(extractFeatures('Studio', 'Sans balcon, pas d\'ascenseur').balcon, undefined);
  assert.equal(extractFeatures('Studio', 'Grand balcon exposé sud, très LUMINEUX').balcon, true);
  assert.equal(extractFeatures('Studio', 'Sous-location interdite selon le bail').sousLocation, undefined);
  assert.equal(extractFeatures('Chambre en colocation', '').coloc, true);
});
