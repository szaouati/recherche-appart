// « ✉️ Contacter mes favoris » : écrire à plusieurs annonces à la suite (demande de Tabatha du 24/09/2026).
// Un brouillon par favori pas encore contacté, rédigé localement (brouillonContact, sans appel au modèle) et rempli
// avec « Mon dossier » (qui ne quitte jamais l'appareil). Rien ne part tout seul : elle copie, ouvre l'annonce,
// colle dans la messagerie du site, puis touche « J'ai envoyé ✔ » → suivi « contacté » + relance à 3 jours.
import { brouillonContact, remplirMarqueurs, MARQUEURS, MARQUEURS_OPTIONNELS } from '../agent-ui.mjs';
import { $, esc, eur, safeUrl } from './util.mjs';
import { S, appliquerEtat } from './etat.mjs';
import { dossier, copier, ouvrirBot } from './chat.mjs';
import { quartier, typeLogement, sourceAffichee } from './annonce-ui.mjs';

/** Favoris à qui elle n'a pas encore écrit (pas de suivi, ou « à contacter »). */
export const favorisAContacter = (favoris) => favoris.filter((l) => !S.contacts[l.id] || S.contacts[l.id].statut === 'a_contacter');

let file = []; // annonces de la session en cours
let i = 0;
let envoyes = 0;
const textes = new Map(); // id -> texte modifié à la main (on ne l'écrase pas en revenant dessus)

function texteDe(l) {
  if (textes.has(l.id)) return { texte: textes.get(l.id), manquants: [] };
  const brut = brouillonContact({
    type: typeLogement(l).toLowerCase(), quartier: quartier(l), surface: l.surface, prix: l.price,
    etage: l.floor ?? null, ascenseur: l.elevator ?? null, dpe: l.dpe ?? null,
  });
  return remplirMarqueurs(brut, dossier());
}

function rendre() {
  const corps = $('#contacts-corps');
  const tete = '<div class="dlg-head"><h2>✉️ Contacter mes favoris</h2><button class="btn ghost small" type="button" data-cf-fermer>Fermer</button></div>';
  if (i >= file.length) {
    corps.innerHTML = `${tete}
      <p><b>${envoyes ? `C'est fait : ${envoyes} message${envoyes > 1 ? 's' : ''} envoyé${envoyes > 1 ? 's' : ''} 🎉` : 'Tu as fait le tour.'}</b></p>
      <p class="hint">Quand quelqu'un te répond, ouvre l'onglet <b>Suivi</b> et choisis « Réponse reçue » (ou « Visite prévue »). Sans réponse au bout de 3 jours, l'appli te rappelle de relancer.</p>
      <div class="dlg-actions"><a class="btn primary" href="#/suivi" data-cf-fermer>Voir mon suivi</a></div>`;
    return;
  }
  const l = file[i];
  const { texte, manquants } = texteDe(l);
  const bloquants = manquants.filter((k) => !MARQUEURS_OPTIONNELS.includes(k));
  const sansLien = !String(dossier().lien_dossier ?? '').trim();
  corps.innerHTML = `${tete}
    <p class="hint">Annonce ${i + 1} sur ${file.length}. Copie le message, ouvre l'annonce, colle-le dans sa messagerie, puis touche « J'ai envoyé ». Rien ne part tout seul.</p>
    ${bloquants.length ? `<p class="hint avert">Il manque : ${esc(bloquants.map((k) => MARQUEURS[k]).join(', '))}. <button class="texte-btn en-ligne" type="button" data-dossier>Remplir « Mon dossier »</button> (une seule fois, ça reste sur ce téléphone).</p>` : ''}
    ${!bloquants.length && sansLien ? '<p class="hint">Astuce : un lien <a href="https://www.dossierfacile.logement.gouv.fr/" target="_blank" rel="noopener noreferrer">DossierFacile</a> dans <button class="texte-btn en-ligne" type="button" data-dossier>« Mon dossier »</button> ajoute ton dossier complet à chaque message.</p>' : ''}
    <div class="cf-annonce"><b>${l.price != null ? esc(eur(l.price)) : '—'}${l.surface ? ` · ${esc(l.surface)} m²` : ''}</b> · ${esc(quartier(l))} <small>${esc(sourceAffichee(l))}</small></div>
    <textarea class="brouillon" rows="11" data-cf-texte aria-label="Message à copier">${esc(texte)}</textarea>
    <div class="dlg-actions">
      <button class="btn ghost small" type="button" data-cf-copier>Copier</button>
      <a class="btn ghost small" href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer">Ouvrir l'annonce ↗</a>
      <button class="btn primary small" type="button" data-cf-envoye>J'ai envoyé ✔</button>
    </div>
    <div class="dlg-actions">
      <button class="texte-btn" type="button" data-cf-claude>Le personnaliser avec Claude</button>
      <button class="btn ghost small" type="button" data-cf-passer>${i + 1 < file.length ? 'Passer à la suivante ›' : 'Terminer'}</button>
    </div>`;
}

export function ouvrirContacts(favoris) {
  file = favorisAContacter(favoris);
  i = 0;
  envoyes = 0;
  textes.clear();
  rendre();
  $('#dlg-contacts').showModal();
}

export function brancherContacts() {
  const dlg = $('#dlg-contacts');
  dlg.addEventListener('input', (e) => { if (e.target.matches('[data-cf-texte]')) textes.set(file[i].id, e.target.value); });
  dlg.addEventListener('click', async (e) => {
    const t = (s) => e.target.closest(s);
    if (t('[data-cf-fermer]')) { dlg.close(); return; }
    if (t('[data-cf-passer]')) { i++; rendre(); return; }
    if (t('[data-cf-copier]')) {
      const ta = $('[data-cf-texte]', dlg);
      const ok = await copier(ta.value, ta);
      t('[data-cf-copier]').textContent = ok ? 'Copié ✔' : 'Sélectionné : copie à la main';
      if (!ok) { ta.focus(); ta.select(); }
      return;
    }
    if (t('[data-cf-envoye]')) {
      const l = file[i];
      appliquerEtat('set_contact', { id: l.id, statut: 'contacte', relance_jours: 3, canal: 'messagerie_annonce', url: l.url, title: l.title });
      envoyes++; i++; rendre();
      return;
    }
    if (t('[data-cf-claude]')) {
      const l = file[i];
      dlg.close();
      ouvrirBot(`Personnalise ce message de contact pour l'annonce ${l.price != null ? eur(l.price) : ''} · ${quartier(l)} (réf ${l.id}) : `);
    }
  });
  // « Mon dossier » rempli depuis le parcours : le brouillon en cours se met à jour.
  $('#dlg-dossier').addEventListener('close', () => { if (dlg.open && file[i]) { textes.delete(file[i].id); rendre(); } });
}
