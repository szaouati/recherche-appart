// Point d'entrée : routage (#/…), événements délégués, en-tête, barre d'onglets. L'état vit dans js/etat.mjs,
// les écrans dans js/vues.mjs, les cartes dans js/cartes.mjs, le chat dans js/chat.mjs.
import { $, $$, eur, depuis } from './js/util.mjs';
import { S, surChangement, emit, chargerTout, demarrerSynchro, appliquerEtat, annonceParId } from './js/etat.mjs';
import { ui, htmlFiltres, majFeuilleFiltres, listesAnnonces, listeSuivi, ecartees, vueAnnonces, vueFavoris, vueSuivi, vuePlus, vueEcartees, vueCriteres, vueDetail, favoris, relancesDues, resumeCriteres, nouvelles } from './js/vues.mjs';
import { remplirFormulaire, brancherCriteres, formulaireActif } from './js/criteres.mjs';
import { brancherBot, ouvrirBot, envoyerBot, copier } from './js/chat.mjs';
import { brancherDialogs, ouvrirAjout, ouvrirDossier } from './js/dialogs.mjs';
import { brancherMascotte, proposerBulleCriteres } from './js/mascotte.mjs';
import { toast } from './js/toast.mjs';
import { quartier } from './js/annonce-ui.mjs';
import { filtresVides, bornes } from './js/filtres.mjs';

// --- Routes ----------------------------------------------------------------
// #/ (annonces) · #/favoris · #/suivi · #/plus · #/plus/criteres · #/plus/ecartees · #/annonce/<id> (par-dessus l'onglet en cours)
function lireRoute(hash = location.hash) {
  const p = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (p[0] === 'annonce' && p[1]) return { onglet: null, annonce: p.slice(1).join('/') };
  if (p[0] === 'favoris') return { onglet: 'favoris' };
  if (p[0] === 'suivi') return { onglet: 'suivi' };
  if (p[0] === 'plus') return { onglet: 'plus', sous: p[1] || null };
  return { onglet: 'annonces' };
}
const routeVue = { annonces: vueAnnonces, favoris: vueFavoris, suivi: vueSuivi };
let route = lireRoute();
let ongletCourant = route.onglet ?? 'annonces';
let sousCourant = route.sous ?? null;
let dernierIdFocus = null;
let navigationInterne = false; // vrai si on est arrivé sur le détail depuis l'appli (le bouton retour peut alors faire history.back())

function vueCourante() {
  if (ongletCourant === 'plus') return sousCourant === 'criteres' ? vueCriteres() : sousCourant === 'ecartees' ? vueEcartees() : vuePlus();
  return routeVue[ongletCourant]();
}
const hashOnglet = () => ({ annonces: '#/', favoris: '#/favoris', suivi: '#/suivi', plus: sousCourant ? `#/plus/${sousCourant}` : '#/plus' })[ongletCourant];

// --- Rendu -----------------------------------------------------------------
const saisieEnCours = (racine) => { const a = document.activeElement; return a && racine.contains(a) && /^(TEXTAREA|INPUT|SELECT)$/.test(a.tagName); };

function rendreVue({ force = false } = {}) {
  const racine = $('#vue');
  if (ongletCourant === 'plus' && sousCourant === 'criteres') {
    // Le formulaire n'est pas redessiné pendant qu'elle le manipule : seulement rempli à neuf s'il vient d'être ouvert
    // ou si une valeur a changé ailleurs (proposition du bot appliquée, autre appareil).
    if (!$('#criteres', racine)) racine.innerHTML = vueCriteres();
    else if (formulaireActif() && !force) return;
    remplirFormulaire();
    return;
  }
  if (!force && saisieEnCours(racine)) return; // ne jamais redessiner sous ses doigts
  const y = window.scrollY;
  const actif = document.activeElement?.closest?.('[data-act][data-id]');
  const cle = actif ? `[data-act="${actif.dataset.act}"][data-id="${CSS.escape(actif.dataset.id)}"]` : null;
  const fk = document.activeElement?.closest?.('[data-fk]')?.dataset.fk;
  const pillsX = $('.pills', racine)?.scrollLeft ?? 0;
  racine.innerHTML = vueCourante();
  if (!force) window.scrollTo(0, y);
  const pills = $('.pills', racine); if (pills) pills.scrollLeft = pillsX;
  if (cle) $(cle, racine)?.focus({ preventScroll: true });
  else if (fk) $(`[data-fk="${CSS.escape(fk)}"]`, racine)?.focus({ preventScroll: true });
}

