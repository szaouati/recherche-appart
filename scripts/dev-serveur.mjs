// Serveur de test local : le site (docs/) + le VRAI code du Worker (worker/src/index.mjs) avec un FAUX GitHub et un FAUX
// Anthropic, tous deux en mémoire. Rien n'est écrit sur disque, dans le dépôt ni chez Cloudflare/GitHub/Anthropic :
// on peut cliquer sur ♥/✕, écrire des notes, changer les critères, discuter avec le bot sans rien risquer.
//   node scripts/dev-serveur.mjs [--vide] [--stress]   → http://localhost:8901
//   --vide   : état partagé vierge   ·   --stress : 160 annonces synthétiques (dont photo cassée, titre très long, sans photo)
// L'état initial est copié de docs/data/etat.json et docs/criteria.json. Le faux modèle répond « Réponse de test » ;
// s'il voit « message de contact » (bouton Contacter), il propose un brouillon.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import worker from '../worker/src/index.mjs';

const RACINE = new URL('../', import.meta.url).pathname;
const PORT_SITE = 8901;
const PORT_WORKER = 8902;
const lire = (p, d) => { try { return JSON.parse(fs.readFileSync(path.join(RACINE, p), 'utf8')); } catch { return d; } };

// --- Faux GitHub (contents API) en mémoire -----------------------------------------------------------------------
const vide = process.argv.includes('--vide');
const stress = process.argv.includes('--stress');
function jeuStress() {
  const src = lire('docs/data/listings.json', { listings: [], meta: {} });
  const modele = src.listings.find((l) => l.photo && l.arrondissement === 18) ?? src.listings.find((l) => l.photo);
  const maintenant = new Date().toISOString();
  const listings = Array.from({ length: 160 }, (_, i) => ({
    ...modele, id: `test:${i}`, url: `https://example.test/annonce/${i}`, price: 500 + (i * 7) % 400, surface: 12 + (i * 3) % 40, rooms: 1 + (i % 3),
    floor: 1 + (i % 6), arrondissement: 18, district: i % 5 === 0 ? 'Quartier au nom exceptionnellement long pour tester la troncature sur une seule ligne dans la carte' : ['Goutte d\'Or', 'La Chapelle', 'Clignancourt', 'Grandes-Carrières'][i % 4],
    title: i === 3 ? 'Magnifique appartement lumineux '.repeat(12) : `Appartement ${i}`,
    photo: i % 3 === 0 ? null : i === 4 ? 'https://example.test/photo-cassee.jpg' : modele.photo,
    first_seen: maintenant, last_seen: maintenant, publishedAt: maintenant, dupOf: undefined, retire: undefined,
  }));
  return { meta: { ...src.meta, generatedAt: maintenant, lastFullAt: maintenant, count: listings.length }, listings };
}
const LISTINGS = stress ? jeuStress() : lire('docs/data/listings.json', { listings: [], meta: {} });
const fichiers = new Map([
  ['docs/data/etat.json', vide ? {} : lire('docs/data/etat.json', {})],
  ['docs/criteria.json', lire('docs/criteria.json', {})],
  ['docs/data/journal.json', { entries: [] }],
  ['docs/data/listings.json', LISTINGS],
].map(([p, c]) => [p, { sha: 'sha0', content: c }]));
let n = 0;
export const journalDeTest = () => fichiers.get('docs/data/journal.json').content;
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

const fetchReel = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.hostname === 'api.anthropic.com') {
    const corps = JSON.parse(opts.body);
    const dernier = corps.messages.at(-1);
    const texteUser = typeof dernier.content === 'string' ? dernier.content : JSON.stringify(dernier.content);
    const apresOutil = Array.isArray(dernier.content) && dernier.content.some((b) => b.type === 'tool_result');
    let contenu = [{ type: 'text', text: 'Réponse de test (faux modèle).' }];
    if (!apresOutil && /message de contact/.test(texteUser)) {
      const ref = /réf ([^\s).]+(?:[:.-][^\s).]+)*)/.exec(texteUser)?.[1];
      contenu = [{ type: 'tool_use', id: 'tu1', name: 'propose_contact_message', input: { ref, canal: 'messagerie_annonce', message: 'Bonjour, je suis très intéressée par votre annonce. {{situation}}. Je suis disponible {{disponibilites}}. Serait-il possible de visiter ? Cordialement, {{prenom}}' } }];
    }
    return new Response(JSON.stringify({ content: contenu, stop_reason: contenu.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
  }
  if (u.hostname !== 'api.github.com') return fetchReel(url, opts);
  const chemin = decodeURIComponent(u.pathname.split('/contents/')[1]);
  const f = fichiers.get(chemin);
  if (!opts.method || opts.method === 'GET') {
    if (!f) return new Response('{}', { status: 404 });
    if (/raw/.test(opts.headers?.Accept ?? '')) return new Response(JSON.stringify(f.content), { status: 200 });
    return new Response(JSON.stringify({ sha: f.sha, content: b64(JSON.stringify(f.content)) }), { status: 200 });
  }
  if (opts.method === 'PUT') {
    const body = JSON.parse(opts.body);
    if (f && body.sha !== f.sha) return new Response('sha mismatch', { status: 409 });
    fichiers.set(chemin, { sha: `sha${++n}`, content: JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')) });
    return new Response('ok', { status: 200 });
  }
  return new Response('non simulé', { status: 500 });
};

// --- Worker réel derrière un petit serveur HTTP ---------------------------------------------------------------------
const env = {
  ALLOWED_ORIGINS: `http://localhost:${PORT_SITE}`, APP_TOKEN: 'test', GITHUB_REPO: 'x/y', GITHUB_TOKEN: 'ghp_fake', ANTHROPIC_API_KEY: 'sk-fake',
  RATE_LIMITER: { limit: async () => ({ success: true }) },
};
http.createServer(async (req, res) => {
  const corps = ['GET', 'HEAD'].includes(req.method) ? undefined : await new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });
  const r = await worker.fetch(new Request(`http://localhost:${PORT_WORKER}${req.url}`, { method: req.method, headers: req.headers, body: corps }), env, { waitUntil: () => {} });
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(PORT_WORKER);

// --- Site statique : docs/, avec config.json pointant vers le faux Worker -------------------------------------------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/config.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ botUrl: `http://localhost:${PORT_WORKER}`, botToken: 'test' })); }
  if (url.pathname === '/data/listings.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(LISTINGS)); }
  let p = path.join(RACINE, 'docs', decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!p.startsWith(path.join(RACINE, 'docs')) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
}).listen(PORT_SITE, () => console.log(`Site de test : http://localhost:${PORT_SITE}  (Worker réel + faux GitHub/Anthropic en mémoire, port ${PORT_WORKER}${vide ? ', état vierge' : ''})`));
