import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attendu } from '../scripts/version-site.mjs';

// Sans ces ?v= à jour, un appareil (Safari surtout) peut rester bloqué sur d'anciens fichiers JS/CSS : c'est le seul
// mécanisme de cache-busting du site (pas d'étape de compilation).
test('docs/index.html : versions des modules à jour', () => {
  const html = fs.readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
  assert.equal(attendu(html), html, 'exécute : node scripts/version-site.mjs');
});
test('docs/index.html : app.js, app.css et import map présents', () => {
  const html = fs.readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
  assert.match(html, /app\.js\?v=[0-9a-f]{8}"/);
  assert.match(html, /app\.css\?v=[0-9a-f]{8}"/);
  assert.match(html, /"\.\/js\/etat\.mjs":"\.\/js\/etat\.mjs\?v=[0-9a-f]{8}"/);
});
