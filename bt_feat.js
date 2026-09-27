// Backtest radar pumps : features, labels, épisodes, évaluation des règles, ML (GBM à souches)
var BT = (typeof window !== 'undefined' ? (window.BT = window.BT || {}) : (globalThis.BT = globalThis.BT || {}));

BT.slideMax = (a, w) => { // max de a[i-w..i-1] (exclut i)
  const n = a.length, out = new Float64Array(n).fill(NaN), dq = [];
  for (let i = 0; i < n; i++) {
    while (dq.length && dq[0] < i - w) dq.shift();
    if (i >= w) out[i] = a[dq[0]];
    while (dq.length && a[dq[dq.length - 1]] <= a[i]) dq.pop();
    dq.push(i);
  }
  return out;
};
BT.slideMin = (a, w) => { const neg = a.map(x => -x), m = BT.slideMax(neg, w); return m.map(x => -x); };
BT.avgPrev = (a, w) => { // moyenne de a[i-w..i-1]
  const n = a.length, out = new Float64Array(n).fill(NaN); let s = 0;
  for (let i = 0; i < n; i++) { if (i >= w) out[i] = s / w; s += a[i]; if (i >= w) s -= a[i - w]; }
  return out;
};
BT.cci = (c, len) => { const n = c.length, out = new Float64Array(n).fill(NaN);
  for (let i = len - 1; i < n; i++) { let m = 0; for (let j = i - len + 1; j <= i; j++) m += c[j]; m /= len;
    let d = 0; for (let j = i - len + 1; j <= i; j++) d += Math.abs(c[j] - m); d /= len; out[i] = d ? (c[i] - m) / (0.015 * d) : 0; }
  return out; };
BT.t3 = (src, len, v) => { const nr = 1 + 0.5 * (len - 1), k = 2 / (nr + 1), e = [0, 0, 0, 0, 0, 0], out = new Float64Array(src.length).fill(NaN);
  const c1 = -v * v * v, c2 = 3 * v * v + 3 * v * v * v, c3 = -6 * v * v - 3 * v - 3 * v * v * v, c4 = 1 + 3 * v + v * v * v + 3 * v * v;
  for (let i = 0; i < src.length; i++) { const x = src[i]; if (isNaN(x)) continue; let p = x;
    for (let q = 0; q < 6; q++) { e[q] = e[q] + k * (p - e[q]); p = e[q]; } out[i] = c1 * e[5] + c2 * e[4] + c3 * e[3] + c4 * e[2]; }
  return out; };

// divergence T3-CCI (creux rouges, 3 drives) évaluée à chaque bougie avec l'info disponible à ce moment
BT.t3divFlags = (h, l, c) => {
  const n = c.length, ind = BT.t3(BT.cci(c, 14), 5, 0.618), flag = new Uint8Array(n), troughs = [];
  const conf = []; // creux confirmé à i+3
  for (let i = 44; i < n - 3; i++) { const v = ind[i]; if (isNaN(v) || v >= 0) continue; let ok = true;
    for (let j = i - 5; j < i && ok; j++) if (!(ind[j] > v)) ok = false;
    for (let j = i + 1; j <= i + 3 && ok; j++) if (!(ind[j] >= v)) ok = false;
    if (!ok) continue; let pi = i; for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) if (l[j] < l[pi]) pi = j;
    troughs.push({i, pi, v, low: l[pi]}); }
  let k = 0; const known = [];
  let minSince = Infinity;
  for (let t = 0; t < n; t++) {
    while (k < troughs.length && troughs[k].i + 3 <= t) { known.push(troughs[k]); k++; minSince = Infinity; }
    if (!known.length) continue;
    const last = known[known.length - 1];
    if (t - last.i > 6) continue;
    // invalidé si le prix est passé sous le dernier drive après lui
    let broken = false; for (let j = last.pi + 1; j <= t; j++) if (l[j] < last.low) { broken = true; break; }
    if (broken) continue;
    let len = 1, cur = last;
    for (let q = known.length - 2; q >= 0; q--) { const p = known[q], gap = cur.i - p.i; if (gap < 5 || gap > 60) break;
      if (cur.v > p.v && cur.low < p.low) { len++; cur = p; } else break; }
    if (len >= 3 && cur.v <= -100) flag[t] = 1;
  }
  return {flag, ind};
};

BT.FEATS = ['vm', 'vm4', 'r1', 'r4', 'r24', 'r72', 'r168', 'd24', 'd168', 'd720', 'd1320', 'rng168', 'rng480', 'atr24', 'oi4', 'oi24', 'btc24', 't3', 'liq', 'up24'];

