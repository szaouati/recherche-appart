// Écrans du site (chaque fonction renvoie du HTML ; app.js s'occupe du routage et des événements).
import { STATUTS_LIBELLES, relanceDue } from '../agent-ui.mjs';
import { esc, safeUrl, eur, depuis } from './util.mjs';
import { S, visible, annonceParId } from './etat.mjs';
import { carte, squeletteCartes, visuel, badges, verdictDe, boutonCoeur, ICONES } from './cartes.mjs';
import { htmlCriteres } from './criteres.mjs';
import { quartier, typeLogement, etageLibelle, prixM2, surfaceLibelle, sourceAffichee } from './annonce-ui.mjs';

export const ui = { seg: 'nouveautes', limite: 30, segInitialise: false };

// --- Sélections ------------------------------------------------------------
const retenues = () => S.ranked.filter((l) => l.ok && visible(l) && S.statut[l.id] !== 'ecarte');
export const nouvelles = () => retenues().filter((l) => l.first_seen > S.vuJusqua);
export const favoris = () => S.ranked.filter((l) => S.statut[l.id] === 'fav');
export const ecartees = () => S.ranked.filter((l) => S.statut[l.id] === 'ecarte');
export const relancesDues = () => Object.values(S.contacts).filter((c) => relanceDue(c)).length;

const vide = (titre, texte, action = '') => `<div class="vide"><b>${esc(titre)}</b><p>${esc(texte)}</p>${action}</div>`;

// --- Annonces --------------------------------------------------------------
export function vueAnnonces() {
  if (!S.charge) return `<ul class="liste">${squeletteCartes(4)}</ul>`;
  if (S.erreurChargement) return vide('Impossible de charger les annonces', 'Le fichier data/listings.json ne répond pas. Réessaie dans un moment, ou préviens Sacha.', '<button class="btn" data-recharger>Réessayer</button>');
  if (!ui.segInitialise) { ui.segInitialise = true; if (!nouvelles().length) ui.seg = 'meilleures'; }
  const n = nouvelles();
  const m = retenues();
  const liste = ui.seg === 'nouveautes' ? n : m;
  const msgVide = ui.seg === 'nouveautes'
    ? ['Rien de nouveau depuis ta dernière visite', 'Regarde les « Meilleures » en attendant.', '<button class="btn" data-seg="meilleures">Voir les meilleures</button>']
    : ['Aucune annonce ne passe tes critères', 'Essaie d\'élargir le budget ou les arrondissements.', '<a class="btn" href="#/plus/criteres">Modifier mes critères</a>'];
  const maj = S.meta.generatedAt ? `${(S.meta.count ?? 0).toLocaleString('fr-FR')} annonces suivies · mise à jour ${depuis(S.meta.generatedAt)}` : '';
  return `<div class="segs" role="tablist" aria-label="Affichage">
      <button role="tab" aria-selected="${ui.seg === 'nouveautes'}" data-seg="nouveautes">Nouveautés<em>${n.length}</em></button>
      <button role="tab" aria-selected="${ui.seg === 'meilleures'}" data-seg="meilleures">Meilleures<em>${m.length}</em></button>
    </div>
    <div class="barre-liste"><span>${liste.length} annonce${liste.length > 1 ? 's' : ''}</span>
      ${ui.seg === 'nouveautes' && liste.length ? '<button class="texte-btn" data-vu>Tout marquer comme vu</button>' : ''}</div>
    ${liste.length ? `<ul class="liste">${liste.slice(0, ui.limite).map(carte).join('')}</ul>` : vide(...msgVide)}
    ${liste.length > ui.limite ? '<button class="btn plus-btn" data-plus>Afficher plus</button>' : ''}
    ${maj ? `<p class="maj">${esc(maj)}</p>` : ''}`;
}

// --- Favoris ---------------------------------------------------------------
export function vueFavoris() {
  if (!S.charge) return `<ul class="liste">${squeletteCartes(2)}</ul>`;
  const f = favoris();
  return `<h2 class="titre-ecran">Mes favoris</h2>
    ${f.length ? `<ul class="liste">${f.slice(0, ui.limite).map(carte).join('')}</ul>` : vide('Aucun favori pour l\'instant', 'Touche le ♥ d\'une annonce pour la garder ici.', '<a class="btn" href="#/">Voir les annonces</a>')}`;
}

