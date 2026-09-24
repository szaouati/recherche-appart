// Clé stable d'une annonce, tirée de son URL, pour reconnaître la même annonce quel que soit son chemin
// d'arrivée (e-mail, export PDF, ajout à la main) : « lbc:3275598896 », « pap:465400898 », « sl:26UN9BSFB757 ».
// Sert à ne pas créer de doublon (annonce déjà ajoutée à la main) ni à faire revenir une annonce que Sacha a
// retirée (liste `rejetes` de docs/data/etat.json).
export function cleAnnonce(url) {
  const u = String(url ?? '');
  let m = /leboncoin\.fr\/(?:ad\/[a-z_]+|vi)\/(\d{6,})/i.exec(u);
  if (m) return `lbc:${m[1]}`;
  m = /pap\.fr\/annonces\/[^?#]*?-r(\d{6,})/i.exec(u);
  if (m) return `pap:${m[1]}`;
  m = /seloger\.com\/annonce\/(?:location\/[^?#]*\/)?([0-9A-Z]{9,14})(?:[?#]|$)/.exec(u);
  if (m) return `sl:${m[1]}`;
  m = /seloger\.com\/annonces\/[^?#]*\/(\d{6,})\.htm/i.exec(u);
  if (m) return `sl:${m[1]}`;
  return null;
}
