// Alerte Telegram. Config : TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (secrets GitHub).

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const eur = (n) => `${Math.round(Number(n)).toLocaleString('fr-FR')} €`;

export const telegramConfigured = () => Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

export function formatAlert(l) {
  const traits = [
    l.features?.balcon && 'balcon',
    l.features?.terrasse && 'terrasse',
    l.elevator && 'ascenseur',
    l.floor != null && l.floor >= 3 && `${l.floor}e étage`,
    l.dpe && `DPE ${l.dpe}`,
    l.features?.lumineux && 'lumineux',
    l.features?.calme && 'calme',
  ].filter(Boolean);
  const verif = l.aVerifier?.length ? `\n⚠️ à vérifier : ${l.aVerifier.join(', ')}` : '';
  return (
    `🏠 <b>${l.score}/100</b> · ${eur(l.price)} CC · ${l.surface ?? '?'} m² · Paris ${l.arrondissement ?? '?'}e\n` +
    `${esc(l.title ?? '')}${traits.length ? `\n${esc(traits.join(' · '))}` : ''}${verif}\n` +
    `<a href="${esc(l.url)}">Voir l'annonce</a>`
  );
}

export async function sendTelegram(text) {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat } = process.env;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status} : ${(await res.text()).slice(0, 200)}`);
}
