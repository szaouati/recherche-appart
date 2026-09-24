// Formulaires modaux : ajout manuel d'une annonce, « Mon dossier » (local à l'appareil).
import { MARQUEURS } from '../agent-ui.mjs';
import { $, store } from './util.mjs';
import { appliquerEtat } from './etat.mjs';
import { dossier } from './chat.mjs';
import { toast } from './toast.mjs';

export function brancherDialogs() {
  $('#form-add').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'ok') return;
    const f = new FormData(e.target);
    const num = (k) => (f.get(k) === '' || f.get(k) == null ? null : Number(f.get(k)));
    const now = new Date().toISOString();
    const listing = {
      id: `manuel:${Date.now()}`, source: 'Manuel', url: f.get('url'), title: f.get('title') || null,
      price: num('price'), surface: num('surface'), rooms: num('rooms'), arrondissement: num('arrondissement'), floor: num('floor'),
      elevator: f.get('elevator') ? true : null, dpe: f.get('dpe') || null, furnished: null,
      features: f.get('balcon') ? { balcon: true } : {}, first_seen: now, last_seen: now, publishedAt: now, photo: null,
    };
    appliquerEtat('ajouter_manuel', { listing });
    e.target.reset();
    toast('Annonce ajoutée.');
  });

  $('#form-dossier').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'ok') return;
    const f = e.target;
    store.set('dossier', Object.fromEntries(Object.keys(MARQUEURS).map((k) => [k, f.elements[k].value.trim()])));
    toast('Dossier enregistré sur cet appareil.');
  });
}

export const ouvrirAjout = () => $('#dlg-add').showModal();
export function ouvrirDossier() {
  const d = dossier();
  const f = $('#form-dossier');
  for (const k of Object.keys(MARQUEURS)) f.elements[k].value = d[k] || '';
  $('#dlg-dossier').showModal();
}