BT.prep = (coins, evalStart) => {
  const btc = coins.find(x => x.s === 'BTCUSDT');
  const btcR24 = new Map();
  if (btc) { const k = btc.k; for (let i = 24; i < k.length; i++) btcR24.set(k[i][0], k[i][4] / k[i - 24][4] - 1); }
  BT.D = [];
  for (const co of coins) {
    const k = co.k, n = k.length; if (n < 1500) continue;
    const t = k.map(x => x[0]), o = k.map(x => x[1]), h = k.map(x => x[2]), l = k.map(x => x[3]), c = k.map(x => x[4]), v = k.map(x => x[5]);
    const av24 = BT.avgPrev(v, 24), mx24 = BT.slideMax(h, 24), mx168 = BT.slideMax(h, 168), mx720 = BT.slideMax(h, 720), mx1320 = BT.slideMax(h, 1320);
    const mn168 = BT.slideMin(l, 168), mx480 = BT.slideMax(h, 480), mn480 = BT.slideMin(l, 480);
    const hl = h.map((x, i) => (x - l[i]) / c[i]), atr = BT.avgPrev(hl, 24);
    const {flag: t3f, ind: t3v} = BT.t3divFlags(h, l, c);
    // OI 4h : valeur connue à la clôture de la bougie (t+1h)
    const oiT = co.o.map(x => x[0]), oiV = co.o.map(x => x[1]);
    let p = 0;
    const F = {}; BT.FEATS.forEach(f => F[f] = new Float32Array(n).fill(NaN));
    const tp = new Int8Array(n).fill(-1), fwd = new Float32Array(n).fill(NaN);
    for (let i = 1330; i < n; i++) {
      const tc = t[i] + 36e5;
      while (p + 1 < oiT.length && oiT[p + 1] <= tc) p++;
      F.vm[i] = v[i] / av24[i];
      F.vm4[i] = (v[i] + v[i - 1] + v[i - 2] + v[i - 3]) / 4 / av24[i - 3];
      F.r1[i] = c[i] / c[i - 1] - 1; F.r4[i] = c[i] / c[i - 4] - 1; F.r24[i] = c[i] / c[i - 24] - 1; F.r72[i] = c[i] / c[i - 72] - 1; F.r168[i] = c[i] / c[i - 168] - 1;
      F.d24[i] = c[i] / mx24[i] - 1; F.d168[i] = c[i] / mx168[i] - 1; F.d720[i] = c[i] / mx720[i] - 1; F.d1320[i] = c[i] / mx1320[i] - 1;
      F.rng168[i] = mx168[i] / mn168[i] - 1; F.rng480[i] = mx480[i] / mn480[i] - 1; F.atr24[i] = atr[i];
      if (oiT.length && oiT[p] <= tc && p >= 6) { F.oi4[i] = oiV[p] / oiV[p - 1] - 1; F.oi24[i] = oiV[p] / oiV[p - 6] - 1; }
      const b = btcR24.get(t[i]); F.btc24[i] = b === undefined ? NaN : b;
      F.t3[i] = t3v[i]; F.liq[i] = Math.log10(av24[i] * 24 + 1); F.up24[i] = t3f[i];
      // label : +15 % avant −8 % dans les 72 h
      if (i + 72 < n) {
        let res = 0, mx = 0;
        for (let j = i + 1; j <= i + 72; j++) {
          mx = Math.max(mx, h[j]);
          if (l[j] <= c[i] * 0.92) { res = 0; break; }          // stop touché d'abord (prudent si les deux dans la même bougie)
          if (h[j] >= c[i] * 1.15) { res = 1; break; }
        }
        tp[i] = res;
        let m2 = 0; for (let j = i + 1; j <= i + 72; j++) m2 = Math.max(m2, h[j]); fwd[i] = m2 / c[i];
      }
    }
    const i0 = t.findIndex(x => x >= evalStart);
    BT.D.push({s: co.s, b: co.b, t, h, l, c, v, F, tp, fwd, t3f, i0: Math.max(i0, 1330), n});
  }
  // épisodes de pump : +30 % en 72 h max
  BT.EP = [];
  for (const d of BT.D) {
    let cur = null;
    for (let i = d.i0; i < d.n - 72; i++) {
      if (d.fwd[i] >= 1.30) {
        if (cur && i - cur.last <= 24) cur.last = i;
        else { if (cur) BT.EP.push(cur); cur = {d, start: i, last: i}; }
      }
    }
    if (cur) BT.EP.push(cur);
  }
  for (const e of BT.EP) { const d = e.d; let pk = e.start, end = Math.min(d.n - 1, e.last + 72);
    for (let j = e.start; j <= end; j++) if (d.h[j] > d.h[pk]) pk = j; e.peak = pk; e.gain = d.h[pk] / d.c[e.start] - 1; }
  return {coins: BT.D.length, episodes: BT.EP.length};
};

