// Petits utilitaires partagés par les modules du site (aucune dépendance).
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// localStorage peut être indisponible (navigation privée, stockage bloqué) : on continue sans mémoire.
export const store = {
  get(k, d) {
    try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* on continue sans mémoire */ }
  },
};

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : '#');
export const eur = (n) => `${Math.round(Number(n)).toLocaleString('fr-FR')} €`;

const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
export function depuis(iso, maintenant = Date.now()) {
  const min = Math.round((new Date(iso).getTime() - maintenant) / 60000);
  if (Math.abs(min) < 60) return rtf.format(min, 'minute');
  if (Math.abs(min) < 60 * 36) return rtf.format(Math.round(min / 60), 'hour');
  return rtf.format(Math.round(min / 1440), 'day');
}
