// Suivi de portefeuilles Hyperliquid (« whales ») -> alertes Telegram.
// Lancé toutes les 10 minutes par GitHub Actions (.github/workflows/whale.yml).
// À chaque passage : positions actuelles (API publique Hyperliquid) comparées au passage précédent.
// Alerte quand une position est ouverte, fermée, retournée, ou change de plus de 20 % (et d'au moins 250 000 $).
// Secrets : TG_BOT_TOKEN, TG_CHAT_ID. Sans eux, le script tourne à vide et écrit ce qu'il aurait envoyé.
import fs from 'node:fs';

const WALLETS = (process.env.WHALES || [
  '0x237152b038d88f4156a0cd71090462de7e3f0883',
  '0xbd1c84113c6deb5044be0c2221f9e9403811ff0e',
  '0x93ab7dbdeb996806454de19c35c8247f4b2511f8',
  '0xec7f9f5b31b8f5da6ac6c0973bbd496e16f9df39',
].join(',')).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const TOKEN = (process.env.TG_BOT_TOKEN || '').trim();
let CHAT = (process.env.TG_CHAT_ID || '').trim();
const MIN_PCT = +(process.env.WHALE_MIN_PCT || 0.2), MIN_USD = +(process.env.WHALE_MIN_USD || 250000);
const STATE = 'whale_state.json';

const api = async body => {
  for (let k = 0; k < 3; k++) {
    try { const r = await fetch('https://api.hyperliquid.xyz/info', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}); if (r.ok) return await r.json(); } catch (e) {}
    await new Promise(r => setTimeout(r, 2000));
  }
  return null;
};
const esc = s => String(s).replace(/[&<>]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c]));
const fr = (v, d = 0) => v.toLocaleString('fr-FR', {minimumFractionDigits: d, maximumFractionDigits: d});
const usd = v => { const a = Math.abs(v); return (v < 0 ? '−' : '') + (a >= 1e6 ? fr(a / 1e6, 2) + ' M$' : a >= 1e3 ? fr(a / 1e3, 0) + ' k$' : fr(a, 0) + ' $'); };
const px = v => fr(v, v >= 1000 ? 0 : v >= 10 ? 2 : 4);
const short = a => a.slice(0, 6) + '…' + a.slice(-4);
const side = s => s > 0 ? 'LONG' : 'SHORT';
const icon = s => s > 0 ? '🟢' : '🔴';