// règles du radar actuel (évaluées à la clôture de chaque bougie 1h)
BT.RULES = {
  hi: (F, i) => F.d24[i] > 0 && F.vm[i] >= 2.5,
  oi: (F, i) => F.oi4[i] >= 0.15 && F.vm[i] >= 2 && F.r4[i] >= 0.02,
  t3: (F, i) => F.up24[i] === 1,
};

// évalue une fonction de signal : précision (TP), rappel sur les épisodes, détails des ratés
BT.evaluate = (fire, opt = {}) => {
  const cd = opt.cooldown || 24, from = opt.from || 0, to = opt.to || Infinity;
  let sig = 0, tp = 0; const fired = new Map();
  for (const d of BT.D) {
    const arr = []; let last = -1e9;
    for (let i = d.i0; i < d.n; i++) {
      if (d.t[i] < from || d.t[i] >= to) continue;
      if (fire(d.F, i, d)) { arr.push(i); if (i - last >= cd && d.tp[i] >= 0) { sig++; tp += d.tp[i]; last = i; } }
    }
    fired.set(d, arr);
  }
  let eps = 0, caught = 0; const missed = [];
  for (const e of BT.EP) {
    const d = e.d; if (d.t[e.start] < from || d.t[e.start] >= to) continue;
    eps++;
    const arr = fired.get(d) || [];
    const ok = arr.some(i => i >= e.start - 48 && i < e.peak && d.h[e.peak] / d.c[i] >= 1.15);
    if (ok) caught++; else missed.push(e);
  }
  return {signals: sig, tp, precision: sig ? tp / sig : 0, episodes: eps, caught, recall: eps ? caught / eps : 0, missed};
};

// pourquoi un épisode est raté : ce qu'on voit entre le départ et le moment où il reste moins de +15 %
BT.diagnose = e => {
  const d = e.d, F = d.F, pk = d.h[e.peak];
  let mvm = 0, brk = 0, moi = -1, mr4 = -1, t3 = 0, n = 0;
  for (let i = Math.max(d.i0, e.start - 48); i < e.peak && pk / d.c[i] >= 1.15; i++) {
    n++; mvm = Math.max(mvm, F.vm[i] || 0); if (F.d24[i] > 0) brk = 1; if (!isNaN(F.oi4[i])) moi = Math.max(moi, F.oi4[i]);
    mr4 = Math.max(mr4, F.r4[i] || 0); if (F.up24[i]) t3 = 1;
  }
  let why = [];
  if (!n) why.push('pump instantané (tout en 1 bougie)');
  else {
    if (!brk) why.push('pas de cassure du plus haut 24 h avant la fin');
    else if (mvm < 2.5) why.push('cassure 24 h mais volume < 2,5× (max ' + mvm.toFixed(1) + '×)');
    if (moi < 0.15) why.push('OI < +15 %');
  }
  return {b: d.b, date: new Date(d.t[e.start]).toISOString().slice(0, 10), gain: e.gain, window: n, maxVm: mvm, brk, maxOi4: moi, t3, why: why.join(' ; ')};
};

