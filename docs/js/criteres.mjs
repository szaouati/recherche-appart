// « Mes critères » : formulaire <-> objet critères. Ces réglages sont PARTAGÉS (Worker → docs/criteria.json) :
// les changements partent 4 s après le dernier geste, jamais à chaque cran de curseur.
import { CRITERES } from '../score.mjs';
import { $, esc, eur } from './util.mjs';
import { S, appliquerEtat, emit, sauverCriteresCache } from './etat.mjs';

const ETATS = ['neutre', 'pref', 'exclu'];
let etatsArr = {};

export function htmlCriteres() {
  return `<form id="criteres" class="criteres" onsubmit="return false">
    <section class="bloc">
      <h2 class="bloc-titre">Indispensable</h2>
      <label class="champ">Budget max <output id="o-budget"></output>
        <input type="range" id="budgetMax" min="600" max="3500" step="50"></label>
      <label class="champ">Surface minimum <output id="o-surface"></output>
        <input type="range" id="surfaceMin" min="9" max="100" step="1"></label>
      <label class="champ">Pièces minimum
        <select id="piecesMin"><option value="1">1 (studio)</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select></label>
      <fieldset class="seg" id="meuble"><legend>Meublé</legend>
        <label><input type="radio" name="meuble" value="indifferent"> Peu importe</label>
        <label><input type="radio" name="meuble" value="oui"> Oui</label>
        <label><input type="radio" name="meuble" value="non"> Non</label>
      </fieldset>
      <fieldset class="cases"><legend>Écarter automatiquement</legend>
        <label><input type="checkbox" id="ex-rdc"> Rez-de-chaussée</label>
        <label><input type="checkbox" id="ex-dpeFG"> DPE F ou G</label>
        <label><input type="checkbox" id="ex-coloc"> Colocation / sous-location</label>
      </fieldset>
    </section>
    <section class="bloc">
      <h2 class="bloc-titre">Arrondissements</h2>
      <p class="hint">Un tap : ★ préféré. Deux taps : ✕ exclu. Trois : neutre.</p>
      <div id="arr-grid" class="arr-grid"></div>
    </section>
    <details class="bloc poids">
      <summary>Ce qui compte pour moi <span class="hint">(0 = indifférent, 5 = essentiel)</span></summary>
      <div id="poids-list"></div>
    </details>
    <section class="bloc">
      <h2 class="bloc-titre">Alerte Telegram</h2>
      <label class="champ case"><input type="checkbox" id="alerteActive"> Me prévenir des nouvelles annonces</label>
      <label class="champ">Seulement si le score est au moins de <output id="o-alerte"></output>
        <input type="range" id="alerteScoreMin" min="40" max="95" step="1"></label>
    </section>
  </form>`;
}

function arrDepuisCriteres() {
  etatsArr = {};
  for (let i = 1; i <= 20; i++) {
    etatsArr[i] = S.criteria.arrondissementsPref.includes(i) ? 'pref' : S.criteria.arrondissements.length && !S.criteria.arrondissements.includes(i) ? 'exclu' : 'neutre';
  }
}
function criteresDepuisArr() {
  const exclus = Object.keys(etatsArr).filter((i) => etatsArr[i] === 'exclu').map(Number);
  S.criteria.arrondissementsPref = Object.keys(etatsArr).filter((i) => etatsArr[i] === 'pref').map(Number);
  S.criteria.arrondissements = exclus.length ? Array.from({ length: 20 }, (_, i) => i + 1).filter((i) => !exclus.includes(i)) : [];
}

export const formulaireOuvert = () => !!$('#criteres');
/** Le formulaire est-il en train d'être manipulé ? (on ne le redessine alors pas sous ses doigts) */
export const formulaireActif = () => !!document.activeElement?.closest?.('#criteres');

export function remplirFormulaire() {
  if (!formulaireOuvert()) return;
  const c = S.criteria;
  $('#budgetMax').value = c.budgetMax;
  $('#surfaceMin').value = c.surfaceMin;
  $('#piecesMin').value = c.piecesMin;
  $(`input[name=meuble][value=${c.meuble}]`).checked = true;
  for (const k of ['rdc', 'dpeFG', 'coloc']) $(`#ex-${k}`).checked = c.exclure[k];
  $('#alerteActive').checked = c.alerteActive;
  $('#alerteScoreMin').value = c.alerteScoreMin;
  arrDepuisCriteres();
  dessinerArr();
  $('#poids-list').innerHTML = CRITERES.map(
    ([k, label]) => `<div class="poids-row"><label for="w-${k}">${esc(label)}</label><output id="ow-${k}">${c.poids[k]}</output>
      <input type="range" id="w-${k}" data-poids="${k}" min="0" max="5" step="1" value="${c.poids[k]}"></div>`,
  ).join('');
  sorties();
}

function sorties() {
  $('#o-budget').textContent = eur(S.criteria.budgetMax);
  $('#o-surface').textContent = `${S.criteria.surfaceMin} m²`;
  $('#o-alerte').textContent = `${S.criteria.alerteScoreMin}/100`;
}

function dessinerArr() {
  $('#arr-grid').innerHTML = Object.entries(etatsArr)
    .map(([i, e]) => `<button type="button" class="arr" data-arr="${i}" data-etat="${e}" aria-label="${i}e arrondissement : ${{ pref: 'préféré', exclu: 'exclu', neutre: 'neutre' }[e]}">${e === 'pref' ? '★' : e === 'exclu' ? '✕' : ''}${i}</button>`)
    .join('');
}

let debounceCritere = null;
let surBulleCriteres = () => {};
export function brancherCriteres({ proposerBulle }) {
  surBulleCriteres = proposerBulle;
  const racine = document.getElementById('vue');
  racine.addEventListener('input', (e) => { if (e.target.closest('#criteres')) lireFormulaire(); });
  racine.addEventListener('click', (e) => {
    const b = e.target.closest('#criteres [data-arr]');
    if (!b) return;
    const i = b.dataset.arr;
    etatsArr[i] = ETATS[(ETATS.indexOf(etatsArr[i]) + 1) % 3];
    dessinerArr();
    lireFormulaire();
  });
}

function lireFormulaire() {
  const c = S.criteria;
  c.budgetMax = Number($('#budgetMax').value);
  c.surfaceMin = Number($('#surfaceMin').value);
  c.piecesMin = Number($('#piecesMin').value);
  c.meuble = $('input[name=meuble]:checked').value;
  for (const k of ['rdc', 'dpeFG', 'coloc']) c.exclure[k] = $(`#ex-${k}`).checked;
  c.alerteActive = $('#alerteActive').checked;
  c.alerteScoreMin = Number($('#alerteScoreMin').value);
  for (const el of document.querySelectorAll('[data-poids]')) {
    c.poids[el.dataset.poids] = Number(el.value);
    $(`#ow-${el.dataset.poids}`).textContent = el.value;
  }
  criteresDepuisArr();
  sauverCriteresCache();
  sorties();
  emit('criteres-local');
  // On attend qu'elle arrête de bouger les curseurs avant d'envoyer au Worker et de proposer un avis :
  // sinon un simple glissement de curseur enverrait des dizaines d'écritures et de bulles.
  clearTimeout(debounceCritere);
  debounceCritere = setTimeout(() => {
    appliquerEtat('set_criteria', { criteria: S.criteria, source: 'panel' });
    surBulleCriteres();
  }, 4000);
}