/** Annonces de la liste qu'on parcourait quand on a ouvert la fiche (pour « précédente / suivante »). */
function idsCourants() {
  if (ongletCourant === 'favoris') return favoris().map((l) => l.id);
  if (ongletCourant === 'suivi') return listeSuivi().map((l) => l.id);
  if (ongletCourant === 'plus' && sousCourant === 'ecartees') return ecartees().map((l) => l.id);
  if (ongletCourant === 'annonces' && S.charge) return listesAnnonces().liste.slice(0, ui.limite).map((l) => l.id);
  return [];
}
function navDetail(id) {
  const ids = idsCourants();
  const index = ids.indexOf(id);
  return index < 0 ? null : { index, total: ids.length, ids };
}
function voisine(delta) {
  const nav = navDetail(route.annonce);
  const cible = nav?.ids[nav.index + delta];
  if (cible != null) location.replace(`#/annonce/${encodeURIComponent(cible)}`); // replace : « retour » ramène à la liste, pas à l'annonce d'avant
}

function rendreDetail() {
  const zone = $('#detail');
  const id = route.annonce;
  zone.hidden = !id;
  document.body.classList.toggle('detail-ouvert', !!id);
  if (!id) { zone.innerHTML = ''; zone.dataset.id = ''; document.title = 'Mon appart à Paris'; return; }
  if (saisieEnCours(zone)) return;
  const defile = $('.det-defile', zone);
  const y = defile?.scrollTop ?? 0;
  const ouvertAvant = zone.dataset.id === id;
  zone.innerHTML = vueDetail(id, navDetail(id));
  zone.dataset.id = id;
  if (ouvertAvant) $('.det-defile', zone).scrollTop = y; else $('.rond', zone)?.focus({ preventScroll: true });
  const l = annonceParId(id);
  document.title = l ? `${quartier(l)}${l.price != null ? ' · ' + eur(l.price) : ''} — Mon appart` : 'Mon appart à Paris';
}

function majEntete() {
  $('#entete-sub').textContent = resumeCriteres();
  const dues = relancesDues();
  const b = $('#relances');
  b.hidden = !dues || !!route.annonce;
  b.textContent = `⏰ ${dues} relance${dues > 1 ? 's' : ''} à faire`;
  // Bannière : données périmées ou source en panne.
  const ban = $('#banniere');
  if (S.meta.generatedAt) {
    const ageH = (Date.now() - new Date(S.meta.generatedAt).getTime()) / 36e5;
    const panne = (S.meta.sources || []).filter((s) => s.status === 'erreur');
    if (ageH > 6) { ban.textContent = `Les données ont ${Math.round(ageH)} h : le bot semble à l'arrêt. Préviens Sacha.`; ban.hidden = false; }
    else if (panne.length) { ban.textContent = `Source en panne : ${panne.map((s) => s.name).join(', ')}. Les annonces affichées peuvent ne pas être à jour.`; ban.hidden = false; }
    else ban.hidden = true;
  }
  // Barre d'onglets : onglet courant + pastilles.
  for (const a of $$('#tabbar a')) a.setAttribute('aria-current', String(a.dataset.tab === ongletCourant));
  const setPastille = (k, n) => { const el = $(`#tabbar [data-tab="${k}"] .pastille`); el.textContent = n; el.hidden = !n; };
  setPastille('favoris', favoris().length);
  setPastille('suivi', relancesDues());
  document.body.dataset.ecran = ongletCourant;
}

function toutRendre() { majEntete(); rendreVue(); rendreDetail(); }

function surRoute() {
  const precedente = route;
  route = lireRoute();
  const avant = [ongletCourant, sousCourant];
  if (route.onglet) { ongletCourant = route.onglet; sousCourant = route.sous ?? null; }
  const changeVue = ongletCourant !== avant[0] || sousCourant !== avant[1];
  if (changeVue) { document.activeElement?.blur?.(); ui.limite = 30; window.scrollTo(0, 0); }
  majEntete();
  if (changeVue) rendreVue({ force: true });
  rendreDetail();
  if (precedente.annonce && !route.annonce && !changeVue) $(`.carte a[href="#/annonce/${CSS.escape(encodeURIComponent(precedente.annonce))}"]`)?.focus({ preventScroll: true });
}
addEventListener('hashchange', surRoute);

