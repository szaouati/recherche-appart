// Déclencheur de collecte. Le planning de GitHub Actions (`schedule`) saute la plupart des exécutions sur
// un dépôt peu actif (2 à 4 passages par jour au lieu de 32). Le cron du Worker, lui, est fiable : il lance
// le workflow « Collecte des annonces » à la main (workflow_dispatch). Le workflow a un `concurrency`
// (group « collecte ») : un déclenchement qui chevauche un autre attend, rien n'est lancé en double.
import { partiesParis } from './telegram.mjs';

const HEURE_DEBUT = 7;   // heure de Paris, comme l'ancien planning GitHub (~7 h à ~23 h)
const HEURE_FIN = 23;
const HEURE_COMPLETE = 5; // une collecte complète par nuit (prix, annonces retirées)

/** Quel mode lancer à cet instant ? 'full' | 'quick' | null (hors plage). Appelé toutes les 30 min. */
export function modeDuCreneau(maintenant) {
  const { heure, minute } = partiesParis(maintenant);
  if (heure === HEURE_COMPLETE && minute < 30) return 'full';
  if (heure >= HEURE_DEBUT && heure < HEURE_FIN) return 'quick';
  return null;
}

export async function declencherCollecte(env, maintenant = Date.now(), fetchFn = fetch) {
  const jeton = env.ACTIONS_TOKEN || env.GITHUB_TOKEN;
  if (!jeton || !env.GITHUB_REPO) return { lance: false, raison: 'non configuré' };
  const mode = modeDuCreneau(maintenant);
  if (!mode) return { lance: false, raison: 'hors plage' };
  const r = await fetchFn(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.WORKFLOW_COLLECTE || 'collect.yml'}/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jeton}`, Accept: 'application/vnd.github+json', 'User-Agent': 'recherche-appart-bot', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs: { mode } }),
  });
  if (r.status !== 204) throw new Error(`workflow_dispatch ${r.status} : ${(await r.text()).slice(0, 200)}`);
  return { lance: true, mode };
}
