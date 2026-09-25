// Rafraîchit chaque jour les panneaux « Run + Conso » et « Trend Tracker » sur TradingView.
// À exécuter dans un onglet TradingView ouvert sur un layout du compte : le script passe lui-même
// sur les trois layouts (sans recharger la page) puis revient sur celui de départ :
//   « Scanner »            → crypto (perps Bybit)
//   « Scanner US »         → actions US > 1 Md$ de capitalisation
//   « Scanner Commo ETF »  → matières premières (CFD OANDA) + ETF > 1 Md$ d'encours
// Pour chaque marché :
// 1) deux univers de 38 symboles : momentum court (Run + Conso) et tendance (Trend Tracker)
// 2) deux watchlists cliquables, en sections, dans l'ordre des panneaux
// 3) entrées des indicateurs du layout ouvert mises à jour (+ sauvegarde du layout)
// 4) alertes des indicateurs de ce marché mises à jour (sinon elles gardent l'ancienne liste)
// Résultat dans window.__refreshResult (texte) et dans localStorage « runconso_last_refresh_<marché> ».
(async () => {
const PINE_RC = 'USER;2fdc570c952e45079baa756c5103d16f';     // Run + Conso : Sweep / Breakout
const PINE_TT = 'USER;5baf968696014daea086e599c3750c9c';     // Trend Tracker 55j
const N = 38;
const LAYOUTS = {crypto: 'Scanner', us: 'Scanner US', macro: 'Scanner Commo ETF'};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runMarket(MODE) {
  const CFG = {
    crypto: {wlRC: 'Run_Conso_Sweeps', wlTT: 'Trend_Tracker', alertSym: 'BTCUSDT'},
    us:     {wlRC: 'US_Run_Conso',     wlTT: 'US_Trend_Tracker', alertSym: 'SPY'},
    macro:  {wlRC: 'Macro_Run_Conso',  wlTT: 'Macro_Trend_Tracker', alertSym: 'GLD'}
  }[MODE];
  const log = ['marché : ' + MODE];
  const isSym = v => typeof v === 'string' && /^[A-Z0-9_]+:\S+$/.test(v);
  // les alertes TradingView refusent NASDAQ/NYSE/AMEX sans abonnement temps réel : on passe par le flux Cboe gratuit (BATS)
  const bats = s => 'BATS:' + s.split(':')[1];
  const scan = async (market, body) => {
    const r = await fetch(`https://scanner.tradingview.com/${market}/scan`, {method: 'POST', credentials: 'include', body: JSON.stringify(body)});
    const j = await r.json();
    return (j.data || []).map(x => ({s: x.s, d: x.d}));
  };
  let symsRC, symsTT, wlRC, wlTT, res;
  try {
    // ── 1. univers + watchlists ─────────────────────────────────────────
    if (MODE === 'crypto') {
      const MIN_VOL = 10e6, TOP = 30;
      const MAJORS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'HYPEUSDT', 'DOGEUSDT', 'ZECUSDT', 'BNBUSDT'];
      const NON = new Set('XAU XAUT XAG PAXG CL BZ WTI BRENT NG SOXL SOXS SPCX SNDK SNXX MSTR SKHY SKHYNIX AAPL KORU INTC MU CRCL META TSLA NVDA EWY MSFT HOOD DRAM CHIP AMZN GOOGL COIN QQQ SPY IBIT MSFU CONL USDC USDE CONLUSDT'.split(' '));
      const tk = await fetch('https://api.bybit.com/v5/market/tickers?category=linear').then(r => r.json());
      const seen = new Set();
      const cands = tk.result.list
        .filter(t => t.symbol.endsWith('USDT'))
        .map(t => ({s: t.symbol, b: t.symbol.replace(/USDT$/, '').replace(/^(1000000|100000|10000|1000)/, ''), v: +t.turnover24h}))
        .filter(t => t.v >= MIN_VOL && !NON.has(t.b))
        .sort((a, b) => b.v - a.v)
        .filter(t => !seen.has(t.b) && seen.add(t.b));
      for (let i = 0; i < cands.length; i += 8) {
        await Promise.all(cands.slice(i, i + 8).map(async t => {
          try {
            const k = (await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${t.s}&interval=D&limit=8`).then(r => r.json())).result.list;
            if (k.length >= 8) t.p7 = (+k[0][4] / +k[7][4] - 1) * 100;
          } catch (e) {}
        }));
      }
      const ranked = cands.filter(t => t.p7 !== undefined).sort((a, b) => b.p7 - a.p7);
      const uniRC = ranked.slice(0, TOP).map(t => t.s);
      for (const m of MAJORS) if (uniRC.length < N && !uniRC.includes(m)) uniRC.push(m);
      for (const t of ranked.slice(TOP)) if (uniRC.length < N && !uniRC.includes(t.s)) uniRC.push(t.s);
      const uniTT = cands.slice(0, N).map(t => t.s);     // les plus liquides : liste stable
      if (uniRC.length < N || uniTT.length < N) throw new Error('univers incomplet');
      symsRC = uniRC.map(s => `BYBIT:${s}.P`);
      symsTT = uniTT.map(s => `BYBIT:${s}.P`);
      log.push('top 7 j : ' + ranked.slice(0, 6).map(t => t.s.replace('USDT', '') + ' ' + t.p7.toFixed(0) + '%').join(', '));
      // état de tendance exact (mêmes règles que l'indicateur) pour trier la watchlist
      const trend = [], flat = [];
      for (let i = 0; i < uniTT.length; i += 8) {
        await Promise.all(uniTT.slice(i, i + 8).map(async s => {
          try {
            const k = (await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${s}&interval=D&limit=400`).then(r => r.json())).result.list.reverse();
            const b = k.map(x => ({h: +x[2], l: +x[3], c: +x[4]}));
            const live = b[b.length - 1].c, closed = b.slice(0, -1);
            let inPos = false, entry = 0;
            for (let j = 55; j < closed.length; j++) {
              let hi = -Infinity, lo = Infinity;
              for (let q = j - 55; q < j; q++) hi = Math.max(hi, closed[q].h);
              for (let q = j - 20; q < j; q++) lo = Math.min(lo, closed[q].l);
              if (inPos && closed[j].c < lo) inPos = false;
              if (!inPos && closed[j].c > hi) { inPos = true; entry = closed[j].c; }
            }
            if (inPos) trend.push({s, gain: (live / entry - 1) * 100}); else flat.push(s);
          } catch (e) { flat.push(s); }
        }));
      }
      trend.sort((a, b) => b.gain - a.gain);
      wlTT = [`###🚀 Tendance 55j · ${trend.length} coins (tri par gain)`, ...trend.map(t => `BYBIT:${t.s}.P`)];
      if (flat.length) wlTT.push('###Hors tendance', ...flat.map(s => `BYBIT:${s}.P`));
      wlRC = ['###Top 20 · perf 7 j', ...symsRC.slice(0, 20), '###Reste de l\'univers', ...symsRC.slice(20)];
      log.push('en tendance : ' + trend.slice(0, 5).map(t => t.s.replace('USDT', '') + ' +' + t.gain.toFixed(0) + '%').join(', '));
    } else if (MODE === 'us') {
      // actions US : capitalisation > 1 Md$, prix > 5 $, volume échangé > 20 M$/jour
      const rows = await scan('america', {
        filter: [
          {left: 'market_cap_basic', operation: 'greater', right: 1e9},
          {left: 'type', operation: 'equal', right: 'stock'},
          {left: 'exchange', operation: 'in_range', right: ['NASDAQ', 'NYSE', 'AMEX']},
          {left: 'close', operation: 'greater', right: 5},
          {left: 'average_volume_30d_calc', operation: 'greater', right: 200000}
        ],
        columns: ['close', 'average_volume_30d_calc', 'Perf.W', 'Perf.3M'],
        sort: {sortBy: 'market_cap_basic', sortOrder: 'desc'}, range: [0, 2500]
      });
      const liq = rows.filter(x => x.d[0] * x.d[1] >= 20e6 && x.d[2] != null && x.d[3] != null)
        .map(x => ({s: x.s, w: x.d[2], m3: x.d[3]}));
      const byW = [...liq].sort((a, b) => b.w - a.w), by3M = [...liq].sort((a, b) => b.m3 - a.m3);
      symsRC = byW.slice(0, N).map(x => bats(x.s));
      symsTT = by3M.slice(0, N).map(x => bats(x.s));
      if (symsRC.length < N || symsTT.length < N) throw new Error('univers US incomplet');
      wlRC = ['###Top 20 · perf semaine', ...symsRC.slice(0, 20), '###Suite', ...symsRC.slice(20)];
      wlTT = ['###🚀 Plus fortes tendances · perf 3 mois', ...symsTT];
      log.push(`${liq.length} actions éligibles · top semaine : ` + byW.slice(0, 5).map(x => x.s.split(':')[1] + ' +' + x.w.toFixed(0) + '%').join(', '));
    } else {
      // matières premières (futures continus) + ETF > 1 Md$ d'encours (hors levier, inverse, crypto, rendement)
      // CFD OANDA : données temps réel gratuites, donc alertes autorisées (les futures CME/ICE exigent un abonnement)
      const COMMO = ['OANDA:XAUUSD', 'OANDA:XAGUSD', 'OANDA:XPTUSD', 'OANDA:XPDUSD', 'OANDA:XCUUSD', 'OANDA:WTICOUSD',
                     'OANDA:BCOUSD', 'OANDA:NATGASUSD', 'OANDA:CORNUSD', 'OANDA:WHEATUSD', 'OANDA:SOYBNUSD', 'OANDA:SUGARUSD'];
      const fut = await scan('cfd', {symbols: {tickers: COMMO}, columns: ['Perf.W', 'Perf.3M']}).catch(() => []);
      const fperf = Object.fromEntries(fut.map(x => [x.s, {w: x.d[0] ?? -999, m3: x.d[1] ?? -999}]));
      const bad = /\b(2x|3x|leveraged|inverse|ultra|ultrapro|daily|bull|bear|short|option|income|yieldmax|covered|buffer|bitcoin|ether|ethereum|solana|xrp|crypto|staking)\b/i;
      const etfRows = await scan('america', {
        filter: [
          {left: 'type', operation: 'equal', right: 'fund'},
          {left: 'aum', operation: 'greater', right: 1e9},
          {left: 'average_volume_30d_calc', operation: 'greater', right: 300000}
        ],
        columns: ['Perf.W', 'Perf.3M', 'description'],
        sort: {sortBy: 'aum', sortOrder: 'desc'}, range: [0, 800]
      });
      const etf = etfRows.filter(x => !bad.test(x.d[2] || '') && x.d[0] != null && x.d[1] != null).map(x => ({s: x.s, w: x.d[0], m3: x.d[1]}));
      const k = N - COMMO.length;
      const etfW = [...etf].sort((a, b) => b.w - a.w).slice(0, k), etf3M = [...etf].sort((a, b) => b.m3 - a.m3).slice(0, k);
      symsRC = [...COMMO, ...etfW.map(x => bats(x.s))];
      symsTT = [...COMMO, ...etf3M.map(x => bats(x.s))];
      const commoW = [...COMMO].sort((a, b) => (fperf[b]?.w ?? -999) - (fperf[a]?.w ?? -999));
      const commo3M = [...COMMO].sort((a, b) => (fperf[b]?.m3 ?? -999) - (fperf[a]?.m3 ?? -999));
      wlRC = ['###Matières premières · perf semaine', ...commoW, '###ETF · perf semaine', ...etfW.map(x => bats(x.s))];
      wlTT = ['###🚀 Matières premières · perf 3 mois', ...commo3M, '###🚀 ETF · perf 3 mois', ...etf3M.map(x => bats(x.s))];
      log.push(`${etf.length} ETF éligibles · top 3 mois : ` + etf3M.slice(0, 4).map(x => x.s.split(':')[1] + ' +' + x.m3.toFixed(0) + '%').join(', '));
    }

    // watchlists (cliquer une ligne = ouvrir le symbole sur le graphique)
    const lists = await fetch('/api/v1/symbols_list/custom/', {credentials: 'include'}).then(r => r.json());
    const put = async (name, symbols) => {
      const uniq = symbols.filter((s, i) => s.startsWith('###') || symbols.indexOf(s) === i);   // pas de doublon
      const wl = lists.find(l => l.name === name);
      const r = wl
        ? await fetch(`/api/v1/symbols_list/custom/${wl.id}/replace/?unsafe=true`, {method: 'POST', credentials: 'include', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(uniq)})
        : await fetch('/api/v1/symbols_list/custom/', {method: 'POST', credentials: 'include', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name, symbols: uniq})});
      log.push(`watchlist ${name} : ` + (r.ok ? 'ok' : 'échec ' + r.status));
    };
    await put(CFG.wlRC, wlRC);
    await put(CFG.wlTT, wlTT);

    // ── 3. entrées des indicateurs du layout ouvert ─────────────────────
    const ch = TradingViewApi.activeChart();
    const studies = ch.getAllStudies().filter(x => /Run \+ Conso|Trend Tracker/.test(x.name));
    for (const st of studies) {
      const study = ch.getStudyById(st.id);
      const iv = study.getInputValues().filter(x => /^in_\d+$/.test(x.id) && isSym(x.value))
        .sort((a, b) => +a.id.slice(3) - +b.id.slice(3));
      const list = /Trend Tracker/.test(st.name) ? symsTT : symsRC;
      study.setInputValues(iv.map((x, i) => ({id: x.id, value: list[i]})));
      log.push(st.name.slice(0, 12) + ' : ' + iv.length + ' symboles');
    }
    if (!studies.length) log.push('indicateurs absents du graphique');
    await sleep(3000);
    await saveLayout();

    // ── 4. alertes de ce marché (repérées par le symbole sur lequel elles sont posées) ──
    const la = await fetch('https://pricealerts.tradingview.com/list_alerts', {credentials: 'include'}).then(r => r.json());
    const alerts = (la.r || la).filter(a => {
      const c = a.conditions ? a.conditions[0] : a.condition;
      const sym = String(a.symbol || '') + String(a.pro_symbol || '');
      return c && c.series && c.series[0] && [PINE_RC, PINE_TT].includes(c.series[0].pine_id)
        && new RegExp('[:"]' + CFG.alertSym + '[."]|[:"]' + CFG.alertSym + '$').test(sym);
    });
    for (const a of alerts) {
      const conds = JSON.parse(JSON.stringify(a.conditions || [a.condition]));
      const list = conds[0].series[0].pine_id === PINE_TT ? symsTT : symsRC;
      for (const c of conds) {
        const inp = c.series[0].inputs;
        const keys = Object.keys(inp).filter(k => /^in_\d+$/.test(k) && isSym(inp[k])).sort((x, y) => +x.slice(3) - +y.slice(3));
        keys.forEach((k, i) => { inp[k] = list[i]; });
      }
      const payload = {
        conditions: conds.map(c => ({type: c.type, series: c.series, resolution: c.resolution})),
        symbol: a.symbol, resolution: a.resolution, message: a.message, sound_file: a.sound_file,
        sound_duration: a.sound_duration, popup: a.popup, auto_deactivate: a.auto_deactivate, email: a.email,
        sms_over_email: a.sms_over_email, mobile_push: a.mobile_push, web_hook: a.web_hook, name: a.name,
        expiration: a.expiration, active: true, ignore_warnings: true, alert_id: a.alert_id,
        client_id: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
      };
      const r = await fetch('https://pricealerts.tradingview.com/modify_restart_alert', {method: 'POST', credentials: 'include', body: JSON.stringify({payload})});
      const j = await r.json().catch(() => ({}));
      log.push(`alerte ${a.alert_id} : ${j.s === 'ok' ? 'ok' : 'échec ' + JSON.stringify(j.err || j).slice(0, 80)}`);
    }
    if (!alerts.length) log.push('aucune alerte pour ce marché');
    res = 'OK · ' + log.join(' · ');
  } catch (e) {
    res = 'ERREUR · ' + e.message + ' · ' + log.join(' · ');
  }
  // trace du dernier passage (lisible depuis n'importe quel onglet TradingView)
  try { localStorage.setItem('runconso_last_refresh_' + MODE, new Date().toISOString() + ' · ' + res); } catch (e) {}
  return res;
}

