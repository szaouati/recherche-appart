import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLeboncoin } from '../collector/lib/parse-leboncoin-email.mjs';
import { parsePap } from '../collector/lib/parse-pap-email.mjs';
import { cleAnnonce } from '../collector/lib/cle-annonce.mjs';

// Fixtures réduites d'après de VRAIS e-mails reçus le 24/09/2026 sur alertes.appart.tabatha@gmail.com
// (structure conservée, styles et pied de page retirés ; adresse e-mail et md5 remplacés).
const bloc = (id, photo, prix, pro, ligne, meuble, quartier) => `
<tr><td align="center" style="padding: 0 24px; font-size: 0;">
  <div><table><tr>
    <td width="330" style="border-radius:16px; background-image: url('${photo}'); background-size: cover;">
      <a href="https://www.leboncoin.fr/vi/${id}.htm#at_medium=email&at_campaign=x" target="_blank"><table><tr><td>&nbsp;</td></tr></table></a>
    </td></tr></table></div>
  <div style="display: inline-block;">
    <a href="https://www.leboncoin.fr/vi/${id}.htm#at_medium=email" target="_blank"><table>
      <tr><td><table><tr><td><span style="font-size: 16px; font-weight: 700; color: #152233;">${prix}</span></td>
        <td>${pro ? '<span style="border: solid 1px #094171">Pro</span>' : ''}</td></tr></table></td></tr>
      <tr><td colspan="2" style="font-size: 14px; line-height: 20px; color: #152233;">
        ${ligne}
      </td></tr>
      <tr><td><span style="font-size: 14px;">${meuble ? 'Meublé' : ''}</span></td></tr>
      <tr><td><img src="https://img8.leboncoin.fr/realestate/ico-location.png"/></td>
        <td style="width: 245px; font-size: 14px;">
          ${quartier}<br />
          Paris 75018
        </td></tr>
      <tr><td><a href="https://www.leboncoin.fr/vi/${id}.htm#x"><table><tr><td bgcolor="#094171">
        Voir l'annonce
      </td></tr></table></a></td></tr>
    </table></a>
  </div>
</td></tr>`;

const EMAIL_LBC = `<html><body>
<tr><td><div><b>Bonjour Tabatha,</b></div><div><b>3 nouvelles annonces immobilières</b> correspondant à <b>vos critères de recherche</b> :</div></td></tr>
${bloc('3275598896', 'https://img.leboncoin.fr/api/v1/lbcpb1/images/22/c5/x.jpg?rule=ad-image', '750 €', false, 'Appartement · 1 pièce · 18 m²', false, 'Chapelle - Marx Dormoy')}
${bloc('3275595375', 'https://img.leboncoin.fr/api/v1/lbcpb1/images/f1/10/y.jpg?rule=ad-image', '850 €', true, 'Appartement · 1 pièce · 20 m²', false, 'La Fourche - Guy Moquet')}
${bloc('3275590517', 'https://img.leboncoin.fr/api/v1/lbcpb1/images/ff/38/z.jpg?rule=ad-image', '900 €', true, 'Appartement · 1 pièce · 15 m²', true, 'Simplon - Poissonniers')}
<tr><td><a href="https://www.leboncoin.fr/my-searches/51502260/">Voir toutes les nouvelles annonces</a></td></tr>
</body></html>`;

test('parseLeboncoin : extrait les 3 annonces d\'une alerte (id, prix, surface, pièces, pro, meublé, quartier, photo)', () => {
  const r = parseLeboncoin(EMAIL_LBC);
  assert.equal(r.length, 3);
  assert.deepEqual(
    r.map((a) => [a.id, a.price, a.surface, a.rooms, a.pro, a.furnished, a.district, a.postalCode]),
    [
      ['3275598896', 750, 18, 1, false, null, 'Chapelle - Marx Dormoy', '75018'],
      ['3275595375', 850, 20, 1, true, null, 'La Fourche - Guy Moquet', '75018'],
      ['3275590517', 900, 15, 1, true, true, 'Simplon - Poissonniers', '75018'],
    ],
  );
  assert.match(r[0].photo, /^https:\/\/img\.leboncoin\.fr\/.*\.jpg/);
});

test('parseLeboncoin : un e-mail sans annonce (messagerie…) renvoie [] sans planter', () => {
  assert.deepEqual(parseLeboncoin('<html><body>Vous avez un nouveau message. Dan Arbib 20 €</body></html>'), []);
  assert.deepEqual(parseLeboncoin(''), []);
});