let chatTried = false;
async function findChat() {
  // le chat id donné est faux : on prend la dernière conversation où quelqu'un a écrit au bot
  chatTried = true;
  try {
    const j = await (await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates`)).json();
    const u = j.ok && j.result.map(x => x.message || x.channel_post || x.my_chat_member).filter(Boolean).pop();
    if (u) { CHAT = String(u.chat.id); state.chat = CHAT; console.log('Chat trouvé automatiquement à partir des derniers messages reçus par le bot.'); return true; }
    console.log(j.ok ? 'Aucun message reçu par le bot : écris-lui « bonjour » dans Telegram.' : 'Lecture des messages du bot impossible : ' + (j.description || 'erreur'));
  } catch (e) {}
  return false;
}
async function tg(text) {
  if (!TOKEN || !CHAT) { console.log('[à vide] ' + text.replace(/<[^>]+>/g, '').replace(/\n/g, ' ¦ ')); return true; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {method: 'POST', body: new URLSearchParams({chat_id: CHAT, text, parse_mode: 'HTML', disable_web_page_preview: 'true'})});
    const j = await r.json();
    if (!j.ok && /chat not found|chat_id is empty|PEER_ID_INVALID/i.test(j.description || '') && !chatTried && await findChat()) return tg(text);
    if (!j.ok) console.log('Telegram a refusé : ' + (j.description || 'erreur'));
    return j.ok;
  } catch (e) { console.log('Telegram injoignable.'); return false; }
}

function snapshot(st) {
  const out = {};
  for (const ap of st.assetPositions || []) {
    const p = ap.position, szi = +p.szi; if (!szi) continue;
    out[p.coin] = {szi, value: +p.positionValue, entry: +p.entryPx, liq: p.liquidationPx ? +p.liquidationPx : null, lev: p.leverage && p.leverage.value, upnl: +p.unrealizedPnl};
  }
  return {equity: +(st.marginSummary || {}).accountValue || 0, pos: out};
}

const state = (() => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return {}; } })();
state.w = state.w || {};
if (state.chat) CHAT = state.chat;
let sent = 0;
for (const addr of WALLETS) {
  const raw = await api({type: 'clearinghouseState', user: addr});
  if (!raw || !raw.marginSummary) { console.log(short(addr) + ' : API indisponible, passage ignoré.'); continue; }
  const now = snapshot(raw), prev = state.w[addr], since = prev ? prev.t : Date.now() - 15 * 60e3;
  const link = `<a href="https://hypurrscan.io/address/${addr}">voir le portefeuille</a>`;
  const head = `🐋 <b>Whale ${short(addr)}</b>`;
  console.log(`${short(addr)} : capital ${usd(now.equity)}, positions ${Object.entries(now.pos).map(([c, p]) => c + ' ' + side(p.szi) + ' ' + usd(p.value)).join(', ') || 'aucune'}`);
  let hello = prev ? prev.hello : false;
  if (!prev || (TOKEN && CHAT && !prev.hello)) {
    // premier passage : on montre simplement où il en est
    const lines = Object.entries(now.pos).map(([c, p]) => `${icon(p.szi)} ${side(p.szi)} <b>${esc(c)}</b> ${usd(p.value)} ×${p.lev} · entrée ${px(p.entry)}${p.liq ? ' · liquidation ' + px(p.liq) : ''} · latent ${usd(p.upnl)}`);
    if (await tg(`${head} · suivi activé\nCapital ${usd(now.equity)}\n${lines.join('\n') || 'Aucune position ouverte.'}\n${link}`)) { sent++; hello = !!(TOKEN && CHAT); }
  }
  if (prev) {
    // gains réalisés depuis le passage précédent (pour les fermetures et allègements)
    let fills = [];
    const changed = Object.keys({...prev.pos, ...now.pos}).filter(c => JSON.stringify((prev.pos[c] || {}).szi) !== JSON.stringify((now.pos[c] || {}).szi));
    if (changed.length) fills = (await api({type: 'userFillsByTime', user: addr, startTime: since})) || [];
    for (const c of changed) {
      const a = prev.pos[c], b = now.pos[c], f = fills.filter(x => x.coin === c);
      const realized = f.reduce((s, x) => s + (+x.closedPnl || 0), 0);
      const vwap = f.length ? f.reduce((s, x) => s + (+x.px) * (+x.sz), 0) / f.reduce((s, x) => s + (+x.sz), 0) : null;
      const at = vwap ? ` vers ${px(vwap)}` : '';
      let msg = null;
      if (!a && b) msg = `${icon(b.szi)} <b>ouvre un ${side(b.szi)} ${esc(c)}</b>${at}\nTaille ${usd(b.value)} ×${b.lev} · entrée ${px(b.entry)}${b.liq ? ' · liquidation ' + px(b.liq) : ''}`;
      else if (a && !b) msg = `⚪ <b>ferme son ${side(a.szi)} ${esc(c)}</b>${at}\nIl était de ${usd(a.value)} · gain réalisé ${usd(realized)}`;
      else if (Math.sign(a.szi) !== Math.sign(b.szi)) msg = `🔄 <b>retourne ${esc(c)} : ${side(a.szi)} → ${side(b.szi)}</b>${at}\nNouvelle taille ${usd(b.value)} ×${b.lev} · entrée ${px(b.entry)}${b.liq ? ' · liquidation ' + px(b.liq) : ''} · gain réalisé ${usd(realized)}`;
      else {
        const dSz = Math.abs(b.szi) - Math.abs(a.szi), dUsd = Math.abs(dSz) * (b.value / Math.abs(b.szi));
        if (Math.abs(dSz) / Math.abs(a.szi) >= MIN_PCT && dUsd >= MIN_USD)
          msg = `${dSz > 0 ? icon(b.szi) + ' <b>renforce' : '🟡 <b>allège'} son ${side(b.szi)} ${esc(c)}</b> de ${usd(dUsd)}${at}\nTaille ${usd(a.value)} → ${usd(b.value)} ×${b.lev} · entrée ${px(b.entry)}${b.liq ? ' · liquidation ' + px(b.liq) : ''}${dSz < 0 ? ' · gain réalisé ' + usd(realized) : ''}`;
      }
      if (msg && await tg(`${head} ${msg}\nCapital ${usd(now.equity)} · ${link}`)) sent++;
      if (!msg) now.pos[c] = a && b ? {...b, base: (prev.pos[c].base || prev.pos[c].szi)} : now.pos[c];
    }
  }
  // pour les petits ajustements, on garde la taille de référence : ils finissent par compter s'ils s'additionnent
  for (const [c, p] of Object.entries(now.pos)) if (p.base && Math.sign(p.base) === Math.sign(p.szi)) { now.pos[c] = {...p, szi: p.base}; delete now.pos[c].base; }
  state.w[addr] = {t: Date.now(), equity: now.equity, pos: now.pos, hello};
}
fs.writeFileSync(STATE, JSON.stringify(state));
console.log('Alertes envoyées : ' + sent);
