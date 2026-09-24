// Fonctions pures du côté site pour les propositions du bot (testées dans test/agent-ui.test.mjs).

export const STATUTS_LIBELLES = {
  a_contacter: 'À contacter',
  contacte: 'Contacté',
  reponse: 'Réponse reçue',
  visite: 'Visite prévue',
  refuse: 'Refusé',
  sans_suite: 'Sans suite',
};

export const MARQUEURS = {
  prenom: 'prénom',
  situation: 'situation',
  telephone: 'téléphone',
  disponibilites: 'disponibilités',
};

/**
 * Remplace {{prenom}}, {{situation}}… par le contenu de « Mon dossier » (stocké UNIQUEMENT sur l'appareil).
 * Un marqueur non renseigné devient « [à compléter : prénom] » et est listé dans `manquants` : on ne
 * laisse jamais partir un message avec un trou, et on n'invente rien.
 */
export function remplirMarqueurs(message, dossier = {}) {
  const manquants = new Set();
  const texte = String(message ?? '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (t, k) => {
    const cle = k.toLowerCase();
    if (!(cle in MARQUEURS)) return '';
    const v = String(dossier?.[cle] ?? '').trim();
    if (v) return v;
    manquants.add(cle);
    return `[à compléter : ${MARQUEURS[cle]}]`;
  });
  return { texte, manquants: [...manquants] };
}

const echapperIcs = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const pad = (n) => String(n).padStart(2, '0');
const formatLocal = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
const formatUtc = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

/**
 * Fichier .ics d'une visite. Heure « flottante » (sans fuseau) : elle s'affiche à l'heure saisie, quel que
 * soit le fuseau de l'appareil. Rappel une heure avant.
 * @param {{titre, debut: string, dureeMin?: number, lieu?: string, description?: string, uid?: string}} v - debut = « 2026-09-29T18:30 »
 */
export function construireIcs(v, maintenant = new Date()) {
  const debut = new Date(v.debut);
  if (Number.isNaN(debut.getTime())) throw new Error('date de visite invalide');
  const fin = new Date(debut.getTime() + (v.dureeMin ?? 30) * 60_000);
  const lignes = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Mon appart a Paris//FR',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${v.uid ?? `${formatUtc(maintenant)}-${Math.random().toString(36).slice(2, 8)}`}@mon-appart`,
    `DTSTAMP:${formatUtc(maintenant)}`,
    `DTSTART:${formatLocal(debut)}`,
    `DTEND:${formatLocal(fin)}`,
    `SUMMARY:${echapperIcs(v.titre)}`,
    ...(v.lieu ? [`LOCATION:${echapperIcs(v.lieu)}`] : []),
    ...(v.description ? [`DESCRIPTION:${echapperIcs(v.description)}`] : []),
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Visite dans 1 heure',
    'TRIGGER:-PT1H',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lignes.join('\r\n') + '\r\n';
}

/** Une relance est due si sa date est passée et que l'annonce n'est plus en cours de discussion. */
export function relanceDue(contact, maintenant = Date.now()) {
  if (!contact?.relance) return false;
  if (['refuse', 'sans_suite', 'visite'].includes(contact.statut)) return false;
  return new Date(contact.relance).getTime() <= maintenant;
}

export function libelleRelance(contact, maintenant = Date.now()) {
  if (!contact?.relance) return null;
  const jours = Math.ceil((new Date(contact.relance).getTime() - maintenant) / 864e5);
  if (jours <= 0) return 'relance à faire';
  return jours === 1 ? 'relance demain' : `relance dans ${jours} j`;
}