function fermerDetail() {
  if (navigationInterne && history.length > 1) history.back();
  else location.hash = hashOnglet();
}

// --- Événements (délégation) -------------------------------------------------
document.addEventListener('click', (e) => {
  const t = (s) => e.target.closest(s);

  if (t('a.lien-carte')) navigationInterne = true;
  if (t('[data-retour]')) { fermerDetail(); return; }

  const bc = t('[data-contact-annonce]');
  if (bc) {
    const l = annonceParId(bc.dataset.contactAnnonce);
    if (l) { ouvrirBot(); envoyerBot(`Rédige-moi un message de ${S.contacts[l.id]?.statut === 'contacte' ? 'relance' : 'contact'} pour cette annonce : ${eur(l.price)}${l.surface ? ` · ${l.surface} m²` : ''} · ${l.title ?? ''} (réf ${l.id}).`); }
    return;
  }
  const nav = t('[data-nav]');
  if (nav) { voisine(Number(nav.dataset.nav)); return; }
  const part = t('[data-partager]');
  if (part) { partager(part.dataset.partager); return; }
  const bm = t('[data-mascotte-annonce]');
  if (bm) {
    const l = annonceParId(bm.dataset.mascotteAnnonce);
    if (l) ouvrirBot(`À propos de cette annonce (${l.title ?? ''} · ${l.price != null ? eur(l.price) : '?'} · réf ${l.id}) : `);
    return;
  }
  const act = t('[data-act]');
  if (act) {
    const id = act.dataset.id;
    const l = annonceParId(id);
    const actif = S.statut[id] !== act.dataset.act;
    const avant = S.statut[id] ?? null;
    appliquerEtat('set_statut', { id, valeur: actif ? act.dataset.act : null, url: l?.url, title: l?.title, price: l?.price });
    if (act.dataset.act === 'ecarte' && actif) {
      toast('Annonce écartée', { action: { libelle: 'Annuler', fn: () => appliquerEtat('set_statut', { id, valeur: avant, url: l?.url, title: l?.title, price: l?.price }) } });
      if (route.annonce === id) fermerDetail();
    }
    return;
  }
  const pill = t('[data-pill]');
  if (pill) { const k = pill.dataset.pill; ui.f.actifs.has(k) ? ui.f.actifs.delete(k) : ui.f.actifs.add(k); ui.limite = 30; rendreVue({ force: true }); return; }
  if (t('[data-filtres]')) { $('#filtres-corps').innerHTML = htmlFiltres(); $('#dlg-filtres').showModal(); return; }
  if (t('[data-filtres-fermer]')) { $('#dlg-filtres').close(); return; }
  if (t('[data-filtres-reset]')) {
    ui.f = { ...filtresVides(), tri: ui.f.tri }; ui.limite = 30; rendreVue({ force: true });
    if ($('#dlg-filtres').open) { $('#filtres-corps').innerHTML = htmlFiltres(); $('#btn-voir')?.focus(); }
    return;
  }
  const seg = t('[data-seg]');
  if (seg) { ui.seg = seg.dataset.seg; ui.limite = 30; rendreVue({ force: true }); return; }
  if (t('[data-plus]')) { ui.limite += 30; rendreVue(); return; }
  if (t('[data-vu]')) { appliquerEtat('set_vu', { ts: new Date().toISOString() }); return; }
  const bot = t('[data-bot]');
  if (bot) { ouvrirBot(bot.dataset.bot || undefined); return; }
  if (t('[data-bot-relances]') || t('#relances')) { ouvrirBot(); envoyerBot('Qui dois-je relancer, et avec quel message ?'); return; }
  if (t('[data-ajout]')) { ouvrirAjout(); return; }
  if (t('[data-dossier]')) { ouvrirDossier(); return; }
  if (t('[data-recharger]')) location.reload();
});

