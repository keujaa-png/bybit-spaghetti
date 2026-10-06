// Robot Telegram des idées macro. Lancé par GitHub Actions (.github/workflows/macro.yml), sans navigateur.
// Le jeton du bot vient du secret TELEGRAM_TOKEN : il n'est jamais écrit dans le dépôt ni dans les journaux.
import fs from 'node:fs';
import crypto from 'node:crypto';
import './macro_engine.js';
const ME = globalThis.ME;
const TOKEN = (process.env.TELEGRAM_TOKEN || '').trim();
let CHAT = (process.env.TELEGRAM_CHAT_ID || '').trim();
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const today = ME.today();

const pb = readJ('macro_playbook.json'), base = readJ('macro_hist.json');
const add = readJ('macro_add.json', {}), state = readJ('macro_state.json', {sent: {}});
state.sent = state.sent || {};
ME.load(pb, base, [add]);

// 1. cours du jour : on ne garde dans le dépôt que les séances terminées
const bars = await ME.scan();
if (bars) {
  ME.merge(bars);
  const cut = today - 400;
  for (const [s, A] of Object.entries(bars)) {
    const B = add[s] = add[s] || {};
    for (const [d, v] of Object.entries(A)) if (+d < today) B[d] = v;
    for (const d of Object.keys(B)) if (+d < cut) delete B[d];
  }
  fs.writeFileSync('macro_add.json', JSON.stringify(add));
  console.log('Cours du jour : ' + Object.keys(bars).length + ' symboles.');
} else console.log('Cours du jour indisponibles : calcul sur les données déjà enregistrées.');

// 2. idées
ME.compute();
const cur = ME.current(), fresh = cur.filter(ME.isNew).reverse();
const s5 = ME.stats(ME.PICK, 0);
console.log(`Idées en cours : ${cur.length}, dont nouvelles : ${fresh.length}. ${ME.btLine()}`);
for (const tr of cur) console.log(`  ${ME.dstr(tr.day)} ${tr.s > 0 ? 'ACHAT' : 'VENTE'} ${tr.leg.n} (${tr.sym}) · ${ME.ideaText(ME.theme(tr.th), tr).title}`);
let polys = [];
try { polys = (await ME.polyCurated()).filter(o => o.hot); } catch (e) {}
console.log('Paris Polymarket qui bougent : ' + polys.length);

// 3. Telegram
const api = m => `https://api.telegram.org/bot${TOKEN}/${m}`;
const key = () => crypto.createHash('sha256').update(TOKEN).digest();
const enc = t => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv); const b = Buffer.concat([c.update(t, 'utf8'), c.final()]); return [iv, c.getAuthTag(), b].map(x => x.toString('base64')).join('.'); };
const dec = t => { try { const [iv, tag, b] = t.split('.').map(x => Buffer.from(x, 'base64')); const d = crypto.createDecipheriv('aes-256-gcm', key(), iv); d.setAuthTag(tag); return Buffer.concat([d.update(b), d.final()]).toString('utf8'); } catch (e) { return ''; } };
async function tg(method, body) {
  try { const r = await fetch(api(method), {method: 'POST', body}); const j = await r.json(); if (!j.ok) console.log('Telegram a refusé (' + method + ') : ' + (j.description || 'erreur')); return j; }
  catch (e) { console.log('Telegram injoignable.'); return {ok: false}; }
}
const sendText = text => tg('sendMessage', new URLSearchParams({chat_id: CHAT, text, parse_mode: 'HTML', disable_web_page_preview: 'true'}));
async function sendIdea(tr) {
  const th = ME.theme(tr.th);
  let cap = ME.caption(th, tr); if (cap.length > 1020) cap = cap.replace(/<b>Contexte\.<\/b>[^\n]*\n/, '');
  try {
    const {createCanvas} = await import('@napi-rs/canvas');
    const cv = createCanvas(900, 620); ME.ideaChart(cv, th, tr);
    const fd = new FormData(); fd.append('chat_id', CHAT); fd.append('caption', cap.slice(0, 1020)); fd.append('parse_mode', 'HTML');
    fd.append('photo', new Blob([cv.toBuffer('image/png')], {type: 'image/png'}), 'idee.png');
    const r = await tg('sendPhoto', fd); if (r.ok) return r;
  } catch (e) { console.log('Chart impossible, envoi du texte seul.'); }
  return sendText(cap);
}

if (!TOKEN) {
  console.log('Pas de jeton Telegram (secret TELEGRAM_TOKEN absent) : rien n’est envoyé.');
} else {
  let welcome = false;
  if (!CHAT && state.chat) CHAT = dec(state.chat);
  if (!CHAT) {
    // premier lancement : le chat est celui de la dernière personne qui a écrit au bot
    try {
      const j = await (await fetch(api('getUpdates'))).json();
      const u = j.ok && j.result.map(x => x.message || x.channel_post || x.my_chat_member).filter(Boolean).pop();
      if (u) { CHAT = String(u.chat.id); state.chat = enc(CHAT); welcome = true; }
      else console.log(j.ok ? 'Aucun message reçu par le bot : écris-lui « bonjour » dans Telegram, puis relance.' : 'Telegram a refusé la lecture des messages : ' + (j.description || 'erreur') + '. Ajoute le secret TELEGRAM_CHAT_ID.');
    } catch (e) { console.log('Telegram injoignable.'); }
  }
  if (CHAT) {
    if (welcome || !state.hello) {
      const r = await sendText(`✅ <b>Idées macro : alertes activées.</b>\nTu recevras ici chaque nouvelle idée avec son chart, 4 vérifications par jour, sans rien garder ouvert.\n\n${ME.esc(ME.btLine())}\nIdées en cours : ${cur.length}. <a href="https://keujaa-png.github.io/bybit-spaghetti/macro.html">Voir la page</a>`);
      if (r.ok) state.hello = today;
    }
    let n = 0;
    for (const tr of fresh) {
      if (state.sent[ME.keyOf(tr)]) continue;
      const r = await sendIdea(tr); if (r.ok) { state.sent[ME.keyOf(tr)] = today; n++; }
    }
    for (const o of polys) {
      const k = 'poly|' + o.p.id + '|' + Math.floor(today / 7); if (state.sent[k]) continue;
      const r = await sendText(ME.polyText(o)); if (r.ok) { state.sent[k] = today; n++; }
    }
    console.log('Messages envoyés : ' + n);
  }
}
for (const k of Object.keys(state.sent)) if (state.sent[k] < today - 120) delete state.sent[k];
fs.writeFileSync('macro_state.json', JSON.stringify(state));
