// Détecte des caractéristiques dans le texte libre d'une annonce.
// Heuristique : on ignore les mentions niées (« sans balcon », « pas d'ascenseur »).

const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

const NEGATION = /(sans|pas de|pas d'|aucun|aucune|ni|non)\s*(de |d')?$/;

function mentionne(texte, regex) {
  const re = new RegExp(regex.source, 'g');
  for (const m of texte.matchAll(re)) {
    const avant = texte.slice(Math.max(0, m.index - 16), m.index);
    if (!NEGATION.test(avant)) return true;
  }
  return false;
}

const PATTERNS = {
  balcon: /\bbalcon/,
  terrasse: /\bterrasse/,
  lumineux: /lumineu|ensoleill|baigne de lumiere|tres clair/,
  calme: /\bcalme|silencieu/,
  traversant: /traversant|double exposition/,
  cave: /\bcave\b/,
  parking: /parking|garage|\bbox\b/,
  parquet: /parquet/,
};

// Ces deux-là ne sont lues que dans le titre : « sous-location interdite » est une clause
// classique dans la description d'un bail normal, ce n'est pas un signal d'alerte.
const PATTERNS_TITRE = {
  coloc: /colocation|\bcoloc\b/,
  sousLocation: /sous-?location|sous-?louer/,
  rdc: /rez[- ]de[- ]chaussee|\brdc\b/,
};

export function extractFeatures(titre, description) {
  const t = norm(titre);
  const d = norm(`${titre} ${description}`);
  const f = {};
  for (const [k, re] of Object.entries(PATTERNS)) if (mentionne(d, re)) f[k] = true;
  for (const [k, re] of Object.entries(PATTERNS_TITRE)) if (mentionne(t, re)) f[k] = true;
  return f;
}
