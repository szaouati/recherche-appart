// Relais entre le site (statique, public) et l'API Anthropic : la clé Claude reste ici, jamais dans
// le navigateur. Réutilise docs/score.mjs comme unique source de vérité pour la forme des critères.
//
// Depuis le 23/09/2026, ce Worker est aussi la seule source de vérité pour l'état PARTAGÉ entre tous
// les appareils qui ouvrent le site (Sacha, Tabatha, n'importe quel autre) : critères de recherche
// (docs/criteria.json), et favoris/écartés/notes/annonces ajoutées à la main (docs/data/etat.json).
// Avant, chaque appareil gardait ces réglages dans son propre localStorage : deux téléphones
// pouvaient diverger. Maintenant, le site lit et écrit toujours via ce Worker, qui lit/écrit les
// fichiers du dépôt avec son propre jeton GitHub (jamais exposé au navigateur) et sert d'arbitre
// unique en cas d'écritures concurrentes (retry-once-on-409, comme le journal).
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

// Ne jamais faire confiance telle quelle à la sortie du modèle ou à ce qu'envoie le navigateur, même
// hors contexte adverse : on reclampe tout aux mêmes bornes que le schéma, en repartant des critères
// actuels en cas de doute.
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
  };
}

const json = (obj, status, headers) => new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json' } });

// --- Lecture / écriture générique d'un fichier JSON du dépôt ------------------------------------
async function lireJSON(env, path, vide) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`;
  const headers = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'recherche-appart-bot' };
  const r = await fetch(url, { headers });
  if (r.status === 404) return { sha: undefined, data: vide };
  if (!r.ok) throw new Error(`GitHub GET ${path} ${r.status}`);
  const body = await r.json();
  try {
    return { sha: body.sha, data: JSON.parse(decodeURIComponent(escape(atob(body.content)))) };
  } catch {
    return { sha: body.sha, data: vide };
  }
}

async function ecrireJSON(env, path, data, sha, message) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`;
  const headers = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'recherche-appart-bot' };
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2) + '\n')));
  return fetch(url, { method: 'PUT', headers, body: JSON.stringify({ message, content, sha, branch: 'main' }) });
}

// --- Journal partagé -------------------------------------------------------------------------
// Chaque échange avec le bot et chaque action notable de Tabatha dans l'appli (♥, ✕, note,
// changement de critères) est ajouté à docs/data/journal.json dans le dépôt, en tâche de fond
// (ctx.waitUntil) : jamais bloquant, jamais fatal pour la réponse au navigateur si ça échoue —
// c'est un journal utile pour Sacha, pas une fonctionnalité vitale de l'appli.
const MAX_ENTRIES = 600;

async function appendJournal(env, entry) {
  if (!env.GITHUB_TOKEN) return; // pas encore configuré : on n'échoue pas bruyamment pour autant
  const path = env.JOURNAL_PATH || 'docs/data/journal.json';
  try {
    let { sha, data } = await lireJSON(env, path, { entries: [] });
    if (!Array.isArray(data.entries)) data.entries = [];
    data.entries.push({ ts: new Date().toISOString(), ...entry });
    data.entries = data.entries.slice(-MAX_ENTRIES);
    let res = await ecrireJSON(env, path, data, sha, `Journal : ${entry.type ?? entry.kind ?? 'mise à jour'}`);
    if (res.status === 409) {
      // Deux écritures concurrentes (ex. un tap ♥ juste après une réponse du chat) : on relit et on réessaie une fois.
      const retry = await lireJSON(env, path, { entries: [] });
      if (!Array.isArray(retry.data.entries)) retry.data.entries = [];
      retry.data.entries.push({ ts: new Date().toISOString(), ...entry });
      retry.data.entries = retry.data.entries.slice(-MAX_ENTRIES);
      res = await ecrireJSON(env, path, retry.data, retry.sha, `Journal : ${entry.type ?? entry.kind ?? 'mise à jour'}`);
    }
    if (!res.ok) console.error('journal: écriture GitHub échouée', res.status, await res.text());
  } catch (e) {
    console.error('journal: erreur', e);
  }
}

const TYPES_EVENEMENT = ['fav', 'ecarte', 'note', 'critere_change', 'ajout_manuel', 'avis'];

