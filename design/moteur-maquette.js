// Moteur commun aux deux maquettes (rendu + interactions minimales). Les données viennent de window.DONNEES.
(() => {
  const D = window.DONNEES, C = window.CTX;
  const dir = document.body.dataset.direction;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const eur = (n) => `${Math.round(n).toLocaleString('fr-FR')} €`;
  const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
  const depuis = (iso) => { const h = Math.round((new Date(iso) - Date.now()) / 36e5); return Math.abs(h) < 36 ? rtf.format(h, 'hour') : rtf.format(Math.round(h / 24), 'day'); };

  const I = {
    coeur: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 20.2s-7.2-4.6-10-9C.4 8 2 4.8 5.6 4.8c2.1 0 3.7 1.2 4.7 2.8 1-1.6 2.6-2.8 4.7-2.8 3.6 0 5.2 3.2 3.6 6.4-2.8 4.4-10 9-10 9z" fill="var(--fill,none)" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    maison: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M3.5 11 12 4l8.5 7M6 9.5V20h12V9.5M10 20v-5h4v5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    suivi: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="18" cy="17" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
    carte: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6zM9 4v14M15 6v14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="18.5" cy="12" r="1.6" fill="currentColor"/></svg>',
    filtres: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="16" cy="7" r="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="8" cy="17" r="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
    retour: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M15 5 8 12l7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    lien: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M8 16 16 8M9 8h7v7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    toit: '<svg viewBox="0 0 64 40" width="64" height="40" aria-hidden="true"><path d="M4 22 32 4l28 18M12 18v18h40V18M27 36V24h10v12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  const st = { tab: 'annonces', seg: 'nouveautes', tri: 'pertinence', pills: new Set(), favs: new Set([D[1]?.id]), detail: null };
  const PILLS = [
    ['meuble', 'Meublé', (l) => l.meuble === true],
    ['balcon', 'Balcon / terrasse', (l) => l.balcon],
    ['nouveau', 'Nouveau', (l) => l.nouveau || (Date.now() - new Date(l.vu)) < 36e5 * 30],
    ['baisse', 'Baisse de prix', (l) => l.baisse > 0],
    ['petit', '≤ 800 €', (l) => l.prix <= 800],
  ];

  const ppm = (l) => (l.prix && l.surface ? Math.round(l.prix / l.surface) : null);
  const etage = (l) => (l.etage == null ? null : l.etage === 0 ? 'RDC' : `${l.etage}${l.etage === 1 ? 'er' : 'e'} étage`);
  const lieu = (l) => l.quartier || (l.arr ? `Paris ${l.arr}e` : 'Paris');
  const teinte = (l) => ((l.arr || 18) * 47 + (lieu(l).length * 13)) % 40 - 20; // petite variation de teinte, stable par annonce

  function liste() {
    let r = D.filter((l) => st.tab !== 'favoris' || st.favs.has(l.id));
    if (st.tab === 'annonces' && st.seg === 'nouveautes') r = r.filter((l) => !l.exemple);
    for (const k of st.pills) r = r.filter(PILLS.find((p) => p[0] === k)[2]);
    const tri = { pertinence: () => 0, prix: (a, b) => (a.prix ?? 1e9) - (b.prix ?? 1e9), surface: (a, b) => (b.surface ?? 0) - (a.surface ?? 0), recent: (a, b) => new Date(b.vu) - new Date(a.vu) }[st.tri];
    return [...r].sort(tri);
  }
  const compte = (k) => D.filter(PILLS.find((p) => p[0] === k)[2]).length;

  // Visuel : photo si elle existe ; sinon une tuile qui PORTE de l'information (surface, pièces) au lieu d'un trou.
  const visuel = (l, grand = false) => l.photo
    ? `<img src="${esc(l.photo)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<div class="tuile" style="--t:${teinte(l)}">${I.toit}<span class="tuile-surface">${l.surface ? `${String(l.surface).replace('.', ',')} m²` : '— m²'}</span><span class="tuile-detail">${esc(l.pieces ? (l.pieces === 1 ? 'studio' : l.pieces + ' pièces') : 'détails à l\'ouverture')}</span></div>`;

  const badges = (l) => [
    l.nouveau ? '<span class="b b-new">Nouveau</span>' : '',
    l.baisse ? `<span class="b b-drop">↓ ${eur(l.baisse)}</span>` : '',
    l.meuble ? '<span class="b">Meublé</span>' : '', l.balcon ? '<span class="b">Balcon</span>' : '',
    l.ascenseur ? '<span class="b">Ascenseur</span>' : '', l.dpe ? `<span class="b">DPE ${esc(l.dpe)}</span>` : '',
  ].join('');

  const coeur = (l) => `<button class="coeur" data-fav="${esc(l.id)}" aria-pressed="${st.favs.has(l.id)}" aria-label="${st.favs.has(l.id) ? 'Retirer des favoris' : 'Garder en favori'}" style="--fill:${st.favs.has(l.id) ? 'currentColor' : 'none'}">${I.coeur}</button>`;

  function carte(l) {
    const infos = [type(l), etage(l), ppm(l) ? `${ppm(l)} €/m²` : null].filter(Boolean).join(' · ');
    return `<li class="carte${l.photo ? ' avec-photo' : ' sans-photo'}${st.detail === l.id ? ' actif' : ''}" data-open="${esc(l.id)}" tabindex="0" role="button" aria-label="${esc(lieu(l))}, ${eur(l.prix)}">
      <div class="visuel">${visuel(l)}${l.exemple ? '<span class="exemple">exemple</span>' : `<span class="verdict v-${l.verdict.tier}">${esc(l.verdict.icone)} ${esc(l.verdict.label)}</span>`}${dir === 'a-vanille' ? coeur(l) : ''}</div>
      <div class="corps">
        <div class="l1"><span class="lieu">${esc(lieu(l))}</span>${dir === 'b-bordeaux' ? coeur(l) : ''}</div>
        <div class="prix"><b>${eur(l.prix)}</b><small> /mois CC</small></div>
        <div class="vt v-${l.verdict.tier}">${l.exemple ? '' : esc(l.verdict.icone) + ' ' + esc(l.verdict.label)}</div>
        <div class="infos">${esc(infos)}</div>
        <div class="badges">${badges(l)}</div>
        <div class="pied">${esc(l.src)} · ${depuis(l.vu)}</div>
      </div></li>`;
  }
  function type(l) { return l.titre; }

  function detail(l) {
    const faits = [['Surface', l.surface ? `${l.surface} m²` : '—'], ['Pièces', l.pieces ?? '—'], ['Étage', etage(l) ?? '—'], ['DPE', l.dpe ?? '—'], ['Meublé', l.meuble == null ? '—' : l.meuble ? 'Oui' : 'Non'], ['Prix / m²', ppm(l) ? `${ppm(l)} €` : '—']];
    return `<div class="det-bar"><button class="rond" data-fermer aria-label="Retour">${I.retour}</button><span class="det-titre">${esc(lieu(l))}</span>${coeur(l)}</div>
      <div class="det-scroll">
        <div class="det-hero">${visuel(l, true)}</div>
        <div class="det-corps">
          <div class="prix grand"><b>${eur(l.prix)}</b><small> /mois charges comprises</small></div>
          <div class="verdict-ligne v-${l.verdict.tier}">${esc(l.verdict.icone)} ${esc(l.verdict.label)}</div>
          <h2 class="det-h">${esc(type(l))} · ${esc(lieu(l))}</h2>
          <div class="badges">${badges(l)}</div>
          <dl class="faits">${faits.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
          ${l.detail.length ? `<h3>Pourquoi cet avis ?</h3><ul class="pourquoi">${l.detail.map((x) => `<li><span>${esc(x.label)}</span><i style="--w:${Math.round((x.v ?? 0) * 100)}%"></i></li>`).join('')}</ul>` : ''}
          <h3>Ma note</h3><textarea rows="2" placeholder="Ce que j'en pense, une question, un doute…"></textarea>
          <h3>Suivi</h3><div class="etapes">${['À contacter', 'Contacté', 'Réponse', 'Visite'].map((x, i) => `<span class="${i === 0 ? 'on' : ''}">${x}</span>`).join('')}</div>
          <p class="pied">${esc(l.src)} · vue ${depuis(l.vu)}</p>
        </div>
      </div>
      <div class="det-cta"><a class="btn sec" href="#" data-noop>Voir l'annonce ${I.lien}</a><button class="btn prim" data-noop>✉️ Contacter</button></div>`;
  }

  function ecran() {
    const items = liste();
    const tabs = [['annonces', 'Annonces', I.maison], ['favoris', 'Favoris', I.coeur], ['suivi', 'Suivi', I.suivi], ['carte', 'Carte', I.carte], ['plus', 'Plus', I.plus]];
    const bientot = { suivi: 'Suivi en pipeline : À contacter → Contacté → Réponse → Visite, avec relances.', carte: 'Vue carte (OpenStreetMap) avec pastilles de prix.', plus: 'Critères, « Mon dossier », ajout manuel, aide, à propos.' };
    let centre;
    if (bientot[st.tab]) centre = `<div class="vide"><b>${tabs.find((t) => t[0] === st.tab)[1]}</b><p>${bientot[st.tab]}</p><p class="mini">Écran non maquetté — prévu dans un palier ultérieur.</p></div>`;
    else centre = `
      ${st.tab === 'annonces' ? `<div class="segs" role="tablist">${[['nouveautes', 'Nouveautés', D.filter((x) => !x.exemple).length], ['meilleures', 'Meilleures', D.length]].map(([k, t, n]) => `<button role="tab" aria-selected="${st.seg === k}" data-seg="${k}">${t}<em>${n}</em></button>`).join('')}</div>` : ''}
      <div class="pills" role="group" aria-label="Filtres">
        <button class="pill filtres" data-noop>${I.filtres} Filtres</button>
        ${PILLS.map(([k, t]) => `<button class="pill" aria-pressed="${st.pills.has(k)}" data-pill="${k}">${t}<em>${compte(k)}</em></button>`).join('')}
      </div>
      <div class="barre-tri"><span>${items.length} annonce${items.length > 1 ? 's' : ''}</span>
        <label>Trier <select data-tri>${[['pertinence', 'Pertinence'], ['prix', 'Prix croissant'], ['surface', 'Surface décroissante'], ['recent', 'Plus récentes']].map(([k, t]) => `<option value="${k}"${st.tri === k ? ' selected' : ''}>${t}</option>`).join('')}</select></label></div>
      ${items.length ? `<ul class="liste">${items.map(carte).join('')}</ul>` : '<div class="vide"><b>Aucune annonce</b><p>Aucune annonce ne correspond à ces filtres.</p><button class="btn sec" data-reset>Retirer les filtres</button></div>'}
      <p class="note-maquette">Maquette. Données réelles de <code>docs/data</code> (annonces sans photo = imports PDF/e-mail) ; les 3 dernières, avec photo, sont des exemples hors budget pour montrer l'autre variante de carte.</p>`;
    return `<header class="haut"><div><h1>Mon appart</h1><p>${esc(C.zone)} · ≤ ${eur(C.budget)} · ${C.surfaceMin} m²+</p></div><button class="rond" data-noop aria-label="Demander à Claude">💬</button></header>
      <main class="principal"><nav class="nav" aria-label="Navigation">${tabs.map(([k, t, ic]) => `<button data-tab="${k}" aria-current="${st.tab === k}">${ic}<span>${t}</span>${k === 'suivi' ? '<i class="pastille">2</i>' : ''}${k === 'favoris' && st.favs.size ? `<i class="pastille">${st.favs.size}</i>` : ''}</button>`).join('')}</nav>
      <section class="centre">${centre}</section>
      <aside class="detail${st.detail ? ' ouvert' : ''}" aria-hidden="${!st.detail}">${st.detail ? detail(D.find((x) => x.id === st.detail)) : '<div class="vide"><p>Sélectionne une annonce pour voir le détail.</p></div>'}</aside></main>`;
  }

  function dessiner() {
    const y = window.scrollY, ds = $('.det-scroll')?.scrollTop;
    $('#app').innerHTML = ecran();
    document.body.classList.toggle('detail-ouvert', !!st.detail);
    window.scrollTo(0, y);
  }
  document.addEventListener('click', (e) => {
    const t = (s) => e.target.closest(s);
    if (t('[data-noop]')) { e.preventDefault(); return; }
    if (t('[data-fav]')) { e.stopPropagation(); const id = t('[data-fav]').dataset.fav; st.favs.has(id) ? st.favs.delete(id) : st.favs.add(id); return dessiner(); }
    if (t('[data-open]')) { st.detail = t('[data-open]').dataset.open; return dessiner(); }
    if (t('[data-fermer]')) { st.detail = null; return dessiner(); }
    if (t('[data-tab]')) { st.tab = t('[data-tab]').dataset.tab; st.detail = null; return dessiner(); }
    if (t('[data-seg]')) { st.seg = t('[data-seg]').dataset.seg; return dessiner(); }
    if (t('[data-pill]')) { const k = t('[data-pill]').dataset.pill; st.pills.has(k) ? st.pills.delete(k) : st.pills.add(k); return dessiner(); }
    if (t('[data-reset]')) { st.pills.clear(); return dessiner(); }
  });
  document.addEventListener('change', (e) => { if (e.target.matches('[data-tri]')) { st.tri = e.target.value; dessiner(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && st.detail) { st.detail = null; dessiner(); } if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-open]')) { e.preventDefault(); st.detail = e.target.dataset.open; dessiner(); } });
  { const m = /detail=(\d+)/.exec(location.hash); if (m && D[+m[1]]) st.detail = D[+m[1]].id; }
  dessiner();
})();
