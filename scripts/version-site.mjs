// Versionne le site sans étape de compilation : chaque module JS (et app.js / app.css) reçoit un ?v=<empreinte> qui
// change seulement quand son contenu change. Les imports entre modules sont versionnés via une import map dans index.html.
// Usage : node scripts/version-site.mjs        (réécrit docs/index.html)
//         node scripts/version-site.mjs --check (échoue si index.html n'est pas à jour ; utilisé par les tests)
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const docs = new URL('../docs/', import.meta.url).pathname;
const empreinte = (f) => crypto.createHash('sha1').update(fs.readFileSync(path.join(docs, f))).digest('hex').slice(0, 8);
const modules = [...fs.readdirSync(path.join(docs, 'js')).filter((f) => f.endsWith('.mjs')).map((f) => `js/${f}`), 'score.mjs', 'agent-ui.mjs'].sort();

export function attendu(html) {
  const carte = Object.fromEntries(modules.map((m) => [`./${m}`, `./${m}?v=${empreinte(m)}`]));
  return html
    .replace(/<script type="importmap">[\s\S]*?<\/script>/, `<script type="importmap">${JSON.stringify({ imports: carte })}</script>`)
    .replace(/app\.js\?v=[^"]*"/, `app.js?v=${empreinte('app.js')}"`)
    .replace(/app\.css\?v=[^"]*"/, `app.css?v=${empreinte('app.css')}"`);
}

const fichier = path.join(docs, 'index.html');
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const html = fs.readFileSync(fichier, 'utf8');
  const neuf = attendu(html);
  if (process.argv.includes('--check')) { if (neuf !== html) { console.error('docs/index.html : versions périmées → node scripts/version-site.mjs'); process.exit(1); } }
  else { fs.writeFileSync(fichier, neuf); console.log(`versions à jour (${modules.length} modules + app.js + app.css)`); }
}
