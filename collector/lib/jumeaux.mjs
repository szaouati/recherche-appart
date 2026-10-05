// Confirmation par jumelle : SeLoger, PAP et Leboncoin n'arrivent que par e-mail d'alerte (lu une
// seule fois, pages bloquées aux robots) : impossible de savoir si l'annonce est toujours en ligne.
// Beaucoup d'agences publient aussi sur Bien'ici, que l'on relit en continu. Une annonce d'e-mail dont
// la jumelle Bien'ici est vivante est donc confirmée (`jumeau`, `confirmeLe`) ; si la jumelle disparaît,
// l'annonce d'e-mail est retirée (`retire`). Clé prudente : prix identique, surface à 1 m² près,
// même arrondissement, même nombre de pièces quand les deux le connaissent.
const TOLERANCE_SURFACE = 1;
const VIVANT_MS = 48 * 36e5;

export const estJumelle = (a, b) =>
  a.price != null && a.surface != null && a.arrondissement != null &&
  Math.round(a.price) === Math.round(b.price) &&
  b.surface != null && Math.abs(a.surface - b.surface) <= TOLERANCE_SURFACE &&
  a.arrondissement === b.arrondissement &&
  (a.rooms == null || b.rooms == null || a.rooms === b.rooms);

export const bienIciVivante = (l, refMs) =>
  l.source === "Bien'ici" && !l.retire && !l.dupOf && new Date(l.last_seen).getTime() > refMs - VIVANT_MS;

/** Met à jour `jumeau`/`confirmeLe`/`retire` des annonces issues d'e-mails. Renvoie {confirmees, retirees}. */
export function confirmerParJumelle(known, refMs, nowIso) {
  const vivantes = [...known.values()].filter((l) => bienIciVivante(l, refMs));
  let confirmees = 0, retirees = 0;
  for (const l of known.values()) {
    if (l.source === "Bien'ici" || l.source === 'Manuel') continue;
    const jumelle = vivantes.find((b) => estJumelle(l, b));
    if (jumelle) {
      l.jumeau = jumelle.id; l.confirmeLe = nowIso; l.jumeauUrl = jumelle.url;
      if (l.retire && l.retireMotif === 'jumeau_disparu') { delete l.retire; delete l.retireMotif; }
      confirmees++;
    } else if (l.jumeau && !l.retire) {
      l.retire = true; l.retireMotif = 'jumeau_disparu'; retirees++;
    }
  }
  return { confirmees, retirees };
}
