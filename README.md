# Recherche d'appart à Paris — prototype

Un bot collecte les annonces de location parisiennes plusieurs fois par jour, les filtre et les note selon
les critères de Tabatha, puis la prévient sur Telegram quand une bonne annonce tombe. Un site lui permet
de régler ses critères et de consulter le classement chaque jour.

```
GitHub Actions (cron 30 min)  →  collector/collect.mjs  →  docs/data/listings.json  →  site (GitHub Pages)
                                        └─ score ≥ seuil ? → Telegram
```

- **Presque aucune dépendance npm.** Node 20+ suffit (le workflow utilise Node 22) — seule exception : `imapflow` +
  `mailparser` pour lire les alertes e-mail (IMAP/MIME), voir « Phase 2 ».
- **Un seul moteur de score** (`docs/score.mjs`) partagé par le site et par le bot : ils classent toujours pareil.
- Coût : 0 € (dépôt public). Voir « Confidentialité ».

## État des sources

| Source | État | Détail |
|---|---|---|
| Bien'ici | ✅ branchée, testée | API JSON du site. Agrège de nombreux réseaux d'agences. ~490 annonces parisiennes ≤ 1 500 € et ≥ 30 m² au 21/09/2026. |
| PAP, SeLoger, Leboncoin (accès direct) | ❌ bloqué | HTTP 403 dès la première requête, même avec des en-têtes de navigateur. Anti-bot + CGU. Non contournable proprement depuis GitHub Actions. |
| E-mail SeLoger | ✅ branchée, testée | IMAP + analyse HTML déterministe. Voir « Phase 2 ». |
| E-mail PAP, Leboncoin | 📬 alertes créées, pas encore lues | PAP : aucune vraie annonce reçue à ce jour. Leboncoin : alerte pas encore créée. |
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

