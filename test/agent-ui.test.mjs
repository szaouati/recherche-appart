import test from 'node:test';
import assert from 'node:assert/strict';
import { IDEES_QUESTIONS, formaterReponse, remplirMarqueurs, construireIcs, relanceDue, libelleRelance, STATUTS_LIBELLES } from '../docs/agent-ui.mjs';

test('remplirMarqueurs : remplace par « Mon dossier », signale ce qui manque, n\'invente rien', () => {
  const { texte, manquants } = remplirMarqueurs('Bonjour, je suis {{situation}}. Merci, {{prenom}} — {{telephone}} — {{iban}}', { prenom: 'Tabatha', situation: 'étudiante en master' });
  assert.equal(texte, 'Bonjour, je suis étudiante en master. Merci, Tabatha — [à compléter : téléphone] — ');
  assert.deepEqual(manquants, ['telephone']);
});

test('remplirMarqueurs : dossier vide → tous les marqueurs restent visibles comme à compléter', () => {
  const { texte, manquants } = remplirMarqueurs('{{prenom}} / {{disponibilites}}', {});
  assert.match(texte, /\[à compléter : prénom\] \/ \[à compléter : disponibilités\]/);
  assert.deepEqual(manquants.sort(), ['disponibilites', 'prenom']);
});

test('construireIcs : événement valide, heure locale, durée, rappel 1 h avant, échappement', () => {
  const ics = construireIcs({ titre: 'Visite : studio, 18e', debut: '2026-09-29T18:30', dureeMin: 45, lieu: '12 rue X; Paris', description: 'Ligne 1\nLigne 2', uid: 'u1' }, new Date('2026-09-24T10:00:00Z'));
  const l = ics.split('\r\n');
  assert.equal(l[0], 'BEGIN:VCALENDAR');
  assert.ok(l.includes('DTSTART:20260929T183000'));
  assert.ok(l.includes('DTEND:20260929T191500'), '45 min plus tard');
  assert.ok(l.includes('SUMMARY:Visite : studio\\, 18e'));
  assert.ok(l.includes('LOCATION:12 rue X\\; Paris'));
  assert.ok(l.includes('DESCRIPTION:Ligne 1\\nLigne 2'));
  assert.ok(l.includes('TRIGGER:-PT1H'));
  assert.ok(l.includes('UID:u1@mon-appart'));
  assert.equal(l.at(-2), 'END:VCALENDAR');
  assert.ok(ics.endsWith('\r\n'));
});

test('construireIcs : date illisible → erreur claire', () => {
  assert.throws(() => construireIcs({ titre: 'x', debut: 'demain' }), /invalide/);
});

test('relances : due seulement si la date est passée et le dossier encore actif', () => {
  const now = Date.parse('2026-09-24T12:00:00Z');
  assert.equal(relanceDue({ statut: 'contacte', relance: '2026-09-23T12:00:00Z' }, now), true);
  assert.equal(relanceDue({ statut: 'contacte', relance: '2026-09-25T12:00:00Z' }, now), false);
  assert.equal(relanceDue({ statut: 'refuse', relance: '2026-09-20T12:00:00Z' }, now), false);
  assert.equal(relanceDue({ statut: 'visite', relance: '2026-09-20T12:00:00Z' }, now), false);
  assert.equal(relanceDue({ statut: 'reponse', relance: '2026-09-20T12:00:00Z' }, now), false, 'une réponse est arrivée : rien à relancer');
  assert.equal(relanceDue(undefined, now), false);
  assert.equal(libelleRelance({ relance: '2026-09-25T10:00:00Z' }, now), 'relance demain');
  assert.equal(libelleRelance({ relance: '2026-09-28T12:00:00Z' }, now), 'relance dans 4 j');
  assert.equal(libelleRelance({ relance: '2026-09-20T12:00:00Z' }, now), 'relance à faire');
});

test('statuts : libellés pour tous les statuts du Worker', () => {
  for (const s of ['a_contacter', 'contacte', 'reponse', 'visite', 'refuse', 'sans_suite']) assert.ok(STATUTS_LIBELLES[s]);
});

test('formaterReponse : gras et tableaux lisibles, HTML toujours échappé', () => {
  assert.equal(formaterReponse('Il reste **21** annonces'), 'Il reste <b>21</b> annonces');
  assert.equal(formaterReponse('<img src=x onerror=alert(1)> **ok**'), '&lt;img src=x onerror=alert(1)&gt; <b>ok</b>');
  const t = formaterReponse('| Annonce | Prix |\n|---|---|\n| A | 550 € |');
  assert.equal(t, 'Annonce · Prix\nA · 550 €');
  assert.equal(formaterReponse('- un\n- deux'), '- un\n- deux');
});

test('idées de questions : thèmes non vides, aucune question en double', () => {
  const toutes = IDEES_QUESTIONS.flatMap((g) => g.questions);
  assert.ok(IDEES_QUESTIONS.length >= 4 && toutes.length >= 15);
  assert.equal(new Set(toutes).size, toutes.length);
  for (const q of ['Où j\'en suis de mes recherches ?', 'Qui a répondu à mes demandes ?', 'C\'est quand mes prochains rendez-vous ?']) assert.ok(toutes.includes(q));
  assert.ok(toutes.every((q) => q.length <= 120 && q.endsWith('?') || !q.endsWith('?')));
});
