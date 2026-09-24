import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceAffichee, quartier, typeLogement, etageLibelle, prixM2, ligneInfos, baissePrix, teinte, badgesEquipements } from '../docs/js/annonce-ui.mjs';

test('quartier : district de l\'API en priorité', () => {
  assert.equal(quartier({ district: 'La Chapelle - Marx Dormoy', arrondissement: 18 }), 'La Chapelle - Marx Dormoy');
});
test('quartier : lu dans un titre généré, sans la parenthèse finale', () => {
  assert.equal(quartier({ title: 'SeLoger (recherche) — 800€, 22m², 1p — Clignancourt-Jules Joffrin (GO HOME, exclusivité)', arrondissement: 18 }), 'Clignancourt-Jules Joffrin');
});
test('quartier : repli sur l\'arrondissement quand le titre n\'en donne pas', () => {
  assert.equal(quartier({ title: 'Leboncoin (recherche) — 550€, 13m², 1p — 18e (quartier non précisé sur la carte)', arrondissement: 18 }), '18e');
  assert.equal(quartier({ title: 'SeLoger — 699€ — détails non chargés dans l\'export, à ouvrir', arrondissement: 18 }), 'Paris 18e');
  assert.equal(quartier({ arrondissement: null }), 'Paris');
});
test('quartier : un titre très long ne casse rien', () => {
  const q = quartier({ district: 'X'.repeat(500) });
  assert.equal(q.length, 500);
});
test('type de logement', () => {
  assert.equal(typeLogement({ rooms: 1 }), 'Studio');
  assert.equal(typeLogement({ rooms: 3 }), '3 pièces');
  assert.equal(typeLogement({ surface: 20 }), 'Studio');
  assert.equal(typeLogement({}), 'Logement');
});
test('étage, prix/m², ligne d\'infos sans trous', () => {
  assert.equal(etageLibelle({ floor: 0 }), 'RDC');
  assert.equal(etageLibelle({ floor: 1 }), '1er étage');
  assert.equal(etageLibelle({ floor: 4 }), '4e étage');
  assert.equal(etageLibelle({}), null);
  assert.equal(prixM2({ price: 900, surface: 30 }), 30);
  assert.equal(prixM2({ price: 900 }), null);
  assert.equal(ligneInfos({ rooms: 1, price: 550, surface: 13, floor: 3 }), 'Studio · 3e étage · 42 €/m²');
  assert.equal(ligneInfos({ price: 699 }), 'Logement');
});
test('source affichée : la vraie source d\'un import manuel vient de l\'URL', () => {
  assert.equal(sourceAffichee({ source: 'Manuel', url: 'https://www.leboncoin.fr/ad/locations/1' }), 'Leboncoin');
  assert.equal(sourceAffichee({ source: 'Manuel', url: 'https://www.pap.fr/annonces/x-r1' }), 'PAP');
  assert.equal(sourceAffichee({ source: 'Manuel', url: 'https://facebook.com/x' }), 'Ajout manuel');
  assert.equal(sourceAffichee({ source: "Bien'ici", url: 'https://www.bienici.com/annonce/a' }), "Bien'ici");
});
test('baisse de prix et teinte stable', () => {
  assert.equal(baissePrix({ price_history: [['a', 900], ['b', 850]] }), 50);
  assert.equal(baissePrix({ price_history: [['a', 850], ['b', 900]] }), 0);
  assert.equal(baissePrix({}), 0);
  const l = { arrondissement: 18, district: 'Montmartre' };
  assert.equal(teinte(l), teinte({ ...l }));
  assert.ok(teinte(l) >= -20 && teinte(l) <= 20);
});
test('badges d\'équipement', () => {
  const b = badgesEquipements({ furnished: true, features: { balcon: true, calme: true }, elevator: true, dpe: 'D' }).map((x) => x.t);
  assert.deepEqual(b, ['Meublé', 'Balcon', 'Ascenseur', 'DPE D', 'Calme']);
});
