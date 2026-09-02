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

  // ---------- 主题 ----------
  var T = {
    bg: '#0d1117', panel: '#0d1117', grid: '#1c2128', text: '#8b949e', textHi: '#e6edf3',
    up: '#ef4444', dn: '#22c55e', upFill: '#ef4444', dnFill: '#22c55e',
    cross: '#6e7681', ma5: '#f0b90b', ma10: '#3b82f6', ma20: '#a855f7', ma60: '#ec4899',
    boll: '#64748b', vol: '#6e7681', dif: '#f0b90b', dea: '#3b82f6', kc: '#f0b90b', dc: '#3b82f6', jc: '#ec4899'
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
    var mainH = Math.round(totalH * (nSub ? 0.62 : 1));
    var subH = nSub ? Math.round((totalH - mainH) / nSub) : 0;
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

  KChart.prototype._drawSub = function (kind, d, start, end, x0, pw, top, h, bw, px) {
    var ctx = this.ctx;
    ctx.font = '10px ui-monospace, Consolas, monospace';
    ctx.strokeStyle = T.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, top); ctx.lineTo(x0 + pw, top); ctx.stroke();
    ctx.fillStyle = T.text; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    if (kind === 'vol') {
      var vmax = 0;
      for (var i = start; i <= end; i++) if (d.v[i] > vmax) vmax = d.v[i];
      if (vmax <= 0) vmax = 1;
      for (var i = start; i <= end; i++) {
        var up = d.c[i] >= d.o[i];
        ctx.fillStyle = up ? T.up : T.dn;
        var hh = Math.max(1, d.v[i] / vmax * h);
        ctx.fillRect(px(i) - bw * 0.34, top + h - hh, bw * 0.68, hh);
      }
      ctx.fillText('VOL ' + fmtVol(d.v[end]), x0 + 2, top + 2);
    } else if (kind === 'macd') {
      var m = macd(d.c, 12, 26, 9);
      var mx = 0;
      for (var i = start; i <= end; i++) {
        [m.dif[i], m.dea[i], m.bar[i]].forEach(function (v) { if (v != null && Math.abs(v) > mx) mx = Math.abs(v); });
      }
      if (mx <= 0) mx = 1;
      var my = function (v) { return top + h / 2 - v / mx * (h / 2 - 2); };
      var zero = my(0);
      ctx.strokeStyle = '#30363d'; ctx.beginPath(); ctx.moveTo(x0, zero); ctx.lineTo(x0 + pw, zero); ctx.stroke();
      for (var i = start; i <= end; i++) {
        if (m.bar[i] == null) continue;
        ctx.fillStyle = m.bar[i] >= 0 ? T.up : T.dn;
        var y = my(m.bar[i]);
        ctx.fillRect(px(i) - bw * 0.3, Math.min(y, zero), bw * 0.6, Math.max(1, Math.abs(y - zero)));
      }
      var ln = function (arr, c) {
        ctx.strokeStyle = c; ctx.lineWidth = 1.1; ctx.beginPath(); var st = false;
        for (var i = start; i <= end; i++) {
          if (arr[i] == null) continue;
          if (!st) { ctx.moveTo(px(i), my(arr[i])); st = true; } else ctx.lineTo(px(i), my(arr[i]));
        }
        ctx.stroke();
      };
      ln(m.dif, T.dif); ln(m.dea, T.dea);
      ctx.fillStyle = T.text;
      ctx.fillText('MACD(12,26,9) DIF ' + fmt(m.dif[end], 3) + ' DEA ' + fmt(m.dea[end], 3), x0 + 2, top + 2);
    } else if (kind === 'kdj') {
      var k = kdj(d.h, d.l, d.c, 9, 3, 3);
      var ky = function (v) { return top + h - (Math.max(-20, Math.min(120, v)) + 20) / 140 * h; };
      var ln2 = function (arr, c) {
        ctx.strokeStyle = c; ctx.lineWidth = 1.1; ctx.beginPath(); var st = false;
        for (var i = start; i <= end; i++) {
          if (arr[i] == null) continue;
          if (!st) { ctx.moveTo(px(i), ky(arr[i])); st = true; } else ctx.lineTo(px(i), ky(arr[i]));
        }
        ctx.stroke();
      };
      ln2(k.k, T.kc); ln2(k.d, T.dc); ln2(k.j, T.jc);
      ctx.fillStyle = T.text;
      ctx.fillText('KDJ(9,3,3) K ' + fmt(k.k[end], 1) + ' D ' + fmt(k.d[end], 1) + ' J ' + fmt(k.j[end], 1), x0 + 2, top + 2);
    }
  };

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
    sma: sma, ema: ema, macd: macd, kdj: kdj, boll: boll, theme: T
  };
})(window);