// --- Suivi (version simple ; le pipeline complet arrive au palier 4) ------------------------------
const ORDRE_SUIVI = ['visite', 'reponse', 'contacte', 'a_contacter', 'refuse', 'sans_suite'];
export function vueSuivi() {
  if (!S.charge) return `<ul class="liste">${squeletteCartes(2)}</ul>`;
  const parStatut = {};
  for (const [id, c] of Object.entries(S.contacts)) {
    const l = annonceParId(id);
    if (l) (parStatut[c.statut] ??= []).push(l);
  }
  const dues = relancesDues();
  const groupes = ORDRE_SUIVI.filter((k) => parStatut[k]?.length);
  return `<h2 class="titre-ecran">Mes démarches</h2>
    ${dues ? `<button class="bandeau" data-bot-relances>⏰ ${dues} relance${dues > 1 ? 's' : ''} à faire — demander à Claude</button>` : ''}
    ${groupes.length ? groupes.map((k) => `<section class="groupe"><h3 class="groupe-titre">${esc(STATUTS_LIBELLES[k])}<em>${parStatut[k].length}</em></h3><ul class="liste">${parStatut[k].map(carte).join('')}</ul></section>`).join('')
      : vide('Aucune démarche en cours', 'Ouvre une annonce et touche « Contacter » : Claude rédige un brouillon, et le suivi apparaît ici.', '<a class="btn" href="#/">Voir les annonces</a>')}`;
}

