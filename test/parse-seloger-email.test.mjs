import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSeLoger } from '../collector/lib/parse-seloger-email.mjs';

// Fixtures reconstituées à partir de vrais e-mails reçus le 22-23/09/2026 sur
// alertes.appart.tabatha@gmail.com (voir samples/seloger-*.txt pour la version texte complète,
// non versionnée). CSS et attributs sans intérêt retirés ; structure et texte réels conservés.

const DEUX_ANNONCES = `
<!--LISTING-->
<table><tr><td>
<th><table><tr><td Background="https://mms.seloger.com/photo1.jpg?h=400&w=540"><a href="https://click.by.seloger.com/?qs=IMG1" name="adimage1_2" target="_blank"></a></td></tr></table></th>
<th><table>
<tr><td><span>Localisation différente</span></td></tr>
<tr><td><a href="https://click.by.seloger.com/?qs=PRICE1" name="adprice1_2" target="_blank"><span><strong>532 €/mois </strong></span><span>charges comprises</span></a></td></tr>
<tr><td><a href="https://click.by.seloger.com/?qs=TYPE1" name="adtype1_2" target="_blank"><strong>appartement 1 pièce à louer</strong></a></td></tr>
<tr><td><a href="https://click.by.seloger.com/?qs=CRIT1" name="adcriteria1_2" target="_blank">1 pièce &middot; 12,7 m²</a></td></tr>
<tr><td><a href="https://click.by.seloger.com/?qs=LOC1" name="adlocation1_2" target="_blank">
Clichy-Trinité,

Paris 9ème arrondissement
(75009)
</a></td></tr>
<tr><td><a href="https://click.by.seloger.com/?qs=BTN1" name="adbutton1_2" target="_blank">Voir l'annonce</a></td></tr>
</table></th>
</td></tr></table>
<!--END LISTING-->
<!--LISTING SPACER--><!--END LISTING SPACER-->
<!--LISTING-->
<table><tr><td>
<th><table><tr><td Background="https://mms.seloger.com/photo2.jpg?h=400&w=540"><a href="https://click.by.seloger.com/?qs=IMG2" name="adimage2_2" target="_blank"></a></td></tr></table></th>
<th><table>
<tr><td><span>Localisation différente</span></td></tr>
<tr><td><a href="https://click.by.seloger.com/?qs=PRICE2" name="adprice2_2" target="_blank"><span><strong>896 €/mois </strong></span><span>charges comprises</span></a></td></tr>
<tr><td><a href="https://click.by.seloger.com/?qs=TYPE2" name="adtype2_2" target="_blank"><strong>Studio meublé de 19m² - rue de Rome 75017 - La Fon...</strong></a></td></tr>
<tr><td><a href="https://click.by.seloger.com/?qs=CRIT2" name="adcriteria2_2" target="_blank">1 pièce &middot; 19 m²</a></td></tr>
<tr><td><a href="https://click.by.seloger.com/?qs=LOC2" name="adlocation2_2" target="_blank">

Paris 17ème arrondissement
(75017)
</a></td></tr>
<tr><td><a href="https://click.by.seloger.com/?qs=BTN2" name="adbutton2_2" target="_blank">Voir l'annonce</a></td></tr>
</table></th>
</td></tr></table>
<!--END LISTING-->
`;

const EXCLUSIF_SANS_SUFFIXE = `
<!--LISTING-->
<table><tr><td>
<th><table><tr><td Background="https://mms.seloger.com/photo3.jpg?h=400&w=540"><a href="https://click.by.seloger.com/?qs=IMG" name="adimage" target="_blank"></a></td></tr></table></th>
<th><table>
<tr><td><a href="https://click.by.seloger.com/?qs=PRICE" name="adprice" target="_blank"><span><strong>791 €/mois </strong></span><span>charges comprises</span></a></td></tr>
<tr><td><a href="https://click.by.seloger.com/?qs=TYPE" name="adtype" target="_blank"><strong>Appartement 2 pièces</strong></a></td></tr>
<tr><td><a href="https://click.by.seloger.com/?qs=CRIT" name="adcriteria" target="_blank">2 pièces &middot; 28,43 m²</a></td></tr>
<tr><td><a href="https://click.by.seloger.com/?qs=LOC" name="adlocation" target="_blank">
Clignancourt-Jules Joffrin,

Paris 18ème arrondissement
(75018)
</a></td></tr>
<tr><td><a href="https://click.by.seloger.com/?qs=BTN" name="adbutton" target="_blank">Voir l'annonce</a></td></tr>
</table></th>
</td></tr></table>
<!--END LISTING-->
`;

test('parseSeLoger : extrait les deux annonces d\'un e-mail groupé (adXXXN_2)', () => {
  const r = parseSeLoger(DEUX_ANNONCES);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], {
    trackingUrl: 'https://click.by.seloger.com/?qs=BTN1',
    price: 532,
    title: 'appartement 1 pièce à louer',
    rooms: 1,
    surface: 12.7,
    postalCode: '75009',
    district: 'Clichy-Trinité',
    photo: 'https://mms.seloger.com/photo1.jpg?h=400&w=540',
  });
  // deuxième annonce : pas de nom de quartier avant "Paris ... arrondissement" → district null
  assert.equal(r[1].district, null);
  assert.equal(r[1].surface, 19);
  assert.equal(r[1].title, 'Studio meublé de 19m² - rue de Rome 75017 - La Fon...');
});

test('parseSeLoger : format « annonce exclusive » sans suffixe numérique (adprice, pas adprice1_1)', () => {
  const r = parseSeLoger(EXCLUSIF_SANS_SUFFIXE);
  assert.equal(r.length, 1);
  assert.equal(r[0].price, 791);
  assert.equal(r[0].rooms, 2);
  assert.equal(r[0].surface, 28.43);
  assert.equal(r[0].postalCode, '75018');
  assert.equal(r[0].district, 'Clignancourt-Jules Joffrin');
});

test('parseSeLoger : aucun bloc LISTING → tableau vide, ne plante pas', () => {
  assert.deepEqual(parseSeLoger('<html><body>rien ici</body></html>'), []);
});

test('parseSeLoger : un bloc sans lien "adbutton" est ignoré (annonce non identifiable)', () => {
  const cassee = DEUX_ANNONCES.replace(/name="adbutton1_2"/, 'name="autrechose1_2"');
  const r = parseSeLoger(cassee);
  assert.equal(r.length, 1); // seule la deuxième annonce reste
});
