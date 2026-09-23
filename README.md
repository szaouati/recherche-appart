# Recherche d'appart à Paris — prototype

Un bot collecte les annonces de location parisiennes plusieurs fois par jour, les filtre et les note selon
les critères de Tabatha, puis la prévient sur Telegram quand une bonne annonce tombe. Un site lui permet
de régler ses critères et de consulter le classement chaque jour.

```
GitHub Actions (cron 30 min)  →  collector/collect.mjs  →  docs/data/listings.json  →  site (GitHub Pages)
                                        └─ score ≥ seuil ? → Telegram
```

- **Aucune dépendance npm.** Node 20+ suffit (le workflow utilise Node 22).
- **Un seul moteur de score** (`docs/score.mjs`) partagé par le site et par le bot : ils classent toujours pareil.
- Coût : 0 € (dépôt public). Voir « Confidentialité ».

## État des sources

| Source | État | Détail |
|---|---|---|
| Bien'ici | ✅ branchée, testée | API JSON du site. Agrège de nombreux réseaux d'agences. ~490 annonces parisiennes ≤ 1 500 € et ≥ 30 m² au 21/09/2026. |
| PAP, SeLoger, Leboncoin (accès direct) | ❌ bloqué | HTTP 403 dès la première requête, même avec des en-têtes de navigateur. Anti-bot + CGU. Non contournable proprement depuis GitHub Actions. |
| Alertes e-mail (PAP, SeLoger) | 📬 alertes reçues, pas encore lues par le bot | Créées sur `alertes.appart.tabatha@gmail.com`, opérationnelles depuis le 22/09/2026. Reste à écrire `collector/sources/email.mjs`. Voir « Phase 2 ». |
| Ajout manuel (Facebook, bouche-à-oreille) | ✅ | Bouton « + Ajouter une annonce » sur le site. Stocké dans le navigateur de Tabatha. |

## Mise en ligne

1. Créer un dépôt GitHub et y pousser ce dossier.
2. **Settings → Pages** : source = `Deploy from a branch`, branche `main`, dossier `/docs`.
3. **Actions → Collecte des annonces → Run workflow** (mode `full`) pour remplir la base une première fois.
4. Le site est à `https://<compte>.github.io/<dépôt>/`.

### Alertes Telegram

1. Sur Telegram, écrire à **@BotFather** → `/newbot` → noter le **jeton**.
2. Tabatha écrit un message quelconque à son nouveau bot, puis ouvrir
   `https://api.telegram.org/bot<JETON>/getUpdates` et noter `chat.id`.
3. Dépôt → **Settings → Secrets and variables → Actions** : secrets `TELEGRAM_BOT_TOKEN` et `TELEGRAM_CHAT_ID`,
   et (onglet Variables) `SITE_URL` avec l'adresse du site.

Règles d'alerte : annonce **nouvelle**, publiée il y a moins de 3 jours, qui passe tous les filtres stricts, avec un
score ≥ seuil (55 par défaut), pas un doublon. Maximum 8 messages par passage. Le premier passage ne notifie rien
(il remplit simplement la base).

WhatsApp : pas d'API officielle gratuite pour envoyer à un particulier. Telegram est le choix pragmatique.

### Enregistrer les critères pour le bot

Le site classe déjà avec les critères réglés dans le navigateur. Pour que le **bot** (alertes) les connaisse, ils doivent
être dans `docs/criteria.json`. Deux façons :

- Depuis le site : ⚙ → dépôt + jeton GitHub (fine-grained, limité à ce dépôt, permission *Contents: read & write*),
  puis « Enregistrer pour le bot ». Le jeton reste dans le navigateur. Mécanisme (lecture du sha, écriture,
  mise à jour, suppression) **testé le 22/09/2026 directement contre l'API GitHub réelle**, sur un fichier
  jetable — fonctionne comme prévu.
- À la main : éditer `docs/criteria.json`.
- Automatiquement quand elle valide une proposition du bot Claude (ci-dessous), si la synchronisation est
  déjà configurée dans ⚙ ; sinon le message le lui rappelle.

> **Historique :** un questionnaire « Ma recherche en détail » (formulaire + envoi manuel du récapitulatif à Sacha) a existé
> jusqu'au 23/09/2026. Retiré : elle ne parle plus qu'au bot Claude, et tout ce qui compte part automatiquement dans le
> journal partagé (ci-dessous) — plus besoin qu'elle envoie quoi que ce soit elle-même.

### Bot Claude (« Demander à Claude ») et la mascotte

Un widget de chat dans le site : Tabatha discute pour ajuster ses critères, Claude répond et — si elle demande clairement
un changement — propose un nouveau réglage complet (diff affiché : « Budget max : 900 € → 850 € »). Elle valide d'un tap ;
ça s'applique sur le site, et si la synchronisation (⚙) est déjà configurée, ça part aussi vers `docs/criteria.json`.