// --- Plus ------------------------------------------------------------------
function pillsSources() {
  const pills = (S.meta.sources || []).map((s) => `<span class="pill ${esc(s.status)}" title="${esc(s.error ?? '')}">${esc(s.name)} · ${s.status === 'erreur' ? 'en panne' : `${s.count} annonces`}</span>`);
  pills.push('<span class="pill todo" title="Les alertes e-mail SeLoger / Leboncoin / PAP arrivent dans une boîte dédiée, lues par le collecteur ; les exports du matin complètent">SeLoger, Leboncoin, PAP · via alertes e-mail et exports du matin</span>');
  return pills.join('');
}
const svg = (d) => `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const IC = {
  criteres: svg('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>'),
  ecartees: svg('<path d="M4 8h16v11H4zM3 5h18v3H3zM10 12h4"/>'),
  chat: svg('<path d="M4 5h16v11H9l-5 4z"/>'),
  ajout: svg('<path d="M12 5v14M5 12h14"/>'),
  dossier: svg('<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1-4 4-6 7-6s6 2 7 6"/>'),
  recharger: svg('<path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5"/>'),
};
const ligne = (icone, titre, detail, attrs) => `<${attrs.startsWith('href') ? 'a' : 'button type="button"'} class="ligne" ${attrs}><span class="ligne-ic" aria-hidden="true">${icone}</span><span class="ligne-txt"><b>${esc(titre)}</b>${detail ? `<small>${esc(detail)}</small>` : ''}</span><span class="ligne-fl" aria-hidden="true">›</span></${attrs.startsWith('href') ? 'a' : 'button'}>`;

export function resumeCriteres() {
  const c = S.criteria;
  const zone = c.arrondissements.length === 1 ? `Paris ${c.arrondissements[0]}e` : c.arrondissements.length ? `${c.arrondissements.length} arrondissements` : 'tout Paris';
  return `${zone} · ≤ ${eur(c.budgetMax)} · ${c.surfaceMin} m²+`;
}

export function vuePlus() {
  return `<h2 class="titre-ecran">Plus</h2>
    <div class="lignes">
      ${ligne(IC.criteres, 'Mes critères', resumeCriteres(), 'href="#/plus/criteres"')}
      ${ligne(IC.ecartees, 'Annonces écartées', `${ecartees().length} écartée${ecartees().length > 1 ? 's' : ''}`, 'href="#/plus/ecartees"')}
      ${ligne(IC.chat, 'Demander à Claude', 'Ajuster mes critères, comparer, rédiger un message…', 'data-bot=""')}
      ${ligne(IC.ajout, 'Ajouter une annonce', 'Vue ailleurs (Facebook, bouche-à-oreille…)', 'data-ajout')}
      ${ligne(IC.dossier, 'Mon dossier', 'Ce que Claude glisse dans tes messages — reste sur cet appareil', 'data-dossier')}
      ${ligne(IC.recharger, 'Recharger la page', 'Pour voir les derniers changements', 'data-recharger')}
    </div>
    <h3 class="groupe-titre">Sources</h3>
    <div class="sources">${pillsSources()}</div>
    <p class="maj">${S.meta.generatedAt ? `Dernière mise à jour ${esc(depuis(S.meta.generatedAt))}.` : ''}</p>`;
}

export function vueEcartees() {
  const e = ecartees();
  return `<a class="retour-lien" href="#/plus">‹ Plus</a><h2 class="titre-ecran">Annonces écartées</h2>
    ${e.length ? `<ul class="liste">${e.slice(0, ui.limite).map(carte).join('')}</ul>` : vide('Rien d\'écarté', 'Les annonces que tu écartes arrivent ici : tu peux toujours les remettre.')}`;
}

export function vueCriteres() {
  return `<a class="retour-lien" href="#/plus">‹ Plus</a><h2 class="titre-ecran">Mes critères</h2>
    <p class="hint">Ces réglages sont partagés : ils s'appliquent à tous tes appareils, et Sacha les voit.</p>
    <button class="btn ghost small" data-bot="Sur mes critères, je voudrais ">💬 Demander à Claude d'ajuster ça</button>
    ${htmlCriteres()}`;
}

// --- Détail d'une annonce ----------------------------------------------------
const faits = (l) => [
  ['Surface', surfaceLibelle(l)], ['Pièces', l.rooms], ['Étage', etageLibelle(l)],
  ['Ascenseur', l.elevator == null ? null : l.elevator ? 'Oui' : 'Non'], ['DPE', l.dpe], ['Meublé', l.furnished == null ? null : l.furnished ? 'Oui' : 'Non'],
  ['Prix / m²', prixM2(l) ? `${prixM2(l)} €` : null], ['Charges', l.charges ? eur(l.charges) : null], ['Publiée', l.publishedAt ? depuis(l.publishedAt) : null],
];

export function vueDetail(id) {
  const l = annonceParId(id);
  if (!l) {
    return `<div class="det-barre"><button class="rond" data-retour aria-label="Retour">‹</button><span class="det-titre">Annonce introuvable</span></div>
      <div class="det-defile">${vide('Cette annonce n\'est plus dans la liste', 'Elle a peut-être été retirée. Reviens à la liste.', '<button class="btn" data-retour>Retour</button>')}</div>`;
  }
  const v = verdictDe(l);
  const note = S.notes[l.id] || '';
  const ct = S.contacts[l.id];
  const detail = l.ok
    ? `<ul class="pourquoi">${(l.detail ?? []).filter((d) => d.poids).map((d) => `<li><span>${esc(d.label)}</span><span class="pts">${d.points}</span><i style="--w:${Math.round((d.valeur ?? 0) * 100)}%"></i></li>`).join('')}</ul>`
    : `<ul class="rejets">${(l.rejets ?? []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`;
  const ecartee = S.statut[l.id] === 'ecarte';
  return `<div class="det-barre"><button class="rond" data-retour aria-label="Retour à la liste">‹</button><span class="det-titre">${esc(quartier(l))}</span>${boutonCoeur(l)}</div>
    <div class="det-defile">
      <div class="det-hero">${visuel(l, { eager: true })}</div>
      <div class="det-corps">
        <div class="prix grand"><b>${l.price != null ? eur(l.price) : '—'}</b><small> /mois charges comprises</small></div>
        ${v ? `<div class="verdict-ligne v-${v.tier}">${esc(v.icone)} ${esc(v.label)}</div>` : ''}
        <h2 class="det-h">${esc(typeLogement(l))} · ${esc(quartier(l))}</h2>
        ${l.title ? `<p class="det-annonce">${esc(l.title)}</p>` : ''}
        <div class="badges">${badges(l, { complet: true })}</div>
        <dl class="faits">${faits(l).map(([k, x]) => `<div><dt>${esc(k)}</dt><dd>${x == null ? '<span class="inconnu">—</span>' : esc(x)}</dd></div>`).join('')}</dl>

        <h3 class="sec">Suivi</h3>
        <select class="suivi" data-id="${esc(l.id)}" aria-label="Suivi de contact">
          <option value="">Pas encore contactée</option>${Object.entries(STATUTS_LIBELLES).map(([k, x]) => `<option value="${k}"${ct?.statut === k ? ' selected' : ''}>${esc(x)}</option>`).join('')}<option value="__aucun">— Retirer le suivi</option>
        </select>

        <h3 class="sec">${l.ok ? 'Pourquoi cet avis ?' : 'Pourquoi écartée ?'}</h3>${detail}

        <h3 class="sec">Ma note</h3>
        <textarea class="note-txt" data-id="${esc(l.id)}" rows="3" placeholder="Ce que j'en pense, une question, un doute… (Sacha la voit aussi)">${esc(note)}</textarea>

        ${l.description ? `<details class="descr"><summary>Texte de l'annonce</summary><p>${esc(String(l.description).slice(0, 1500))}${String(l.description).length > 1500 ? '…' : ''}</p></details>` : ''}
        <div class="det-actions">
          <button class="btn ghost" type="button" data-act="ecarte" data-id="${esc(l.id)}">${ecartee ? 'Remettre dans la liste' : '✕ Écarter'}</button>
          <button class="btn ghost" type="button" data-mascotte-annonce="${esc(l.id)}"><img src="mascotte.webp" width="18" height="18" alt=""> En discuter avec Claude</button>
        </div>
        <p class="pied-det">${esc(sourceAffichee(l))} · ${l.publishedAt ? 'publiée ' + depuis(l.publishedAt) : 'vue ' + depuis(l.first_seen)}</p>
      </div>
    </div>
    <div class="det-cta"><a class="btn" href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer">Voir l'annonce ↗</a><button class="btn primary" type="button" data-contact-annonce="${esc(l.id)}">✉️ Contacter</button></div>`;
}
