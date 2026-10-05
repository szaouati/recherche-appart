import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmerParJumelle, estJumelle } from '../collector/lib/jumeaux.mjs';
import { estVisible } from '../docs/score.mjs';

const NOW = '2026-10-05T12:00:00.000Z';
const REF = Date.parse(NOW);
const bi = (o = {}) => ({ id: 'bienici:a', source: "Bien'ici", price: 800, surface: 20, rooms: 1, arrondissement: 18, last_seen: NOW, url: 'https://www.bienici.com/annonce/a', ...o });
const em = (o = {}) => ({ id: 'pap:1', source: 'PAP', price: 800, surface: 20.5, rooms: 1, arrondissement: 18, last_seen: '2026-09-25T00:00:00.000Z', ...o });
const base = (...ls) => new Map(ls.map((l) => [l.id, l]));

test('jumelle : prix identique, surface à 1 m², même arrondissement', () => {
  assert.ok(estJumelle(em(), bi()));
  assert.ok(!estJumelle(em({ price: 810 }), bi()));
  assert.ok(!estJumelle(em({ surface: 22 }), bi()));
  assert.ok(!estJumelle(em({ arrondissement: 17 }), bi()));
  assert.ok(!estJumelle(em({ rooms: 2 }), bi()));
  assert.ok(estJumelle(em({ rooms: null }), bi()));
  assert.ok(!estJumelle(em({ surface: null }), bi()));
});

test('annonce d\'e-mail confirmée par une jumelle Bien\'ici vivante, puis retirée si elle disparaît', () => {
  const k = base(bi(), em());
  assert.deepEqual(confirmerParJumelle(k, REF, NOW), { confirmees: 1, retirees: 0 });
  const e = k.get('pap:1');
  assert.equal(e.jumeau, 'bienici:a');
  assert.equal(estVisible(e, {}, REF), true, 'confirmée : visible malgré 10 jours');

  k.get('bienici:a').retire = true;
  assert.deepEqual(confirmerParJumelle(k, REF, NOW), { confirmees: 0, retirees: 1 });
  assert.equal(e.retire, true);
  assert.equal(estVisible(e, {}, REF), false);

  delete k.get('bienici:a').retire; // la jumelle revient : l'annonce aussi
  confirmerParJumelle(k, REF, NOW);
  assert.equal(e.retire, undefined);
});

test('jumelle périmée (> 48 h) ou doublon : pas de confirmation', () => {
  const k = base(bi({ last_seen: '2026-10-01T00:00:00.000Z' }), em());
  assert.deepEqual(confirmerParJumelle(k, REF, NOW), { confirmees: 0, retirees: 0 });
});

test('sans jumelle : visible 3 jours seulement', () => {
  const frais = em({ last_seen: '2026-10-04T00:00:00.000Z' });
  assert.equal(estVisible(frais, {}, REF), true);
  assert.equal(estVisible(em(), {}, REF), false);
});

test('une annonce manuelle n\'est jamais touchée', () => {
  const k = base(bi(), em({ id: 'm:1', source: 'Manuel', jumeau: 'x' }));
  confirmerParJumelle(k, REF, NOW);
  assert.equal(k.get('m:1').retire, undefined);
});
