// La mascotte : présence discrète qui invite à tout modifier, et récolte ses avis (👍/👎 → journal partagé).
// Illustration : docs/mascotte.webp (fournie par Sacha ; origine et droits à confirmer — ne pas la réutiliser
// ailleurs, ni comme logo, sans lui en parler). Elle ouvre le même chat que « Demander à Claude ».
import { $, esc, store } from './util.mjs';
import { S, envoyerEvenement } from './etat.mjs';
import { ouvrirBot } from './chat.mjs';

export function montrerBulle(texte, boutons) {
  const bulle = $('#mascotte-bulle');
  bulle.innerHTML = `<p>${esc(texte)}</p><div class="mascotte-bulle-actions"></div>`;
  const zone = bulle.querySelector('.mascotte-bulle-actions');
  for (const b of boutons) {
    const btn = document.createElement('button');
    btn.className = 'btn small' + (b.primaire ? ' primary' : ' ghost');
    btn.textContent = b.texte;
    btn.addEventListener('click', () => { cacherBulle(); b.action?.(); });
    zone.appendChild(btn);
  }
  bulle.hidden = false;
}
export function cacherBulle() { $('#mascotte-bulle').hidden = true; }

export function proposerBulleCriteres() {
  if (store.get('bulleCriteresVue', false)) return; // une seule fois par appareil, pas à chaque réglage
  store.set('bulleCriteresVue', true);
  montrerBulle('Ces nouveaux critères, ça te va ?', [
    { texte: '👍 Oui', primaire: true, action: () => envoyerEvenement('avis', { sujet: 'criteres', avis: 'positif', criteria: S.criteria }) },
    { texte: '👎 Pas trop', action: () => envoyerEvenement('avis', { sujet: 'criteres', avis: 'negatif', criteria: S.criteria }) },
    { texte: 'Dis-m\'en plus', action: () => ouvrirBot('') },
  ]);
}

// iOS (Safari) ne propose aucun vrai popup natif d'installation déclenchable en JS : la seule option est
// d'expliquer nous-mêmes le geste « Partager → Sur l'écran d'accueil ». On ne le propose qu'à Safari lui-même
// (pas Chrome/Firefox iOS, ni les navigateurs intégrés d'apps tierces), et jamais si déjà installée.
export function estCandidatInstallationIOS() {
  const ua = navigator.userAgent || '';
  const iOS = /iP(hone|od|ad)/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
  const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  const dejaInstallee = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  return iOS && safari && !dejaInstallee;
}
function proposerBulleInstall() {
  if (!estCandidatInstallationIOS() || store.get('bulleInstallVue', false)) return;
  store.set('bulleInstallVue', true);
  montrerBulle(
    "Envie de l'avoir comme une vraie appli sur ton iPhone ? Appuie sur ⬆️ Partager en bas de Safari, puis « Sur l'écran d'accueil ».",
    [{ texte: 'Compris', primaire: true, action: () => {} }],
  );
}

export function brancherMascotte() {
  $('#mascotte-flottante').addEventListener('click', () => ouvrirBot());
  // Si elle a filé discuter avec le bot plutôt que de choisir « Plus tard », on propose quand même l'installation
  // à la fermeture du chat, sans quoi ça ne se représente jamais de la session.
  $('#dlg-bot').addEventListener('close', () => setTimeout(proposerBulleInstall, 400));
  // Premier contact : une seule fois, on se présente et on explique la transparence avec Sacha.
  if (!store.get('bulleAccueilVue', false)) {
    store.set('bulleAccueilVue', true);
    setTimeout(() => montrerBulle(
      "Coucou, c'est moi ! Tu peux tout me demander pour ajuster tes critères. Ce qu'on se dit ici, et tes ♥/✕/notes, Sacha les voit aussi pour adapter le site pour toi.",
      [
        { texte: 'Compris, on discute', primaire: true, action: () => ouvrirBot() },
        { texte: 'Plus tard', action: () => setTimeout(proposerBulleInstall, 1000) },
      ],
    ), 1200);
  } else {
    setTimeout(proposerBulleInstall, 1500);
  }
}
