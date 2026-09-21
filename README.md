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
| Alertes e-mail (PAP, SeLoger, Leboncoin, Jinka) | ⏳ à faire | Voie recommandée pour les particuliers. Voir plus bas. |
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
  puis « Enregistrer pour le bot ». Le jeton reste dans le navigateur. **Cette fonction n'a pas été testée contre l'API GitHub réelle.**
- À la main : éditer `docs/criteria.json`.

### « Ma recherche en détail » (retour de Tabatha vers Sacha)

Le bouton du même nom ouvre un questionnaire libre (rédhibitoires, quartiers, trajet, dates, budget « coup de cœur »…). Il génère un
récapitulatif texte = critères chiffrés + réponses + JSON prêt à coller dans `docs/criteria.json`. Elle l'envoie via le bouton de
partage du téléphone (WhatsApp, iMessage…) ou le bouton « Copier ». Réponses stockées uniquement dans son navigateur.

`docs/config.json` (facultatif) : `contactEmail` ajoute un bouton « Envoyer par e-mail » ; `alertEmail` affiche l'adresse dédiée
dans l'assistant d'alertes. Ces deux valeurs sont **publiques** (dépôt public) : ne les renseigne que si tu l'acceptes.

## Utilisation locale

```bash
node collector/collect.mjs            # collecte complète (~6 s) et écrit docs/data/listings.json
node collector/collect.mjs --quick    # seulement les annonces les plus récentes
node collector/collect.mjs --dry      # simulation : n'écrit rien, n'envoie rien, affiche les alertes
python3 -m http.server 8765 --directory docs   # puis http://localhost:8765
node --test test/*.test.mjs           # 8 tests (filtres, score, détection de caractéristiques)
```

## Comment l'annonce est notée

1. **Filtres stricts** (budget, surface, pièces, arrondissements, meublé, RDC, DPE F/G, colocation) : une annonce qui
   échoue est écartée, avec la raison visible (« Pourquoi écartée ? »). Une donnée **absente** ne disqualifie pas :
   l'annonce reste, marquée « À vérifier ».
2. **Score 0-100** = Σ(poids × valeur) / Σ(poids), poids de 0 à 5 réglables. Ce qui n'apparaît pas dans l'annonce vaut 0
   (on ne devine pas). Le détail par critère est dépliable sur chaque carte.
3. Les caractéristiques « balcon », « lumineux », « calme », etc. sont lues **dans le texte** de l'annonce (avec gestion des
   négations : « sans balcon »). C'est une heuristique, pas une donnée structurée.

Calibrage : sur les données du 21/09/2026, le meilleur score est ~71 et 10 % des annonces retenues dépassent 54. D'où le
seuil d'alerte par défaut à 55. À ajuster avec l'usage.

## Limites connues

- **API Bien'ici non officielle** : le format peut changer. Le site affiche alors « source en panne » et le workflow
  passe au rouge si toutes les sources échouent.
- **Annonces « 1970 »** : l'API renvoie des dizaines de milliers d'entrées à date de publication 1970 (~88 000 pour Paris).
  Elles sont ignorées (hypothèse : annonces périmées), ainsi que toute annonce publiée il y a plus de 75 jours.
- **Doublons** : une même annonce postée par plusieurs agences est repérée par (prix, surface, arrondissement, étage,
  pièces) et masquée. Clé volontairement prudente : elle ne s'applique que si tous ces champs sont connus.
- **Favoris / écartées / annonces manuelles** sont stockés dans le navigateur (localStorage), donc par appareil.
- **Pas de proximité métro** : il faudrait croiser avec les données de stations, non fait dans le prototype.
- **Fraîcheur GitHub Actions** : les crons peuvent être retardés de plusieurs minutes aux heures de pointe.

## Confidentialité

GitHub Pages depuis un dépôt privé exige un plan payant. Avec un dépôt **public**, `docs/criteria.json` (budget, critères)
est lisible par tous. Si c'est gênant : dépôt privé + Pages (GitHub Pro), ou héberger `docs/` sur Cloudflare Pages
derrière Cloudflare Access. La page contient `noindex` mais ce n'est pas une protection.

## Phase 2 : alertes e-mail (PAP, SeLoger, Leboncoin)

Principe : une adresse dédiée reçoit les alertes créées par Tabatha sur chaque site (ou une alerte Jinka, qui regroupe
plusieurs sources). Une source `collector/sources/email.mjs` lit la boîte en IMAP, extrait lien / prix / surface / arrondissement
de chaque annonce, et les injecte dans le même pipeline (donc même score, même alerte Telegram).

Ce qui manque pour l'écrire correctement : **un vrai e-mail d'alerte de chaque site**. Le format de chaque expéditeur est
différent, et les liens SeLoger passent par un redirecteur de suivi (l'identifiant de l'annonce doit en être extrait pour éviter
les doublons). Écrire le parseur à l'aveugle donnerait du code non vérifié.
