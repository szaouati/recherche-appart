# Import des exports PDF du matin (Leboncoin / SeLoger / PAP)

Leboncoin bloque tout accès automatisé (captcha) : Sacha exporte chaque matin la page de résultats en PDF
(Chrome → Imprimer → Enregistrer en PDF). Les PDF conservent les liens directs de chaque annonce.

- `extract_leboncoin.py <pdf>` → JSON (id d'annonce, prix, surface, pièces, étage, quartier…).
  Piège déjà rencontré : les rectangles de lien se chevauchent et une même annonce peut être coupée entre deux
  pages ; il faut fusionner par `min(y0)/max(y1)` et ne marquer une annonce « vue » qu'une fois prix+surface trouvés.
- SeLoger : mêmes principes, mais le prix se trouve ~400 pt SOUS le haut du rectangle du lien (segmenter chaque
  carte du début de son lien jusqu'au début du suivant). Valeur de référence pour vérifier : `26UQGQUJT971` = 804 €/14 m²
  (issue de l'e-mail décodé). Des cartes sortent parfois vides (contenu chargé en différé) : prix seul, à signaler.
- PAP : liens `/annonces/...-rNNN`, peu d'annonces.

Règles : dédoublonner sur (prix, surface arrondie, pièces) face à `docs/data/etat.json` (manuel) ET
`docs/data/listings.json` ; ignorer RDC, colocation, hors 18e ; ne JAMAIS supprimer ni écraser les annonces
des jours précédents (ajout uniquement, via `POST /etat {action:'ajouter_manuel'}` ; `modifier_manuel` pour corriger).
Ne pas toucher à `vuJusqua` : « Nouveautés » montre tout ce qu'elle n'a pas encore consulté.