// ─── Pilote : les trois layouts, l'un après l'autre, dans le même onglet ──
// (on change de layout sans recharger la page, puis on revient sur celui de départ)
const api = TradingViewApi;
async function saveLayout() {
  const b = [...document.querySelectorAll('button')].find(e => /Save all charts/.test(e.getAttribute('aria-label') || ''));
  if (b) b.click();
  for (let i = 0; i < 15; i++) { await sleep(1000); try { if (!api.hasChartChanges()) return; } catch (e) { return; } }
}
async function switchTo(rec) {
  await saveLayout();
  const p = api.loadChartFromServer(rec);
  if (p && p.then) await p;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    try { if (api.layoutName() === rec.name && api.activeChart().getAllStudies().some(s => /Trend Tracker|Run \+ Conso/.test(s.name))) break; } catch (e) {}
  }
  await sleep(4000);                                          // laisse les indicateurs se charger
}
const results = [];
try {
  const startName = api.layoutName();
  const recs = await new Promise(res => { try { api.getSavedCharts(x => res(x || [])); } catch (e) { res([]); } setTimeout(() => res([]), 12000); });
  const order = window.__refreshMarkets || ['crypto', 'us', 'macro'];
  for (const m of order) {
    try {
      if (api.layoutName() !== LAYOUTS[m]) {
        const rec = recs.find(r => r.name === LAYOUTS[m]);
        if (!rec) { results.push(`ERREUR ${m} · layout « ${LAYOUTS[m]} » introuvable`); continue; }
        await switchTo(rec);
      }
      results.push(await runMarket(m));
    } catch (e) { results.push(`ERREUR ${m} · ${e.message}`); }
  }
  if (api.layoutName() !== startName) {
    const rec = recs.find(r => r.name === startName);
    if (rec) await switchTo(rec);
  }
} catch (e) { results.push('ERREUR · ' + e.message); }
window.__refreshResult = results.join('\n');
try { localStorage.setItem('runconso_last_refresh', new Date().toISOString() + '\n' + window.__refreshResult); } catch (e) {}
})();
