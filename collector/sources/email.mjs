// Source : alertes reçues par e-mail sur alertes.appart.tabatha@gmail.com (IMAP Gmail).
// Actuellement : SeLoger uniquement (collector/lib/parse-seloger-email.mjs, format décodé le
// 23/09/2026 sur de vrais e-mails). PAP et Leboncoin : pas encore de format décodé (aucune vraie
// alerte PAP reçue à ce jour) — voir CLAUDE.md § pipeline e-mail avant d'en ajouter.
//
// Contrairement à Bien'ici, cette source est incrémentale : elle ne relit que les e-mails non lus
// (IMAP \Seen) et les marque lus une fois traités (succès ou échec — un e-mail cassé ne doit pas
// être retenté indéfiniment). Le classement final se fait comme pour toute autre source dans
// collect.mjs, qui dédoublonne par id : un même e-mail relu deux fois ne crée pas de doublon.

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { parseSeLoger, resoudreLienSeLoger } from '../lib/parse-seloger-email.mjs';
import { extractFeatures } from '../lib/features.mjs';

const MAX_MESSAGES_PAR_PASSAGE = 30; // borne le temps d'exécution ; le reste attend le passage suivant

function arrondissementDepuisCodePostal(cp) {
  const n = Number(cp);
  if (n === 75116) return 16;
  return n >= 75001 && n <= 75020 ? n - 75000 : null;
}

async function normaliserSeLoger(brut, dateEmail) {
  const { url, id } = await resoudreLienSeLoger(brut.trackingUrl);
  return {
    id: `seloger:${id}`,
    source: 'SeLoger',
    url,
    title: brut.title,
    price: brut.price,
    surface: brut.surface,
    rooms: brut.rooms,
    floor: null,
    elevator: null,
    furnished: null,
    postalCode: brut.postalCode,
    arrondissement: arrondissementDepuisCodePostal(brut.postalCode),
    district: brut.district,
    photo: brut.photo,
    dpe: null,
    agencyFee: null,
    deposit: null,
    pro: null,
    availableDate: null,
    publishedAt: (dateEmail ?? new Date()).toISOString(),
    description: brut.title ?? '',
    features: extractFeatures(brut.title ?? '', ''),
    // Une alerte e-mail ne donne qu'un titre court, jamais une vraie description : une mention
    // absente n'est pas un signal fiable d'absence (voir docs/score.mjs). Distinct de Bien'ici, où
    // la description réelle rend ce même silence un peu plus parlant.
    texteLimite: true,
  };
}

export async function fetchEmail(_criteria, { log = console.log } = {}) {
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_APP_PASSWORD;
  if (!user || !pass) throw new Error('IMAP_USER / IMAP_APP_PASSWORD manquants (secrets GitHub Actions)');

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false, // ne jamais journaliser l'échange IMAP : pourrait exposer des détails d'authentification
  });

  const items = [];
  const warnings = [];

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const traiter = async (expediteur, analyser, nomSource) => {
        let uids;
        try {
          uids = await client.search({ from: expediteur, seen: false });
        } catch (e) {
          warnings.push(`Recherche IMAP (${nomSource}) : ${e.message}`);
          return;
        }
        if (!uids.length) return log(`  ${nomSource} : aucun nouvel e-mail`);
        log(`  ${nomSource} : ${uids.length} nouvel(aux) e-mail(s)${uids.length > MAX_MESSAGES_PAR_PASSAGE ? ` (${MAX_MESSAGES_PAR_PASSAGE} traités ce passage, le reste au prochain)` : ''}`);

        for (const uid of uids.slice(0, MAX_MESSAGES_PAR_PASSAGE)) {
          try {
            const msg = await client.fetchOne(uid, { source: true });
            const parsed = await simpleParser(msg.source);
            const brutes = analyser(parsed.html || '');
            for (const brut of brutes) {
              try {
                items.push(await normaliserSeLoger(brut, parsed.date));
              } catch (e) {
                warnings.push(`${nomSource} (uid ${uid}) : ${e.message}`);
              }
            }
          } catch (e) {
            warnings.push(`${nomSource} (uid ${uid}) : ${e.message}`);
          } finally {
            // Marqué lu même en cas d'échec : un e-mail durablement cassé ne doit pas être retenté
            // à l'infini. S'il faut le retraiter, le remarquer non lu dans Gmail.
            await client.messageFlagsAdd(uid, ['\\Seen']).catch(() => {});
          }
        }
      };

      await traiter('annonces@alertes.seloger.com', parseSeLoger, 'SeLoger');
      // PAP/Leboncoin : à ajouter ici une fois leur format décodé sur un vrai e-mail (voir CLAUDE.md).
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  if (!items.length && warnings.length) throw new Error(warnings[0]);
  return { items, warnings };
}