test('parseLeboncoin : prix avec espace insécable (1 050 €) et surface décimale', () => {
  const r = parseLeboncoin(bloc('3200000001', 'https://img.leboncoin.fr/a.jpg', '1&nbsp;050&nbsp;€', false, 'Appartement · 2 pièces · 30,5 m²', false, 'Montmartre'));
  assert.equal(r[0].price, 1050);
  assert.equal(r[0].surface, 30.5);
  assert.equal(r[0].rooms, 2);
});

const EMAIL_PAP = `<html><body>
<table><tr><td>Un 1 pièces de 10&nbsp;m² se libère à Paris 18e</td></tr>
<tr><td><table><tr><td>
  <a href="https://www.pap.fr/annonces/-r465400898?a=62869767&amp;email=x%40y.z&amp;md5=abc&amp;utm_source=alerte_location">
    <img src="https://cdn.pap.fr/photos/pap/49/01/4901c107.jpg" width="518" border="0">
  </a></td></tr>
  <tr><td>Location appartement · Paris 18e
    <br><span>641&nbsp;&euro; / mois</span>
    <br><span>1 pièces · 10&nbsp;m²</span></td></tr>
  <tr><td><a href="https://www.pap.fr/annonces/-r465400898?a=1">Voir l'annonce et contacter le propriétaire</a></td></tr>
</table></td></tr>
<tr><td><a href="https://www.pap.fr/pass-prioritaire?email=x">Je prends mon Pass Prioritaire</a> 39&nbsp;&euro; pour un mois</td></tr>
</table></body></html>`;

test('parsePap : extrait l\'annonce d\'une alerte, retire le suivi de l\'URL', () => {
  const r = parsePap(EMAIL_PAP);
  assert.equal(r.length, 1);
  assert.deepEqual(
    { id: r[0].id, price: r[0].price, rooms: r[0].rooms, surface: r[0].surface, arr: r[0].arrondissement },
    { id: '465400898', price: 641, rooms: 1, surface: 10, arr: 18 },
  );
  assert.equal(r[0].url, 'https://www.pap.fr/annonces/-r465400898');
  assert.ok(!r[0].url.includes('email'), 'aucune adresse e-mail ne doit rester dans l\'URL');
});

test('parsePap : deux annonces dans un même e-mail, chacune avec ses propres chiffres', () => {
  const carte = (id, prix, pieces) => `<a href="https://www.pap.fr/annonces/appartement-paris-18e-75018-r${id}?a=1"><img src="https://cdn.pap.fr/p${id}.jpg"></a>
    <td>Location appartement · Paris 18e <br><span>${prix}&nbsp;&euro; / mois</span><br><span>${pieces}</span></td>`;
  const r = parsePap(`<html>${carte('465400001', 700, '2 pièces · 25&nbsp;m²')}${carte('465400002', 820, '1 pièces · 30,5&nbsp;m²')}</html>`);
  assert.deepEqual(r.map((a) => [a.id, a.price, a.rooms, a.surface]), [['465400001', 700, 2, 25], ['465400002', 820, 1, 30.5]]);
});

test('parsePap : e-mail sans annonce → []', () => {
  assert.deepEqual(parsePap('<html>Créez votre compte sur PAP.fr</html>'), []);
});

test('cleAnnonce : même annonce reconnue quel que soit le chemin (e-mail, PDF, ajout à la main)', () => {
  assert.equal(cleAnnonce('https://www.leboncoin.fr/vi/3275598896.htm#at_medium=email'), 'lbc:3275598896');
  assert.equal(cleAnnonce('https://www.leboncoin.fr/ad/locations/3275598896?saved_id_view=abc'), 'lbc:3275598896');
  assert.equal(cleAnnonce('https://www.pap.fr/annonces/-r465400898'), 'pap:465400898');
  assert.equal(cleAnnonce('https://www.pap.fr/annonces/appartement-paris-18e-75018-r465400898?a=1'), 'pap:465400898');
  assert.equal(cleAnnonce('https://www.seloger.com/annonce/location/ile-de-france/paris-75/paris-75000/26UN9BSFB757'), 'sl:26UN9BSFB757');
  assert.equal(cleAnnonce('https://www.seloger.com/annonce/26M1DQI6X9NI?serp_view=list'), 'sl:26M1DQI6X9NI');
  assert.equal(cleAnnonce('https://www.leboncoin.fr/recherche?category=10'), null);
  assert.equal(cleAnnonce(undefined), null);
});