// --- État partagé (favoris/écartés/notes/annonces manuelles) -----------------------------------
// Un Worker Cloudflare réutilise le même module (donc les mêmes objets au niveau module) entre
// plusieurs requêtes successives dans un isolate. `etatVide()` doit donc renvoyer un objet NEUF à
// chaque appel — jamais une constante partagée — sinon deux requêtes qui tombent toutes les deux sur
// « docs/data/etat.json » introuvable (ou illisible) se retrouveraient à muter le MÊME objet en
// mémoire, et donc à mélanger leurs données. `etatPropre` fait pareil par précaution : elle ne
// renvoie jamais telles quelles les sous-structures de `data`, toujours des copies fraîches.
const etatVide = () => ({ statut: {}, notes: {}, manuel: [], vuJusqua: null });

function etatPropre(data) {
  return {
    statut: data?.statut && typeof data.statut === 'object' ? { ...data.statut } : {},
    notes: data?.notes && typeof data.notes === 'object' ? { ...data.notes } : {},
    manuel: Array.isArray(data?.manuel) ? [...data.manuel] : [],
    vuJusqua: typeof data?.vuJusqua === 'string' ? data.vuJusqua : null,
  };
}

async function lireEtat(env) {
  const { data } = await lireJSON(env, env.ETAT_PATH || 'docs/data/etat.json', etatVide());
  return etatPropre(data);
}

// Applique `muter` sur l'état actuel et écrit, avec un réessai (relecture + nouvelle application de
// la même mutation) en cas de conflit d'écriture — la mutation ne doit dépendre que de l'état qu'elle
// reçoit, jamais d'une valeur capturée avant coup, pour que ce réessai soit correct.
async function ecrireEtatMute(env, muter) {
  const path = env.ETAT_PATH || 'docs/data/etat.json';
  let { sha, data } = await lireJSON(env, path, etatVide());
  data = etatPropre(data);
  muter(data);
  data.updatedAt = new Date().toISOString();
  let res = await ecrireJSON(env, path, data, sha, 'État partagé : mise à jour');
  if (res.status === 409) {
    const retry = await lireJSON(env, path, etatVide());
    data = etatPropre(retry.data);
    muter(data);
    data.updatedAt = new Date().toISOString();
    res = await ecrireJSON(env, path, data, retry.sha, 'État partagé : mise à jour');
  }
  if (!res.ok) throw new Error(`GitHub PUT état ${res.status} : ${(await res.text()).slice(0, 300)}`);
  return data;
}

async function ecrireCriteriaPartage(env, propose) {
  const path = env.CRITERIA_PATH || 'docs/criteria.json';
  let { sha, data } = await lireJSON(env, path, {});
  let suivant = validerProposition(propose, mergeCriteria(data));
  let res = await ecrireJSON(env, path, suivant, sha, 'Critères partagés : mise à jour');
  if (res.status === 409) {
    const retry = await lireJSON(env, path, {});
    suivant = validerProposition(propose, mergeCriteria(retry.data));
    res = await ecrireJSON(env, path, suivant, retry.sha, 'Critères partagés : mise à jour');
  }
  if (!res.ok) throw new Error(`GitHub PUT critères ${res.status} : ${(await res.text()).slice(0, 300)}`);
  return suivant;
}

async function etatComplet(env) {
  const [{ data: critData }, etat] = await Promise.all([lireJSON(env, env.CRITERIA_PATH || 'docs/criteria.json', {}), lireEtat(env)]);
  return { criteria: mergeCriteria(critData), ...etat };
}

const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