Une petite mascotte (dessinée pour ce site, `#mascotte-def` dans `docs/index.html` — pas le personnage du manga
d'inspiration) flotte en bas de l'écran et ouvre le même chat. Elle apparaît aussi à côté du panneau « Mes critères » et
sur chaque annonce, pour montrer que tout est modifiable en discutant. Une bulle d'accueil (une fois par appareil)
explique la transparence : ce qu'elle dit au bot et ses ♥ / ✕ / notes sont vus par Sacha. Après un changement de critères,
une bulle légère (👍/👎, une fois par appareil) récolte un avis rapide.

### Journal partagé (`docs/data/journal.json`)

Remplace l'ancien envoi manuel : chaque échange de chat, et chaque action notable (♥ garder, ✕ écarter, note personnelle
sur une annonce, changement de critères — panneau ou bot —, ajout manuel, avis 👍/👎 à la mascotte) est ajouté par le
**Worker** à `docs/data/journal.json`, en tâche de fond (`ctx.waitUntil`, jamais bloquant pour elle). Fichier plafonné aux
600 dernières entrées. Sacha (et Claude Code, voir `CLAUDE.md`) le lit directement dans le dépôt — pas besoin qu'elle
envoie quoi que ce soit. Nécessite le secret `GITHUB_TOKEN` du Worker (voir plus bas) ; sans lui, le journal reste vide
mais rien d'autre n'est affecté (échec silencieux, par design).

**Limite assumée :** chaque événement crée un commit sur le dépôt public (mécanisme testé, voir plus bas) — l'historique
Git se remplit vite. Pour un outil à usage strictement personnel, ce n'est pas gênant ; à reconsidérer (squash périodique,
ou déplacer vers une vraie base) si ça devient pénible.

**Architecture** — le site est public et statique (GitHub Pages) : une clé Anthropic posée dedans serait lisible par
n'importe qui. Elle reste donc côté serveur, dans un petit **Worker Cloudflare** (`worker/`) qui sert de relais :
```
Site (navigateur) → Worker Cloudflare (clé Claude en secret) → API Anthropic
                        └─ valide/clampe la proposition avant de la renvoyer
```
- Modèle : `claude-haiku-4-5-20251001`, appelé avec un outil (`tool use`) `propose_criteria` dont le schéma vient de
  `docs/score.mjs` (`CRITERES`) — pas de duplication.
- Protections : CORS restreint à l'origine du site, jeton `APP_TOKEN` (non sensible, juste pour filtrer les robots),
  limite de débit **20 requêtes/min par IP** (binding `ratelimit` Cloudflare), prompt qui cantonne le sujet à cette
  appli, et **reclamping serveur** de tout ce que le modèle renvoie (bornes numériques, énumérations) avant de le
  transmettre au navigateur — jamais de confiance aveugle dans la sortie du modèle.
