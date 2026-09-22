// Relais entre le site (statique, public) et l'API Anthropic : la clé Claude reste ici, jamais dans
// le navigateur. Réutilise docs/score.mjs comme unique source de vérité pour la forme des critères.
import { CRITERES, mergeCriteria } from '../../docs/score.mjs';

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 700;
const MAX_HISTORY = 12; // derniers messages envoyés en contexte (6 échanges)
const MAX_MSG_LEN = 1500;

function poidsSchema() {
  const properties = {};
  for (const [k] of CRITERES) properties[k] = { type: 'integer', minimum: 0, maximum: 5 };
  return { type: 'object', properties, additionalProperties: false };
}

const CRITERIA_TOOL = {
  name: 'propose_criteria',
  description:
    "Propose un nouveau réglage complet des critères de recherche, que Tabatha valide ou non avant application. " +
    "Renvoie toujours l'objet COMPLET (repars des critères actuels fournis, ne change que ce qui a été demandé).",
  input_schema: {
    type: 'object',
    properties: {
      budgetMax: { type: 'number', minimum: 300, maximum: 5000, description: 'Loyer maximum charges comprises, en euros' },
      surfaceMin: { type: 'number', minimum: 5, maximum: 200, description: 'Surface minimale en m²' },
      piecesMin: { type: 'integer', minimum: 1, maximum: 6 },
      arrondissements: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 20 }, description: 'Arrondissements autorisés ; vide = tout Paris' },
      arrondissementsPref: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 20 } },
      meuble: { type: 'string', enum: ['indifferent', 'oui', 'non'] },
      exclure: {
        type: 'object',
        properties: { rdc: { type: 'boolean' }, dpeFG: { type: 'boolean' }, coloc: { type: 'boolean' } },
        additionalProperties: false,
      },
      poids: poidsSchema(),
      alerteActive: { type: 'boolean' },
      alerteScoreMin: { type: 'integer', minimum: 0, maximum: 100 },
    },
    required: ['budgetMax', 'surfaceMin', 'piecesMin', 'arrondissements', 'meuble', 'exclure', 'poids', 'alerteActive', 'alerteScoreMin'],
  },
};

const clamp = (n, lo, hi, dflt) => (Number.isFinite((n = Number(n))) ? Math.min(hi, Math.max(lo, n)) : dflt);
const listeArr = (a) => (Array.isArray(a) ? [...new Set(a.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 20))] : []);

// Ne jamais faire confiance telle quelle à la sortie du modèle, même hors contexte adverse :
// on reclampe tout aux mêmes bornes que le schéma, en repartant des critères actuels en cas de doute.
function validerProposition(p, actuel) {
  if (!p || typeof p !== 'object') return null;
  const c = mergeCriteria(actuel);
  return mergeCriteria({
    budgetMax: clamp(p.budgetMax, 300, 5000, c.budgetMax),
    surfaceMin: clamp(p.surfaceMin, 5, 200, c.surfaceMin),
    piecesMin: clamp(p.piecesMin, 1, 6, c.piecesMin),
    arrondissements: listeArr(p.arrondissements),
    arrondissementsPref: listeArr(p.arrondissementsPref),
    meuble: ['indifferent', 'oui', 'non'].includes(p.meuble) ? p.meuble : c.meuble,
    exclure: {
      rdc: typeof p.exclure?.rdc === 'boolean' ? p.exclure.rdc : c.exclure.rdc,
      dpeFG: typeof p.exclure?.dpeFG === 'boolean' ? p.exclure.dpeFG : c.exclure.dpeFG,
      coloc: typeof p.exclure?.coloc === 'boolean' ? p.exclure.coloc : c.exclure.coloc,
    },
    poids: Object.fromEntries(CRITERES.map(([k]) => [k, clamp(p.poids?.[k], 0, 5, c.poids[k])])),
    alerteActive: typeof p.alerteActive === 'boolean' ? p.alerteActive : c.alerteActive,
    alerteScoreMin: clamp(p.alerteScoreMin, 0, 100, c.alerteScoreMin),
  });
}

function corsHeaders(origin, allowed) {
  const ok = allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : 'null',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Token',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

const json = (obj, status, headers) => new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json' } });

export default {
  async fetch(request, env) {
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin, allowed);

    if (request.method === 'OPTIONS') return new Response(null, { headers });
    if (request.method !== 'POST') return json({ error: 'Méthode non supportée' }, 405, headers);
    if (!allowed.includes(origin)) return json({ error: 'Origine non autorisée' }, 403, headers);
    if (request.headers.get('X-App-Token') !== env.APP_TOKEN) return json({ error: 'Jeton invalide' }, 401, headers);

    const ip = request.headers.get('CF-Connecting-IP') || 'inconnu';
    try {
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return json({ error: 'Trop de messages, réessaie dans une minute.' }, 429, headers);
    } catch (e) {
      console.error('rate limiter indisponible', e); // on continue plutôt que de bloquer le service
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'JSON invalide' }, 400, headers);
    }

    const message = String(body.message ?? '').slice(0, MAX_MSG_LEN).trim();
    if (!message) return json({ error: 'Message vide' }, 400, headers);
    const history = (Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY) : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MSG_LEN) }));
    const actuel = mergeCriteria(body.criteria && typeof body.criteria === 'object' ? body.criteria : {});

    const system = [
      'Tu es l\'assistant du site "Mon appart à Paris", qui aide Tabatha à régler ses critères de recherche de location.',
      'Réponds toujours en français, en une ou deux phrases courtes, ton chaleureux et concret.',
      "Restreins-toi strictement aux critères de recherche d'appartement : pour toute autre demande, dis poliment que tu n'es là que pour ça.",
      `Critères actuels (JSON) : ${JSON.stringify(actuel)}`,
      "Si elle demande clairement un changement (budget, surface, pièces, arrondissement, meublé, ce qui compte pour elle, seuil d'alerte…), appelle propose_criteria avec l'objet COMPLET mis à jour (repars des critères actuels, ne change que ce qui a été demandé). Sinon, réponds simplement, sans appeler l'outil.",
    ].join('\n');

    let data;
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system, messages: [...history, { role: 'user', content: message }], tools: [CRITERIA_TOOL] }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!r.ok) throw new Error(`Anthropic HTTP ${r.status} : ${(await r.text()).slice(0, 300)}`);
      data = await r.json();
    } catch (e) {
      console.error(e);
      return json({ error: "Je n'ai pas pu réfléchir à ta demande là. Réessaie dans une minute, ou règle directement les curseurs." }, 502, headers);
    }

    const texte = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const outil = (data.content ?? []).find((b) => b.type === 'tool_use' && b.name === 'propose_criteria');
    const proposal = outil ? validerProposition(outil.input, actuel) : null;

    return json({ reply: texte || (proposal ? 'Voilà ce que je te propose :' : '…'), proposal }, 200, headers);
  },
};
