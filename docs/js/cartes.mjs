// Composants d'annonce : visuel (photo ou tuile de remplacement), carte de liste, badges.
// Règle : jamais de trou. Sans photo, la tuile PORTE l'information (surface, pièces) au lieu de rester vide.
import { esc, safeUrl, eur, depuis } from './util.mjs';
import { STATUTS_LIBELLES, relanceDue, libelleRelance } from '../agent-ui.mjs';
import { verdictScore } from '../score.mjs';
import { S } from './etat.mjs';
import { quartier, ligneInfos, surfaceLibelle, typeLogement, baissePrix, teinte, badgesEquipements, sourceAffichee } from './annonce-ui.mjs';

const ICONES = {
  coeur: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 20.2s-7.2-4.6-10-9C.4 8 2 4.8 5.6 4.8c2.1 0 3.7 1.2 4.7 2.8 1-1.6 2.6-2.8 4.7-2.8 3.6 0 5.2 3.2 3.6 6.4-2.8 4.4-10 9-10 9z" fill="var(--fill,none)" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  toit: '<svg viewBox="0 0 64 40" width="64" height="40" aria-hidden="true"><path d="M4 22 32 4l28 18M12 18v18h40V18M27 36V24h10v12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  croix: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};
export { ICONES };

export const estNouveau = (l) => l.first_seen > S.vuJusqua && l.source !== 'Manuel';

/** Tuile de remplacement (sans photo, ou photo cassée) : surface en grand + type de logement. */
export function tuile(l) {
  return `<div class="tuile" style="--t:${teinte(l)}">${ICONES.toit}<span class="tuile-surface">${esc(surfaceLibelle(l) ?? '— m²')}</span><span class="tuile-detail">${esc(l.surface || l.rooms ? typeLogement(l).toLowerCase() : 'détails sur l\'annonce')}</span></div>`;
}

export function visuel(l, { eager = false } = {}) {
  if (!l.photo) return tuile(l);
  // Photo hébergée chez un tiers : sans referrer, chargée à la demande. Si elle est cassée, app.js la remplace par la tuile.
  return `<img class="photo-img" src="${esc(safeUrl(l.photo))}" alt="" loading="${eager ? 'eager' : 'lazy'}" decoding="async" referrerpolicy="no-referrer" data-tuile="${esc(tuile(l))}">`;
}

export function chipContact(l) {
  const ct = S.contacts[l.id];
  if (!ct) return '';
  const rel = libelleRelance(ct);
  const visite = ct.visite ? ' · ' + new Date(ct.visite).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  return `<span class="b b-contact${relanceDue(ct) ? ' due' : ''}">✉️ ${esc(STATUTS_LIBELLES[ct.statut] ?? ct.statut)}${rel ? ' · ' + esc(rel) : ''}${esc(visite)}</span>`;
}

export function badges(l, { complet = false } = {}) {
  const b = [chipContact(l)];
  if (estNouveau(l)) b.push('<span class="b b-new">Nouveau</span>');
  const baisse = baissePrix(l);
  if (baisse) b.push(`<span class="b b-drop">↓ ${eur(baisse)}</span>`);
  for (const x of badgesEquipements(l).slice(0, complet ? 99 : 4)) b.push(`<span class="b">${esc(x.t)}</span>`);
  if (complet && l.agencyFee) b.push(`<span class="b">Frais d'agence ${eur(Math.round(l.agencyFee))}</span>`);
  if (l.aVerifier?.length) b.push(`<span class="b b-warn">À vérifier : ${esc(l.aVerifier.join(', '))}</span>`);
  return b.join('');
}

export const verdictDe = (l) => (l.ok ? verdictScore(l.rangOk, l.totalOk) : null);

export function boutonCoeur(l) {
  const fav = S.statut[l.id] === 'fav';
  return `<button type="button" class="coeur" data-act="fav" data-id="${esc(l.id)}" aria-pressed="${fav}" aria-label="${fav ? 'Retirer des favoris' : 'Garder en favori'}">${ICONES.coeur}</button>`;
}

/** Carte de liste. Le lien étiré sur toute la carte ouvre le détail (#/annonce/ID) ; les boutons restent au-dessus. */
export function carte(l) {
  const v = verdictDe(l);
  const avecPhoto = !!l.photo;
  const ecartee = S.statut[l.id] === 'ecarte';
  const pepite = l.ok && l.rangOk === 0 && l.totalOk > 1;
  const q = quartier(l);
  return `<li class="carte ${avecPhoto ? 'avec-photo' : 'sans-photo'}${pepite ? ' pepite' : ''}" data-id="${esc(l.id)}">
    <div class="visuel">${visuel(l)}${v && avecPhoto ? `<span class="verdict v-${v.tier}">${esc(v.icone)} ${esc(v.label)}</span>` : ''}${boutonCoeur(l)}</div>
    <div class="corps">
      <h3 class="lieu"><a class="lien-carte" href="#/annonce/${encodeURIComponent(l.id)}">${esc(q)}</a></h3>
      <div class="prix"><b>${l.price != null ? eur(l.price) : '—'}</b><small> /mois CC</small></div>
      ${v && !avecPhoto ? `<div class="verdict-txt v-${v.tier}">${esc(v.icone)} ${esc(v.label)}</div>` : ''}
      <div class="infos">${esc(ligneInfos(l))}</div>
      <div class="badges">${badges(l)}</div>
      <div class="pied"><span>${esc(sourceAffichee(l))} · ${l.publishedAt ? 'publiée ' + depuis(l.publishedAt) : 'vue ' + depuis(l.first_seen)}</span>
        <button type="button" class="texte-btn" data-act="ecarte" data-id="${esc(l.id)}" aria-pressed="${ecartee}">${ecartee ? 'Remettre' : '✕ Écarter'}</button></div>
    </div>
  </li>`;
}

export function squeletteCartes(n = 4) {
  return Array.from({ length: n }, (_, i) => `<li class="carte squelette${i % 2 ? '' : ' avec-photo'}" aria-hidden="true"><div class="visuel"><div class="tuile"></div></div><div class="corps"><i class="sq l1"></i><i class="sq l2"></i><i class="sq l3"></i></div></li>`).join('');
}