// Construit l'annonce ajoutée à la main côté serveur : on fait confiance aux champs de contenu
// (prix, surface…) mais jamais à un id/horodatage fourni par le navigateur.
function construireAnnonceManuelle(l) {
  const now = new Date().toISOString();
  return {
    id: `manuel:${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    source: 'Manuel',
    url: typeof l?.url === 'string' ? l.url.slice(0, 500) : '',
    title: l?.title ? String(l.title).slice(0, 200) : null,
    price: num(l?.price),
    surface: num(l?.surface),
    rooms: num(l?.rooms),
    arrondissement: num(l?.arrondissement),
    floor: num(l?.floor),
    elevator: l?.elevator ? true : null,
    dpe: typeof l?.dpe === 'string' && /^[A-G]$/.test(l.dpe) ? l.dpe : null,
    furnished: null,
    features: l?.balcon || l?.features?.balcon ? { balcon: true } : {},
    first_seen: now,
    last_seen: now,
    publishedAt: now,
    photo: null,
  };
}

export default {
  async fetch(request, env, ctx) {
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin, allowed);

    if (request.method === 'OPTIONS') return new Response(null, { headers });
    if (!allowed.includes(origin)) return json({ error: 'Origine non autorisée' }, 403, headers);
    if (request.headers.get('X-App-Token') !== env.APP_TOKEN) return json({ error: 'Jeton invalide' }, 401, headers);

    const ip = request.headers.get('CF-Connecting-IP') || 'inconnu';
    try {
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return json({ error: 'Trop de requêtes, réessaie dans une minute.' }, 429, headers);
    } catch (e) {
      console.error('rate limiter indisponible', e); // on continue plutôt que de bloquer le service
    }

    // Lecture de l'état partagé (critères + favoris/écartés/notes/annonces manuelles) : appelée au
    // chargement du site et régulièrement en tâche de fond pour que tous les appareils convergent.
    if (request.method === 'GET') {
      const { pathname } = new URL(request.url);
      if (pathname !== '/etat') return json({ error: 'Introuvable' }, 404, headers);
      try {
        return json(await etatComplet(env), 200, headers);
      } catch (e) {
        console.error(e);
        return json({ error: 'Lecture impossible' }, 502, headers);
      }
    }

    if (request.method !== 'POST') return json({ error: 'Méthode non supportée' }, 405, headers);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'JSON invalide' }, 400, headers);
    }

    // Écriture de l'état partagé : chaque appareil envoie son intention (« mets fav sur X »,
    // « voici mes nouveaux critères »…), le Worker l'applique sur l'état le plus frais possible et
    // renvoie l'état complet qui en résulte — c'est TOUJOURS cette réponse qui fait foi, jamais ce
    // que le navigateur avait localement, ce qui règle de lui-même les écritures simultanées.
    if (body.kind === 'etat') {
      try {
        if (body.action === 'set_criteria') {
          if (!body.criteria || typeof body.criteria !== 'object') return json({ error: 'critères invalides' }, 400, headers);
          const criteria = await ecrireCriteriaPartage(env, body.criteria);
          ctx.waitUntil(appendJournal(env, {
            kind: 'event', type: 'critere_change',
            payload: { source: typeof body.source === 'string' ? body.source : 'app', diff: Array.isArray(body.diff) ? body.diff.slice(0, 20) : undefined },
            criteria,
          }));
          return json({ criteria, ...(await lireEtat(env)) }, 200, headers);
        }

        const id = typeof body.id === 'string' && body.id ? body.id.slice(0, 200) : null;
        let etat;
        let journalType = null;
        let journalPayload = null;

        if (body.action === 'set_statut') {
          if (!id) return json({ error: 'id manquant' }, 400, headers);
          const valeur = ['fav', 'ecarte'].includes(body.valeur) ? body.valeur : null;
          etat = await ecrireEtatMute(env, (e) => { if (valeur) e.statut[id] = valeur; else delete e.statut[id]; });
          if (valeur) { journalType = valeur; journalPayload = { listingId: id, url: body.url, title: body.title, price: body.price }; }
        } else if (body.action === 'set_note') {
          if (!id) return json({ error: 'id manquant' }, 400, headers);
          const texte = String(body.texte ?? '').slice(0, 2000).trim();
          etat = await ecrireEtatMute(env, (e) => { if (texte) e.notes[id] = texte; else delete e.notes[id]; });
          journalType = 'note';
          journalPayload = { listingId: id, url: body.url, title: body.title, note: texte };
        } else if (body.action === 'set_vu') {
          const ts = Number.isFinite(Date.parse(body.ts)) ? body.ts : new Date().toISOString();
          etat = await ecrireEtatMute(env, (e) => { if (!e.vuJusqua || ts > e.vuJusqua) e.vuJusqua = ts; });
        } else if (body.action === 'ajouter_manuel') {
          const listing = construireAnnonceManuelle(body.listing);
          etat = await ecrireEtatMute(env, (e) => { e.manuel.unshift(listing); e.manuel = e.manuel.slice(0, 200); });
          journalType = 'ajout_manuel';
          journalPayload = { url: listing.url, title: listing.title, price: listing.price };
        } else if (body.action === 'supprimer_manuel') {
          // Retire une annonce ajoutée à la main devenue indisponible (louée, retirée), et les
          // favoris/notes qui lui étaient attachés. Réversible via l'historique git.
          if (!id) return json({ error: 'id manquant' }, 400, headers);
          let existait = false;
          etat = await ecrireEtatMute(env, (e) => {
            existait = e.manuel.some((x) => x.id === id);
            e.manuel = e.manuel.filter((x) => x.id !== id);
            delete e.statut[id];
            delete e.notes[id];
          });
          if (!existait) return json({ error: 'Annonce manuelle introuvable' }, 404, headers);
        } else if (body.action === 'modifier_manuel') {
          // Corrige un champ d'une annonce déjà ajoutée à la main (typiquement son url, quand on a
          // pu récupérer le vrai lien après coup — ex. Leboncoin, dont le captcha empêche de le
          // retrouver automatiquement au moment de l'ajout).
          if (!id) return json({ error: 'id manquant' }, 400, headers);
          const patch = body.patch && typeof body.patch === 'object' ? body.patch : {};
          const champsAutorises = ['url', 'title', 'price', 'surface', 'rooms', 'floor', 'dpe'];
          let trouve = false;
          etat = await ecrireEtatMute(env, (e) => {
            const l = e.manuel.find((x) => x.id === id);
            if (!l) return;
            trouve = true;
            if (typeof patch.url === 'string') l.url = patch.url.slice(0, 500);
            if (typeof patch.title === 'string') l.title = patch.title.slice(0, 200);
            for (const k of ['price', 'surface', 'rooms', 'floor']) if (patch[k] != null && Number.isFinite(Number(patch[k]))) l[k] = Number(patch[k]);
            if (typeof patch.dpe === 'string' && /^[A-G]$/.test(patch.dpe)) l.dpe = patch.dpe;
          });
          if (!trouve) return json({ error: 'Annonce manuelle introuvable' }, 404, headers);
        } else {
          return json({ error: 'Action inconnue' }, 400, headers);
        }

        if (journalType) {
          const criteria = mergeCriteria(body.criteria && typeof body.criteria === 'object' ? body.criteria : {});
          ctx.waitUntil(appendJournal(env, { kind: 'event', type: journalType, payload: journalPayload, criteria }));
        }
        const { data: critData } = await lireJSON(env, env.CRITERIA_PATH || 'docs/criteria.json', {});
        return json({ criteria: mergeCriteria(critData), ...etat }, 200, headers);
      } catch (e) {
        console.error(e);
        return json({ error: "Échec de l'enregistrement partagé, réessaie." }, 502, headers);
      }
    }

    // Simple fait à consigner qui ne fait pas partie de l'état partagé (avis 👍/👎 sur la mascotte) :
    // pas d'appel à Claude, juste un ajout au journal. Réponse immédiate, écriture en tâche de fond.
    if (body.kind === 'event') {
      const type = TYPES_EVENEMENT.includes(body.type) ? body.type : null;
      if (!type) return json({ error: 'Type d\'événement inconnu' }, 400, headers);
      let payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
      try {
        const s = JSON.stringify(payload);
        if (s.length > 4000) payload = { tronque: true, apercu: s.slice(0, 500) };
      } catch {
        payload = {};
      }
      const criteria = mergeCriteria(body.criteria && typeof body.criteria === 'object' ? body.criteria : {});
      ctx.waitUntil(appendJournal(env, { kind: 'event', type, payload, criteria }));
      return json({ ok: true }, 200, headers);
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
    const reply = texte || (proposal ? 'Voilà ce que je te propose :' : '…');

    ctx.waitUntil(appendJournal(env, { kind: 'chat', message, reply, proposal, criteria: actuel }));
    return json({ reply, proposal }, 200, headers);
  },
};
