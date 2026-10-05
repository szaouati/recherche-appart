import test from 'node:test';
import assert from 'node:assert/strict';
import { declencherCollecte, modeDuCreneau } from '../worker/src/declencheur.mjs';

// Octobre 2026 : Paris = UTC+2.
const paris = (hhmm) => Date.parse(`2026-10-05T${hhmm}:00+02:00`);

test('créneaux : quick de 7 h à 23 h, full à 5 h, rien la nuit', () => {
  assert.equal(modeDuCreneau(paris('07:00')), 'quick');
  assert.equal(modeDuCreneau(paris('22:30')), 'quick');
  assert.equal(modeDuCreneau(paris('23:00')), null);
  assert.equal(modeDuCreneau(paris('03:00')), null);
  assert.equal(modeDuCreneau(paris('05:00')), 'full');
  assert.equal(modeDuCreneau(paris('05:30')), null);
});

test('déclenche workflow_dispatch avec le bon mode et le jeton', async () => {
  const appels = [];
  const f = async (url, init) => { appels.push({ url, init }); return new Response(null, { status: 204 }); };
  const r = await declencherCollecte({ GITHUB_REPO: 'o/r', ACTIONS_TOKEN: 'tok' }, paris('12:00'), f);
  assert.deepEqual(r, { lance: true, mode: 'quick' });
  assert.equal(appels[0].url, 'https://api.github.com/repos/o/r/actions/workflows/collect.yml/dispatches');
  assert.equal(appels[0].init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(appels[0].init.body), { ref: 'main', inputs: { mode: 'quick' } });
});

test('sans jeton ou hors plage : aucun appel ; refus de GitHub : erreur lisible', async () => {
  const f = async () => { throw new Error('ne doit pas être appelé'); };
  assert.equal((await declencherCollecte({ GITHUB_REPO: 'o/r' }, paris('12:00'), f)).lance, false);
  assert.equal((await declencherCollecte({ GITHUB_REPO: 'o/r', GITHUB_TOKEN: 't' }, paris('02:00'), f)).lance, false);
  const refus = async () => new Response('Resource not accessible', { status: 403 });
  await assert.rejects(declencherCollecte({ GITHUB_REPO: 'o/r', GITHUB_TOKEN: 't' }, paris('12:00'), refus), /403/);
});
