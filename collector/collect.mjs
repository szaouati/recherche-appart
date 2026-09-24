// Orchestrateur : collecte → fusion avec l'historique → écriture du JSON du site → alertes Telegram.
// Usage : node collector/collect.mjs [--dry] [--no-notify] [--quick]
//   --quick : ne relit que les annonces les plus récentes (passages fréquents). Sans : collecte complète.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeCriteria, rankListings } from '../docs/score.mjs';
import { fetchBienici, verifierDisponibilite } from './sources/bienici.mjs';
import { fetchEmail } from './sources/email.mjs';
import { cleAnnonce } from './lib/cle-annonce.mjs';
import { formatAlert, sendTelegram, telegramConfigured } from './notify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRITERIA_FILE = path.join(ROOT, 'docs/criteria.json');
const DB_FILE = path.join(ROOT, 'docs/data/listings.json');
const ETAT_FILE = path.join(ROOT, 'docs/data/etat.json');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const NO_NOTIFY = DRY || args.includes('--no-notify');
const QUICK = args.includes('--quick');

const RETENTION_JOURS = 21;
const MAX_ALERTES = 8;
const FRAICHEUR_ALERTE_JOURS = 3; // pas d'alerte pour une annonce publiée il y a plus longtemps
const MAX_VERIF_DISPONIBILITE = 25; // annonces Bien'ici les mieux classées vérifiées par collecte complète

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ajouter une source = ajouter une ligne ici (fonction async (criteria) => listings normalisés).
// Chaque source renvoie { items, warnings }.
const SOURCES = [
  { name: "Bien'ici", run: (c, mode) => fetchBienici(c, { mode }) },
  { name: 'E-mail (SeLoger)', run: (c) => fetchEmail(c) },
];

// Une même annonce est souvent postée par plusieurs agences. On garde la plus ancienne et on marque
// les autres (dupOf) : le site et les alertes les ignorent. Clé prudente : prix, surface, arrondissement,
// étage et pièces doivent tous être connus et identiques.
function marquerDoublons(known) {
  const vus = new Map();
  const tri = [...known.values()].sort((a, b) => String(a.first_seen).localeCompare(String(b.first_seen)));
  for (const l of tri) {
    delete l.dupOf;
    if (l.price == null || l.surface == null || l.arrondissement == null || l.floor == null || l.rooms == null) continue;
    const cle = [Math.round(l.price), Math.round(l.surface), l.arrondissement, l.floor, l.rooms].join('|');
    if (vus.has(cle)) l.dupOf = vus.get(cle);
    else vus.set(cle, l.id);
  }
}

const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
};

