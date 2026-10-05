import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.mjs';
import { parisVersISO, resumeCriteres, tacheHoraire } from '../worker/src/telegram.mjs';

// Faux GitHub + faux Telegram + faux KV, tous en mémoire. Chaque appel à l'API Telegram est enregistré
// (méthode + paramètres) pour vérifier ce que Tabatha et Sacha reçoivent vraiment.
const SECRET = 'cle-webhook-test';
const SACHA = 111;
const TABATHA = 222;

function creerEnv({ listings = [], meta } = {}) {
  const fichiers = new Map();
  let sha = 0;
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const db64 = (s) => Buffer.from(s, 'base64').toString('utf8');
  const maintenant = new Date().toISOString();
  fichiers.set('docs/data/listings.json', { sha: 's0', content: { meta: meta ?? { generatedAt: maintenant, lastFullAt: maintenant }, listings } });
  fichiers.set('docs/criteria.json', { sha: 's0', content: {} });

  const appels = [];
  let messageId = 100;
  let modele = null;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.hostname === 'api.telegram.org') {
      const methode = u.pathname.split('/').at(-1);
      const params = JSON.parse(opts.body);
      appels.push({ methode, params });
      if (methode === 'sendPhoto' && /cassee/.test(params.photo)) return new Response(JSON.stringify({ ok: false, description: 'wrong file' }), { status: 400 });
      if (methode === 'getMe') return new Response(JSON.stringify({ ok: true, result: { username: 'appart_bot' } }));
      return new Response(JSON.stringify({ ok: true, result: { message_id: ++messageId } }));
    }
    if (u.hostname === 'api.anthropic.com') {
      const contenu = modele(JSON.parse(opts.body));
      return new Response(JSON.stringify({ content: contenu, stop_reason: contenu.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' }));
    }
    if (u.hostname !== 'api.github.com') throw new Error('fetch non simulé : ' + url);
    const path = decodeURIComponent(u.pathname.split('/contents/')[1]);
    if (!opts.method || opts.method === 'GET') {
      const f = fichiers.get(path);
      if (!f) return { status: 404, ok: false, json: async () => ({}) };
      if (/raw/.test(opts.headers?.Accept ?? '')) return { status: 200, ok: true, json: async () => f.content };
      return { status: 200, ok: true, json: async () => ({ sha: f.sha, content: b64(JSON.stringify(f.content)) }) };
    }
    const body = JSON.parse(opts.body);
    const f = fichiers.get(path);
    if (f && body.sha !== f.sha) return { status: 409, ok: false, text: async () => 'sha mismatch' };
    fichiers.set(path, { sha: `sha${++sha}`, content: JSON.parse(db64(body.content)) });
    return { status: 200, ok: true, text: async () => 'ok' };
  };

  const kv = new Map();
  const env = {
    ALLOWED_ORIGINS: 'https://example.test', APP_TOKEN: 'tok', GITHUB_REPO: 'x/y', GITHUB_TOKEN: 'ghp_fake',
    JOURNAL_PATH: 'docs/data/journal.json', CRITERIA_PATH: 'docs/criteria.json', ETAT_PATH: 'docs/data/etat.json',
    RATE_LIMITER: { limit: async () => ({ success: true }) },
    TELEGRAM_BOT_TOKEN: 'bot-fake', TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_HEURES: '9,19', SITE_URL: 'https://site.test/',
    TG: {
      get: async (k, type) => (kv.has(k) ? (type === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
      put: async (k, v) => { kv.set(k, v); },
      delete: async (k) => { kv.delete(k); },
    },
  };
  const enCours = [];
  const ctx = { waitUntil: (p) => enCours.push(p) };
  let updateId = 1;

  const h = {
    env, kv, fichiers, appels,
    definirModele: (fn) => { modele = fn; },
    vider: () => appels.splice(0),
    envoisA: (chat) => appels.filter((a) => String(a.params.chat_id) === String(chat) && /^send(Message|Photo)$/.test(a.methode)),
    journal: () => fichiers.get('docs/data/journal.json')?.content.entries ?? [],
    etat: () => fichiers.get('docs/data/etat.json')?.content ?? {},
    async update(u, secret = SECRET) {
      const req = new Request('https://worker.test/telegram', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret, 'Content-Type': 'application/json' }, body: JSON.stringify({ update_id: updateId++, ...u }) });
      const res = await worker.fetch(req, env, ctx);
      await Promise.all(enCours.splice(0));
      return res;
    },
    message: (chat, text, extra = {}) => h.update({ message: { message_id: 1, chat: { id: chat, type: 'private' }, from: { id: chat, first_name: chat === TABATHA ? 'Tabatha' : 'X' }, text, ...extra } }),
    bouton: (chat, data, message_id = 50, reply_markup) => h.update({ callback_query: { id: 'cq', from: { id: chat }, data, message: { message_id, chat: { id: chat }, reply_markup } } }),
    async horaire(iso) {
      const o = {
        traiterEtat: () => { throw new Error('non utilisé'); },
        appendJournal: async (e) => {
          const f = fichiers.get('docs/data/journal.json');
          const entries = [...(f?.content.entries ?? []), { ts: new Date().toISOString(), ...e }];
          fichiers.set('docs/data/journal.json', { sha: `sha${++sha}`, content: { entries } });
        },
        chargerDonnees: async () => ({ listings: fichiers.get('docs/data/listings.json').content.listings, meta: fichiers.get('docs/data/listings.json').content.meta, etat: h.etat(), criteria: {} }),
      };
      await tacheHoraire(env, o, Date.parse(iso));
    },
    // Branche les deux comptes comme après l'onboarding réel.
    async brancher() {
      await h.message(SACHA, '/start');
      await h.message(TABATHA, '/start');
      await h.bouton(SACHA, `ok:${TABATHA}`);
      h.vider();
    },
  };
  return h;
}

// Un instant d'aujourd'hui où il est `heure` h à Paris, quelle que soit la saison (les données de test sont fraîches).
const instantParis = (heure, sec = 0) => {
  const d = [...Array(24).keys()].map((hh) => new Date(new Date().setUTCHours(hh, 0, sec, 0)))
    .find((x) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' }).format(x)) === heure);
  return d.toISOString();
};
const recent = () => new Date(Date.now() - 36e5).toISOString();
const annonce = (id, extra = {}) => ({ id, source: "Bien'ici", url: `https://ex.test/${id}`, price: 750, surface: 22, rooms: 1, floor: 3, dpe: 'C', arrondissement: 18, district: 'Goutte d’Or', first_seen: recent(), last_seen: new Date().toISOString(), features: {}, title: 'Studio', ...extra });

test('webhook sans la bonne clé secrète : 401, rien n’est lu ni envoyé', async () => {
  const h = creerEnv();
  const res = await h.update({ message: { chat: { id: 1, type: 'private' }, text: '/start' } }, 'mauvaise');
  assert.equal(res.status, 401);
  assert.equal(h.appels.length, 0);
  assert.equal(h.kv.size, 0);
});

test('onboarding : 1er /start = Sacha admin ; /start de Tabatha → demande à Sacha → accès ouvert, accueil transparent', async () => {
  const h = creerEnv();
  await h.message(SACHA, '/start');
  assert.match(h.envoisA(SACHA)[0].params.text, /administrateur/);
  h.vider();

  await h.message(TABATHA, '/start');
  const demande = h.envoisA(SACHA)[0];
  assert.match(demande.params.text, /Demande d’accès.*Tabatha/);
  assert.equal(demande.params.reply_markup.inline_keyboard[0][0].callback_data, `ok:${TABATHA}`);
  assert.match(h.envoisA(TABATHA)[0].params.text, /privé/);
  h.vider();

  // Tabatha ne peut pas s'auto-autoriser.
  await h.bouton(TABATHA, `ok:${TABATHA}`);
  assert.equal(h.kv.get('role:tabatha'), undefined);

  await h.bouton(SACHA, `ok:${TABATHA}`);
  assert.equal(JSON.parse(h.kv.get('role:tabatha')), String(TABATHA));
  const accueil = h.envoisA(TABATHA)[0].params.text;
  assert.match(accueil, /Sacha peut lire nos échanges/, 'la collecte est annoncée, comme dans l’appli');
  assert.match(accueil, /9 h et 19 h/);
});

test('un inconnu qui écrit autre chose que /start ne déclenche rien', async () => {
  const h = creerEnv();
  await h.message(SACHA, '/start');
  h.vider();
  await h.message(333, 'salut');
  assert.equal(h.appels.length, 0);
});

test('une mise à jour renvoyée par Telegram (même update_id) n’est traitée qu’une fois', async () => {
  const h = creerEnv();
  const u = { update_id: 42, message: { chat: { id: SACHA, type: 'private' }, text: '/start' } };
  const envoi = () => worker.fetch(new Request('https://worker.test/telegram', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET }, body: JSON.stringify(u) }), h.env, { waitUntil() {} });
  await envoi();
  await envoi();
  assert.equal(h.envoisA(SACHA).length, 1);
});

