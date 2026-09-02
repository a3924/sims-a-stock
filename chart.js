/* chart.js — K线/指标/筹码峰绘制引擎（Canvas 2D，暗色主题）
 * 依赖: window.GAME_KLINE / window.GAME_CHIPS
 */
(function (global) {
  'use strict';

  // ---------- 指标计算 ----------
  function sma(arr, n) {
    var out = new Array(arr.length).fill(null), sum = 0;
    for (var i = 0; i < arr.length; i++) {
      sum += arr[i];
      if (i >= n) sum -= arr[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }
  // 前导 null 之后的简单移动平均：arr 从索引 from 起连续有效，计算 m 期均线
  function smaAfter(arr, from, m) {
    var out = new Array(arr.length).fill(null), sum = 0;
    for (var i = from; i < arr.length; i++) {
      sum += arr[i];
      if (i - from >= m) sum -= arr[i - m];
      if (i - from >= m - 1) out[i] = sum / m;
    }
    return out;
  }
  function ema(arr, n) {
    var out = new Array(arr.length).fill(null), k = 2 / (n + 1), prev = null;
    for (var i = 0; i < arr.length; i++) {
      if (i < n - 1) continue;
      if (prev === null) { prev = arr[i]; } else { prev = arr[i] * k + prev * (1 - k); }
      out[i] = prev;
    }
    return out;
  }
  function macd(close, fast, slow, sig) {
    fast = fast || 12; slow = slow || 26; sig = sig || 9;
    var ef = ema(close, fast), es = ema(close, slow);
    var dif = close.map(function (_, i) { return (ef[i] == null || es[i] == null) ? null : ef[i] - es[i]; });
    var valid = dif.filter(function (x) { return x != null; });
    var deaRaw = ema(valid, sig);
    var dea = new Array(close.length).fill(null), j = 0;
    for (var i = 0; i < close.length; i++) {
      if (dif[i] == null) { dea[i] = null; continue; }
      dea[i] = deaRaw[j++];
    }
    var bar = close.map(function (_, i) { return (dif[i] == null || dea[i] == null) ? null : (dif[i] - dea[i]) * 2; });
    return { dif: dif, dea: dea, bar: bar };
  }
  function kdj(high, low, close, n, m1, m2) {
    n = n || 9; m1 = m1 || 3; m2 = m2 || 3;
    var k = new Array(close.length).fill(null),
        d = new Array(close.length).fill(null),
        j = new Array(close.length).fill(null);
    var pk = 50, pd = 50;
    for (var i = 0; i < close.length; i++) {
      if (i < n - 1) continue;
      var hh = -Infinity, ll = Infinity;
      for (var q = i - n + 1; q <= i; q++) { if (high[q] > hh) hh = high[q]; if (low[q] < ll) ll = low[q]; }
      var rsv = (hh === ll) ? 50 : (close[i] - ll) / (hh - ll) * 100;
      pk = (m1 - 1) / m1 * pk + 1 / m1 * rsv;
      pd = (m2 - 1) / m2 * pd + 1 / m2 * pk;
      k[i] = pk; d[i] = pd; j[i] = 3 * pk - 2 * pd;
    }
    return { k: k, d: d, j: j };
  }
  function boll(close, n, k) {
    n = n || 20; k = k || 2;
    var mid = sma(close, n), up = new Array(close.length).fill(null), dn = new Array(close.length).fill(null);
    for (var i = 0; i < close.length; i++) {
      if (mid[i] == null) continue;
      var s = 0;
      for (var q = i - n + 1; q <= i; q++) s += Math.pow(close[q] - mid[i], 2);
      var sd = Math.sqrt(s / n);
      up[i] = mid[i] + k * sd; dn[i] = mid[i] - k * sd;
    }
    return { mid: mid, up: up, dn: dn };
  }
  // ---- 同花顺常见副图指标计算 ----
  function meanOf(a, f, t) {
    var s = 0;
    for (var i = f; i <= t; i++) s += a[i];
    return s / (t - f + 1);
  }
  // RSI(N) Wilder 平滑
  function rsi(close, n) {
    var out = new Array(close.length).fill(null), ag = 0, al = 0;
    for (var i = 1; i < close.length; i++) {
      var ch = close[i] - close[i - 1];
      var g = ch > 0 ? ch : 0, l = ch < 0 ? -ch : 0;
      if (i < n) { ag += g; al += l; continue; }
      if (i === n) { ag /= n; al /= n; }
      else { ag = (ag * (n - 1) + g) / n; al = (al * (n - 1) + l) / n; }
      if (al <= 0) al = 1e-9;
      out[i] = 100 - 100 / (1 + ag / al);
    }
    return out;
  }
  // CCI(N)：顺势指标
  function cci(h, l, c, n) {
    var out = new Array(c.length).fill(null);
    for (var i = n - 1; i < c.length; i++) {
      var tp = (h[i] + l[i] + c[i]) / 3, s = 0, s2 = 0;
      for (var q = i - n + 1; q <= i; q++) s += (h[q] + l[q] + c[q]) / 3;
      var ma = s / n;
      for (var q2 = i - n + 1; q2 <= i; q2++) s2 += Math.abs((h[q2] + l[q2] + c[q2]) / 3 - ma);
      var md = s2 / n;
      out[i] = md > 0 ? (tp - ma) / (0.015 * md) : 0;
    }
    return out;
  }
  // 威廉指标 WR(N)：越高越超卖
  function wr(h, l, c, n) {
    var out = new Array(c.length).fill(null);
    for (var i = n - 1; i < c.length; i++) {
      var hh = -Infinity, ll = Infinity;
      for (var q = i - n + 1; q <= i; q++) { if (h[q] > hh) hh = h[q]; if (l[q] < ll) ll = l[q]; }
      out[i] = hh === ll ? 50 : (hh - c[i]) / (hh - ll) * 100;
    }
    return out;
  }
  // 乖离率 BIAS(N)
  function bias(c, n) {
    var m = sma(c, n), out = new Array(c.length).fill(null);
    for (var i = 0; i < c.length; i++) if (m[i] != null && m[i] !== 0) out[i] = (c[i] - m[i]) / m[i] * 100;
    return out;
  }
  // 能量潮 OBV(+MA)
  function obv(c, v, n) {
    var o = new Array(c.length).fill(0);
    for (var i = 1; i < c.length; i++) {
      if (c[i] > c[i - 1]) o[i] = o[i - 1] + v[i];
      else if (c[i] < c[i - 1]) o[i] = o[i - 1] - v[i];
      else o[i] = o[i - 1];
    }
    return { obv: o, ma: sma(o, n || 30) };
  }
  // 趋向指标 DMI(N)
  function dmi(h, l, c, n) {
    n = n || 14;
    var pdm = new Array(c.length).fill(0), mdm = new Array(c.length).fill(0), tr = new Array(c.length).fill(0);
    for (var i = 1; i < c.length; i++) {
      var up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
      if (up > dn && up > 0) pdm[i] = up;
      if (dn > up && dn > 0) mdm[i] = dn;
      tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    }
    var pdi = new Array(c.length).fill(null), mdi = new Array(c.length).fill(null), dx = new Array(c.length).fill(null);
    for (var i = n - 1; i < c.length; i++) {
      var sp = 0, sm = 0, st = 0;
      for (var q = i - n + 1; q <= i; q++) { sp += pdm[q]; sm += mdm[q]; st += tr[q]; }
      if (st <= 0) continue;
      pdi[i] = 100 * sp / st; mdi[i] = 100 * sm / st;
      dx[i] = (pdi[i] + mdi[i]) > 0 ? 100 * Math.abs(pdi[i] - mdi[i]) / (pdi[i] + mdi[i]) : 0;
    }
    var adx = new Array(c.length).fill(null);
    for (var i = 2 * n - 2; i < c.length; i++) adx[i] = meanOf(dx, i - n + 1, i);
    var adxr = new Array(c.length).fill(null);
    for (var i = 2 * n - 2; i < c.length; i++) if (i >= n && adx[i - n] != null) adxr[i] = (adx[i] + adx[i - n]) / 2;
    return { pdi: pdi, mdi: mdi, adx: adx, adxr: adxr };
  }
  // 平均真实波幅 ATR(N)
  function atr(h, l, c, n) {
    n = n || 14;
    var tr = new Array(c.length).fill(0), out = new Array(c.length).fill(null);
    for (var i = 1; i < c.length; i++) tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    for (var i = n; i < c.length; i++) out[i] = meanOf(tr, i - n + 1, i);
    return out;
  }
  // ROC(N,M)：变动率
  function roc(c, n, m) {
    n = n || 12; m = m || 6;
    var r = new Array(c.length).fill(null);
    for (var i = n; i < c.length; i++) if (c[i - n] !== 0) r[i] = (c[i] - c[i - n]) / c[i - n] * 100;
    return { roc: r, ma: smaAfter(r, n, m) };
  }
  // MTM(N,M)：动量线
  function mtm(c, n, m) {
    n = n || 12; m = m || 6;
    var r = new Array(c.length).fill(null);
    for (var i = n; i < c.length; i++) r[i] = c[i] - c[i - n];
    return { mtm: r, ma: smaAfter(r, n, m) };
  }
  // VR(N,M)：成交量变异率
  function vr(c, v, n, m) {
    n = n || 26; m = m || 6;
    var r = new Array(c.length).fill(null);
    for (var i = n; i < c.length; i++) {
      var a = 0, b = 0, cc = 0;
      for (var q = i - n + 1; q <= i; q++) {
        if (c[q] > c[q - 1]) a += v[q];
        else if (c[q] < c[q - 1]) cc += v[q];
        else b += v[q];
      }
      var den = cc + b / 2;
      r[i] = den > 0 ? (a + b / 2) / den * 100 : 100;
    }
    return { vr: r, ma: smaAfter(r, n, m) };
  }
  // PSY(N,M)：心理线
  function psy(c, n, m) {
    n = n || 12; m = m || 6;
    var r = new Array(c.length).fill(null);
    for (var i = n; i < c.length; i++) {
      var up = 0;
      for (var q = i - n + 1; q <= i; q++) if (c[q] > c[q - 1]) up++;
      r[i] = up / n * 100;
    }
    return { psy: r, ma: smaAfter(r, n, m) };
  }

  // ---------- 主题 ----------
  var T = {
    bg: '#0d1117', panel: '#0d1117', grid: '#1c2128', text: '#8b949e', textHi: '#e6edf3',
    up: '#ef4444', dn: '#22c55e', upFill: '#ef4444', dnFill: '#22c55e',
    cross: '#6e7681', ma5: '#f0b90b', ma10: '#3b82f6', ma20: '#a855f7', ma60: '#ec4899',
    boll: '#64748b', vol: '#6e7681', dif: '#f0b90b', dea: '#3b82f6', kc: '#f0b90b', dc: '#3b82f6', jc: '#ec4899',
    rsi6: '#f0b90b', rsi12: '#3b82f6', rsi24: '#a855f7',
    cci: '#f0b90b', wr1: '#f0b90b', wr2: '#ec4899',
    bias6: '#f0b90b', bias12: '#3b82f6', bias24: '#a855f7',
    obv: '#f0b90b', obvma: '#3b82f6',
    pdi: '#f0b90b', mdi: '#3b82f6', adx: '#a855f7', adxr: '#ec4899',
    atr: '#f0b90b', roc: '#f0b90b', rocma: '#3b82f6',
    mtm: '#f0b90b', mtmma: '#3b82f6', vr: '#f0b90b', vrma: '#a855f7',
    psy: '#f0b90b', psyma: '#3b82f6'
  };

  function fmt(n, dec) {
    if (n == null || isNaN(n)) return '--';
    return Number(n).toFixed(dec == null ? 2 : dec);
  }
  function fmtVol(v) {
    if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
    if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
    return String(Math.round(v));
  }

  // ---------- K线图 ----------
  function KChart(canvas, opts) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = Object.assign({ subs: ['vol', 'macd', 'kdj'], showBoll: true, showMa: true }, opts || {});
    this.data = null;
    this.endIdx = 0;
    this.maxIdx = 0;       // 可见上界（防未来函数）：只渲染 <= 当前游戏日的数据
    this.viewBars = 120;
    this.cross = null;      // {x, y}
    this.hoverIdx = -1;
    this.padL = 8; this.padR = 62; this.padT = 18; this.padB = 20;
    this._bind();
  }

  KChart.prototype._fireView = function () {
    if (this.opts.onView) this.opts.onView(this.viewBars, this.data ? this.data.d[this.endIdx] : null);
  };
  KChart.prototype._bind = function () {
    // 游戏内图表始终以「当前游戏日」为最右端（最右永远=今日），不做拖动平移，仅保留滚轮缩放与双击复位
    var self = this;
    this.cv.addEventListener('mousemove', function (e) {
      var r = self.cv.getBoundingClientRect();
      self.cross = { x: e.clientX - r.left, y: e.clientY - r.top };
      self.draw();
    });
    this.cv.addEventListener('mouseleave', function () { self.cross = null; self.draw(); });
    this.cv.addEventListener('wheel', function (e) {
      e.preventDefault();
      self.viewBars = Math.max(10, Math.min(500, Math.round(self.viewBars * (e.deltaY > 0 ? 1.12 : 0.89))));
      self._fireView(); self.draw();
    }, { passive: false });
    this.cv.addEventListener('dblclick', function () { self.viewBars = 120; self._fireView(); self.draw(); });
  };

  KChart.prototype._plotW = function () { return (this.cssW != null ? this.cssW : this.cv.width / (window.devicePixelRatio || 1)) - this.padL - this.padR; };
  KChart.prototype._maxIdx = function () { return this.data ? this.data.c.length - 1 : 0; };

  KChart.prototype.setData = function (stock, endIdx) {
    this.data = stock;
    this.endIdx = endIdx != null ? endIdx : stock.c.length - 1;
    this.maxIdx = this.endIdx;   // 当前游戏日即为可见上界，禁止滑向未来
    this.draw();
  };
  KChart.prototype.setEndIdx = function (i) { this.endIdx = i; this.draw(); };

  KChart.prototype.resize = function (w, h) {
    var dpr = window.devicePixelRatio || 1;
    this.cv.width = w * dpr; this.cv.height = h * dpr;
    this.cv.style.width = w + 'px'; this.cv.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cssW = w; this.cssH = h;
    this.draw();
  };

  KChart.prototype.draw = function () {
    var ctx = this.ctx, d = this.data, W = this.cssW || this.cv.width, H = this.cssH || this.cv.height;
    if (!d) return;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = T.bg; ctx.fillRect(0, 0, W, H);

    var nSub = this.opts.subs.length;
    var totalH = H - this.padT - this.padB;
    // 主图高度随副图数量收缩：副图越多主图让出越多空间，但主图始终 ≥50%
    var mainR = nSub === 0 ? 1 : nSub <= 2 ? 0.66 : nSub <= 4 ? 0.58 : 0.5;
    var mainH = Math.round(totalH * mainR);
    var subH = nSub ? Math.max(24, Math.round((totalH - mainH - 4 * (nSub - 1)) / nSub)) : 0;
    var pw = this._plotW();

    var start = Math.max(0, this.endIdx - this.viewBars + 1);
    var end = Math.min(this.maxIdx, this.endIdx);
    var cnt = end - start + 1;
    if (cnt <= 1) return;

    // 价格范围
    var hi = -Infinity, lo = Infinity;
    for (var i = start; i <= end; i++) {
      if (d.h[i] > hi) hi = d.h[i];
      if (d.l[i] < lo) lo = d.l[i];
    }
    var ma5 = sma(d.c, 5), ma10 = sma(d.c, 10), ma20 = sma(d.c, 20), ma60 = sma(d.c, 60);
    var bl = this.opts.showBoll ? boll(d.c, 20, 2) : null;
    [ma5, ma10, ma20, ma60].forEach(function (m) {
      if (!this.opts.showMa) return;
      for (var i = start; i <= end; i++) if (m[i] != null) { if (m[i] > hi) hi = m[i]; if (m[i] < lo) lo = m[i]; }
    }, this);
    if (bl) for (var i = start; i <= end; i++) {
      if (bl.up[i] != null) { if (bl.up[i] > hi) hi = bl.up[i]; if (bl.dn[i] < lo) lo = bl.dn[i]; }
    }
    var padY = (hi - lo) * 0.06; hi += padY; lo -= padY;

    var mainTop = this.padT, mainBot = this.padT + mainH;
    // 记录当前价格轴（供筹码峰对齐使用）
    this._lo = lo; this._hi = hi; this._priceTop = mainTop; this._priceBot = mainBot;
    var x0 = this.padL, bw = pw / cnt, cw = Math.max(1, bw * 0.68);
    var py = function (p) { return mainBot - (p - lo) / (hi - lo) * mainH; };
    var px = function (i) { return x0 + (i - start) * bw + bw / 2; };

    // 网格 + 价格轴
    ctx.font = '11px ui-monospace, Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = T.grid; ctx.lineWidth = 1;
    ctx.fillStyle = T.text; ctx.textAlign = 'left';
    for (var g = 0; g <= 4; g++) {
      var yy = mainTop + mainH * g / 4, pv = hi - (hi - lo) * g / 4;
      ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x0 + pw, yy); ctx.stroke();
      ctx.fillText(fmt(pv), x0 + pw + 5, yy);
    }

    // 蜡烛
    for (var i = start; i <= end; i++) {
      var up = d.c[i] >= d.o[i], col = up ? T.up : T.dn;
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
      var cx = px(i);
      ctx.beginPath(); ctx.moveTo(cx, py(d.h[i])); ctx.lineTo(cx, py(d.l[i])); ctx.stroke();
      var yo = py(d.o[i]), yc = py(d.c[i]);
      var top = Math.min(yo, yc), hgt = Math.max(Math.abs(yc - yo), 1);
      ctx.fillRect(cx - cw / 2, top, cw, hgt);
    }

    // MA / BOLL
    var line = function (arr, color, dash) {
      ctx.strokeStyle = color; ctx.lineWidth = 1.2;
      ctx.setLineDash(dash || []);
      ctx.beginPath(); var started = false;
      for (var i = start; i <= end; i++) {
        if (arr[i] == null) continue;
        if (!started) { ctx.moveTo(px(i), py(arr[i])); started = true; }
        else ctx.lineTo(px(i), py(arr[i]));
      }
      ctx.stroke(); ctx.setLineDash([]);
    };
    if (this.opts.showMa) { line(ma5, T.ma5); line(ma10, T.ma10); line(ma20, T.ma20); line(ma60, T.ma60); }
    if (bl) { line(bl.up, T.boll, [3, 3]); line(bl.mid, T.boll, [3, 3]); line(bl.dn, T.boll, [3, 3]); }

    // 日期轴（每隔若干根；右端=当前游戏日必标注，且右对齐贴右边界避免溢出被裁）
    ctx.fillStyle = T.text; ctx.textBaseline = 'top';
    var step = Math.max(1, Math.floor(cnt / 6));
    var first = start + ((end - start) % step);   // 让 end(当前日) 一定落在标注序列
    // 最左端那根 bar(start) 始终贴左边界标注，避免“第一根 K 线无角标/角标悬空在离边缘约 step 处”的错觉
    if (first !== start) { ctx.textAlign = 'left'; ctx.fillText(this._dateLabel(start), x0, H - this.padB + 3); }
    for (var i = first; i <= end; i += step) {
      if (i === end) { ctx.textAlign = 'right'; ctx.fillText(this._dateLabel(i), x0 + pw, H - this.padB + 3); }
      else { ctx.textAlign = 'center'; ctx.fillText(this._dateLabel(i), px(i), H - this.padB + 3); }
    }

    // 副图
    for (var s = 0; s < nSub; s++) {
      var st = mainBot + (s === 0 ? 6 : 0) + s * subH;
      this._drawSub(this.opts.subs[s], d, start, end, x0, pw, st, Math.max(20, subH - 8), bw, px);
    }

    // 顶部信息
    var last = end, prev = Math.max(0, last - 1);
    var chg = prev >= 0 && d.c[prev] ? (d.c[last] - d.c[prev]) / d.c[prev] * 100 : 0;
    var ds2 = String(d.d[last]);
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.font = 'bold 12px ui-monospace, Consolas, monospace';
    ctx.fillStyle = T.textHi;
    ctx.fillText((this.opts.title || (d.name || '') + ' ' + (d.code || '')), x0, 2);
    ctx.font = '11px ui-monospace, Consolas, monospace';
    var col = chg >= 0 ? T.up : T.dn;
    ctx.fillStyle = col;
    ctx.fillText('开' + fmt(d.o[last]) + ' 高' + fmt(d.h[last]) + ' 低' + fmt(d.l[last]) +
                 ' 收' + fmt(d.c[last]) + '  ' + (chg >= 0 ? '+' : '') + fmt(chg, 2) + '%', x0 + 150, 3);

    // 十字光标
    if (this.cross && this.cross.x >= x0 && this.cross.x <= x0 + pw) {
      var idx = Math.round(start + (this.cross.x - x0 - bw / 2) / bw);
      idx = Math.max(start, Math.min(end, idx));
      var cx2 = px(idx);
      ctx.strokeStyle = T.cross; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx2, mainTop); ctx.lineTo(cx2, H - this.padB); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x0, this.cross.y); ctx.lineTo(x0 + pw, this.cross.y); ctx.stroke();
      ctx.setLineDash([]);
      // 光标价格
      if (this.cross.y >= mainTop && this.cross.y <= mainBot) {
        var cp = hi - (this.cross.y - mainTop) / mainH * (hi - lo);
        ctx.fillStyle = '#30363d'; ctx.fillRect(x0 + pw + 2, this.cross.y - 8, this.padR - 4, 16);
        ctx.fillStyle = T.textHi; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(fmt(cp), x0 + pw + 5, this.cross.y);
      }
      // 悬浮信息框
      var info = [this._dateLabelFull(idx)];
      info.push('开' + fmt(d.o[idx]) + ' 收' + fmt(d.c[idx]));
      info.push('高' + fmt(d.h[idx]) + ' 低' + fmt(d.l[idx]));
      info.push('量' + fmtVol(d.v[idx]));
      if (d.t && d.t[idx] != null) info.push('换' + fmt(d.t[idx], 2) + '%');
      ctx.font = '11px ui-monospace, Consolas, monospace';
      var bw2 = 112, bh2 = info.length * 14 + 8;
      // 光标在绘图区右半边 → 信息框翻到光标左侧；否则放右侧；硬性夹紧在绘图区内不溢出
      var bx = (cx2 - x0 > pw / 2) ? (cx2 - bw2 - 10) : (cx2 + 10);
      bx = Math.max(x0, Math.min(bx, x0 + pw - bw2));
      var by = Math.max(mainTop + 4, Math.min(this.cross.y - bh2 / 2, mainBot - bh2 - 4));
      ctx.fillStyle = 'rgba(22,27,34,0.94)'; ctx.fillRect(bx, by, bw2, bh2);
      ctx.strokeStyle = '#30363d'; ctx.strokeRect(bx, by, bw2, bh2);
      ctx.fillStyle = T.textHi; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      info.forEach(function (t, k) { ctx.fillText(t, bx + 6, by + 4 + k * 14); });
      this.hoverIdx = idx;
    } else this.hoverIdx = -1;
  };

  // 日期标签：opts.baseIdx = 当前游戏日下标（最右永远=今日），向左 T-1/T-2 递减
  KChart.prototype._dateLabel = function (i) {
    var s = String(this.data.d[i]);
    if (this.opts.baseIdx == null) return s.slice(4, 6) + '/' + s.slice(6, 8);
    var rel = i - this.opts.baseIdx;
    if (rel === 0) return '今日';
    return rel < 0 ? ('T' + rel) : ('T+' + rel);
  };
  KChart.prototype._dateLabelFull = function (i) {
    var s = String(this.data.d[i]);
    if (this.opts.baseIdx == null) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
    var rel = i - this.opts.baseIdx;
    if (rel === 0) return '今日';
    return rel < 0 ? ('T' + rel) : ('T+' + rel);
  };

  // 副图小标题（同花顺式：指标名 + 当前值），放在副图窗口内顶部
  function subTitle(kind) {
    var names = {
      vol: 'VOL', macd: 'MACD(12,26,9)', kdj: 'KDJ(9,3,3)', rsi: 'RSI(6,12,24)',
      cci: 'CCI(14)', wr: 'WR(10,6)', bias: 'BIAS(6,12,24)', obv: 'OBV(30)',
      dmi: 'DMI(14)', atr: 'ATR(14)', roc: 'ROC(12,6)', mtm: 'MTM(12,6)',
      vr: 'VR(26,6)', psy: 'PSY(12,6)'
    };
    return names[kind] || kind.toUpperCase();
  }

  KChart.prototype._drawSub = function (kind, d, start, end, x0, pw, top, h, bw, px) {
    var ctx = this.ctx;
    // 顶部边框线
    ctx.strokeStyle = T.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, top); ctx.lineTo(x0 + pw, top); ctx.stroke();
    ctx.font = '10px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';

    // 窗口标题行：指标名 + 指标当前值（默认 dim）
    var title = subTitle(kind);
    var titleX = x0 + 4, titleY = top + 1;

    // 统一的绘图基线
    var pTop = top + 14, pH = Math.max(12, h - 16);   // 标题区约占 14px

    var yLine = function (arr, color, yOf, dash) {
      ctx.strokeStyle = color; ctx.lineWidth = 1.1;
      ctx.setLineDash(dash || []);
      ctx.beginPath(); var st = false;
      for (var i = start; i <= end; i++) {
        if (arr[i] == null) continue;
        if (!st) { ctx.moveTo(px(i), yOf(arr[i])); st = true; }
        else ctx.lineTo(px(i), yOf(arr[i]));
      }
      ctx.stroke(); ctx.setLineDash([]);
    };
    var hRef = function (vv, color, dash) {
      ctx.strokeStyle = color || '#30363d'; ctx.lineWidth = 1;
      ctx.setLineDash(dash || [3, 3]);
      ctx.beginPath(); ctx.moveTo(x0, vv); ctx.lineTo(x0 + pw, vv); ctx.stroke();
      ctx.setLineDash([]);
    };

    if (kind === 'vol') {
      var vmax = 0;
      for (var i = start; i <= end; i++) if (d.v[i] > vmax) vmax = d.v[i];
      if (vmax <= 0) vmax = 1;
      var vBot = top + h - 2;
      var vH = Math.max(10, vBot - pTop);
      for (var i = start; i <= end; i++) {
        var up = d.c[i] >= d.o[i];
        ctx.fillStyle = up ? T.up : T.dn;
        var hh = Math.max(1, d.v[i] / vmax * vH);
        ctx.fillRect(px(i) - bw * 0.34, vBot - hh, bw * 0.68, hh);
      }
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  ' + fmtVol(d.v[end]), titleX, titleY);
    } else if (kind === 'macd') {
      var m = macd(d.c, 12, 26, 9);
      var mx = 0;
      for (var i = start; i <= end; i++) {
        [m.dif[i], m.dea[i], m.bar[i]].forEach(function (v) { if (v != null && Math.abs(v) > mx) mx = Math.abs(v); });
      }
      if (mx <= 0) mx = 1;
      var mY = function (v) { return pTop + pH / 2 - v / mx * (pH / 2); };
      var zero = mY(0);
      ctx.strokeStyle = '#30363d'; ctx.beginPath(); ctx.moveTo(x0, zero); ctx.lineTo(x0 + pw, zero); ctx.stroke();
      for (var i = start; i <= end; i++) {
        if (m.bar[i] == null) continue;
        ctx.fillStyle = m.bar[i] >= 0 ? T.up : T.dn;
        var y = mY(m.bar[i]);
        ctx.fillRect(px(i) - bw * 0.3, Math.min(y, zero), bw * 0.6, Math.max(1, Math.abs(y - zero)));
      }
      yLine(m.dif, T.dif, mY); yLine(m.dea, T.dea, mY);
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  DIF:' + fmt(m.dif[end], 3) + '  DEA:' + fmt(m.dea[end], 3), titleX, titleY);
    } else if (kind === 'kdj') {
      var k = kdj(d.h, d.l, d.c, 9, 3, 3);
      var kY = function (v) { return pTop + pH - (Math.max(-20, Math.min(120, v)) + 20) / 140 * pH; };
      hRef(pTop + pH * 0.2); hRef(pTop + pH * 0.8);
      yLine(k.k, T.kc, kY); yLine(k.d, T.dc, kY); yLine(k.j, T.jc, kY);
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  K:' + fmt(k.k[end], 1) + '  D:' + fmt(k.d[end], 1) + '  J:' + fmt(k.j[end], 1), titleX, titleY);
    } else if (kind === 'rsi') {
      var r6 = rsi(d.c, 6), r12 = rsi(d.c, 12), r24 = rsi(d.c, 24);
      var rY = function (v) { return pTop + pH - Math.max(0, Math.min(100, v)) / 100 * pH; };
      hRef(pTop + pH * 0.2, '#30363d'); hRef(pTop + pH * 0.8, '#30363d');   // 20/80 参考
      yLine(r6, T.rsi6, rY); yLine(r12, T.rsi12, rY); yLine(r24, T.rsi24, rY);
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  ' + fmt(r6[end], 1) + '/' + fmt(r12[end], 1) + '/' + fmt(r24[end], 1), titleX, titleY);
    } else if (kind === 'cci') {
      var cc = cci(d.h, d.l, d.c, 14);
      var cm = 0;
      for (var i = start; i <= end; i++) if (cc[i] != null && Math.abs(cc[i]) > cm) cm = Math.abs(cc[i]);
      cm = Math.max(cm, 100);
      var cY = function (v) { return pTop + pH / 2 - v / cm * (pH / 2); };
      ctx.strokeStyle = '#30363d'; ctx.beginPath(); ctx.moveTo(x0, cY(0)); ctx.lineTo(x0 + pw, cY(0)); ctx.stroke();
      hRef(cY(100)); hRef(cY(-100));
      yLine(cc, T.cci, cY);
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  ' + fmt(cc[end], 1), titleX, titleY);
    } else if (kind === 'wr') {
      var w1 = wr(d.h, d.l, d.c, 10), w2 = wr(d.h, d.l, d.c, 6);
      var wY = function (v) { return pTop + pH - Math.max(0, Math.min(100, v)) / 100 * pH; };
      hRef(pTop + pH * 0.2); hRef(pTop + pH * 0.8);   // 20(超买)/80(超卖) 参考
      yLine(w1, T.wr1, wY); yLine(w2, T.wr2, wY);
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  ' + fmt(w1[end], 1) + '/' + fmt(w2[end], 1), titleX, titleY);
    } else if (kind === 'bias') {
      var b6 = bias(d.c, 6), b12 = bias(d.c, 12), b24 = bias(d.c, 24);
      var bm = 0;
      for (var i = start; i <= end; i++) {
        [b6[i], b12[i], b24[i]].forEach(function (v) { if (v != null && Math.abs(v) > bm) bm = Math.abs(v); });
      }
      bm = Math.max(bm, 2);
      var bY = function (v) { return pTop + pH / 2 - v / bm * (pH / 2); };
      ctx.strokeStyle = '#30363d'; ctx.beginPath(); ctx.moveTo(x0, bY(0)); ctx.lineTo(x0 + pw, bY(0)); ctx.stroke();
      yLine(b6, T.bias6, bY); yLine(b12, T.bias12, bY); yLine(b24, T.bias24, bY);
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  ' + fmt(b6[end], 2) + '/' + fmt(b12[end], 2) + '/' + fmt(b24[end], 2), titleX, titleY);
    } else if (kind === 'obv') {
      var o = obv(d.c, d.v, 30);
      var oLo = 0, oHi = 0;
      for (var i = start; i <= end; i++) {
        if (o.obv[i] > oHi) oHi = o.obv[i];
        if (o.obv[i] < oLo) oLo = o.obv[i];
        if (o.ma[i] != null) { if (o.ma[i] > oHi) oHi = o.ma[i]; if (o.ma[i] < oLo) oLo = o.ma[i]; }
      }
      if (oHi === oLo) { oHi = oLo + 1; }
      var oY = function (v) { return pTop + (oHi - v) / (oHi - oLo) * pH; };
      yLine(o.obv, T.obv, oY); yLine(o.ma, T.obvma, oY);
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  ' + fmtBig(o.obv[end]), titleX, titleY);
    } else if (kind === 'dmi') {
      var dm = dmi(d.h, d.l, d.c, 14);
      var dY = function (v) { return pTop + pH - Math.max(0, Math.min(100, v)) / 100 * pH; };
      yLine(dm.pdi, T.pdi, dY); yLine(dm.mdi, T.mdi, dY);
      yLine(dm.adx, T.adx, dY); yLine(dm.adxr, T.adxr, dY);
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  PDI:' + fmt(dm.pdi[end], 1) + '  MDI:' + fmt(dm.mdi[end], 1) +
        '  ADX:' + fmt(dm.adx[end], 1), titleX, titleY);
    } else if (kind === 'atr') {
      var at = atr(d.h, d.l, d.c, 14);
      var am = 0;
      for (var i = start; i <= end; i++) if (at[i] != null && at[i] > am) am = at[i];
      if (am <= 0) am = 1;
      var aY = function (v) { return pTop + pH - v / am * pH; };
      yLine(at, T.atr, aY);
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  ' + fmt(at[end], 2), titleX, titleY);
    } else if (kind === 'roc') {
      var rc = roc(d.c, 12, 6);
      var rm = 0;
      for (var i = start; i <= end; i++) {
        if (rc.roc[i] != null && Math.abs(rc.roc[i]) > rm) rm = Math.abs(rc.roc[i]);
      }
      rm = Math.max(rm, 1);
      var rcY = function (v) { return pTop + pH / 2 - v / rm * (pH / 2); };
      ctx.strokeStyle = '#30363d'; ctx.beginPath(); ctx.moveTo(x0, rcY(0)); ctx.lineTo(x0 + pw, rcY(0)); ctx.stroke();
      yLine(rc.roc, T.roc, rcY); yLine(rc.ma, T.rocma, rcY);
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  ' + fmt(rc.roc[end], 2), titleX, titleY);
    } else if (kind === 'mtm') {
      var mm = mtm(d.c, 12, 6);
      var mmm = 0;
      for (var i = start; i <= end; i++) {
        if (mm.mtm[i] != null && Math.abs(mm.mtm[i]) > mmm) mmm = Math.abs(mm.mtm[i]);
      }
      mmm = Math.max(mmm, 0.01);
      var mmY = function (v) { return pTop + pH / 2 - v / mmm * (pH / 2); };
      ctx.strokeStyle = '#30363d'; ctx.beginPath(); ctx.moveTo(x0, mmY(0)); ctx.lineTo(x0 + pw, mmY(0)); ctx.stroke();
      yLine(mm.mtm, T.mtm, mmY); yLine(mm.ma, T.mtmma, mmY);
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  ' + fmt(mm.mtm[end], 2), titleX, titleY);
    } else if (kind === 'vr') {
      var vv = vr(d.c, d.v, 26, 6);
      var vrm = 0;
      for (var i = start; i <= end; i++) if (vv.vr[i] != null && vv.vr[i] > vrm) vrm = vv.vr[i];
      vrm = Math.max(vrm, 100);
      var vrY = function (v) { return pTop + pH - Math.max(0, v) / vrm * pH; };
      yLine(vv.vr, T.vr, vrY); yLine(vv.ma, T.vrma, vrY);
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  ' + fmt(vv.vr[end], 0), titleX, titleY);
    } else if (kind === 'psy') {
      var ps = psy(d.c, 12, 6);
      var pY = function (v) { return pTop + pH - Math.max(0, Math.min(100, v)) / 100 * pH; };
      hRef(pTop + pH * 0.5, '#30363d'); hRef(pTop + pH * 0.25); hRef(pTop + pH * 0.75);
      yLine(ps.psy, T.psy, pY); yLine(ps.ma, T.psyma, pY);
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  ' + fmt(ps.psy[end], 0), titleX, titleY);
    }
  };

  // 大整数紧凑格式化（OBV 等累计量）
  function fmtBig(n) {
    if (n == null || isNaN(n)) return '--';
    var neg = n < 0 ? '-' : '';
    var a = Math.abs(n);
    if (a >= 1e8) return neg + (a / 1e8).toFixed(2) + '亿';
    if (a >= 1e4) return neg + (a / 1e4).toFixed(1) + '万';
    return neg + Math.round(a);
  }

  // ---------- 筹码峰（横向，与主图价格轴对齐） ----------
  function ChipChart(canvas) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.data = null; this.date = null; this.cssW = 0; this.cssH = 0;
    this.hideDate = false;
  }
  ChipChart.prototype.resize = function (w, h) {
    var dpr = window.devicePixelRatio || 1;
    this.cv.width = w * dpr; this.cv.height = h * dpr;
    this.cv.style.width = w + 'px'; this.cv.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cssW = w; this.cssH = h; this.draw();
  };
  ChipChart.prototype.setData = function (code, date, priceRect) {
    var all = (global.GAME_CHIPS || {}).stocks || {};
    this.data = all[code] || null;
    this.date = date;
    this.priceRect = priceRect || null;   // {lo,hi,top,bot} 与 K 线主图价格轴对齐
    this.draw();
  };
  ChipChart.prototype.draw = function () {
    var ctx = this.ctx, W = this.cssW, H = this.cssH;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = T.panel; ctx.fillRect(0, 0, W, H);
    ctx.font = '10px ui-monospace, Consolas, monospace';
    if (!this.data) { ctx.fillStyle = T.text; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('筹码峰', 4, 2); return; }
    var frames = this.data.frames, keys = Object.keys(frames);
    var lastKey = keys[0];
    for (var i = 0; i < keys.length; i++) { if (Number(keys[i]) <= Number(this.date)) lastKey = keys[i]; }
    ctx.fillStyle = T.text; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('筹码峰' + (this.hideDate ? '' : ' ' + lastKey), 4, 2);

    var frame = frames[lastKey];
    var bins = this.data.bins;
    var maxPct = Math.max.apply(null, frame);
    if (maxPct <= 0) maxPct = 1;

    var pr = this.priceRect;
    if (!pr || !(pr.hi > pr.lo)) {
      // 退化模式：未提供价格轴对齐信息时均匀铺满
      var padT = 16, padB = 16, h = H - padT - padB;
      var barH = h / bins.length;
      for (var i = 0; i < bins.length; i++) {
        var w0 = frame[i] / maxPct * (W - 46);
        var y0 = padT + (bins.length - 1 - i) * barH;
        ctx.fillStyle = '#3b82f6';
        ctx.globalAlpha = 0.55 + frame[i] / maxPct * 0.45;
        ctx.fillRect(4, y0, Math.max(0, w0), Math.max(1, barH - 1));
        ctx.globalAlpha = 1;
        if (i % 12 === 0) {
          ctx.fillStyle = T.text; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          ctx.fillText(bins[i].toFixed(0), W - 40, y0 + barH / 2);
        }
      }
      return;
    }

    // 与 K 线主图价格轴对齐：相同价格映射到相同 y
    var lo = pr.lo, hi = pr.hi, top = pr.top, bot = pr.bot;
    var yOf = function (p) { return bot - (p - lo) / (hi - lo) * (bot - top); };
    var barMaxW = W - 56;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, top, W, bot - top); ctx.clip();
    for (var i = 0; i < bins.length; i++) {
      var p = bins[i];
      if (p < lo || p > hi) continue;
      var step = (i < bins.length - 1) ? (bins[i + 1] - bins[i]) : (bins[i] - bins[i - 1]);
      if (!(step > 0)) step = (hi - lo) / 30;
      var yT = yOf(p + step / 2), yB = yOf(p - step / 2);
      var w1 = frame[i] / maxPct * barMaxW;
      ctx.fillStyle = '#3b82f6';
      ctx.globalAlpha = 0.55 + frame[i] / maxPct * 0.45;
      ctx.fillRect(4, yT, Math.max(0, w1), Math.max(1, yB - yT));
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    // 价格刻度（右侧，与 K 线价格轴同尺度）
    ctx.fillStyle = T.text; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (var g = 0; g <= 4; g++) {
      var yy = top + (bot - top) * g / 4;
      var pv = hi - (hi - lo) * g / 4;
      ctx.fillText(pv.toFixed(2), W - 4, yy);
    }
  };

  global.ChartEng = {
    KChart: KChart, ChipChart: ChipChart,
    sma: sma, ema: ema, macd: macd, kdj: kdj, boll: boll,
    rsi: rsi, cci: cci, wr: wr, bias: bias, obv: obv, dmi: dmi,
    atr: atr, roc: roc, mtm: mtm, vr: vr, psy: psy,
    fmtBig: fmtBig, subTitle: subTitle, theme: T
  };
})(window);
