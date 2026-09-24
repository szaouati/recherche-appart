// Analyseur des e-mails d'alerte PAP (expéditeur users-alertes@pap.fr, sujet « Alerte email : … »).
// Format décodé le 24/09/2026 sur le premier vrai e-mail reçu : HTML brut, pas la conversion texte de Gmail.
//
// Chaque annonce = un lien `https://www.pap.fr/annonces/<slug>-r<ID>?…` autour de la photo
// (`<img src="https://cdn.pap.fr/photos/…">`), suivi de trois lignes :
//   «Location appartement · Paris 18e» / «641 € / mois» / «1 pièces · 10 m²»
// PAP ne donne ni étage ni DPE dans l'alerte. Le reste de l'e-mail (Pass Prioritaire, agenda, pied de page)
// n'a pas de lien « /annonces/…-r<ID> » avec photo : il est ignoré.

function decoder(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&euro;/gi, '€')
    .replace(/&middot;/gi, '·')
    .replace(/&amp;/gi, '&')
    .replace(/&#0?39;|&apos;|&rsquo;/gi, "'");
}

const RE_CARTE = /<a\s+href="(https:\/\/www\.pap\.fr\/annonces\/[^"]*?-r(\d{6,})[^"]*)"[^>]*>\s*<img\s+src="([^"]+)"/gi;

/**
 * @param {string} html - corps HTML complet du message.
 * @returns {Array<{id, url, price, rooms, surface, arrondissement, photo}>}
 */
export function parsePap(html) {
  const s = String(html);
  const cartes = [...s.matchAll(RE_CARTE)];
  const annonces = [];
  const vus = new Set();
  cartes.forEach((c, i) => {
    const id = c[2];
    if (vus.has(id)) return;
    const fin = i + 1 < cartes.length ? cartes[i + 1].index : c.index + 3000;
    const texte = decoder(s.slice(c.index, fin).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
    const prix = /(\d[\d\s]*?)\s*€\s*\/\s*mois/i.exec(texte);
    const pieces = /(\d+)\s*pi[eè]ces?\s*·\s*([\d.,]+)\s*m²/i.exec(texte);
    const lieu = /Paris\s*(\d{1,2})\s*(?:er|e|[eè]me)\b/i.exec(texte);
    if (!prix || !pieces) return;
    const arrondissement = lieu ? Number(lieu[1]) : null;
    vus.add(id);
    annonces.push({
      id,
      url: c[1].split('?')[0], // on retire le suivi (adresse e-mail, md5, utm) : jamais dans les données publiques
      price: Number(prix[1].replace(/\D/g, '')),
      rooms: Number(pieces[1]),
      surface: Number(pieces[2].replace(',', '.')),
      arrondissement: arrondissement >= 1 && arrondissement <= 20 ? arrondissement : null,
      photo: c[3],
    });
  });
  return annonces;
}
