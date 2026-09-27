// Backtest radar pumps : téléchargement des données Bybit (bougies 1h + open interest 4h)
var BT = (typeof window !== 'undefined' ? (window.BT = window.BT || {}) : (globalThis.BT = globalThis.BT || {}));
BT.sleep = ms => new Promise(r => setTimeout(r, ms));
BT.getJ = async u => {
  for (let k = 0; k < 4; k++) {
    try { const j = await fetch(u).then(r => r.json()); if (j.retCode === 0) return j; await BT.sleep(1500); } catch (e) { await BT.sleep(1500); }
  }
  return null;
};
BT.kl = async (s, start, end) => {
  const out = []; let e = end;
  for (let g = 0; g < 20; g++) {
    const j = await BT.getJ(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${s}&interval=60&limit=1000&end=${e}`);
    const L = (j && j.result && j.result.list) || []; if (!L.length) break;
    for (const x of L) out.push([+x[0], +x[1], +x[2], +x[3], +x[4], +x[6]]);
    const oldest = +L[L.length - 1][0]; if (oldest <= start || L.length < 1000) break; e = oldest - 1;
  }
  const m = new Map(); for (const r of out) if (r[0] >= start) m.set(r[0], r);
  return [...m.values()].sort((a, b) => a[0] - b[0]);
};
BT.oi = async (s, start, end) => {
  const out = []; let e = end;
  for (let g = 0; g < 20; g++) {
    const j = await BT.getJ(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${s}&intervalTime=4h&limit=200&endTime=${e}`);
    const L = (j && j.result && j.result.list) || []; if (!L.length) break;
    for (const x of L) out.push([+x.timestamp, +x.openInterest]);
    const oldest = +L[L.length - 1].timestamp; if (oldest <= start || L.length < 200) break; e = oldest - 1;
  }
  const m = new Map(); for (const r of out) if (r[0] >= start) m.set(r[0], r);
  return [...m.values()].sort((a, b) => a[0] - b[0]);
};
BT.load = async (minVol = 5e6, days = 180) => {
  const inst = await BT.getJ('https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000');
  const tradfi = new Set(((inst && inst.result.list) || []).filter(o => ['stock', 'ETF', 'commodity', 'forex'].includes(o.symbolType)).map(o => o.symbol));
  const tk = await BT.getJ('https://api.bybit.com/v5/market/tickers?category=linear');
  const NON = new Set(['USDC', 'USDE', 'XAUT', 'PAXG']), seen = new Set();
  const list = tk.result.list.filter(t => t.symbol.endsWith('USDT') && !tradfi.has(t.symbol) && +t.turnover24h >= minVol)
    .map(t => ({s: t.symbol, b: t.symbol.replace(/USDT$/, '').replace(/^(1000000|100000|10000|1000)/, ''), v: +t.turnover24h}))
    .filter(t => !NON.has(t.b)).sort((a, b) => b.v - a.v).filter(t => !seen.has(t.b) && seen.add(t.b));
  if (!list.find(x => x.s === 'BTCUSDT')) list.unshift({s: 'BTCUSDT', b: 'BTC'});
  const end = Date.now(), start = end - (days + 60) * 864e5;
  BT.end = end; BT.evalStart = end - days * 864e5; BT.coins = [];
  let done = 0; BT.status = 'chargement 0/' + list.length;
  for (let i = 0; i < list.length; i += 6) {
    await Promise.all(list.slice(i, i + 6).map(async t => {
      const [k, o] = await Promise.all([BT.kl(t.s, start, end), BT.oi(t.s, start, end)]);
      if (k.length > 1500) BT.coins.push({...t, k, o});
      done++;
    }));
    BT.status = `chargement ${done}/${list.length}`;
  }
  BT.status = 'chargé ' + BT.coins.length + ' coins';
  return BT.coins.length;
};
