// Suivi de portefeuilles Hyperliquid (« whales ») -> alertes Telegram.
// Lancé toutes les 10 minutes par GitHub Actions (.github/workflows/whale.yml).
// À chaque passage : positions actuelles (API publique Hyperliquid) comparées au passage précédent.
// Alerte quand une position d'au moins 2 M$ est ouverte, fermée ou retournée, ou quand elle change de plus de 20 % et d'au moins 2 M$.
// Secrets : TG_BOT_TOKEN, TG_CHAT_ID. Sans eux, le script tourne à vide et écrit ce qu'il aurait envoyé.
import fs from 'node:fs';

// Les portefeuilles reliés par « + » appartiennent au même trader : leurs positions sont additionnées, une seule alerte par trade.
const WALLETS = (process.env.WHALES || [
  '0x237152b038d88f4156a0cd71090462de7e3f0883+0xbd1c84113c6deb5044be0c2221f9e9403811ff0e',
  '0x93ab7dbdeb996806454de19c35c8247f4b2511f8',
  '0xec7f9f5b31b8f5da6ac6c0973bbd496e16f9df39',
  // les 10 meilleurs traders du classement Hyperliquid (choisis le 13/10/2026 : gros gains cumulés, mois positif, actifs, pas de market makers)
  '0x77375a8c9d13bf79afb2a87f1b0ac1dfd5f5bf66',
  '0x880ac484a1743862989a441d6d867238c7aa311c',
  '0x469e9a7f624b04c24f0e64edf8d8a277e6bf58a5',
  '0xaf0fdd39e5d92499b0ed9f68693da99c0ec1e92e',
  '0x051c2e6d49cf82ebc47f08f9b85800f94fc9693c',
  '0x7a6d5fc57f6906f337c48fe2763c3a501304f79c',
  '0xbf49647d017805fcc576ac10f33a788e636f4258',
  '0xf517639a8872e756ac98d3c65507d2ebc25cc032',
  '0x936cf4fb95c30ce83f658b5bbb247e4bb381bb0f',
  '0x0871deb34bfd2052b1c10dc4f6c0912a2a47e927',
].join(',')).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const NAMES = {
  '0x77375a8c9d13bf79afb2a87f1b0ac1dfd5f5bf66': 'Top 1 (+61 M$)',
  '0x880ac484a1743862989a441d6d867238c7aa311c': 'Top 2 · SilkBtc (+121 M$)',
  '0x469e9a7f624b04c24f0e64edf8d8a277e6bf58a5': 'Top 3 (+28 M$)',
  '0xaf0fdd39e5d92499b0ed9f68693da99c0ec1e92e': 'Top 4 (+27 M$)',
  '0x051c2e6d49cf82ebc47f08f9b85800f94fc9693c': 'Top 5 (+14 M$)',
  '0x7a6d5fc57f6906f337c48fe2763c3a501304f79c': 'Top 6 (+15 M$)',
  '0xbf49647d017805fcc576ac10f33a788e636f4258': 'Top 7 (+32 M$)',
  '0xf517639a8872e756ac98d3c65507d2ebc25cc032': 'Top 8 · NMTD (+30 M$)',
  '0x936cf4fb95c30ce83f658b5bbb247e4bb381bb0f': 'Top 9 (+12 M$)',
  '0x0871deb34bfd2052b1c10dc4f6c0912a2a47e927': 'Top 10 · PURRINA (+15 M$)',
};
const TOKEN = (process.env.TG_BOT_TOKEN || '').trim();
let CHAT = (process.env.TG_CHAT_ID || '').trim();
const MIN_PCT = +(process.env.WHALE_MIN_PCT || 0.2), MIN_USD = +(process.env.WHALE_MIN_USD || 2000000);  // seuls les gros trades (2 M$ et plus) déclenchent une alerte
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
const short = a => a.split('+').map(x => x.slice(0, 6) + '…' + x.slice(-4)).join(' + ');
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
    try { const me = await (await fetch(`https://api.telegram.org/bot${TOKEN}/getMe`)).json(); if (me.ok) console.log('Ce jeton est celui du bot @' + me.result.username + ' : c’est à lui qu’il faut écrire (bouton Démarrer).'); } catch (e) {}
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

// additionne les positions de plusieurs portefeuilles du même trader
function merge(snaps) {
  if (snaps.length === 1) return snaps[0];
  const out = {equity: snaps.reduce((s, x) => s + x.equity, 0), pos: {}};
  for (const sn of snaps) for (const [c, p] of Object.entries(sn.pos)) {
    const q = out.pos[c];
    if (!q) { out.pos[c] = {...p}; continue; }
    const szi = q.szi + p.szi;
    out.pos[c] = {szi, value: q.value + p.value * Math.sign(p.szi) * Math.sign(q.szi || 1), upnl: q.upnl + p.upnl, lev: q.lev,
      entry: Math.sign(q.szi) === Math.sign(p.szi) ? (q.entry * Math.abs(q.szi) + p.entry * Math.abs(p.szi)) / (Math.abs(q.szi) + Math.abs(p.szi)) : q.entry,
      liq: q.liq && p.liq ? (q.szi > 0 ? Math.max(q.liq, p.liq) : Math.min(q.liq, p.liq)) : (q.liq || p.liq)};
    out.pos[c].value = Math.abs(out.pos[c].value);
    if (!szi) delete out.pos[c];
  }
  return out;
}

