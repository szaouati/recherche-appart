// Analyseur des e-mails d'alerte Leboncoin (expéditeur no.reply@leboncoin.fr, sujet « N nouveaux biens à
// louer à Paris (75018) »). Format décodé le 24/09/2026 sur un vrai e-mail : HTML brut, pas la conversion
// texte de Gmail.
//
// Chaque annonce = un bloc dont la photo est en `background-image: url('…')` sur une cellule, suivie de
// liens `https://www.leboncoin.fr/vi/<ID>.htm#…` (l'identifiant numérique est LE lien direct de l'annonce,
// sans captcha contrairement au site) puis d'un texte de la forme :
//   «750 € [Pro] Appartement · 1 pièce · 18 m² [Meublé] Chapelle - Marx Dormoy Paris 75018 Voir l'annonce»
// On découpe donc en blocs sur la photo, puis on lit le TEXTE du bloc (plus stable que les styles inline).
// Un e-mail sans bloc d'annonce (messagerie, confirmation de compte…) renvoie simplement [].

function decoder(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&euro;/gi, '€')
    .replace(/&middot;/gi, '·')
    .replace(/&amp;/gi, '&')
    .replace(/&#0?39;|&apos;|&rsquo;/gi, "'")
    .replace(/&eacute;/gi, 'é')
    .replace(/&egrave;/gi, 'è');
}

const RE_PHOTO = /background-image:\s*url\('([^']+)'\)/i;
const RE_ID = /leboncoin\.fr\/vi\/(\d{6,})\.htm/i;
const RE_TEXTE = /(\d[\d\s  ]*?)\s*€\s*(Pro\s+)?([^·€]+?)\s*·\s*(?:(\d+)\s*pi[eè]ces?\s*·\s*)?([\d.,]+)\s*m²\s*(Meubl[ée]\s+)?(.+?)\s*Paris\s*(75\d{3})/i;

/**
 * @param {string} html - corps HTML complet du message (parsed.html).
 * @returns {Array<{id, price, type, rooms, surface, furnished, pro, district, postalCode, photo}>}
 */
export function parseLeboncoin(html) {
  const zones = String(html).split(/(?=background-image:\s*url\(')/i).slice(1);
  const annonces = [];
  const vus = new Set();
  for (const zone of zones) {
    const id = RE_ID.exec(zone)?.[1];
    if (!id || vus.has(id)) continue;
    const texte = decoder(zone.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
    const m = RE_TEXTE.exec(texte);
    if (!m) continue;
    const price = Number(m[1].replace(/\D/g, ''));
    const surface = Number(m[5].replace(',', '.'));
    if (!Number.isFinite(price) || !Number.isFinite(surface)) continue;
    vus.add(id);
    annonces.push({
      id,
      price,
      type: m[3].trim(),
      rooms: m[4] ? Number(m[4]) : null,
      surface,
      furnished: m[6] ? true : null,
      pro: Boolean(m[2]),
      district: m[7].trim() || null,
      postalCode: m[8],
      photo: RE_PHOTO.exec(zone)?.[1] ?? null,
    });
  }
  return annonces;
}