test('résumé de 9 h : meilleures annonces non écartées, une carte chacune, puis jamais renvoyées', async () => {
  const h = creerEnv({ listings: [
    annonce('bienici:a', { price: 650, features: { balcon: true }, photo: 'https://img.test/a.jpg' }),
    annonce('bienici:b', { price: 800 }),
    annonce('bienici:c', { price: 700, photo: 'https://img.test/cassee.jpg' }),
    annonce('bienici:loin', { arrondissement: 11 }),
  ] });
  await h.brancher();
  h.fichiers.set('docs/data/etat.json', { sha: 'e0', content: { statut: { 'bienici:b': 'ecarte' } } });

  await h.horaire(instantParis(9));
  const envois = h.envoisA(TABATHA);
  assert.match(envois[0].params.text, /2 nouvelles annonces.*ce matin/);
  assert.equal(envois.length, 1 + 2 + 1, 'intro + 2 cartes (+ repli texte pour la photo cassée)');
  const cartes = envois.slice(1);
  assert.equal(cartes[0].methode, 'sendPhoto');
  assert.match(cartes[0].params.caption, /650 €.*22 m²/);
  assert.match(cartes[0].params.caption, /balcon/);
  assert.equal(cartes[0].params.reply_markup.inline_keyboard[0][0].callback_data, 's:f:bienici:a');
  assert.equal(cartes[0].params.reply_markup.inline_keyboard[1][0].url, 'https://ex.test/bienici:a');
  assert.equal(cartes.at(-1).methode, 'sendMessage', 'photo refusée par Telegram → la carte part en texte');
  assert.ok(!envois.some((e) => /bienici:(b|loin)/.test(JSON.stringify(e.params))), 'ni écartée ni hors critères');
  assert.deepEqual(h.journal().at(-1).ids, ['bienici:a', 'bienici:c']);
  assert.equal(h.journal().at(-1).kind, 'telegram_envoye');

  h.vider();
  await h.horaire(instantParis(9, 30)); // même créneau : rien
  await h.horaire(instantParis(19)); // 19 h : plus rien de neuf → silence
  await h.horaire(instantParis(12)); // 12 h : pas une heure prévue
  assert.equal(h.envoisA(TABATHA).length, 0);
});

