// Analyseur déterministe pour les e-mails d'alerte SeLoger — HTML BRUT tel que livré par IMAP/MIME,
// pas la conversion texte de Gmail (qui linéarise différemment et n'a servi qu'au repérage initial
// du format). Décodé le 23/09/2026 sur de vrais e-mails envoyés à alertes.appart.tabatha@gmail.com.
//
// Chaque bien est encadré par des commentaires <!--LISTING--> … <!--END LISTING--> et contient des
// liens <a href="URL_DE_SUIVI" name="adXXX(N)_(total)">…</a> où XXX ∈ {price,type,criteria,location,
// button} — le suffixe numérique (N_total) est absent quand l'e-mail ne contient qu'une seule
// annonce (ex. le format « annonce exclusive » d'une agence partenaire via SeLoger).
//
// Le lien "adbutton" (texte "Voir l'annonce") est LE lien de l'annonce : les autres (adimage,
// "Localisation différente", "Gérer mes alertes"…) sont des liens de navigation/désabonnement.
// C'est un redirecteur qui se résout en un seul saut 302 vers l'URL stable de l'annonce (voir
// resoudreLienSeLoger ci-dessous) — vérifié à la main avec curl le 23/09/2026.

const RE_CHAMP = /<a\s+href="([^"]+)"\s+name="ad(price|type|criteria|location|button)\d*(?:_\d+)?"[^>]*>([\s\S]*?)<\/a>/gi;
const RE_PHOTO = /Background="([^"]+\.(?:jpg|jpeg|png)[^"]*)"/i;

function texteBrut(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&middot;/gi, '·')
    .replace(/&rarr;/gi, '→')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} html - corps HTML complet de l'e-mail (parsed.html d'un message SeLoger).
 * @returns {Array<{trackingUrl, price, title, rooms, surface, postalCode, district, photo}>}
 */
export function parseSeLoger(html) {
  const blocs = String(html).split(/<!--\s*LISTING\s*-->/i).slice(1);
  const annonces = [];

  for (const bloc of blocs) {
    const fin = bloc.search(/<!--\s*END LISTING\s*-->/i);
    const zone = fin === -1 ? bloc : bloc.slice(0, fin);

    const champs = {};
    for (const m of zone.matchAll(RE_CHAMP)) champs[m[2].toLowerCase()] = { href: m[1], texte: texteBrut(m[3]) };
    if (!champs.button) continue; // pas de "Voir l'annonce" identifié dans ce bloc : on l'ignore

    const prix = champs.price?.texte.match(/([\d][\d\s]*(?:[.,]\d+)?)\s*€\s*\/?\s*mois/i);
    const critere = champs.criteria?.texte.match(/(\d+)\s*pi[eè]ces?\s*[·.]\s*([\d,]+)\s*m²/i);
    const cp = champs.location?.texte.match(/\((\d{5})\)/);
    const quartier = champs.location?.texte.match(/^(.*?)\s*Paris\s*\d+(?:è|e)me arrondissement/i);
    const photo = zone.match(RE_PHOTO);

    annonces.push({
      trackingUrl: champs.button.href,
      price: prix ? Number(prix[1].replace(/\s/g, '').replace(',', '.')) : null,
      title: champs.type?.texte || null,
      rooms: critere ? Number(critere[1]) : null,
      surface: critere ? Number(critere[2].replace(',', '.')) : null,
      postalCode: cp ? cp[1] : null,
      district: quartier ? quartier[1].replace(/,\s*$/, '').trim() || null : null,
      photo: photo ? photo[1] : null,
    });
  }
  return annonces;
}

// Résout le lien de suivi click.by.seloger.com en l'URL stable de l'annonce, sans suivre plus loin
// (la page de l'annonce elle-même répond 403, anti-bot — inutile de la charger, on ne veut que
// l'URL et l'identifiant). Un seul saut 302 suffit (vérifié à la main).
export async function resoudreLienSeLoger(trackingUrl) {
  const res = await fetch(trackingUrl, {
    redirect: 'manual',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; recherche-appart-perso/1.0)' },
    signal: AbortSignal.timeout(15_000),
  });
  const location = res.headers.get('location');
  if (!location) throw new Error(`Pas de redirection pour ce lien SeLoger (statut ${res.status})`);
  const url = location.split('?')[0];
  const id = url.split('/').filter(Boolean).pop();
  if (!id) throw new Error(`Impossible d'extraire un identifiant de ${url}`);
  return { url, id };
}