// ─── ML : gradient boosting (souches sur features discrétisées), perte logistique ───
BT.gbm = (X, y, opt = {}) => {
  const nF = X[0].length, N = X.length, B = opt.bins || 32, T = opt.trees || 150, lr = opt.lr || 0.1, minLeaf = opt.minLeaf || 200;
  // bornes de quantiles par feature (NaN = bin spécial 0)
  const edges = [];
  for (let f = 0; f < nF; f++) {
    const vals = []; for (let i = 0; i < N; i += Math.max(1, Math.floor(N / 20000))) { const x = X[i][f]; if (!isNaN(x)) vals.push(x); }
    vals.sort((a, b) => a - b); const e = []; for (let q = 1; q < B - 1; q++) e.push(vals[Math.floor(q * vals.length / (B - 1))]); edges.push(e);
  }
  const binOf = (f, x) => { if (isNaN(x)) return 0; const e = edges[f]; let lo = 0, hi = e.length; while (lo < hi) { const m = (lo + hi) >> 1; if (x <= e[m]) hi = m; else lo = m + 1; } return lo + 1; };
  const Xb = X.map(r => Uint8Array.from(r.map((x, f) => binOf(f, x))));
  const pos = y.reduce((a, b) => a + b, 0) / N, F0 = Math.log(pos / (1 - pos));
  const Fx = new Float64Array(N).fill(F0), trees = [];
  for (let t = 0; t < T; t++) {
    const g = new Float64Array(N), hh = new Float64Array(N);
    for (let i = 0; i < N; i++) { const p = 1 / (1 + Math.exp(-Fx[i])); g[i] = y[i] - p; hh[i] = p * (1 - p); }
    let best = null;
    for (let f = 0; f < nF; f++) {
      const G = new Float64Array(B + 1), H = new Float64Array(B + 1), C = new Float64Array(B + 1);
      for (let i = 0; i < N; i++) { const b = Xb[i][f]; G[b] += g[i]; H[b] += hh[i]; C[b]++; }
      const Gt = G.reduce((a, b) => a + b, 0), Ht = H.reduce((a, b) => a + b, 0), Ct = N;
      // split : bins <= s à gauche (le bin NaN 0 va à gauche)
      let gl = 0, hl = 0, cl = 0;
      for (let s = 0; s < B; s++) {
        gl += G[s]; hl += H[s]; cl += C[s];
        const gr = Gt - gl, hr = Ht - hl, cr = Ct - cl;
        if (cl < minLeaf || cr < minLeaf) continue;
        const gain = gl * gl / (hl + 1) + gr * gr / (hr + 1) - Gt * Gt / (Ht + 1);
        if (!best || gain > best.gain) best = {f, s, gain, wl: gl / (hl + 1), wr: gr / (hr + 1)};
      }
    }
    if (!best) break;
    trees.push({f: best.f, s: best.s, wl: lr * best.wl, wr: lr * best.wr});
    for (let i = 0; i < N; i++) Fx[i] += Xb[i][best.f] <= best.s ? lr * best.wl : lr * best.wr;
  }
  const model = {F0, trees, edges, feats: opt.feats};
  model.predict = row => { let s = F0; for (const tr of trees) s += (binOf(tr.f, row[tr.f]) <= tr.s ? tr.wl : tr.wr); return 1 / (1 + Math.exp(-s)); };
  return model;
};

// jeu de données pour le ML : lignes horaires (échantillonnées), coupe temporelle train / test
BT.dataset = (from, to, keepNeg = 0.15, seed = 1) => {
  let r = seed; const rnd = () => { r = (r * 1103515245 + 12345) % 2147483648; return r / 2147483648; };
  const X = [], y = [];
  for (const d of BT.D) for (let i = d.i0; i < d.n; i++) {
    if (d.t[i] < from || d.t[i] >= to || d.tp[i] < 0) continue;
    if (!d.tp[i] && rnd() > keepNeg) continue;
    X.push(BT.FEATS.map(f => d.F[f][i])); y.push(d.tp[i]);
  }
  return {X, y};
};
BT.scoreAll = model => { for (const d of BT.D) { d.P = new Float32Array(d.n).fill(NaN); for (let i = d.i0; i < d.n; i++) d.P[i] = model.predict(BT.FEATS.map(f => d.F[f][i])); } };

// trade simulé : entrée à la clôture, objectif +15 %, stop −8 %, sortie forcée à 72 h, frais 0,12 % aller-retour
BT.trades = (fire, opt = {}) => {
  const cd = opt.cooldown || 24, from = opt.from || 0, to = opt.to || Infinity; let n = 0, sum = 0, win = 0;
  for (const d of BT.D) {
    let last = -1e9;
    for (let i = d.i0; i < d.n - 72; i++) {
      if (d.t[i] < from || d.t[i] >= to) continue;
      if (i - last < cd || !fire(d.F, i, d)) continue;
      last = i; const c = d.c[i]; let r = null;
      for (let j = i + 1; j <= i + 72; j++) { if (d.l[j] <= c * 0.92) { r = -0.08; break; } if (d.h[j] >= c * 1.15) { r = 0.15; break; } }
      if (r === null) r = d.c[i + 72] / c - 1;
      r -= 0.0012; n++; sum += r; if (r > 0) win++;
    }
  }
  return {n, avg: n ? sum / n : 0, win: n ? win / n : 0};
};