test('données de collecte vieilles de plus de 12 h : Sacha est prévenu, Tabatha ne reçoit rien', async () => {
  const vieux = new Date(Date.now() - 20 * 36e5).toISOString();
  const h = creerEnv({ listings: [annonce('bienici:a')], meta: { generatedAt: vieux, lastFullAt: vieux } });
  await h.brancher();
  await h.horaire(instantParis(19));
  assert.equal(h.envoisA(TABATHA).length, 0);
  assert.match(h.envoisA(SACHA)[0].params.text, /collecte/);
});

test('♥ sur une carte : écrit dans l’état partagé, journalise (canal telegram), bouton « annuler »', async () => {
  const h = creerEnv({ listings: [annonce('bienici:a')] });
  await h.brancher();
  const clavier = { inline_keyboard: [[{ text: '♥', callback_data: 's:f:bienici:a' }], [{ text: 'Voir', url: 'https://ex.test/bienici:a' }]] };
  await h.bouton(TABATHA, 's:f:bienici:a', 77, clavier);
  assert.equal(h.etat().statut['bienici:a'], 'fav');
  const j = h.journal().at(-1);
  assert.equal(j.type, 'fav');
  assert.equal(j.canal, 'telegram');
  const edit = h.appels.find((a) => a.methode === 'editMessageReplyMarkup');
  assert.equal(edit.params.message_id, 77);
  assert.equal(edit.params.reply_markup.inline_keyboard[0][0].callback_data, 's:0:bienici:a');
  assert.equal(edit.params.reply_markup.inline_keyboard[1][0].url, 'https://ex.test/bienici:a', 'le lien reste');

  await h.bouton(TABATHA, 's:0:bienici:a', 77, clavier);
  assert.equal(h.etat().statut['bienici:a'], undefined);
});

