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
async function sendIdea(tr, extra = '') {
  const th = ME.theme(tr.th);
  const cap = ME.caption(th, tr) + extra;
  try {
    const {createCanvas} = await import('@napi-rs/canvas');
    const cv = createCanvas(900, 620); ME.ideaChart(cv, th, tr);
    const fd = new FormData(); fd.append('chat_id', CHAT); fd.append('caption', cap.slice(0, 1020)); fd.append('parse_mode', 'HTML');
    fd.append('photo', new Blob([cv.toBuffer('image/png')], {type: 'image/png'}), 'idee.png');
    const r = await tg('sendPhoto', fd); if (r.ok) return r;
  } catch (e) { console.log('Chart impossible, envoi du texte seul.'); }
  return sendText(cap);
}

// Modèle Claude (secret ANTHROPIC_API_KEY) : il lit l'actualité, avec recherche web quand l'API l'accepte
const AKEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const MODEL = (process.env.MACRO_MODEL || '').trim() || 'claude-opus-5-5';
async function claude(system, user, search) {
  const call = async tools => {
    let messages = [{role: 'user', content: user}], out = '';
    for (let k = 0; k < 4; k++) {
      const body = {model: MODEL, max_tokens: 6000, system, messages}; if (tools) body.tools = tools;
      const r = await fetch('https://api.anthropic.com/v1/messages', {method: 'POST', headers: {'x-api-key': AKEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'}, body: JSON.stringify(body)});
      const j = await r.json();
      if (!r.ok) return {err: r.status + ' ' + ((j.error && j.error.message) || 'erreur')};
      out += (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
      if (j.stop_reason !== 'pause_turn') return {text: out};
      messages = [...messages, {role: 'assistant', content: j.content}];
    }
    return {text: out};
  };
  let res = await call(search ? [{type: 'web_search_20250305', name: 'web_search', max_uses: 6}] : null);
  if (res.err && search) { console.log('IA : appel avec recherche web refusé (' + res.err + '), nouvel essai sans.'); res = await call(null); }
  if (res.err) console.log('IA : refus de l’API (' + res.err + ').');
  return res.text || '';
}
const jsonOf = text => { const m = [...text.matchAll(/<json>([\s\S]*?)<\/json>/g)].pop(); const s = m ? m[1] : text.slice(text.search(/[\[{]/), Math.max(text.lastIndexOf(']'), text.lastIndexOf('}')) + 1); try { return JSON.parse(s); } catch (e) { return null; } };
// Avis du modèle sur une idée issue de la règle backtestée : il vérifie dans l'actualité si le thème tient
async function opinion(th, tr) {
  if (!AKEY) return '';
  try {
    const tx = ME.ideaText(th, tr);
    const system = `Tu es le desk global macro d'un hedge fund. On te soumet une idée de swing trade de quelques mois, produite par une règle mécanique backtestée (un indicateur macro casse ; le titre lié n'a pas encore réagi, ou vient tout juste de démarrer). Vérifie dans l'actualité récente ce qui se passe vraiment sur ce thème et sur ce titre : cause de la cassure, raison possible du retard du titre (bonne ou mauvaise), événement à venir qui peut tout changer. Sois critique et factuel. Termine par <json>{"avis": "une ou deux phrases courtes en français, 220 caractères max, avec le fait le plus important et le risque principal", "conviction": 1 à 5}</json>.`;
    const user = `Idée : ${tr.s > 0 ? 'ACHAT' : 'VENTE'} ${tr.leg.n} (${tr.sym}, ${tr.leg.w}).\nThème : ${tx.title}. ${tx.ctx}\nDéclencheur : ${tx.trig}\nÉtat du titre : ${tx.why}\nDate : ${new Date().toISOString().slice(0, 10)}.`;
    const j = jsonOf(await claude(system, user, true));
    if (!j || !j.avis) return '';
    console.log(`  avis IA ${j.conviction}/5 sur ${tr.leg.n} : ${j.avis}`);
    return {conv: +j.conviction || 0, line: `\n🧠 <b>Opus ${ME.esc(j.conviction)}/5</b> : ${ME.esc(String(j.avis).slice(0, 260))}`};
  } catch (e) { return ''; }
}

// Titres de presse de la semaine sur le thème (Google Actualités), joints à chaque idée
const unent = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
async function headlines(q) {
  try {
    const r = await fetch('https://news.google.com/rss/search?q=' + encodeURIComponent(q + ' when:7d') + '&hl=en-US&gl=US&ceid=US:en', {headers: {'User-Agent': 'Mozilla/5.0'}});
    const x = await r.text();
    return [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 2).map(m => {
      const g = t => unent(((m[1].match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)</' + t + '>')) || [])[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim());
      const src = g('source'); let title = g('title'); if (src && title.endsWith(' - ' + src)) title = title.slice(0, -src.length - 3);
      return {title, link: g('link'), src};
    }).filter(i => i.title && /^https:\/\//.test(i.link));
  } catch (e) { return []; }
}
const newsText = (th, H) => '📰 ' + H.map(h => `<a href="${ME.esc(h.link)}">${ME.esc(h.title)}</a>`).join('\n📰 ');
if (cur[0]) { const th = ME.theme(cur[0].th), H = th.news ? await headlines(th.news) : []; console.log('Titres de presse (' + th.name + ') : ' + H.length + (H[0] ? ' · ex. « ' + H[0].title + ' »' : '')); }

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
      const r = await sendText(`✅ <b>Idées macro activées.</b> <a href="https://keujaa-png.github.io/bybit-spaghetti/macro.html">Voir la page</a>`);
      if (r.ok) state.hello = today;
    }
    let n = 0;
    for (const tr of fresh) {
      if (state.sent[ME.keyOf(tr)]) continue;
      const op = await opinion(ME.theme(tr.th), tr);
      // veto : si le desk IA juge l'idée mauvaise (1 ou 2 sur 5), elle n'est pas envoyée
      if (op && op.conv && op.conv <= 2) { console.log('  idée écartée par le desk IA (' + op.conv + '/5) : ' + tr.leg.n); state.sent[ME.keyOf(tr)] = today; continue; }
      const r = await sendIdea(tr, op ? op.line : '');
      if (r.ok) {
        state.sent[ME.keyOf(tr)] = today; n++;
        const th = ME.theme(tr.th), H = th.news ? await headlines(th.news) : [];
        if (H.length) await sendText(newsText(th, H));
      }
    }
    for (const o of polys) {
      const k = 'poly|' + o.p.id + '|' + Math.floor(today / 7); if (state.sent[k]) continue;
      const r = await sendText(ME.polyText(o)); if (r.ok) { state.sent[k] = today; n++; }
    }
    console.log('Messages envoyés : ' + n);
  }
}
// 4. Idées tirées des grandes news macro, par un modèle Claude (une fois par jour, si le secret ANTHROPIC_API_KEY existe)
const FX = {USD: 1, EUR: 1.12, GBP: 1.33, GBX: 0.0133, CHF: 1.22, NOK: 0.095, SEK: 0.1, DKK: 0.15, JPY: 0.0065, HKD: 0.128, AUD: 0.65, CAD: 0.72, SGD: 0.77, KRW: 0.0007, TWD: 0.031, INR: 0.0115, BRL: 0.19, MXN: 0.055, ZAR: 0.055, CNY: 0.14, PLN: 0.27};
async function checkSym(tv) {
  try {
    const r = await fetch('https://scanner.tradingview.com/global/scan', {method: 'POST', body: JSON.stringify({symbols: {tickers: [tv]}, columns: ['close', 'average_volume_30d_calc', 'currency', 'description']})});
    const d = (await r.json()).data[0]; if (!d) return null;
    const [c, v, cur, name] = d.d, usd = c * v * (FX[cur] || 0) / 1e6;
    return {tv: d.s, name, usd, liquid: FX[cur] ? usd >= 20 : true};
  } catch (e) { return null; }
}
async function aiIdeas() {
  // titres de presse : à la une (économie, monde) + une recherche par thème
  const feeds = ['https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en', 'https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US:en', 'https://www.nhc.noaa.gov/index-at.xml'];
  const qs = ['central bank rate decision', 'bond market selloff', 'election markets reaction', 'tariffs trade war', 'China economy stimulus property', 'profit warning sector demand', 'commodity supply shock', 'currency crisis emerging markets', 'sovereign debt downgrade',
    // météo et climat
    'El Niño La Niña forecast NOAA', 'drought crop yields', 'heat wave power prices', 'cold snap natural gas demand', 'hurricane Gulf of Mexico energy', 'frost Brazil coffee sugar', 'monsoon India crops', 'Rhine water levels shipping', 'flood mine port closure', 'wildfire lumber', 'harvest forecast USDA',
    // offre, transport, politique des matières premières
    'OPEC production decision', 'mine strike supply', 'export ban commodity', 'Red Sea Suez Panama canal shipping', 'refinery outage', 'sanctions oil metals', 'port strike',
    // actions : faits propres à une société ou à un secteur
    'raises full-year guidance', 'profit warning shares', 'record order backlog', 'regulator approval shares jump', 'antitrust ruling', 'pricing power demand surge sector', 'capex cut industry',
    // monde
    'Bank of Japan yen', 'ECB decision', 'Federal Reserve outlook', 'India economy rupee', 'Brazil fiscal real', 'Mexico peso trade', 'Australia RBA iron ore', 'Korea Taiwan semiconductor exports', 'export controls chips', 'Middle East conflict oil',
    ...ME.PB.themes.map(t => t.news).filter(Boolean)];
  const H = [], seen = new Set();
  const push = (x, max) => { let n = 0; for (const m of x.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const g = t => unent(((m[1].match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)</' + t + '>')) || [])[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim());
    const src = g('source'); let title = g('title'); if (src && title.endsWith(' - ' + src)) title = title.slice(0, -src.length - 3);
    const link = g('link'), age = (Date.now() - Date.parse(g('pubDate'))) / 864e5, k = title.toLowerCase().slice(0, 60);
    if (!title || !/^https:\/\//.test(link) || !(age < 4) || seen.has(k)) continue;
    seen.add(k); H.push({title, link, src, age}); if (++n >= max) break; } };
  for (const u of feeds) { try { push(await (await fetch(u, {headers: {'User-Agent': 'Mozilla/5.0'}})).text(), 25); } catch (e) {} }
  for (const q of qs) { try { push(await (await fetch('https://news.google.com/rss/search?q=' + encodeURIComponent(q + ' when:3d') + '&hl=en-US&gl=US&ceid=US:en', {headers: {'User-Agent': 'Mozilla/5.0'}})).text(), 3); } catch (e) {} }
  if (H.length < 10) { console.log('IA : trop peu de titres de presse (' + H.length + '), passage annulé.'); return 0; }
  // tableau de marché
  const themes = ME.PB.themes.map(th => { const D = ME.drvSeries(th), R = ME.ruleOf(th), n = D.v.length; if (n <= R.CH) return null; const last = (ME.SIGS[th.id] || []).slice(-1)[0];
    return `${th.name} | ${th.drv.label} : ${ME.drvFmt(th)(D.v[n - 1])} (${ME.drvChg(th, ME.chg(th, D.v[n - 1], D.v[n - 1 - R.CH]))} en ${ME.per(th).ch})${last && n - 1 - last.i < 30 ? ' | cassure ' + (last.sg > 0 ? 'haussière' : 'baissière') + ' le ' + ME.dstr(last.day) : ''}`; }).filter(Boolean);
  const uni = new Map();
  for (const th of ME.PB.themes) for (const l of [...th.short, ...th.long]) { if (l.liq === false || uni.has(l.tv)) continue; const st = ME.legState(l.tv, 1, today); if (st) uni.set(l.tv, `${l.tv} | ${l.n} | ${l.w} | 20 séances ${ME.pct(st.r20, 0)} | ${st.conf ? 'au-dessus' : 'en dessous'} de sa moyenne 50 séances`); }
  const recent = Object.entries(state.ai || {}).filter(([, d]) => d > today - 30).map(([k]) => k);
  const system = `Tu es le desk global macro d'un hedge fund. Tu écris pour un trader qui prend peu de positions, en swing sur plusieurs mois, et qui ne veut que tes meilleures idées. À partir des titres de presse des derniers jours et du tableau de marché fournis, tu classes tes 2 meilleures idées du moment.
Champ : le monde entier. Banques centrales, dette et budget, élections, guerre commerciale, géopolitique, matières premières (énergie, métaux, agricole) avec leurs facteurs d'offre : météo et climat (El Niño ou La Niña, sécheresse, gel, canicule, ouragan, mousson, niveau des fleuves), grèves, quotas, embargos, routes maritimes. Demande d'un secteur quand elle bascule.
Ce qu'exige une idée de desk :
- Un fait daté et vérifiable, trouvé dans les titres fournis ou confirmé par ta recherche web. Pas de rumeur, pas d'analyse technique.
- Une chaîne de causalité claire jusqu'au titre, et la preuve que le marché ne l'a pas encore payée : sers-toi des performances du tableau et vérifie le cours récent.
- Une asymétrie : dis ce qui se passe si tu as tort. Si le scénario adverse est aussi probable, pas d'idée.
- Un effet qui dure des mois, pas des jours.
- Deux profils sont acceptés : le titre qui n'a pas encore réagi, ou le tout début d'une tendance longue (le titre vient de démarrer et le mouvement a de quoi durer des mois). Jamais un titre déjà étiré.
- Ça peut être une idée sur une seule action : résultats ou prévisions qui changent la trajectoire, carnet de commandes, décision d'un régulateur, changement de prix ou de demande dans son secteur. Même exigence : un fait daté, pas encore dans le prix.
- Un instrument très liquide et négociable chez Interactive Brokers, partout dans le monde : action, ETF pays ou secteur, ETF de matière première (par exemple WEAT, CORN, SOYB, UNG, USO, GLD, SLV, CPER, DBA) quand c'est l'expression la plus propre. Prends de préférence un titre du tableau ; sinon donne son symbole TradingView exact (PLACE:TICKER).
- Ne répète aucune de ces idées déjà envoyées : ${recent.join(', ') || 'aucune'}.
Raisonne comme un desk de hedge fund, dans cet ordre, sans copier personne :
1. Régime : où en sont la liquidité, les banques centrales, le crédit et le dollar, et dans quel sens ça bouge.
2. Ce qui est dans les prix : le consensus, le positionnement probable, ce que le titre a déjà fait.
3. Ton écart avec le consensus : le point précis où tu penses que le marché se trompe, et pourquoi tu le verrais avant lui (un fait récent qu'il sous-estime, un effet de second tour, un délai de transmission).
4. Le catalyseur et son calendrier : ce qui forcera le marché à réviser, et quand, à 6-18 mois.
5. L'expression la plus propre : l'instrument qui porte la thèse avec le moins de risques parasites.
6. L'asymétrie : gain si tu as raison, perte si tu as tort, et le fait précis qui te fait couper.
Donne toujours tes 2 meilleures idées du moment, même imparfaites, avec une note honnête : c'est la note qui décide de l'envoi, pas toi.
Note ta conviction de 1 à 5 sans complaisance : 4 veut dire que tu engagerais le capital du fonds sur cette thèse aujourd'hui, 5 est rare, 3 veut dire intéressante mais il manque une étape. Seules les idées à 4 ou 5 sont envoyées.
Tu peux chercher sur le web pour vérifier un fait, sa date, et ce que le marché a déjà intégré. Raisonne brièvement, puis termine par <json>[ ... ]</json> : un tableau JSON avec tes 2 idées. Chaque idée : {"titre": "8 mots max", "sens": "achat" ou "vente", "tv": "PLACE:TICKER", "nom": "nom du titre", "fait": "le fait d'actualité daté, une phrase courte en français", "pourquoi": "le mécanisme vers ce titre et pourquoi ce n'est pas dans le prix, une phrase courte en français", "risque": "ce qui te donnerait tort, 12 mots max", "mois": nombre de mois, "invalidation": "le signal concret pour couper, 10 mots max", "confiance": 1 à 5, "refs": [numéros des titres de presse utilisés]}.`;
  const user = `TITRES DE PRESSE (moins de 4 jours)\n${H.map((h, i) => `[${i + 1}] ${h.title} — ${h.src}`).join('\n')}\n\nINDICATEURS MACRO\n${themes.join('\n')}\n\nTITRES DU TABLEAU\n${[...uni.values()].join('\n')}`;
  let ideas = jsonOf(await claude(system, user, true));
  if (!Array.isArray(ideas)) { console.log('IA : pas de liste d’idées lisible.'); return 0; }
  console.log(`IA (${MODEL}) : ${H.length} titres lus, ${ideas.length} idée(s) proposée(s).`);
  state.ai = state.ai || {}; let n = 0;
  for (const it of ideas.slice(0, 2)) {
    const buy = /achat/i.test(it.sens || ''), key = String(it.tv || '').toUpperCase() + (buy ? '|achat' : '|vente');
    if (!it.tv || !(it.confiance >= 4) || recent.includes(key)) { console.log('  écartée : ' + (it.nom || it.tv) + ' (confiance ' + it.confiance + ')'); continue; }
    const ok = await checkSym(String(it.tv).toUpperCase());
    if (!ok || !ok.liquid) { console.log('  écartée : ' + it.tv + (ok ? ' trop peu liquide' : ' introuvable')); continue; }
    console.log(`  ${buy ? 'ACHAT' : 'VENTE'} ${it.nom} (${ok.tv}) · ${it.titre}`);
    if (!TOKEN || !CHAT) continue;
    const e = ME.esc, cap = `🧠 <b>${e(it.titre)}</b>\n${buy ? '🟢 <b>ACHAT' : '🔴 <b>VENTE'} ${e(it.nom)}</b> · ${e(ME.short(ok.tv))}\n\n${e(it.fait)}\n${e(it.pourquoi)}\nRisque : ${e(it.risque || 'non précisé')}.\nHorizon : environ ${e(it.mois)} mois. Je coupe si : ${e(it.invalidation)}.\n<a href="${ME.tvUrl(ok.tv)}">Chart TradingView</a> · conviction ${e(it.confiance)}/5 · idée du desk IA, non backtestée`;
    let res = {ok: false};
    const L = ME.FULL[ok.tv];
    if (L && L.c.length > 130) { try {
      const {createCanvas} = await import('@napi-rs/canvas'); const cv = createCanvas(900, 340), ctx = cv.getContext('2d'); ctx.fillStyle = '#0e1117'; ctx.fillRect(0, 0, 900, 340);
      const l0 = L.t.length - 250 > 0 ? L.t.length - 250 : 0, ma = L.c.map((_, i) => ME.sma(L.c, 50, i));
      ME.panel(ctx, 0, 6, 900, 328, L.t.slice(l0), [{v: ma.slice(l0), color: '#5b6b80', w: 2, dash: [6, 5]}, {v: L.c.slice(l0), color: '#d7dde5', w: 2.5}], {title: it.nom + '  (' + ok.tv + ')'});
      const fd = new FormData(); fd.append('chat_id', CHAT); fd.append('caption', cap.slice(0, 1020)); fd.append('parse_mode', 'HTML'); fd.append('photo', new Blob([cv.toBuffer('image/png')], {type: 'image/png'}), 'idee.png');
      res = await tg('sendPhoto', fd);
    } catch (err) {} }
    if (!res.ok) res = await sendText(cap);
    if (res.ok) { state.ai[key] = today; n++; const refs = (it.refs || []).map(i => H[i - 1]).filter(Boolean).slice(0, 2); if (refs.length) await sendText('📰 ' + refs.map(h => `<a href="${e(h.link)}">${e(h.title)}</a>`).join('\n📰 ')); }
  }
  return n;
}
// deux lectures des news par jour au plus (une à chaque passage du matin et du soir)
if (AKEY && Date.now() - (state.aiLast || 0) > 10 * 3600e3) {
  try { const n = await aiIdeas(); state.aiLast = Date.now(); state.aiDay = today; console.log('Idées IA envoyées : ' + n); } catch (e) { console.log('IA : erreur, passage ignoré (' + e.message + ').'); }
} else if (!AKEY) console.log('Pas de clé ANTHROPIC_API_KEY : pas d’idées tirées des news.');

// 5. Thèses sous surveillance (macro_watch.json + thèses ajoutées par le desk IA).
// Chaque thèse attend un déclencheur sur le chart. Quand il se produit, Opus vérifie l'actualité et le chart :
// l'idée part sur Telegram seulement s'il la note 4/5 ou plus. Rien n'est envoyé tant qu'il ne se passe rien.
const WATCH_REVIEWS = +(process.env.WATCH_REVIEWS || 2);   // avis d'Opus au plus par passage (coût)
const WATCH_MIN = +(process.env.WATCH_MIN || 4);
const iso = () => new Date().toISOString().slice(0, 10);
const dayOf = s => Math.floor(Date.parse(s) / 864e5);
async function quotes(syms) {
  const cols = ['close', 'SMA50', 'SMA200', 'RSI', 'Perf.1M', 'Perf.YTD', 'price_52_week_high', 'price_52_week_low', 'High.1M', 'Low.1M', 'description', 'currency'];
  try {
    const r = await fetch('https://scanner.tradingview.com/global/scan', {method: 'POST', body: JSON.stringify({symbols: {tickers: syms}, columns: cols})});
    const out = {};
    for (const d of (await r.json()).data || []) { const o = {}; cols.forEach((c, i) => o[c] = d.d[i]); out[d.s] = o; }
    return out;
  } catch (e) { return {}; }
}
const yahooOf = tv => {
  const [x, t] = tv.split(':');
  if (x === 'FX') return t + '=X';
  const suf = {EURONEXT: '.PA', XETR: '.DE', MIL: '.MI', LSE: '.L', SIX: '.SW', TSE: '.T', HKEX: '.HK', ASX: '.AX', TSX: '.TO', BME: '.MC', OMXSTO: '.ST', OSL: '.OL'}[x];
  if (['NYSE', 'NASDAQ', 'AMEX', 'NYSEARCA', 'CBOE'].includes(x)) return t.replace('.', '-');
  return suf ? t.replace(/\.$/, '') + suf : null;
};
async function history(tv) {
  const y = yahooOf(tv); if (!y) return null;
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?range=1y&interval=1d`, {headers: {'User-Agent': 'Mozilla/5.0'}});
    const res = (await r.json()).chart.result[0], c = res.indicators.quote[0].close, t = [], v = [];
    res.timestamp.forEach((s, i) => { if (c[i] != null) { t.push(Math.floor(s / 86400)); v.push(c[i]); } });
    return v.length > 60 ? {t, c: v} : null;
  } catch (e) { return null; }
}
function hit(w, q, q2) {
  if (!q || q.close == null) return null;
  const v = q2 ? q.close / q2.close : q.close;
  if (w.si === 'sous') return v < w.niveau ? v : null;
  if (w.si === 'au-dessus') return v > w.niveau ? v : null;
  if (w.si === 'plus_bas_1m') return q['Low.1M'] != null && v <= q['Low.1M'] * 1.003 ? v : null;
  if (w.si === 'plus_haut_1m') return q['High.1M'] != null && v >= q['High.1M'] * 0.997 ? v : null;
  return null;
}
const trigText = w => w.si === 'sous' ? 'passe sous ' + w.niveau : w.si === 'au-dessus' ? 'passe au-dessus de ' + w.niveau : w.si === 'plus_bas_1m' ? 'touche son plus bas d’un mois' : 'touche son plus haut d’un mois';
const qLine = (tv, q) => q ? `${tv} : ${(+q.close).toPrecision(5)} ${q.currency || ''} | moyenne 50 j ${q.SMA50 ? (+q.SMA50).toPrecision(5) : '?'} | moyenne 200 j ${q.SMA200 ? (+q.SMA200).toPrecision(5) : '?'} | RSI ${q.RSI ? Math.round(q.RSI) : '?'} | 1 mois ${q['Perf.1M'] != null ? q['Perf.1M'].toFixed(1) + ' %' : '?'} | depuis janvier ${q['Perf.YTD'] != null ? q['Perf.YTD'].toFixed(1) + ' %' : '?'} | 52 semaines ${q.price_52_week_low} – ${q.price_52_week_high}` : tv + ' : pas de cours';

async function reviewThesis(w, q, q2, v) {
  const system = `Tu es le desk global macro d'un hedge fund. Le trader suit une thèse macro et attendait un signal du chart pour entrer. Le signal vient de se produire. Tu décides s'il faut y aller maintenant, pour un swing de plusieurs mois.
Vérifie sur le web l'actualité des derniers jours sur ce thème et sur ce titre. Puis juge :
1. La thèse tient-elle encore ? Un fait récent la renforce-t-il ou la casse-t-il (banque centrale, budget, élection, résultats, guerre, pétrole) ?
2. Le chart : le signal est-il propre (cassure nette, tendance qui démarre) ou le mouvement est-il déjà étiré (RSI extrême, loin de la moyenne 50 jours) ? On n'achète pas un sommet, on ne vend pas un plancher.
3. Le rapport gain/risque avec une invalidation concrète et proche.
4. Le prochain catalyseur et sa date.
Sois sévère : 4 veut dire que tu engagerais le capital du fonds aujourd'hui, 5 est rare, 3 veut dire attendre.
Termine par <json>{"note": 1 à 5, "analyse": "3 phrases courtes en français : ce qui vient de se passer (fait daté), pourquoi le chart confirme ou non, le risque principal", "invalidation": "niveau précis pour couper, 10 mots max", "objectif": "objectif de prix ou de ratio, 8 mots max", "catalyseur": "prochain événement et sa date, 10 mots max"}</json>.`;
  const user = `Thèse : ${w.titre}
Sens : ${w.sens === 'achat' ? 'ACHAT' : 'VENTE'} ${w.nom} (${w.tv}${w.tv2 ? ', contre ' + (w.sens === 'achat' ? 'vente' : 'achat') + ' de ' + w.tv2 : ''})
Raisonnement de départ (${w.cree}) : ${w.these}
Signal : ${w.tv2 ? 'le ratio ' + w.tv + ' / ' + w.tv2 + ' (' + v.toFixed(4) + ')' : 'le cours'} ${trigText(w)}.
Invalidation prévue : ${w.invalidation}
Cours actuels :
${qLine(w.tv, q)}${w.tv2 ? '\n' + qLine(w.tv2, q2) : ''}
Date : ${iso()}.`;
  const j = jsonOf(await claude(system, user, true));
  return j && j.note ? j : null;
}

async function sendThesis(w, q, v, op) {
  const e = ME.esc, buy = w.sens === 'achat';
  const px = w.tv2 ? 'ratio ' + v.toFixed(4) : (+q.close).toPrecision(5) + ' ' + (q.currency || '');
  const cap = `🎯 <b>${e(w.titre)}</b>\n${buy ? '🟢 <b>ACHAT' : '🔴 <b>VENTE'} ${e(w.nom)}</b> · ${e(ME.short(w.tv))}${w.tv2 ? ' / ' + e(ME.short(w.tv2)) : ''} · ${e(px)}\n\n` +
    `${e(w.these)}\n\n🧠 <b>Opus ${e(op.note)}/5</b> : ${e(op.analyse)}\n\n` +
    `Je coupe si : ${e(op.invalidation || w.invalidation)}\nObjectif : ${e(op.objectif || '?')} · horizon ${e(w.mois || 4)} mois\nCatalyseur : ${e(op.catalyseur || '?')}\n` +
    `<a href="${ME.tvUrl(w.tv)}">Chart TradingView</a> · pas un conseil`;
  const H = w.tv2 ? null : await history(w.tv);
  if (H && TOKEN && CHAT) {
    try {
      const {createCanvas} = await import('@napi-rs/canvas'); const cv = createCanvas(900, 340), ctx = cv.getContext('2d'); ctx.fillStyle = '#0e1117'; ctx.fillRect(0, 0, 900, 340);
      const ma = H.c.map((_, i) => ME.sma(H.c, 50, i)), lines = [{v: ma, color: '#5b6b80', w: 2, dash: [6, 5]}, {v: H.c, color: '#d7dde5', w: 2.5}];
      if (w.niveau && !w.tv2) lines.unshift({v: H.c.map(() => w.niveau), color: buy ? '#3fb950' : '#f85149', w: 1.5, dash: [3, 4]});
      const n = H.c.length - 1;
      ME.panel(ctx, 0, 6, 900, 328, H.t, lines, {title: w.nom + '  (' + w.tv + ')', marks: [{i: n, v: H.c[n], color: buy ? '#3fb950' : '#f85149', label: buy ? 'signal achat' : 'signal vente'}]});
      const fd = new FormData(); fd.append('chat_id', CHAT); fd.append('caption', cap.slice(0, 1020)); fd.append('parse_mode', 'HTML'); fd.append('photo', new Blob([cv.toBuffer('image/png')], {type: 'image/png'}), 'these.png');
      const r = await tg('sendPhoto', fd); if (r.ok) return r;
    } catch (err) { console.log('  chart impossible : ' + err.message); }
  }
  if (!TOKEN || !CHAT) { console.log('  [à vide] ' + cap.replace(/<[^>]+>/g, '').replace(/\n+/g, ' ¦ ')); return {ok: true}; }
  return sendText(cap);
}

async function watchTheses() {
  const seed = (readJ('macro_watch.json', {theses: []}).theses || []);
  state.watch = state.watch || {};
  const S = state.watch;   // id -> {sent, reviewed, note} ; les thèses du desk IA sont dans S[id].w
  const all = [...seed, ...Object.values(S).filter(x => x.w).map(x => x.w)]
    .filter(w => !(S[w.id] && S[w.id].sent) && !(w.expire && today > dayOf(w.expire)));
  if (!all.length) return 0;
  const Q = await quotes([...new Set(all.flatMap(w => [w.tv, w.tv2].filter(Boolean)))]);
  let reviews = 0, n = 0;
  for (const w of all) {
    const q = Q[w.tv], q2 = w.tv2 ? Q[w.tv2] : null, v = hit(w, q, q2);
    const st = S[w.id] = S[w.id] || {};
    console.log(`  thèse ${w.id} : ${q ? (w.tv2 && q2 ? 'ratio ' + (q.close / q2.close).toFixed(4) : q.close) : 'pas de cours'} · ${v != null ? 'SIGNAL (' + trigText(w) + ')' : 'en attente (' + trigText(w) + ')'}`);
    if (v == null) continue;
    if (st.reviewed && today - st.reviewed < 5) continue;   // jugée il y a moins de 5 jours : on attend
    if (!AKEY || reviews >= WATCH_REVIEWS) continue;
    reviews++;
    let op = null; try { op = await reviewThesis(w, q, q2, v); } catch (e) {}
    st.reviewed = today; st.note = op ? +op.note : null;
    if (!op) { console.log('  avis Opus illisible'); continue; }
    console.log(`  Opus ${op.note}/5 sur ${w.id} : ${op.analyse}`);
    if (+op.note < WATCH_MIN) continue;
    const r = await sendThesis(w, q, v, op);
    if (r.ok) { st.sent = today; n++; }
  }
  return n;
}

// Une fois par semaine, le desk IA ajoute jusqu'à 3 thèses « prochain domino », avec leur déclencheur sur le chart
async function newTheses() {
  state.watch = state.watch || {};
  const seed = (readJ('macro_watch.json', {theses: []}).theses || []);
  const live = [...seed, ...Object.values(state.watch).filter(x => x.w).map(x => x.w)].filter(w => !(w.expire && today > dayOf(w.expire)));
  const system = `Tu es le desk global macro d'un hedge fund. Tu prépares des thèses de swing de plusieurs mois que le trader surveillera, chacune avec un déclencheur précis sur le chart pour entrer.
Pense en effets de second ordre : quand un choc est déjà dans les prix d'un actif (par exemple l'immobilier français après la hausse de l'OAT), quel est le prochain domino qui n'a pas encore bougé (les banques qui portent cette dette, la devise, les pays voisins, les fournisseurs, les clients) ?
Exigences : un fait macro daté et vérifiable (cherche sur le web) ; une chaîne de causalité claire ; un actif très liquide et négociable chez Interactive Brokers (action, ETF, devise FX:EURUSD, future) avec son symbole TradingView exact (PLACE:TICKER) ; un déclencheur qui prouve que le marché commence à l'intégrer : "sous" ou "au-dessus" d'un niveau précis proche du cours actuel (moins de 8 % d'écart), "plus_bas_1m" ou "plus_haut_1m". Pour revendre un rebond d'un titre survendu, "au-dessus" de sa moyenne 50 jours.
Ne propose rien qui ressemble aux thèses déjà suivies : ${live.map(w => w.tv + ' ' + w.sens).join(', ') || 'aucune'}.
Propose au plus 3 thèses, seulement celles que tu notes 4 ou 5 (4 veut dire que tu engagerais le capital du fonds dès le déclencheur). Zéro est une réponse acceptable.
Termine par <json>[{"id": "mot-cle-court", "titre": "8 mots max", "sens": "achat" ou "vente", "tv": "PLACE:TICKER", "nom": "nom du titre", "these": "fait daté et mécanisme, 2 phrases courtes en français", "si": "sous" | "au-dessus" | "plus_bas_1m" | "plus_haut_1m", "niveau": nombre ou null, "invalidation": "10 mots max", "mois": nombre, "note": 4 ou 5}]</json>.`;
  const uni = new Map();
  for (const th of ME.PB.themes) for (const l of [...th.short, ...th.long]) { if (l.liq === false || uni.has(l.tv)) continue; const st = ME.legState(l.tv, 1, today); if (st) uni.set(l.tv, `${l.tv} | ${l.n} | 20 séances ${ME.pct(st.r20, 0)} | ${st.conf ? 'au-dessus' : 'en dessous'} de sa moyenne 50 séances`); }
  const user = `Date : ${iso()}.\nTITRES DU TABLEAU (performances récentes)\n${[...uni.values()].join('\n')}`;
  const L = jsonOf(await claude(system, user, true));
  if (!Array.isArray(L)) { console.log('Desk IA : pas de nouvelle thèse lisible.'); return 0; }
  let n = 0;
  for (const w of L.slice(0, 3)) {
    if (!w || !w.tv || !(w.note >= 4) || !/^(sous|au-dessus|plus_bas_1m|plus_haut_1m)$/.test(w.si || '')) continue;
    w.tv = String(w.tv).toUpperCase(); w.sens = /achat/i.test(w.sens) ? 'achat' : 'vente';
    const Q = (await quotes([w.tv]))[w.tv];
    if (!Q || Q.close == null) { console.log('  thèse écartée, symbole introuvable : ' + w.tv); continue; }
    if (/^(sous|au-dessus)$/.test(w.si) && !(Math.abs(w.niveau / Q.close - 1) < 0.15)) { console.log('  thèse écartée, niveau trop loin du cours : ' + w.tv); continue; }
    const ok = await checkSym(w.tv); if (ok && !ok.liquid) { console.log('  thèse écartée, trop peu liquide : ' + w.tv); continue; }
    w.id = 'ia-' + String(w.id || w.tv).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30) + '-' + today;
    w.cree = iso(); w.expire = new Date((today + 30 * (w.mois || 4)) * 864e5).toISOString().slice(0, 10);
    state.watch[w.id] = {w};
    console.log(`  nouvelle thèse : ${w.sens.toUpperCase()} ${w.nom} (${w.tv}), signal si ${trigText(w)}`);
    n++;
  }
  return n;
}

try {
  if (AKEY && today - (state.watchGen || 0) >= 7) { const k = await newTheses(); state.watchGen = today; console.log('Thèses ajoutées par le desk IA : ' + k); }
  console.log('Thèses sous surveillance :');
  console.log('Idées de thèses envoyées : ' + await watchTheses());
} catch (e) { console.log('Thèses : erreur, passage ignoré (' + e.message + ').'); }
for (const [k, x] of Object.entries(state.watch || {})) if (x.w && x.w.expire && today > dayOf(x.w.expire) + 30) delete state.watch[k];

for (const k of Object.keys(state.sent)) if (state.sent[k] < today - 120) delete state.sent[k];
fs.writeFileSync('macro_state.json', JSON.stringify(state));