- Testé le 22/09/2026 en conditions réelles : changement de critère bien interprété (budget vs préférence
  d'arrondissement distingués), question simple sans proposition, refus poli d'une demande hors sujet.
- Testé le 23/09/2026 après ajout du journal : l'endpoint `{"kind":"event",...}` répond `{"ok":true}` sans
  `GITHUB_TOKEN` (n'échoue pas), rejette un type d'événement inconnu (400), et le chat continue de fonctionner.

**Déploiement / maintenance** (`worker/`) :
```bash
cd worker
npx wrangler login                          # une fois, ouvre le navigateur (compte Cloudflare)
npx wrangler deploy                         # publie/republie le Worker
npx wrangler secret put ANTHROPIC_API_KEY   # colle la clé quand demandé — jamais ailleurs
npx wrangler secret put GITHUB_TOKEN        # pour que le journal puisse écrire sur le dépôt (voir ci-dessous)
npx wrangler secret list                    # vérifie qu'ils existent, sans jamais les afficher
npx wrangler tail                           # logs en direct, utile en cas de souci
```
Après un premier déploiement, reporter l'URL affichée dans `docs/config.json` (`botUrl`). `botToken` doit être identique
à `APP_TOKEN` dans `worker/wrangler.jsonc`. Coût : gratuit à ce volume (palier gratuit Workers + rate limiting), seul
l'usage de l'API Anthropic est facturé à Sacha (modèle Haiku, conversations courtes → quelques centimes au pire).

**`GITHUB_TOKEN`** — un jeton fine-grained ne peut être créé que depuis l'interface web GitHub, pas en CLI :
1. `github.com/settings/personal-access-tokens/new` → *Repository access* : « Only select repositories » →
   `szaouati/recherche-appart` uniquement.
2. *Permissions* → *Repository permissions* → **Contents : Read and write**. Rien d'autre.
3. Générer, copier, puis `npx wrangler secret put GITHUB_TOKEN` dans `worker/` et le coller quand demandé.

## Utilisation locale

```bash
node collector/collect.mjs            # collecte complète (~6 s) et écrit docs/data/listings.json
node collector/collect.mjs --quick    # seulement les annonces les plus récentes
node collector/collect.mjs --dry      # simulation : n'écrit rien, n'envoie rien, affiche les alertes
python3 -m http.server 8765 --directory docs   # puis http://localhost:8765
node --test test/*.test.mjs           # 11 tests (filtres, score, verdicts, détection de caractéristiques)
```

## Comment l'annonce est notée

1. **Filtres stricts** (budget, surface, pièces, arrondissements, meublé, RDC, DPE F/G, colocation) : une annonce qui
   échoue est écartée, avec la raison visible (« Pourquoi écartée ? »). Une donnée **absente** ne disqualifie pas :
   l'annonce reste, marquée « À vérifier ».
2. **Score 0-100** en interne = Σ(poids × valeur) / Σ(poids), poids de 0 à 5 réglables. Ce qui n'apparaît pas dans
   l'annonce vaut 0 (on ne devine pas). **Ce chiffre n'est plus affiché à Tabatha** : depuis le 23/09/2026,
   `verdictScore(rang, total)` (`docs/score.mjs`) le traduit en avis relatif au marché disponible (« Sa meilleure
   option pour l'instant », « Lui correspond très bien », « Un bon compromis », « Passable pour elle », « Assez loin
   de ses critères »), calculé sur le **rang** parmi les annonces retenues plutôt que sur une note absolue — utile
   dans un marché tendu où le meilleur score réel peut être bas. Le détail chiffré par critère reste disponible dans
   « Pourquoi cet avis ? » pour qui veut creuser.
3. Les caractéristiques « balcon », « lumineux », « calme », etc. sont lues **dans le texte** de l'annonce (avec gestion des
   négations : « sans balcon »). C'est une heuristique, pas une donnée structurée.

Seuil d'alerte Telegram par défaut : 55/100 (score interne, indépendant du libellé affiché). À ajuster avec l'usage.

## Limites connues

- **API Bien'ici non officielle** : le format peut changer. Le site affiche alors « source en panne » et le workflow
  passe au rouge si toutes les sources échouent.
- **Annonces « 1970 »** : l'API renvoie des dizaines de milliers d'entrées à date de publication 1970 (~88 000 pour Paris).
  Elles sont ignorées (hypothèse : annonces périmées), ainsi que toute annonce publiée il y a plus de 75 jours.
- **Doublons** : une même annonce postée par plusieurs agences est repérée par (prix, surface, arrondissement, étage,
  pièces) et masquée. Clé volontairement prudente : elle ne s'applique que si tous ces champs sont connus.
- **Favoris / écartées / notes / annonces manuelles** sont stockés dans le navigateur (localStorage), donc par appareil —
  si elle utilise le site sur deux appareils, chacun a son propre état. Ces actions sont aussi envoyées au journal
  partagé (ci-dessus), donc Sacha les voit même si elles ne sont pas synchronisées entre ses appareils à elle.
- **Pas de proximité métro** : il faudrait croiser avec les données de stations, non fait dans le prototype.
- **Fraîcheur GitHub Actions** : les crons peuvent être retardés de plusieurs minutes aux heures de pointe.

## Confidentialité

GitHub Pages depuis un dépôt privé exige un plan payant. Avec un dépôt **public**, `docs/criteria.json` (budget, critères)
est lisible par tous. Si c'est gênant : dépôt privé + Pages (GitHub Pro), ou héberger `docs/` sur Cloudflare Pages
derrière Cloudflare Access. La page contient `noindex` mais ce n'est pas une protection.

## Phase 2 : alertes e-mail (PAP, SeLoger, Leboncoin)

Adresse dédiée `alertes.appart.tabatha@gmail.com`, créée le 22/09/2026, alertes PAP et SeLoger opérationnelles depuis le
22/09/2026 (Leboncoin à créer). Une source `collector/sources/email.mjs` (à écrire) lira ces e-mails et extraira lien /
prix / surface / arrondissement de chaque annonce, pour les injecter dans le même pipeline (donc même score, même alerte
Telegram, mêmes filtres).

Extraction envisagée via l'API Claude (un appel structuré par e-mail, plutôt qu'un analyseur regex par site — plus robuste
aux changements de template, pas besoin de code spécifique par expéditeur) : clé `ANTHROPIC_API_KEY` en secret GitHub
Actions (jamais côté navigateur), valeurs reclampées après coup comme le fait déjà `worker/src/index.mjs` pour les
critères, contenu de l'e-mail traité comme une donnée non fiable et jamais comme des instructions.

Accès à la boîte : le connecteur Gmail d'une session Claude Code peut être relié directement à
`alertes.appart.tabatha@gmail.com` (confirmé le 23/09/2026) — à revérifier si beaucoup de temps a passé avant de lire
quoi que ce soit. Sinon, IMAP classique avec les secrets `IMAP_USER` / `IMAP_APP_PASSWORD` (déjà enregistrés le
22/09/2026). Voir `CLAUDE.md` § pipeline e-mail pour la suite.