const state = (() => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return {}; } })();
state.w = state.w || {};
if (state.chat) CHAT = state.chat;
let sent = 0;
const hellos = [];
for (const addr of WALLETS) {
  const addrs = addr.split('+');
  const raws = [];
  for (const a of addrs) raws.push(await api({type: 'clearinghouseState', user: a}));
  if (raws.some(r => !r || !r.marginSummary)) { console.log(short(addr) + ' : API indisponible, passage ignoré.'); continue; }
  const now = merge(raws.map(snapshot)), prev = state.w[addr], since = prev ? prev.t : Date.now() - 15 * 60e3;
  const link = addrs.map((a, k) => `<a href="https://hypurrscan.io/address/${a}">${addrs.length > 1 ? 'wallet ' + (k + 1) : 'voir le portefeuille'}</a>`).join(' · ');
  const head = `🐋 <b>${NAMES[addr] ? esc(NAMES[addr]) + ' · ' + short(addr) : 'Whale ' + short(addr)}</b>`;
  console.log(`${short(addr)} : capital ${usd(now.equity)}, positions ${Object.entries(now.pos).map(([c, p]) => c + ' ' + side(p.szi) + ' ' + usd(p.value)).join(', ') || 'aucune'}`);
  let hello = prev ? prev.hello : false;
  if (!prev || (TOKEN && CHAT && !prev.hello)) {
    // premier passage : on montre simplement où il en est
    const lines = Object.entries(now.pos).map(([c, p]) => `${icon(p.szi)} ${side(p.szi)} <b>${esc(c)}</b> ${usd(p.value)} ×${p.lev} · entrée ${px(p.entry)}${p.liq ? ' · liquidation ' + px(p.liq) : ''} · latent ${usd(p.upnl)}`);
    hellos.push({addr, text: `${head}\nCapital ${usd(now.equity)}\n${lines.join('\n') || 'Aucune position ouverte.'}\n${link}`});
  }
  if (prev) {
    // gains réalisés depuis le passage précédent (pour les fermetures et allègements)
    let fills = [];
    const changed = Object.keys({...prev.pos, ...now.pos}).filter(c => JSON.stringify((prev.pos[c] || {}).szi) !== JSON.stringify((now.pos[c] || {}).szi));
    if (changed.length) for (const a of addrs) fills = fills.concat((await api({type: 'userFillsByTime', user: a, startTime: since})) || []);
    for (const c of changed) {
      const a = prev.pos[c], b = now.pos[c], f = fills.filter(x => x.coin === c);
      const realized = f.reduce((s, x) => s + (+x.closedPnl || 0), 0);
      const vwap = f.length ? f.reduce((s, x) => s + (+x.px) * (+x.sz), 0) / f.reduce((s, x) => s + (+x.sz), 0) : null;
      const at = vwap ? ` vers ${px(vwap)}` : '';
      let msg = null;
      if (!a && b && b.value >= MIN_USD) msg = `${icon(b.szi)} <b>ouvre un ${side(b.szi)} ${esc(c)}</b>${at}\nTaille ${usd(b.value)} ×${b.lev} · entrée ${px(b.entry)}${b.liq ? ' · liquidation ' + px(b.liq) : ''}`;
      else if (a && !b && a.value >= MIN_USD) msg = `⚪ <b>ferme son ${side(a.szi)} ${esc(c)}</b>${at}\nIl était de ${usd(a.value)} · gain réalisé ${usd(realized)}`;
      else if (a && b && Math.sign(a.szi) !== Math.sign(b.szi) && Math.max(a.value, b.value) >= MIN_USD) msg = `🔄 <b>retourne ${esc(c)} : ${side(a.szi)} → ${side(b.szi)}</b>${at}\nNouvelle taille ${usd(b.value)} ×${b.lev} · entrée ${px(b.entry)}${b.liq ? ' · liquidation ' + px(b.liq) : ''} · gain réalisé ${usd(realized)}`;
      else if (a && b && Math.sign(a.szi) === Math.sign(b.szi)) {
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
// état de départ des nouveaux traders suivis : regroupé en un minimum de messages
if (hellos.length) {
  let buf = '👀 <b>Suivi activé</b>', group = [];
  const flush = async () => { if (group.length && await tg(buf)) { sent++; for (const a of group) state.w[a].hello = !!(TOKEN && CHAT); } };
  for (const h of hellos) {
    if (buf.length + h.text.length > 3800) { await flush(); buf = '👀 <b>Suivi activé (suite)</b>'; group = []; }
    buf += '\n\n' + h.text; group.push(h.addr);
  }
  await flush();
}
fs.writeFileSync(STATE, JSON.stringify(state));
console.log('Alertes envoyées : ' + sent);
