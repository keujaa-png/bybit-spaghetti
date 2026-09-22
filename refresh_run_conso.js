// Rafraîchit chaque jour l'univers du panneau « Run + Conso » sur TradingView.
// À exécuter dans un onglet TradingView ouvert sur le layout « Scanner » (connecté au compte).
// 1) univers = 30 meilleurs perps Bybit sur 7 jours (volume 24 h ≥ 10 M$) + majors, 38 symboles
// 2) watchlist « Run_Conso_Sweeps » remplacée par cet univers
// 3) entrées de l'indicateur sur le graphique mises à jour (+ sauvegarde du layout)
// 4) alerte(s) de l'indicateur mises à jour avec les mêmes symboles (sinon elles gardent l'ancienne liste)
// Résultat dans window.__refreshResult (texte).
(async () => {
  const PINE_ID = 'USER;2fdc570c952e45079baa756c5103d16f';
  const WL_NAME = 'Run_Conso_Sweeps';
  const N = 38, TOP = 30, MIN_VOL = 10e6;
  const MAJORS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'HYPEUSDT', 'DOGEUSDT', 'ZECUSDT', 'BNBUSDT'];
  const NON = new Set('XAU XAUT XAG PAXG CL BZ WTI BRENT NG SOXL SOXS SPCX SNDK SNXX MSTR SKHY SKHYNIX AAPL KORU INTC MU CRCL META TSLA NVDA EWY MSFT HOOD DRAM CHIP AMZN GOOGL COIN QQQ SPY IBIT MSFU CONL USDC USDE CONLUSDT'.split(' '));
  const log = [];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    // ── 1. univers ──────────────────────────────────────────────────────
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
    const uni = ranked.slice(0, TOP).map(t => t.s);
    for (const m of MAJORS) if (uni.length < N && !uni.includes(m)) uni.push(m);
    for (const t of ranked.slice(TOP)) if (uni.length < N && !uni.includes(t.s)) uni.push(t.s);
    if (uni.length < N) throw new Error('univers incomplet : ' + uni.length);
    const syms = uni.map(s => `BYBIT:${s}.P`);
    log.push('top 7 j : ' + ranked.slice(0, 8).map(t => t.s.replace('USDT', '') + ' ' + t.p7.toFixed(0) + '%').join(', '));

    // ── 2. watchlist ────────────────────────────────────────────────────
    const lists = await fetch('/api/v1/symbols_list/custom/', {credentials: 'include'}).then(r => r.json());
    const wl = lists.find(l => l.name === WL_NAME);
    if (wl) {
      const r = await fetch(`/api/v1/symbols_list/custom/${wl.id}/replace/?unsafe=true`, {method: 'POST', credentials: 'include', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(syms)});
      log.push('watchlist : ' + (r.ok ? 'ok' : 'échec ' + r.status));
    } else log.push('watchlist introuvable');

    // ── 3. entrées de l'indicateur sur le graphique ─────────────────────
    const ch = TradingViewApi.activeChart();
    const st = ch.getAllStudies().find(x => /Run \+ Conso/.test(x.name));
    if (st) {
      const study = ch.getStudyById(st.id);
      const iv = study.getInputValues()
        .filter(x => /^in_\d+$/.test(x.id) && typeof x.value === 'string' && x.value.indexOf('BYBIT:') === 0)
        .sort((a, b) => +a.id.slice(3) - +b.id.slice(3));
      study.setInputValues(iv.map((x, i) => ({id: x.id, value: syms[i]})));
      log.push('indicateur : ' + iv.length + ' symboles');
      await sleep(3000);
      const save = [...document.querySelectorAll('button')].find(e => /Save all charts/.test(e.getAttribute('aria-label') || ''));
      if (save) save.click();
    } else log.push('indicateur absent du graphique');

    // ── 4. alertes de l'indicateur ──────────────────────────────────────
    const la = await fetch('https://pricealerts.tradingview.com/list_alerts', {credentials: 'include'}).then(r => r.json());
    const alerts = (la.r || la).filter(a => {
      const c = a.conditions ? a.conditions[0] : a.condition;
      return c && c.series && c.series[0] && c.series[0].pine_id === PINE_ID;
    });
    for (const a of alerts) {
      const conds = JSON.parse(JSON.stringify(a.conditions || [a.condition]));
      for (const c of conds) {
        const inp = c.series[0].inputs;
        const keys = Object.keys(inp).filter(k => /^in_\d+$/.test(k) && typeof inp[k] === 'string' && inp[k].indexOf('BYBIT:') === 0)
          .sort((x, y) => +x.slice(3) - +y.slice(3));
        keys.forEach((k, i) => { inp[k] = syms[i]; });
        for (const k of ['type', 'series', 'resolution']) if (!(k in c)) delete c[k];
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
    if (!alerts.length) log.push('aucune alerte trouvée');
    window.__refreshResult = 'OK · ' + log.join(' · ');
  } catch (e) {
    window.__refreshResult = 'ERREUR · ' + e.message + ' · ' + log.join(' · ');
  }
})();
