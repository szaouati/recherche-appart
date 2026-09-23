import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.mjs';

// Faux GitHub : un petit dépôt en mémoire, avec sha qui change à chaque écriture et une capacité à
// simuler un conflit d'écriture (409) pour vérifier le retry-once du Worker.
function creerEnvDeTest() {
  const fichiers = new Map();
  let compteurSha = 0;
  let conflitSimule = 0;
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const db64 = (s) => Buffer.from(s, 'base64').toString('utf8');

  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.hostname !== 'api.github.com') throw new Error('fetch non simulé : ' + url);
    const path = decodeURIComponent(u.pathname.split('/contents/')[1]);
    if (!opts.method || opts.method === 'GET') {
      const f = fichiers.get(path);
      if (!f) return { status: 404, ok: false, json: async () => ({}) };
      return { status: 200, ok: true, json: async () => ({ sha: f.sha, content: b64(JSON.stringify(f.content)) }) };
    }
    if (opts.method === 'PUT') {
      if (conflitSimule > 0) { conflitSimule--; return { status: 409, ok: false, text: async () => 'conflict' }; }
      const body = JSON.parse(opts.body);
      const f = fichiers.get(path);
      if (f && body.sha !== f.sha) return { status: 409, ok: false, text: async () => 'sha mismatch' };
      const sha = `sha${++compteurSha}`;
      fichiers.set(path, { sha, content: JSON.parse(db64(body.content)) });
      return { status: 200, ok: true, text: async () => 'ok' };
    }
    throw new Error('méthode non simulée');
  };

  const env = {
    ALLOWED_ORIGINS: 'https://example.test',
    APP_TOKEN: 'tok123',
    GITHUB_REPO: 'x/y',
    GITHUB_TOKEN: 'ghp_fake',
    JOURNAL_PATH: 'docs/data/journal.json',
    CRITERIA_PATH: 'docs/criteria.json',
    ETAT_PATH: 'docs/data/etat.json',
    RATE_LIMITER: { limit: async () => ({ success: true }) },
  };
  const ctx = { waitUntil: (p) => p };
  const HEADERS = { Origin: 'https://example.test', 'X-App-Token': 'tok123', 'Content-Type': 'application/json' };

  return {
    fichiers,
    definirConflit: (n) => { conflitSimule = n; },
    async post(body) {
      const req = new Request('https://worker.test/', { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
      const res = await worker.fetch(req, env, ctx);
      return { status: res.status, body: await res.json() };
    },
    async get(path) {
      const req = new Request(`https://worker.test${path}`, { method: 'GET', headers: HEADERS });
      const res = await worker.fetch(req, env, ctx);
      return { status: res.status, body: await res.json() };
    },
    async requeteBrute(headers) {
      const req = new Request('https://worker.test/etat', { method: 'GET', headers });
      return worker.fetch(req, env, ctx);
    },
  };
}

const CRITERES_VALIDES = { budgetMax: 900, surfaceMin: 10, piecesMin: 1, arrondissements: [18], arrondissementsPref: [18], meuble: 'indifferent', exclure: { rdc: true, dpeFG: true, coloc: true }, poids: {}, alerteActive: true, alerteScoreMin: 45 };

test('GET /etat : fichier absent → forme vide propre, pas une erreur', async () => {
  const env = creerEnvDeTest();
  env.fichiers.set('docs/criteria.json', { sha: 'sha0', content: CRITERES_VALIDES });
  const r = await env.get('/etat');
  assert.equal(r.status, 200);
  assert.equal(r.body.criteria.budgetMax, 900);
  assert.deepEqual(r.body.statut, {});
  assert.deepEqual(r.body.manuel, []);
});

test('set_statut : applique, journalise, et ne journalise pas quand on retire', async () => {
  const env = creerEnvDeTest();
  env.fichiers.set('docs/criteria.json', { sha: 'sha0', content: CRITERES_VALIDES });
  const r = await env.post({ kind: 'etat', action: 'set_statut', id: 'a', valeur: 'fav', criteria: {} });
  assert.equal(r.body.statut.a, 'fav');
  assert.equal(env.fichiers.get('docs/data/journal.json').content.entries.at(-1).type, 'fav');

  const avant = env.fichiers.get('docs/data/journal.json').content.entries.length;
  const r2 = await env.post({ kind: 'etat', action: 'set_statut', id: 'a', valeur: null, criteria: {} });
  assert.equal(r2.body.statut.a, undefined);
  assert.equal(env.fichiers.get('docs/data/journal.json').content.entries.length, avant, 'retirer un statut ne doit pas journaliser');
});

test('set_vu : monotone, ne recule jamais', async () => {
  const env = creerEnvDeTest();
  env.fichiers.set('docs/criteria.json', { sha: 'sha0', content: CRITERES_VALIDES });
  await env.post({ kind: 'etat', action: 'set_vu', ts: '2026-09-23T12:00:00.000Z' });
  const r = await env.post({ kind: 'etat', action: 'set_vu', ts: '2026-09-23T10:00:00.000Z' });
  assert.equal(r.body.vuJusqua, '2026-09-23T12:00:00.000Z');
});

test('ajouter_manuel : id/horodatages régénérés côté serveur, jamais ceux du navigateur', async () => {
  const env = creerEnvDeTest();
  env.fichiers.set('docs/criteria.json', { sha: 'sha0', content: CRITERES_VALIDES });
  const r = await env.post({ kind: 'etat', action: 'ajouter_manuel', listing: { url: 'https://x', title: 'T', price: 850, id: 'FAUX_ID_CLIENT' }, criteria: {} });
  assert.equal(r.body.manuel.length, 1);
  assert.notEqual(r.body.manuel[0].id, 'FAUX_ID_CLIENT');
  assert.match(r.body.manuel[0].id, /^manuel:/);
  assert.equal(r.body.manuel[0].price, 850);
});

test('set_criteria : clampe aux bornes du schéma et écrit dans criteria.json (fichier séparé de etat.json)', async () => {
  const env = creerEnvDeTest();
  env.fichiers.set('docs/criteria.json', { sha: 'sha0', content: CRITERES_VALIDES });
  const r = await env.post({ kind: 'etat', action: 'set_criteria', criteria: { ...CRITERES_VALIDES, budgetMax: 999999 }, source: 'panel' });
  assert.equal(r.body.criteria.budgetMax, 5000);
  assert.equal(env.fichiers.get('docs/criteria.json').content.budgetMax, 5000);
});

test('conflit d\'écriture (409) : relit et réessaie une fois, sans perdre les autres données', async () => {
  const env = creerEnvDeTest();
  env.fichiers.set('docs/criteria.json', { sha: 'sha0', content: CRITERES_VALIDES });
  await env.post({ kind: 'etat', action: 'set_note', id: 'a', texte: 'déjà là', criteria: {} });
  env.definirConflit(1);
  const r = await env.post({ kind: 'etat', action: 'set_statut', id: 'b', valeur: 'ecarte', criteria: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.statut.b, 'ecarte');
  assert.equal(r.body.notes.a, 'déjà là', 'les données écrites avant le conflit ne doivent pas disparaître');
});

test('origine non autorisée et jeton invalide sont rejetés', async () => {
  const env = creerEnvDeTest();
  const r1 = await env.requeteBrute({ Origin: 'https://evil.test', 'X-App-Token': 'tok123' });
  assert.equal(r1.status, 403);
  const r2 = await env.requeteBrute({ Origin: 'https://example.test', 'X-App-Token': 'MAUVAIS' });
  assert.equal(r2.status, 401);
});
