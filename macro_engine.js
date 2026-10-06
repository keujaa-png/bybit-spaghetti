// Moteur des idées macro : partagé par la page (macro.html) et par le robot Telegram (macro_bot.mjs).
(function (root) {
  const ME = {PB: null, RULE: {LB: 120, CH: 20, CD: 20, lag: 0.03, max: 1, hold: 60}, FULL: {}, ALL: [], PICK: [], ECO: [], SIGS: {}};
  const today = ME.today = () => Math.floor(Date.now() / 864e5);
  const nf = ME.nf = (v, d = 1) => v.toLocaleString('fr-FR', {minimumFractionDigits: d, maximumFractionDigits: d});
  const sg = ME.sg = (v, d = 1) => (v > 0 ? '+' : v < 0 ? '−' : '') + nf(Math.abs(v), d);
  const pct = ME.pct = (v, d = 1) => sg(100 * v, d) + ' %';
  const dstr = ME.dstr = day => { const d = new Date(day * 864e5); return String(d.getUTCDate()).padStart(2, '0') + '/' + String(d.getUTCMonth() + 1).padStart(2, '0'); };
  ME.esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  ME.tvUrl = s => 'https://www.tradingview.com/chart/?symbol=' + encodeURIComponent(s);
  ME.short = s => s.split(':')[1];
  const isEco = ME.isEco = s => s.startsWith('ECONOMICS:');
  const ruleOf = ME.ruleOf = th => Object.assign({}, ME.RULE, th.rule || {});
  ME.theme = id => ME.PB.themes.find(x => x.id === id);

  // ----- données -----
  ME.setSeries = (s, m) => {
    const a = [...m.entries()].sort((x, y) => x[0] - y[0]);
    ME.FULL[s] = {t: a.map(x => x[0]), o: a.map(x => x[1][0]), c: a.map(x => x[1][1])};
  };
  ME.load = (pb, base, adds) => {
    ME.PB = pb; ME.RULE = Object.assign(ME.RULE, pb.rule || {}); ME.FULL = {}; ME.pub = {};
    for (const th of pb.themes) if (th.drv.pub != null) ME.pub[th.drv.a] = th.drv.pub;
    for (const [s, h] of Object.entries(base.H)) {
      const m = new Map(); h.t.forEach((d, i) => m.set(d, [h.o[i], h.c[i]]));
      for (const add of adds) for (const [d, v] of Object.entries((add && add[s]) || {})) m.set(+d, v);
      ME.setSeries(s, m);
    }
  };
  ME.allSyms = () => {
    const set = new Set();
    for (const th of ME.PB.themes) { set.add(th.drv.a); if (th.drv.b) set.add(th.drv.b); for (const l of [...th.short, ...th.long]) set.add(l.tv); }
    for (const p of ME.PB.polys || []) for (const l of [...p.short, ...p.long]) set.add(l.tv);
    return [...set];
  };
  // Cours du jour + 2 séances précédentes (scanner TradingView). Renvoie les barres {sym: {jour: [ouverture, clôture]}}.
  ME.scan = async () => {
    const cols = ['close', 'open', 'time', 'close[1]', 'open[1]', 'time[1]', 'close[2]', 'open[2]', 'time[2]'];
    let j = null;
    for (const c of [cols, cols.slice(0, 6), cols.slice(0, 3)]) {
      try {
        const r = await fetch('https://scanner.tradingview.com/global/scan', {method: 'POST', body: JSON.stringify({symbols: {tickers: ME.allSyms()}, columns: c})});
        j = await r.json(); if (j && j.data) break;
      } catch (e) { j = null; }
    }
    if (!j || !j.data) return null;
    const out = {};
    for (const row of j.data) {
      const s = row.s, d = row.d, A = out[s] = {};
      for (let k = 0; k + 2 < d.length; k += 3) {
        const c = d[k], o = d[k + 1], t = d[k + 2];
        if (c == null || t == null) continue;
        const day = Math.floor(t / 86400) + (isEco(s) ? (ME.pub[s] || 0) : 0);
        A[day] = [o == null || isEco(s) ? +c.toPrecision(6) : +o.toPrecision(6), +c.toPrecision(6)];
      }
    }
    return out;
  };
  ME.merge = bars => {
    for (const [s, A] of Object.entries(bars || {})) {
      if (!ME.FULL[s]) continue;
      const m = new Map(ME.FULL[s].t.map((x, i) => [x, [ME.FULL[s].o[i], ME.FULL[s].c[i]]]));
      for (const [day, v] of Object.entries(A)) m.set(+day, v);
      ME.setSeries(s, m);
    }
  };

  // ----- règles -----
  const sma = ME.sma = (c, n, i) => { if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += c[k]; return s / n; };
  const drvSeries = ME.drvSeries = th => {
    const A = ME.FULL[th.drv.a], T = today(), t = [], v = []; if (!A) return {t, v};
    if (th.drv.k === 'spread') {
      const B = ME.FULL[th.drv.b]; if (!B) return {t, v};
      const ib = new Map(B.t.map((d, i) => [d, i]));
      A.t.forEach((d, i) => { if (d < T && ib.has(d)) { t.push(d); v.push(A.c[i] - B.c[ib.get(d)]); } });
    } else A.t.forEach((d, i) => { if (d < T) { t.push(d); v.push(A.c[i]); } });
    return {t, v};
  };
  const chg = ME.chg = (th, a, b) => th.drv.k === 'price' ? a / b - 1 : a - b;
  ME.signals = th => {
    const R = ruleOf(th), {t, v} = drvSeries(th), out = [], last = {1: -99, '-1': -99};
    for (let i = Math.max(R.LB, R.CH); i < v.length; i++) {
      let hi = -1e18, lo = 1e18;
      for (let k = i - R.LB + 1; k <= i; k++) { if (v[k] > hi) hi = v[k]; if (v[k] < lo) lo = v[k]; }
      const ch = chg(th, v[i], v[i - R.CH]);
      let s = 0;
      if (v[i] >= hi && ch >= th.drv.x) s = 1; else if (v[i] <= lo && ch <= -th.drv.x) s = -1;
      if (s && i - last[s] > R.CD) { last[s] = i; out.push({day: t[i], sg: s, v: v[i], ch, ref: v[i - R.CH], i}); }
    }
    return out;
  };
  const legState = ME.legState = (sym, s, day) => {
    const L = ME.FULL[sym]; if (!L) return null;
    let i = -1; for (let k = L.t.length - 1; k >= 0; k--) if (L.t[k] <= day) { i = k; break; }
    if (i < 60) return null;
    const sm = sma(L.c, 50, i), r20 = s * (L.c[i] / L.c[i - 20] - 1), conf = s * (L.c[i] - sm) > 0;
    return {sym, s, i, e: i + 1 < L.t.length ? i + 1 : null, r20, conf, lag: !conf && r20 < ME.RULE.lag};
  };
  const fwd = ME.fwd = (tr, N) => {
    const L = ME.FULL[tr.sym]; if (tr.e == null) return null;
    const x = Math.min(tr.e + N, L.c.length - 1);
    return x - tr.e >= 2 ? tr.s * (L.c[x] / L.o[tr.e] - 1) : null;
  };
  ME.result = tr => {
    const L = ME.FULL[tr.sym]; if (tr.e == null) return null;
    const x = Math.min(tr.e + ME.RULE.hold, L.c.length - 1);
    let worst = 0; for (let k = tr.e; k <= x; k++) { const r = tr.s * (L.c[k] / L.o[tr.e] - 1); if (r < worst) worst = r; }
    return {ret: tr.s * (L.c[x] / L.o[tr.e] - 1), bars: x - tr.e, entry: L.o[tr.e], eday: L.t[tr.e], worst, open: x - tr.e < ME.RULE.hold};
  };
  ME.compute = () => {
    ME.ALL = []; ME.PICK = []; ME.ECO = []; ME.SIGS = {}; for (const k in baseCache) delete baseCache[k];
    for (const th of ME.PB.themes) {
      const S = ME.SIGS[th.id] = ME.signals(th);
      for (const sig of S) {
        const legs = [...th.short.map(l => [l, -sig.sg]), ...th.long.map(l => [l, sig.sg])], ep = [];
        for (const [l, s] of legs) { const st = legState(l.tv, s, sig.day); if (st) ep.push(Object.assign(st, {th: th.id, fam: th.fam, day: sig.day, sig, leg: l})); }
        const pick = ep.filter(x => x.lag).sort((a, b) => a.r20 - b.r20).slice(0, ME.RULE.max);
        if (th.alert === false) ME.ECO.push(...pick); else { ME.ALL.push(...ep); ME.PICK.push(...pick); }
      }
    }
  };
  const baseCache = {};
  const baseline = (sym, s, N, from) => {
    const k = sym + '|' + s + '|' + N + '|' + from; if (k in baseCache) return baseCache[k];
    const L = ME.FULL[sym]; let a = 0, n = 0;
    for (let i = 60; i + N < L.c.length; i++) { if (L.t[i] < from) continue; a += s * (L.c[i + N] / L.o[i] - 1); n++; }
    return baseCache[k] = n ? a / n : 0;
  };
  ME.stats = (T, from, to = 1e9) => {
    const N = ME.RULE.hold, R = T.filter(x => x.day >= from && x.day < to).map(x => ({x, f: fwd(x, N)})).filter(o => o.f != null);
    if (!R.length) return null;
    const mean = a => a.reduce((p, q) => p + q, 0) / a.length;
    return {n: R.length, ep: new Set(R.map(o => o.x.th + o.x.day)).size, win: R.filter(o => o.f > 0).length / R.length, avg: mean(R.map(o => o.f)), exc: mean(R.map(o => o.f - baseline(o.x.sym, o.x.s, N, from)))};
  };
  ME.firstDay = () => Math.min(...ME.PICK.map(x => x.day));
  ME.current = () => ME.PICK.filter(tr => { const L = ME.FULL[tr.sym]; return tr.e == null || L.c.length - 1 - tr.e < ME.RULE.hold; }).sort((a, b) => b.day - a.day);
  ME.isNew = tr => tr.day >= today() - 4;
  ME.keyOf = tr => tr.th + '|' + tr.day + '|' + tr.sym;

  // ----- textes -----
  const drvFmt = ME.drvFmt = th => {
    const d = th.drv;
    if (d.k === 'spread') return v => nf(100 * v, 0) + ' pb';
    if (d.k === 'yield') return v => nf(v, 2) + ' %';
    if (d.unit === 'k') return v => nf(v / 1000, 0) + ' k';
    if (d.k === 'abs') return v => nf(v, d.dec == null ? 1 : d.dec) + ' ' + d.unit;
    return v => nf(v, Math.abs(v) < 20 ? 2 : Math.abs(v) < 1000 ? 1 : 0);
  };
  const drvChg = ME.drvChg = (th, ch) => {
    const d = th.drv;
    if (d.k === 'price') return pct(ch);
    if (d.k === 'abs') return sg(ch, d.dec == null ? 1 : d.dec) + ' ' + (d.unit === '%' ? 'pt' : d.unit);
    return sg(100 * ch, 0) + ' pb';
  };
  ME.drvX = th => { const d = th.drv; return d.k === 'price' ? nf(100 * d.x, 0) + ' %' : d.k === 'abs' ? nf(d.x, d.dec == null ? 1 : d.dec) + ' ' + (d.unit === '%' ? 'pt' : d.unit) : nf(100 * d.x, 0) + ' pb'; };
  ME.per = th => { const R = ruleOf(th); return th.rule ? {ch: R.CH + ' publications', lb: R.LB + ' mois'} : {ch: R.CH + ' séances', lb: R.LB + ' séances'}; };
  ME.ideaText = (th, tr) => {
    const side = tr.sig.sg > 0 ? th.up : th.down, raw = tr.s * tr.r20, f = drvFmt(th), p = ME.per(th);
    return {
      title: side.t, ctx: side.w,
      trig: `${th.drv.label} à ${f(tr.sig.v)}, soit ${drvChg(th, tr.sig.ch)} en ${p.ch} : ${tr.sig.sg > 0 ? 'plus haut' : 'plus bas'} de ${p.lb} le ${dstr(tr.day)}.`,
      why: `${tr.leg.n} (${tr.leg.w}) n’a pas encore réagi : ${pct(raw)} sur 20 séances, et le titre est encore ${tr.s < 0 ? 'au-dessus' : 'en dessous'} de sa moyenne 50 séances.`,
      plan: `Entrée à l’ouverture suivante, sortie après ${ME.RULE.hold} séances (environ ${Math.round(ME.RULE.hold / 21)} mois). L’idée ne tient plus si l’indicateur revient vers ${f(tr.sig.ref)}.`
    };
  };
  ME.btLine = () => {
    const s = ME.stats(ME.PICK, 0); if (!s) return '';
    return `Backtest ${nf((today() - ME.firstDay()) / 365.25, 0)} ans : ${s.n} idées, ${nf(100 * s.win, 0)} % gagnantes, ${pct(s.avg)} en moyenne (${sg(100 * s.exc)} pt contre le hasard).`;
  };
  ME.caption = (th, tr) => {
    const tx = ME.ideaText(th, tr), e = ME.esc;
    return `${th.flag} <b>${e(tx.title)}</b>\n${tr.s > 0 ? '🟢 <b>ACHAT' : '🔴 <b>VENTE'} ${e(tr.leg.n)}</b> (${e(tr.sym)})\n\n<b>Contexte.</b> ${e(tx.ctx)}\n<b>Déclencheur.</b> ${e(tx.trig)}\n<b>Pourquoi ce titre.</b> ${e(tx.why)}\n<b>Plan testé.</b> ${e(tx.plan)}\n\n${e(ME.btLine())}\n<a href="${ME.tvUrl(tr.sym)}">Chart TradingView</a> · idée à étudier, pas un conseil`;
  };

  // ----- charts (canvas du navigateur ou de Node) -----
  const FONT = 'system-ui, "DejaVu Sans", sans-serif';
  const MONTHS = ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'];
  const panel = ME.panel = (ctx, X, Y, W, H, t, lines, o = {}) => {
    let lo = 1e18, hi = -1e18;
    for (const l of lines) for (const v of l.v) if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const pad = (hi - lo) * 0.1 || 1; lo -= pad; hi += pad;
    const n = t.length, px = i => X + 10 + (W - 106) * i / Math.max(1, n - 1), py = v => Y + H - 28 - (H - 66) * (v - lo) / (hi - lo);
    ctx.fillStyle = '#d7dde5'; ctx.font = '600 22px ' + FONT; ctx.textAlign = 'left'; ctx.fillText(o.title || '', X + 10, Y + 24);
    ctx.font = '17px ' + FONT; ctx.strokeStyle = '#262d36'; ctx.lineWidth = 1; ctx.setLineDash([]);
    for (let k = 0; k <= 2; k++) { const v = lo + pad + (hi - lo - 2 * pad) * k / 2, y = py(v); ctx.beginPath(); ctx.moveTo(X + 10, y); ctx.lineTo(X + W - 92, y); ctx.stroke(); ctx.fillStyle = '#7f8fa3'; ctx.fillText(o.fmt ? o.fmt(v) : nf(v, 2), X + W - 86, y + 6); }
    let pm = -1; for (let i = 0; i < n; i++) { const m = new Date(t[i] * 864e5).getUTCMonth(); if (m !== pm) { if (pm >= 0 && (n < 200 || m % 3 === 0)) { ctx.fillStyle = '#7f8fa3'; ctx.fillText(MONTHS[m], px(i), Y + H - 7); } pm = m; } }
    for (const l of lines) { ctx.strokeStyle = l.color; ctx.lineWidth = l.w || 2; ctx.setLineDash(l.dash || []); ctx.beginPath(); let st = false; l.v.forEach((v, i) => { if (v == null) return; if (st) ctx.lineTo(px(i), py(v)); else { ctx.moveTo(px(i), py(v)); st = true; } }); ctx.stroke(); }
    ctx.setLineDash([]);
    for (const m of o.marks || []) { if (m.i < 0 || m.i >= n) continue; const x = px(m.i), y = py(m.v); ctx.fillStyle = m.color; ctx.beginPath(); ctx.arc(x, y, 8, 0, 7); ctx.fill(); ctx.strokeStyle = '#0e1117'; ctx.lineWidth = 2; ctx.stroke(); ctx.fillStyle = m.color; ctx.font = '600 18px ' + FONT; ctx.textAlign = x > X + W - 260 ? 'right' : 'left'; ctx.fillText(m.label, x + (ctx.textAlign === 'right' ? -13 : 13), y - 12); ctx.textAlign = 'left'; ctx.font = '17px ' + FONT; }
  };
  ME.ideaChart = (cv, th, tr) => {
    cv.width = 900; cv.height = 620; const ctx = cv.getContext('2d');
    ctx.fillStyle = '#0e1117'; ctx.fillRect(0, 0, 900, 620);
    const D = drvSeries(th), di = D.t.indexOf(tr.day), d0 = Math.max(0, D.t.length - (th.rule ? 48 : 130));
    panel(ctx, 0, 6, 900, 290, D.t.slice(d0), [{v: D.v.slice(d0), color: '#f0a030', w: 2.5}], {title: th.drv.label, fmt: drvFmt(th), marks: di >= d0 ? [{i: di - d0, v: D.v[di], color: '#f0a030', label: 'signal ' + dstr(tr.day)}] : []});
    const L = ME.FULL[tr.sym], l0 = Math.max(0, L.t.length - 130), ma = L.c.map((_, i) => sma(L.c, 50, i));
    const col = tr.s > 0 ? '#26c281' : '#ef5350';
    panel(ctx, 0, 316, 900, 298, L.t.slice(l0), [{v: ma.slice(l0), color: '#5b6b80', w: 2, dash: [6, 5]}, {v: L.c.slice(l0), color: '#d7dde5', w: 2.5}], {title: tr.leg.n + '  (' + tr.sym + ')', marks: tr.e != null && tr.e >= l0 ? [{i: tr.e - l0, v: L.o[tr.e], color: col, label: (tr.s > 0 ? 'achat ' : 'vente ') + dstr(L.t[tr.e])}] : []});
  };

  // ----- Polymarket (paris suivis du playbook) -----
  ME.polyPrice = m => { try { return +JSON.parse(m.outcomePrices)[0]; } catch (e) { return null; } };
  ME.polyCurated = async () => {
    const out = [];
    for (const p of ME.PB.polys || []) {
      let ev = null; try { ev = await (await fetch('https://gamma-api.polymarket.com/events?slug=' + encodeURIComponent(p.slug))).json(); } catch (e) {}
      const m = ev && ev[0] && (ev[0].markets || []).find(x => !x.closed && new RegExp(p.outcome, 'i').test((x.groupItemTitle || '') + ' ' + (x.question || '')));
      if (!m) continue;
      const pr = ME.polyPrice(m), w1 = +m.oneWeekPriceChange || 0, d1 = +m.oneDayPriceChange || 0;
      const legs = [...p.long.map(l => [l, 1]), ...p.short.map(l => [l, -1])].map(([l, s]) => { const st = legState(l.tv, s, today()); return st ? {l, s, st} : null; }).filter(Boolean);
      out.push({p, pr, w1, d1, hot: pr >= 0.5 && w1 >= 0.15, legs});
    }
    return out;
  };
  ME.polyText = o => {
    const e = ME.esc, lag = o.legs.filter(x => x.st.lag);
    return `🗳️ <b>${e(o.p.t)}</b>\nCote Polymarket : <b>${nf(100 * o.pr, 0)} %</b> (${sg(100 * o.w1, 0)} pt en une semaine).\n${e(o.p.w)}\n\n` + (lag.length ? 'Titres liés qui n’ont pas encore réagi : ' + lag.map(x => `${x.s > 0 ? '🟢' : '🔴'} <a href="${ME.tvUrl(x.l.tv)}">${e(x.l.n)}</a> (${pct(x.s * x.st.r20, 0)} sur 20 séances)`).join(', ') + '.' : 'Tous les titres liés ont déjà bougé : rien à proposer, le marché a déjà payé la nouvelle.') + `\n\nNon backtesté · <a href="https://polymarket.com/event/${e(o.p.slug)}">voir le pari</a>`;
  };

  root.ME = ME;
})(typeof globalThis !== 'undefined' ? globalThis : this);
