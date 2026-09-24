// Toasts : retour discret d'une action (avec « Annuler » quand elle est réversible). Un seul à la fois.
import { esc } from './util.mjs';

let minuteur = null;
export function toast(message, { action, duree = 5000 } = {}) {
  let zone = document.getElementById('toasts');
  if (!zone) {
    zone = Object.assign(document.createElement('div'), { id: 'toasts' });
    zone.setAttribute('role', 'status');
    zone.setAttribute('aria-live', 'polite');
    document.body.appendChild(zone);
  }
  clearTimeout(minuteur);
  zone.innerHTML = `<div class="toast"><span>${esc(message)}</span>${action ? `<button type="button" class="toast-action">${esc(action.libelle)}</button>` : ''}</div>`;
  zone.querySelector('.toast-action')?.addEventListener('click', () => { zone.innerHTML = ''; action.fn(); });
  minuteur = setTimeout(() => { zone.innerHTML = ''; }, duree);
}
