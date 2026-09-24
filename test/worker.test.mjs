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

  let modeleScripte = null;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.hostname === 'api.anthropic.com') {
      if (!modeleScripte) throw new Error('Anthropic non scripté');
      const corps = JSON.parse(opts.body);
      const contenu = modeleScripte(corps);
      return new Response(JSON.stringify({ content: contenu, stop_reason: contenu.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' }), { status: 200 });
    }
    if (u.hostname !== 'api.github.com') throw new Error('fetch non simulé : ' + url);
    const path = decodeURIComponent(u.pathname.split('/contents/')[1]);
    if (!opts.method || opts.method === 'GET') {
      const f = fichiers.get(path);
      if (!f) return { status: 404, ok: false, json: async () => ({}) };
      if (/raw/.test(opts.headers?.Accept ?? '')) return { status: 200, ok: true, json: async () => f.content };
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
  // Le Worker ne fait pas attendre sa réponse par les écritures de journal en tâche de fond
  // (ctx.waitUntil) : ici on les capture et on les attend nous-mêmes avant de rendre la main, pour
  // qu'un test ne « fuite » jamais une écriture en cours dans globalThis.fetch du test suivant.
  const enCours = [];
  const ctx = { waitUntil: (p) => { enCours.push(p); } };
  const HEADERS = { Origin: 'https://example.test', 'X-App-Token': 'tok123', 'Content-Type': 'application/json' };

  return {
    fichiers,
    definirConflit: (n) => { conflitSimule = n; },
    definirModele: (fn) => { modeleScripte = fn; },
    env,
    async post(body) {
      const req = new Request('https://worker.test/', { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
      const res = await worker.fetch(req, env, ctx);
      await Promise.all(enCours.splice(0));
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

test('modifier_manuel : corrige un champ (ex. url) d\'une annonce déjà ajoutée, sans toucher aux autres', async () => {
  const env = creerEnvDeTest();
  env.fichiers.set('docs/criteria.json', { sha: 'sha0', content: CRITERES_VALIDES });
  const ajout = await env.post({ kind: 'etat', action: 'ajouter_manuel', listing: { url: 'https://leboncoin.fr/recherche?x', title: 'T', price: 800 }, criteria: {} });
  const id = ajout.body.manuel[0].id;
  const r = await env.post({ kind: 'etat', action: 'modifier_manuel', id, patch: { url: 'https://leboncoin.fr/ad/locations/1234567.htm' } });
  assert.equal(r.body.manuel[0].url, 'https://leboncoin.fr/ad/locations/1234567.htm');
  assert.equal(r.body.manuel[0].price, 800, 'les autres champs restent inchangés');
});

test('supprimer_manuel : retire l\'annonce et ses favoris/notes, sans toucher aux autres', async () => {
  const env = creerEnvDeTest();
  env.fichiers.set('docs/criteria.json', { sha: 'sha0', content: CRITERES_VALIDES });
  const a = await env.post({ kind: 'etat', action: 'ajouter_manuel', listing: { url: 'https://x/a', price: 700 }, criteria: {} });
  const b = await env.post({ kind: 'etat', action: 'ajouter_manuel', listing: { url: 'https://x/b', price: 800 }, criteria: {} });
  const idA = a.body.manuel[0].id;
  const idB = b.body.manuel[0].id;
  await env.post({ kind: 'etat', action: 'set_statut', id: idA, valeur: 'fav', criteria: {} });
  await env.post({ kind: 'etat', action: 'set_note', id: idA, texte: 'à visiter', criteria: {} });
  const r = await env.post({ kind: 'etat', action: 'supprimer_manuel', id: idA });
  assert.deepEqual(r.body.manuel.map((x) => x.id), [idB]);
  assert.equal(r.body.statut[idA], undefined);
  assert.equal(r.body.notes[idA], undefined);
});

test('supprimer_manuel : mémorise la clé de l\'annonce dans `rejetes` (pour que l\'e-mail ne la ramène pas)', async () => {
  const env = creerEnvDeTest();
  env.fichiers.set('docs/criteria.json', { sha: 'sha0', content: CRITERES_VALIDES });
  const a = await env.post({ kind: 'etat', action: 'ajouter_manuel', listing: { url: 'https://www.leboncoin.fr/ad/locations/3275598896', price: 750 }, criteria: {} });
  const r = await env.post({ kind: 'etat', action: 'supprimer_manuel', id: a.body.manuel[0].id });
  assert.deepEqual(r.body.rejetes, ['lbc:3275598896']);
});

test('supprimer_manuel : id inconnu → 404', async () => {
  const env = creerEnvDeTest();
  env.fichiers.set('docs/criteria.json', { sha: 'sha0', content: CRITERES_VALIDES });
  const r = await env.post({ kind: 'etat', action: 'supprimer_manuel', id: 'manuel:inexistant' });
  assert.equal(r.status, 404);
});

test('modifier_manuel : id inconnu → 404, n\'écrit rien', async () => {
  const env = creerEnvDeTest();
  env.fichiers.set('docs/criteria.json', { sha: 'sha0', content: CRITERES_VALIDES });
  const r = await env.post({ kind: 'etat', action: 'modifier_manuel', id: 'manuel:inexistant', patch: { url: 'https://x' } });
  assert.equal(r.status, 404);
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

// ---- Suivi de contact ---------------------------------------------------------------------------------
test('set_contact : enregistre le statut avec une relance, journalise, et le retire avec statut null', async () => {
  const env = creerEnvDeTest();
  env.fichiers.set('docs/criteria.json', { sha: 'sha0', content: CRITERES_VALIDES });
  const r = await env.post({ kind: 'etat', action: 'set_contact', id: 'manuel:1', statut: 'contacte', note: 'Message envoyé sur Leboncoin', relance_jours: 3, canal: 'messagerie_annonce', url: 'https://x', criteria: {} });
  const c = r.body.contacts['manuel:1'];
  assert.equal(c.statut, 'contacte');
  assert.equal(c.canal, 'messagerie_annonce');
  const jours = (Date.parse(c.relance) - Date.now()) / 864e5;
  assert.ok(jours > 2.9 && jours < 3.1, 'relance à J+3');
  const j = env.fichiers.get('docs/data/journal.json').content.entries.at(-1);
  assert.equal(j.type, 'contact');
  assert.equal(j.payload.statut, 'contacte');
  assert.ok(!JSON.stringify(j).includes('Message envoyé'), 'la note (potentiellement personnelle) ne va pas au journal public');

  const r2 = await env.post({ kind: 'etat', action: 'set_contact', id: 'manuel:1', statut: null, criteria: {} });
  assert.equal(r2.body.contacts['manuel:1'], undefined);
});

test('set_contact : un statut inconnu vaut « retirer » ; une visite fixe la date sans relance', async () => {
  const env = creerEnvDeTest();
  env.fichiers.set('docs/criteria.json', { sha: 'sha0', content: CRITERES_VALIDES });
  await env.post({ kind: 'etat', action: 'set_contact', id: 'a', statut: 'contacte', relance_jours: 2, criteria: {} });
  const r = await env.post({ kind: 'etat', action: 'set_contact', id: 'a', statut: 'visite', visite: '2026-10-01T16:30:00Z', criteria: {} });
  assert.equal(r.body.contacts.a.statut, 'visite');
  assert.equal(r.body.contacts.a.visite, '2026-10-01T16:30:00.000Z');
  assert.equal(r.body.contacts.a.relance, null, 'plus de relance une fois la visite fixée');
  const r2 = await env.post({ kind: 'etat', action: 'set_contact', id: 'a', statut: 'BIDON', criteria: {} });
  assert.equal(r2.body.contacts.a, undefined);
});

test('set_contact : relance_jours null/absent ne crée pas de relance à demain ; une réponse reçue efface la relance', async () => {
  const env = creerEnvDeTest();
  env.fichiers.set('docs/criteria.json', { sha: 'sha0', content: CRITERES_VALIDES });
  const r0 = await env.post({ kind: 'etat', action: 'set_contact', id: 'a', statut: 'a_contacter', relance_jours: null, criteria: {} });
  assert.equal(r0.body.contacts.a.relance, null, 'null ne doit pas être borné à 1 jour');
  await env.post({ kind: 'etat', action: 'set_contact', id: 'a', statut: 'contacte', relance_jours: 3, criteria: {} });
  const r1 = await env.post({ kind: 'etat', action: 'set_contact', id: 'a', statut: 'contacte', criteria: {} });
  assert.ok(r1.body.contacts.a.relance, 'sans relance_jours, l\'ancienne relance est conservée');
  const r2 = await env.post({ kind: 'etat', action: 'set_contact', id: 'a', statut: 'reponse', relance_jours: null, criteria: {} });
  assert.equal(r2.body.contacts.a.relance, null, 'une réponse reçue efface la relance');
});

// ---- Chat de bout en bout -------------------------------------------------------------------------------
test('chat : requête → agent (outil de lecture puis réponse) → journal ; propositions renvoyées au navigateur', async () => {
  const env = creerEnvDeTest();
  const now = new Date().toISOString();
  env.fichiers.set('docs/criteria.json', { sha: 'sha0', content: CRITERES_VALIDES });
  env.fichiers.set('docs/data/listings.json', { sha: 's1', content: { meta: { lastFullAt: now }, listings: [
    { id: 'bienici:x1', source: "Bien'ici", url: 'https://ex.test/x1', price: 700, surface: 20, rooms: 1, floor: 3, dpe: 'C', arrondissement: 18, first_seen: now, last_seen: now, features: {}, title: 'Studio' },
  ] } });
  let tour = 0;
  env.definirModele((corps) => {
    tour++;
    assert.ok(corps.tools.length >= 10, 'tous les outils sont envoyés');
    if (tour === 1) return [{ type: 'tool_use', id: 't1', name: 'list_listings', input: {} }];
    if (tour === 2) {
      const resultat = JSON.parse(corps.messages.at(-1).content[0].content);
      assert.equal(resultat.annonces[0].id, 'bienici:x1');
      return [{ type: 'tool_use', id: 't2', name: 'propose_listing_actions', input: { actions: [{ ref: 'bienici:x1', action: 'fav' }] } }];
    }
    return [{ type: 'text', text: 'Je te propose de garder le studio.' }];
  });
  const r = await env.post({ message: 'Garde ma meilleure annonce', history: [], criteria: CRITERES_VALIDES });
  assert.equal(r.status, 200);
  assert.equal(r.body.reply, 'Je te propose de garder le studio.');
  assert.equal(r.body.propositions[0].type, 'actions');
  assert.equal(r.body.propositions[0].actions[0].id, 'bienici:x1');
  const j = env.fichiers.get('docs/data/journal.json').content.entries.at(-1);
  assert.equal(j.kind, 'chat');
  assert.deepEqual(j.propositions, ['actions']);
  assert.deepEqual(j.outils, ['list_listings', 'propose_listing_actions']);
  assert.ok(!env.fichiers.has('docs/data/etat.json'), "le chat n'écrit jamais l'état partagé : seule la validation dans l'appli le fait");
});

test("chat : panne de l'API du modèle → erreur 502 lisible, rien n'est écrit", async () => {
  const env = creerEnvDeTest();
  env.fichiers.set('docs/criteria.json', { sha: 'sha0', content: CRITERES_VALIDES });
  env.definirModele(() => { throw new Error('boum'); });
  const r = await env.post({ message: 'Salut', history: [], criteria: CRITERES_VALIDES });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /Réessaie/);
});