Une petite mascotte (`docs/mascotte.webp` — image fournie par Sacha, recadrée et réduite pour le web depuis
`il_fullxfull.7846345879_12sa.webp`, 3000×3000 sans transparence à l'origine ; **origine et droits de réutilisation à
confirmer avec Sacha**, notamment parce que ce dépôt est public) flotte en bas de l'écran et ouvre le même chat.
Elle apparaît aussi à côté du panneau « Mes critères » et
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
node --test test/*.test.mjs           # 15 tests (filtres, score, verdicts, e-mail SeLoger, détection de caractéristiques)
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

**SeLoger : branché et actif** depuis le 23/09/2026 (`collector/sources/email.mjs`). PAP et Leboncoin : pas encore
(aucune vraie alerte PAP reçue à ce jour — budget/zone très restreints, 18e ≤ 900 €, normal que ça prenne du temps ;
Leboncoin n'a pas encore d'alerte créée). Voir `CLAUDE.md` § pipeline e-mail pour la suite.

Adresse dédiée `alertes.appart.tabatha@gmail.com`, créée le 22/09/2026. Lue par **IMAP** (`imapflow` + `mailparser`,
seules dépendances npm du projet — voir « Pourquoi deux dépendances » plus bas), secrets `IMAP_USER` /
`IMAP_APP_PASSWORD` déjà enregistrés le 22/09/2026. Incrémental : seuls les e-mails non lus (`\Seen`) sont traités,
puis marqués lus (succès ou échec — un e-mail durablement cassé n'est pas retenté à l'infini ; pour le refaire, le
remarquer non lu dans Gmail). 30 e-mails maximum par passage.

Le connecteur Gmail d'une session Claude Code peut aussi lire cette boîte directement (confirmé le 23/09/2026, utile
pour inspecter de nouveaux formats sans attendre un déploiement) — à revérifier si beaucoup de temps a passé.

### Décision : analyse déterministe du HTML, pas l'API Claude

Le plan initial prévoyait une extraction par l'API Claude (plus robuste si le format est inconnu). Une fois le format
SeLoger décodé sur de vrais e-mails (23/09/2026), une analyse déterministe s'est avérée meilleure : gratuite, instantanée,
sans dépendance à un service externe, et surtout **exacte** — le HTML porte des attributs `name="adprice1_2"` /
`adtype1_2` / `adcriteria1_2` / `adlocation1_2` / `adbutton1_2` qui identifient chaque champ sans ambiguïté (le suffixe
numérique est absent quand l'e-mail ne contient qu'une seule annonce, ex. le format « annonce exclusive » d'une agence
partenaire — `collector/lib/parse-seloger-email.mjs` gère les deux). L'API Claude reste la bonne option pour un
expéditeur dont le format n'a pas encore été décodé (PAP, Leboncoin) : à réévaluer une fois qu'un vrai e-mail de leur
part sera disponible.

**⚠️ Piège découvert en cours de route** : mon premier jet analysait la *conversion texte de Gmail* (celle que renvoie
l'outil de lecture d'e-mails, pratique pour repérer un format visuellement) plutôt que le **HTML brut** que IMAP fournit
réellement. Les deux ne s'écrivent pas pareil (linéarisation des liens différente) : un analyseur calé sur l'un ne
fonctionne pas forcément sur l'autre. `parse-seloger-email.mjs` a été réécrit contre le HTML brut avant d'être fiable —
tout futur analyseur (PAP, Leboncoin) doit être construit et testé contre le HTML brut (`parsed.html` de `mailparser`),
jamais contre une conversion texte d'outil de lecture.

### Format SeLoger, décodé le 23/09/2026 sur de vrais e-mails (`samples/seloger-*.txt`, gitignorés)

Trois échantillons réels sauvegardés (texte, pour référence rapide) : `seloger-1-annonce.txt`, `seloger-2-annonces.txt`
(plusieurs biens), `seloger-exclusif.txt` (agence partenaire). Le HTML brut correspondant a servi à écrire et tester
`parse-seloger-email.mjs` (fixtures réelles, allégées du CSS, dans `test/parse-seloger-email.test.mjs`).

- **Repère fiable** : chaque bien est encadré par `<!--LISTING--> … <!--END LISTING-->` et contient des liens
  `<a href="TRACKING_URL" name="adXXX...">` où XXX ∈ `{price, type, criteria, location, button}`. Le lien `adbutton`
  (texte « Voir l'annonce ») est LE lien de l'annonce — les autres (`adimage`, « Localisation différente », « Gérer mes
  alertes »…) sont des liens de navigation/désabonnement à ignorer.
- **Résolution de l'URL** : le lien `adbutton` (`https://click.by.seloger.com/?qs=…`) est un redirecteur 302, résolu en
  **un seul saut** (`fetch(url, {redirect:'manual'})`, testé) vers une URL stable du type
  `https://www.seloger.com/annonce/location/ile-de-france/paris-75/paris-75000/<ID>?utm_...`. `<ID>` (ex.
  `26BVYT451S9C`) sert d'identifiant unique (`seloger:<ID>`), l'URL nettoyée des `utm_*` de lien affiché. La page de
  l'annonce elle-même répond 403 en accès direct (anti-bot, comme Bien'ici) : inutile d'aller plus loin que le premier
  saut, on n'a pas besoin de charger la page.
- **⚠️ Incohérence constatée sur une vraie donnée** : un e-mail affichait le texte « Paris 17ème arrondissement » avec
  le code postal `(75015)` juste en dessous — les deux se contredisent. **Toujours dériver l'arrondissement du code
  postal à 5 chiffres**, jamais du texte ordinal (même logique que `collector/sources/bienici.mjs::arrondissement()`).
- **Prix** : dans le champ `adprice`, motif `NNN €/mois` (« charges comprises » dans un `<span>` séparé, ignoré).
- **Surface/pièces** : dans le champ `adcriteria`, motif `N pièce(s) · NN[,N] m²`.
- **Titre** (`adtype`) : parfois tronqué par SeLoger lui-même avec `...` — normal, ne pas essayer de le compléter.
- **Photo** : capturée en bonus depuis l'attribut `Background="...jpg"` du bloc (pas dans les champs `adXXX`).
- SeLoger élargit spontanément la zone quand peu de résultats correspondent exactement (« Nous avons élargi vos critères
  de recherches ») : des arrondissements hors zone apparaissent dans l'e-mail. Sans conséquence : le filtre strict sur
  `criteria.arrondissements` (déjà dans `docs/score.mjs`) les écartera comme pour toute autre source.

### Pourquoi deux dépendances npm (seule exception au « zéro dépendance »)

`imapflow` (client IMAP) et `mailparser` (décodage MIME : multipart, quoted-printable/base64, charsets). Hors de portée
d'un code fait main sans risque de bugs subtils et difficiles à détecter (encodages, dossiers imbriqués, littéraux
IMAP…) pour un gain minime. Toutes les autres sources (Bien'ici, le site, le Worker) restent sans dépendance.
`.github/workflows/collect.yml` installe désormais via `npm ci` avant de lancer la collecte.