async function main() {
  if (args.includes('--test-telegram')) {
    if (!telegramConfigured()) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID manquants');
    await sendTelegram(`✅ Le bot fonctionne. Les bonnes annonces arriveront ici.\n${process.env.SITE_URL || ''}`);
    return console.log('Message de test envoyé.');
  }
  const now = new Date();
  const nowIso = now.toISOString();
  const criteria = mergeCriteria(await readJson(CRITERIA_FILE, {}));
  const db = await readJson(DB_FILE, { meta: {}, listings: [] });
  const known = new Map(db.listings.map((l) => [l.id, l]));
  const baseline = known.size === 0; // premier passage : on ne notifie pas 3000 annonces d'un coup

  const mode = QUICK && !baseline ? 'quick' : 'full';
  const statuts = [];
  const fresh = [];
  for (const src of SOURCES) {
    console.log(`Source ${src.name} (${mode})…`);
    try {
      const { items, warnings } = await src.run(criteria, mode);
      fresh.push(...items);
      statuts.push({ name: src.name, status: warnings.length ? 'partiel' : 'ok', count: items.length, error: warnings[0] ?? null });
    } catch (e) {
      console.error(`  ✗ ${src.name} : ${e.message}`);
      statuts.push({ name: src.name, status: 'erreur', count: 0, error: e.message });
    }
  }

  // Une annonce déjà ajoutée à la main (export PDF du matin) ou retirée par Sacha (`rejetes`) ne doit pas
  // revenir par e-mail : on la reconnaît à son identifiant dans l'URL (cleAnnonce).
  const etat = await readJson(ETAT_FILE, {});
  const dejaTraitees = new Set([...(etat.manuel ?? []).map((l) => cleAnnonce(l.url)), ...(etat.rejetes ?? [])].filter(Boolean));
  const avant = fresh.length;
  for (let i = fresh.length - 1; i >= 0; i--) {
    const cle = cleAnnonce(fresh[i].url);
    if (cle && dejaTraitees.has(cle)) fresh.splice(i, 1);
  }
  if (fresh.length < avant) console.log(`  ${avant - fresh.length} annonce(s) ignorée(s) : déjà ajoutée(s) à la main ou rejetée(s).`);

  // Fusion : on conserve first_seen, l'historique de prix et le drapeau « notifié ».
  const nouveaux = [];
  for (const l of fresh) {
    const old = known.get(l.id);
    if (old) {
      const history = old.price_history ?? [[old.first_seen, old.price]];
      if (l.price !== old.price) history.push([nowIso, l.price]);
      known.set(l.id, { ...old, ...l, first_seen: old.first_seen, last_seen: nowIso, notified: old.notified, price_history: history });
    } else {
      // Au premier passage, la date de publication est la meilleure estimation de « première apparition ».
      const first = baseline ? l.publishedAt || nowIso : nowIso;
      const entry = { ...l, first_seen: first, last_seen: nowIso, notified: baseline, price_history: [[first, l.price]] };
      known.set(l.id, entry);
      nouveaux.push(entry);
    }
  }
  const limite = now.getTime() - RETENTION_JOURS * 864e5;
  marquerDoublons(known);

  // Vérification ciblée de disponibilité : le champ que renvoie l'API de RECHERCHE de Bien'ici est
  // inutilisable (toujours à false), et une annonce retirée par l'agence peut rester dans les
  // résultats de recherche plusieurs semaines (leur index tarde à se synchroniser). Seule l'API de
  // fiche individuelle est fiable — trop coûteuse pour tout vérifier, donc seulement ce qu'elle
  // verrait vraiment : les mieux classées de cette collecte complète.
  if (mode === 'full') {
    const candidats = rankListings([...known.values()].filter((l) => !l.dupOf), criteria)
      .listings.filter((l) => l.ok && l.source === "Bien'ici")
      .slice(0, MAX_VERIF_DISPONIBILITE);
    let retirees = 0;
    for (const l of candidats) {
      try {
        const disponible = await verifierDisponibilite(l.id.replace("bienici:", ''));
        const entree = known.get(l.id);
        if (disponible === false) { entree.retire = true; retirees++; }
        else delete entree.retire;
      } catch (e) {
        console.error(`  ✗ Vérification disponibilité ${l.id} : ${e.message}`);
      }
      await sleep(200);
    }
    if (retirees) console.log(`  ${retirees} annonce(s) Bien'ici retirée(s) du marché (fiche indisponible), exclue(s).`);
  }

  const listings = [...known.values()].filter((l) => new Date(l.last_seen).getTime() > limite);

  const out = {
    meta: { generatedAt: nowIso, lastFullAt: mode === 'full' ? nowIso : db.meta?.lastFullAt ?? null, mode, count: listings.length, newThisRun: nouveaux.length, baseline, sources: statuts },
    listings,
  };
  console.log(`${fresh.length} annonces collectées, ${nouveaux.length} nouvelles, ${listings.length} en base.`);

  // Alertes : nouvelles annonces, récentes, qui passent les filtres stricts et dépassent le seuil.
  if (criteria.alerteActive && !baseline) {
    const { listings: ranked } = rankListings(listings, criteria);
    const seuilDate = now.getTime() - FRAICHEUR_ALERTE_JOURS * 864e5;
    const aAlerter = ranked
      .filter((l) => !l.notified && !l.dupOf && !l.retire && l.ok && l.score >= criteria.alerteScoreMin)
      .filter((l) => !l.publishedAt || new Date(l.publishedAt).getTime() > seuilDate);
    console.log(`${aAlerter.length} annonce(s) à signaler (score ≥ ${criteria.alerteScoreMin}).`);

    if (aAlerter.length && (NO_NOTIFY || !telegramConfigured())) {
      console.log(NO_NOTIFY ? '  (mode sans notification)' : '  Telegram non configuré (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID).');
      if (DRY) for (const l of aAlerter.slice(0, MAX_ALERTES)) console.log('  ---\n' + formatAlert(l));
    } else if (aAlerter.length) {
      const envoyees = aAlerter.slice(0, MAX_ALERTES);
      for (const l of envoyees) {
        try {
          await sendTelegram(formatAlert(l));
          known.get(l.id).notified = true;
        } catch (e) {
          console.error(`  ✗ Telegram : ${e.message}`);
          break; // on réessaiera au prochain passage
        }
      }
      const reste = aAlerter.length - envoyees.length;
      if (reste > 0) {
        try {
          await sendTelegram(`… et ${reste} autre(s) bonne(s) annonce(s) sur ${process.env.SITE_URL || 'le site'}`);
          for (const l of aAlerter.slice(MAX_ALERTES)) known.get(l.id).notified = true;
        } catch (e) {
          console.error(`  ✗ Telegram : ${e.message}`);
        }
      }
    }
  }

  if (DRY) return console.log('Mode --dry : rien n\'est écrit.');
  out.listings = [...known.values()].filter((l) => new Date(l.last_seen).getTime() > limite);
  await fs.mkdir(path.dirname(DB_FILE), { recursive: true });
  await fs.writeFile(DB_FILE, JSON.stringify(out));
  console.log(`Écrit ${path.relative(ROOT, DB_FILE)}`);

  // Si TOUTES les sources échouent, on le signale par un code de sortie pour que l'Action passe au rouge.
  if (statuts.every((s) => s.status === 'erreur')) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