test('un inconnu ne peut pas appuyer sur les boutons', async () => {
  const h = creerEnv({ listings: [annonce('bienici:a')] });
  await h.brancher();
  await h.bouton(999, 's:e:bienici:a');
  assert.equal(h.etat().statut?.['bienici:a'], undefined);
  assert.match(h.appels.find((a) => a.methode === 'answerCallbackQuery').params.text, /non autorisé/);
});

test('message libre → agent → réponse + proposition à boutons ; rien n’est écrit avant « Appliquer »', async () => {
  const h = creerEnv({ listings: [annonce('bienici:a')] });
  await h.brancher();
  h.kv.set(`msg:${TABATHA}:500`, JSON.stringify('bienici:a')); // carte envoyée plus tôt
  let vu = null;
  h.definirModele((corps) => {
    vu ??= corps;
    if (corps.messages.at(-1).role === 'user' && typeof corps.messages.at(-1).content === 'string') {
      return [{ type: 'tool_use', id: 't1', name: 'propose_listing_actions', input: { actions: [{ ref: 'bienici:a', action: 'fav' }] } }];
    }
    return [{ type: 'text', text: 'Je te propose de **garder** celle-là <3' }];
  });

  await h.message(TABATHA, 'celle-là me plaît', { reply_to_message: { message_id: 500 } });
  assert.match(vu.system[1].text, /Telegram/, 'consignes du canal Telegram');
  assert.match(vu.messages.at(-1).content, /réf bienici:a/, 'l’agent sait à quelle carte elle répond');
  const envois = h.envoisA(TABATHA);
  assert.equal(envois[0].params.text, 'Je te propose de <b>garder</b> celle-là &lt;3', 'gras converti, HTML échappé');
  const prop = envois[1];
  assert.match(prop.params.text, /Garder/);
  const pa = prop.params.reply_markup.inline_keyboard[0][0].callback_data;
  assert.match(pa, /^pa:/);
  assert.equal(h.etat().statut, undefined, 'rien n’est appliqué sans validation');
  const chat = h.journal().find((e) => e.kind === 'chat');
  assert.equal(chat.canal, 'telegram');
  assert.equal(chat.qui, 'tabatha');
  assert.equal(chat.message, 'celle-là me plaît');

  await h.bouton(TABATHA, pa, 601);
  assert.equal(h.etat().statut['bienici:a'], 'fav');
  h.vider();
  await h.bouton(TABATHA, pa, 601); // deuxième tap : déjà consommée
  assert.match(h.appels.find((a) => a.methode === 'answerCallbackQuery').params.text, /expiré/);

  const hist = JSON.parse(h.kv.get(`hist:${TABATHA}`));
  assert.deepEqual(hist.map((m) => m.role), ['user', 'assistant']);
});

test('/nouveautes par Sacha : aperçu sans marquer comme envoyé', async () => {
  const h = creerEnv({ listings: [annonce('bienici:a')] });
  await h.brancher();
  await h.message(SACHA, '/nouveautes');
  assert.match(h.envoisA(SACHA)[0].params.text, /aperçu/);
  assert.equal(h.kv.get('envoyes'), undefined);
  await h.message(TABATHA, '/nouveautes');
  assert.deepEqual(JSON.parse(h.kv.get('envoyes')), ['bienici:a']);
});

test('heure de Paris → ISO, été comme hiver ; résumé lisible des critères', () => {
  assert.equal(parisVersISO('2026-10-05T18:30'), '2026-10-05T16:30:00.000Z');
  assert.equal(parisVersISO('2026-12-05T18:30'), '2026-12-05T17:30:00.000Z');
  const r = resumeCriteres({ budgetMax: 900 }, { budgetMax: 1000, arrondissements: [18, 19] });
  assert.match(r, /900 € → <b>1\s000 €<\/b>/u);
  assert.match(r, /18e, 19e/);
});