// Feuille « Filtres » : les entrées modifient ui.f en direct ; la liste dessous suit, la feuille n'est pas redessinée.
function surFiltre(e) {
  const el = e.target;
  if (el.matches('[data-tri], [data-tri-feuille]')) { ui.f.tri = el.value; rendreVue({ force: true }); if (el.matches('[data-tri-feuille]')) majFeuilleFiltres($('#filtres-corps')); return; }
  const corps = $('#filtres-corps');
  if (!corps.contains(el)) return;
  if (el.matches('[data-f-pastille]')) { const k = el.dataset.fPastille; el.checked ? ui.f.actifs.add(k) : ui.f.actifs.delete(k); }
  else if (el.dataset.f === 'prixMax') { const max = Number(el.max); ui.f.prixMax = Number(el.value) >= max ? null : Number(el.value); }
  else if (el.dataset.f === 'surfaceMin') ui.f.surfaceMin = Number(el.value) <= 0 ? null : Number(el.value);
  else if (el.dataset.f === 'etageMin') ui.f.etageMin = el.value === '' ? null : Number(el.value);
  else return;
  ui.limite = 30;
  rendreVue({ force: true });
  majFeuilleFiltres(corps);
}
document.addEventListener('input', (e) => { if (e.target.matches?.('[data-f="prixMax"], [data-f="surfaceMin"]')) surFiltre(e); });
document.addEventListener('change', (e) => {
  if (e.target.matches?.('[data-tri], [data-tri-feuille], [data-f-pastille], [data-f="etageMin"]')) { surFiltre(e); return; }
  const sel = e.target.closest('select.suivi');
  if (!sel) return;
  const id = sel.dataset.id;
  const l = annonceParId(id);
  const v = sel.value;
  if (!v) return;
  const statutContact = v === '__aucun' ? null : v;
  appliquerEtat('set_contact', { id, statut: statutContact, relance_jours: statutContact === 'contacte' ? 3 : null, url: l?.url, title: l?.title });
});
document.addEventListener('focusout', (e) => {
  const ta = e.target.closest('.note-txt');
  if (!ta) return;
  const id = ta.dataset.id;
  const l = annonceParId(id);
  appliquerEtat('set_note', { id, texte: ta.value.trim(), url: l?.url, title: l?.title });
});
// Une photo tierce cassée (404, hotlink refusé) est remplacée par la tuile : jamais d'image brisée.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img?.tagName === 'IMG' && img.classList.contains('photo-img')) img.outerHTML = img.dataset.tuile;
}, true);
// Partager l'annonce d'origine (feuille de partage du téléphone) ; à défaut, copie du lien.
async function partager(id) {
  const l = annonceParId(id);
  if (!l?.url) return;
  const titre = `${quartier(l)}${l.price != null ? ' · ' + eur(l.price) : ''}`;
  if (navigator.share) { try { await navigator.share({ title: titre, text: titre, url: l.url }); } catch { /* annulé */ } return; }
  toast(await copier(l.url) ? 'Lien de l\'annonce copié' : 'Copie impossible : ouvre l\'annonce et partage-la de là');
}
// Glisser à l'horizontale sur la fiche = annonce précédente / suivante (téléphone).
{
  let dep = null;
  const zone = $('#detail');
  zone.addEventListener('touchstart', (e) => { dep = e.target.closest('textarea, input, select') || e.touches.length > 1 ? null : [e.touches[0].clientX, e.touches[0].clientY]; }, { passive: true });
  zone.addEventListener('touchend', (e) => {
    if (!dep) return;
    const dx = e.changedTouches[0].clientX - dep[0], dy = e.changedTouches[0].clientY - dep[1];
    dep = null;
    if (Math.abs(dx) > 90 && Math.abs(dy) < 50) voisine(dx < 0 ? 1 : -1);
  }, { passive: true });
}
// Échap ferme le détail ; ← / → parcourent les annonces (bureau).
document.addEventListener('keydown', (e) => {
  if (!route.annonce || document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') fermerDetail();
  else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !e.target.closest?.('textarea, input, select')) voisine(e.key === 'ArrowRight' ? 1 : -1);
});

// --- Démarrage ---------------------------------------------------------------
surChangement((motif) => {
  if (motif === 'criteres-local') { majEntete(); return; }
  toutRendre();
});

async function demarrer() {
  brancherCriteres({ proposerBulle: proposerBulleCriteres });
  brancherBot();
  brancherDialogs();
  brancherMascotte();
  emit('init'); // classe le cache local et affiche les squelettes pendant le chargement
  await chargerTout();
  demarrerSynchro();
}
demarrer();
