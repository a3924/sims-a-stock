/* app.js — 《我的模拟人生·A股版》游戏逻辑
 * 依赖: window.GAME_KLINE / GAME_INDEX / GAME_ETF / GAME_CHIPS / GAME_NEWS / ChartEng
 */
(function (global) {
  'use strict';

  var KL = global.GAME_KLINE, IX = global.GAME_INDEX,
      CH = global.GAME_CHIPS, NW = global.GAME_NEWS || { market: [], stocks: {} };
  var OV = global.GAME_OAMV ? global.GAME_OAMV.series : null;
  var ET = global.GAME_ETF ? global.GAME_ETF.etfs : {};
  // 把 20 只 ETF 注入股票池（cat='etf'），pickPool 每局抽 3 只与股票同场交易
  Object.keys(ET).forEach(function (c) { if (!KL.stocks[c]) KL.stocks[c] = ET[c]; });
  var DAYS = IX.sh_index.d;                 // 全局日期轴（交易日）
  var TOTAL_BARS = DAYS.length;
  var GAME_BARS = 242;                      // 一局约365自然日
  var INIT_CASH = 200000;                   // 统一20万本金
  var RF = 0.02;                            // 无风险年化2%

  var IDX_OPTIONS = [
    { k: 'sh_index', n: '上证指数' }, { k: 'sz_index', n: '深证成指' },
    { k: 'a50', n: '上证50' }, { k: 'hs300', n: '沪深300' },
    { k: 'zz500', n: '中证500' }, { k: 'zz1000', n: '中证1000' },
    { k: 'zz2000', n: '中证2000(微盘)' }, { k: 'nasdaq_etf', n: '纳指ETF' },
    { k: 'sp500_etf', n: '标普ETF' },
    { k: 'etf_518880', n: '黄金ETF' }, { k: 'etf_513180', n: '恒生科技ETF' },
    { k: 'etf_512000', n: '券商ETF' }
  ].concat(OV ? [{ k: 'oamv', n: '0AMV 活跃市值' }] : []);

  function seriesOf(k) {
    if (k && k.indexOf('etf_') === 0) return ET[k.slice(4)] || null;
    return k === 'oamv' ? OV : IX[k];
  }

  // 游戏中隐藏真实日期（只显示相对交易日 T+n），真实区间仅在结算页"显示真实日期"揭晓。
  var HIDE = true;
  var GAME_TITLE = '我的模拟人生·A股版';   // 游戏名（多处复用）
  var GAME_VERSION = 'v20260902.5';   // 构建版本号：每次改动 JS 后累加，便于在网页上核对是否加载到最新代码

  // 全局日期轴索引，用于相对交易日换算
  var DAY_IDX = {};
  DAYS.forEach(function (d, i) { DAY_IDX[d] = i; });

  // 序列内日期 -> 索引（美股ETF等序列与A股日历不完全一致，不能直接用全局下标）
  function seriesEndIdx(series, date) {
    var d = series.d;
    if (!series._map) {
      series._map = {};
      for (var q = 0; q < d.length; q++) series._map[d[q]] = q;
    }
    var j = series._map[date];
    if (j != null) return j;
    var lo = 0, hi = d.length - 1, best = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (d[mid] <= date) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best < 0 ? 0 : best;
  }

  // 相对交易日标签：T0 / T+n / T-n（以本局起始日为基准）
  function relDay(date) {
    var j = DAY_IDX[date];
    if (j == null) return '';
    var rel = j - S.startIdx;
    if (rel === 0) return 'T0';
    return rel < 0 ? ('T' + rel) : ('T+' + rel);
  }
  // 游戏中统一的日期显示：隐藏模式显示相对交易日
  function dayLabel(date) { return HIDE ? relDay(date) : fmtDate(date); }

  var S = null;   // 游戏状态

  // ---------- 工具 ----------
  function money(v) {
    var a = Math.abs(v);
    var s = a >= 10000 ? (a / 10000).toFixed(2) + '万' : a.toFixed(0);
    return (v < 0 ? '-' : '') + '¥' + s;
  }
  function pct(v) { return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }
  function cls(v) { return v > 0 ? 'up' : (v < 0 ? 'dn' : ''); }
  function fmtDate(d) { var s = String(d); return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8); }
  function el(id) { return document.getElementById(id); }

  // ---------- 临时存档（cookie 为主 + localStorage 兜底） ----------
  // 说明：cookie 写紧凑版（受 ~4KB 单条限制，流水过多时自动截断）；localStorage 写完整版。
  // 读取时优先 localStorage（完整可恢复），其次 cookie（截断兜底）。二者均带构建版本号 g，
  // 版本不匹配则视为无效存档（避免旧档加载到新代码引发错乱）。
  var SAVE_KEY = 'mlife_save';
  var SAVE_EXPIRE_DAYS = 30;

  function buildSaveObj() {
    return {
      v: 1, g: GAME_VERSION,
      startIdx: S.startIdx, curIdx: S.curIdx, day: S.day, cash: S.cash,
      md: S.marginDebt, mu: S.marginUsed, mu2: S.marginUnlocked,
      over: S.over, revealed: S.revealed, sel: S.sel, rp: S.repoolUsed ? 1 : 0,
      pool: S.pool.map(function (p) { return p.code; }),
      pos: S.positions.map(function (p) { return [p.code, p.shares, p.cost, p.buyIdx]; }),
      tr: S.trades.map(function (t) {
        return [t.code, t.shares, t.cost, t.sell, t.buyIdx, t.sellIdx, t.pl, t.days, t.fee, t.forced ? 1 : 0];
      }),
      eq: S.equity.map(function (e) { return e.v; }),
      stats: S.stats || null
    };
  }
  function saveProgress() {
    if (!S) return;
    try {
      var full = buildSaveObj();
      // 1) localStorage：完整版（容量大，file:///http 下均可作为主恢复源）
      try { localStorage.setItem(SAVE_KEY, JSON.stringify(full)); } catch (e) {}
      // 2) cookie：紧凑版，超 ~3.8KB 则丢弃流水（保证 cookie 不爆，仍满足"写入 cookie"需求）
      var cj = JSON.stringify(full);
      var truncated = false;
      if (cj.length > 3800) { full.tr = []; full.trunc = true; cj = JSON.stringify(full); truncated = true; }
      var exp = new Date(Date.now() + SAVE_EXPIRE_DAYS * 86400000).toUTCString();
      document.cookie = SAVE_KEY + '=' + encodeURIComponent(cj) + '; expires=' + exp + '; path=/; SameSite=Lax';
      if (truncated) console.warn('[存档] 交易流水过多，cookie 已省略流水（localStorage 仍保留完整进度）');
    } catch (e) { /* 存储不可用（如某些浏览器 file:// 限制）时静默 */ }
  }
  function readRaw() {
    var raw = null;
    try { raw = localStorage.getItem(SAVE_KEY); } catch (e) {}
    if (!raw) {
      try {
        var m = document.cookie.match(new RegExp('(?:^|; )' + SAVE_KEY + '=([^;]*)'));
        if (m) raw = decodeURIComponent(m[1]);
      } catch (e) {}
    }
    return raw;
  }
  function readSave() {
    var raw = readRaw();
    if (!raw) return null;
    var o;
    try { o = JSON.parse(raw); } catch (e) { return null; }
    if (!o || o.g !== GAME_VERSION) return null;            // 版本不匹配 -> 无效
    if (typeof o.startIdx !== 'number' || typeof o.curIdx !== 'number') return null;
    return o;
  }
  function hasSave() { return !!readSave(); }
  function clearSave() {
    try { document.cookie = SAVE_KEY + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax'; } catch (e) {}
    try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
  }
  function loadProgress() {
    var o = readSave();
    if (!o) return false;
    var pool = o.pool.map(function (c) {
      var s = KL.stocks[c];
      return { code: c, name: s.name, ind: s.ind, cat: s.cat };
    });
    var map = {};
    pool.forEach(function (p) { map[p.code] = buildMap(KL.stocks[p.code]); });
    S = {
      startIdx: o.startIdx, curIdx: o.curIdx, day: o.day, cash: o.cash,
      marginDebt: o.md, marginUsed: o.mu, positions: [], trades: [], equity: [],
      map: map, pool: pool, sel: o.sel, marginUnlocked: o.mu2,
      over: o.over, revealed: o.revealed, stats: o.stats, repoolUsed: !!o.rp
    };
    S.positions = (o.pos || []).map(function (a) {
      return { code: a[0], shares: a[1], cost: a[2], buyIdx: a[3] };
    });
    S.trades = (o.tr || []).map(function (a) {
      return {
        code: a[0], name: KL.stocks[a[0]] ? KL.stocks[a[0]].name : a[0],
        shares: a[1], cost: a[2], sell: a[3], buyIdx: a[4], sellIdx: a[5],
        pl: a[6], days: a[7], fee: a[8], forced: !!a[9]
      };
    });
    S.equity = (o.eq || []).map(function (v, i) { return { d: DAYS[o.startIdx + i], v: v }; });
    return true;
  }

  // 0AMV 活跃市值（全市场），取 <= 指定日期的最近值
  function oamvAt(date) {
    if (!OV) return null;
    var i = seriesEndIdx(OV, date);
    return (i != null && OV.c[i] != null) ? OV.c[i] : null;
  }
  // 本局 0AMV 区间统计（开局→收官，及区间极值）
  function oamvStats() {
    if (!OV) return null;
    var i0 = seriesEndIdx(OV, DAYS[S.startIdx]);
    var i1 = seriesEndIdx(OV, DAYS[S.curIdx]);
    if (i0 < 0 || i1 < 0) return null;
    var c = OV.c, mn = Infinity, mx = -Infinity;
    for (var q = i0; q <= i1; q++) {
      if (c[q] == null) continue;
      if (c[q] < mn) mn = c[q];
      if (c[q] > mx) mx = c[q];
    }
    var s = c[i0], e = c[i1];
    return { s: s, e: e, chg: s ? (e - s) / s * 100 : 0, min: mn, max: mx };
  }

  function buildMap(stock) {
    var m = {};
    for (var i = 0; i < stock.d.length; i++) m[stock.d[i]] = i;
    return m;
  }

  // 涨跌停幅度
  function limitOf(code, cat) {
    if (cat === 'st') return 0.05;
    if (/^(30|68)/.test(code)) return 0.20;
    return 0.10;
  }

  // ---------- 开新局 ----------
  function newGame() {
    var maxStart = TOTAL_BARS - GAME_BARS - 1;
    var startIdx = Math.floor(Math.random() * (maxStart + 1));
    if (startIdx < 0) startIdx = 0;
    S = {
      startIdx: startIdx, curIdx: startIdx, day: 1,
      cash: INIT_CASH, marginDebt: 0, marginUsed: 0,
      positions: [], trades: [], equity: [], map: {},
      pool: [], sel: null, marginUnlocked: false, over: false,
      revealed: false, stats: null, repoolUsed: false
    };
    pickPool();
    S.map = {};
    S.pool.forEach(function (p) { S.map[p.code] = buildMap(KL.stocks[p.code]); });
    S.equity.push({ d: DAYS[startIdx], v: INIT_CASH });
    renderSelect();
  }

  // 抽 18 只：白马3 / 蓝筹3 / 妖股3 / ST2 / 周期4 / ETF3，同行业≤2
  // ETF 需在本局起始日前已上市（首根K线 <= 起始日），避免未上市标的提前泄露价格
  function pickPool() {
    var byCat = { white: [], blue: [], monster: [], st: [], cycle: [], etf: [] };
    var startD = DAYS[S.startIdx];
    Object.keys(KL.stocks).forEach(function (c) {
      var s = KL.stocks[c];
      if (!byCat[s.cat]) return;
      if (s.cat === 'etf' && s.d[0] > startD) return;
      byCat[s.cat].push({ code: c, name: s.name, ind: s.ind, cat: s.cat });
    });
    var need = { white: 3, blue: 3, monster: 3, st: 2, cycle: 4, etf: 3 };
    var pool = [];
    Object.keys(need).forEach(function (cat) {
      var arr = byCat[cat].slice(), got = 0, guard = 0;
      var indCnt = {};
      while (got < need[cat] && arr.length && guard < 500) {
        guard++;
        var i = Math.floor(Math.random() * arr.length);
        var e = arr[i];
        var cnt = 0;
        pool.forEach(function (p) { if (p.ind === e.ind) cnt++; });
        if (cnt >= 2) continue;
        pool.push(e); arr.splice(i, 1); got++;
      }
    });
    S.pool = pool;
    S.sel = pool[0].code;
  }

  // ---------- 选股界面 ----------
  var panelSel = ['nasdaq_etf', 'hs300', 'zz2000'];   // 面板2/3/4 默认
  var selCharts = [], selChip = null;

  function renderSelect() {
    el('screen-select').style.display = 'block';
    el('screen-game').style.display = 'none';
    el('screen-settle').style.display = 'none';
    el('start-info').innerHTML = '起始日 ' + (HIDE ? '<b class="hid">????-??-??</b>（已隐藏）'
      : fmtDate(DAYS[S.curIdx])) + ' · 本金 ' + money(INIT_CASH);

    // 股票列表
    var html = '';
    S.pool.forEach(function (p) {
      var i = S.map[p.code][DAYS[S.curIdx]];
      var st = KL.stocks[p.code];
      var px = i != null ? st.c[i] : null;
      html += '<div class="pool-item' + (p.code === S.sel ? ' on' : '') + '" data-code="' + p.code + '">' +
        '<div class="pi-name">' + p.name + '<span class="tag t-' + p.cat + '">' +
        ({ white: '白马', blue: '蓝筹', monster: '妖股', st: 'ST', cycle: '周期', etf: 'ETF' })[p.cat] + '</span></div>' +
        '<div class="pi-code">' + p.code + ' · ' + p.ind + '</div>' +
        '<div class="pi-px">' + (px != null ? px.toFixed(2) : '停牌') + '</div></div>';
    });
    el('pool-list').innerHTML = html;
    Array.prototype.forEach.call(el('pool-list').children, function (node) {
      node.onclick = function () { S.sel = node.getAttribute('data-code'); renderSelect(); };
    });

    // 4 面板
    if (!selCharts.length) {
      for (var i = 0; i < 4; i++) {
        var cv = el('sel-cv' + i);
        selCharts.push(new ChartEng.KChart(cv, { subs: i === 0 ? ['vol', 'macd'] : ['vol'] }));
      }
    }
    drawSelPanels();
  }

  function drawSelPanels() {
    if (!S) return;
    var w = el('sel-panels').clientWidth / 2 - 12, h = 200;
    var idxOf = function (code) { return S.map[code] ? S.map[code][DAYS[S.curIdx]] : null; };
    // 面板1：当前股票（显示到起始日）
    var st = KL.stocks[S.sel], ei = idxOf(S.sel);
    if (ei == null) ei = lastIdxBefore(S.sel, DAYS[S.curIdx]);
    selCharts[0].resize(w, h);
    selCharts[0].opts.title = st.name + ' ' + S.sel;
    selCharts[0].opts.baseIdx = HIDE ? ei : null;
    selCharts[0].setData(st, ei);
    for (var i = 1; i < 4; i++) {
      var ix = seriesOf(panelSel[i - 1]) || IX.hs300;
      var ii = seriesEndIdx(ix, DAYS[S.curIdx]);
      selCharts[i].resize(w, h);
      selCharts[i].opts.title = ix.name;
      selCharts[i].opts.baseIdx = HIDE ? ii : null;   // 指数序列按自身日期定位
      selCharts[i].setData(ix, ii);
    }
  }

  // ---------- 选项下拉 ----------
  function fillSelect(node, cur) {
    var h = '';
    IDX_OPTIONS.forEach(function (o) {
      h += '<option value="' + o.k + '"' + (o.k === cur ? ' selected' : '') + '>' + o.n + '</option>';
    });
    node.innerHTML = h;
  }

  function buildPanelSelects() {
    var h = '';
    for (var i = 1; i < 4; i++) {
      h += '<select id="sel-ix' + i + '">';
      IDX_OPTIONS.forEach(function (o, k) {
        h += '<option value="' + o.k + '"' + (o.k === panelSel[i - 1] ? ' selected' : '') + '>' + o.n + '</option>';
      });
      h += '</select>';
    }
    el('panel-sels').innerHTML = h;
    for (var i = 1; i < 4; i++) {
      (function (i) {
        el('sel-ix' + i).onchange = function () {
          panelSel[i - 1] = this.value; drawSelPanels();
        };
      })(i);
    }
  }

  // ---------- 进入游戏 ----------
  function startGame() {
    el('screen-select').style.display = 'none';
    el('screen-game').style.display = 'flex';
    if (!mainChart) {
      mainChart = new ChartEng.KChart(el('main-chart'), { subs: ['vol', 'macd', 'kdj'] });
      chipChart = new ChartEng.ChipChart(el('chip-chart'));
      miniChart = new ChartEng.KChart(el('mini-chart'), { subs: ['vol'], showMa: true, showBoll: false });
    }
    fillSelect(el('mini-sel'), miniSel);
    el('mini-sel').onchange = function () { miniSel = this.value; renderGame(); };
    fillMultiAdds();
    window.addEventListener('resize', layout);
    layout();
    renderGame();
  }

  var mainChart = null, chipChart = null, miniChart = null, miniSel = 'sh_index';

  function layout() {
    var wrap = el('chart-wrap');
    var wrapW = wrap.clientWidth, ch = wrap.clientHeight;
    if (wrapW <= 0 || ch <= 0) return;
    var gap = 6, padX = 20;
    var chipW = Math.min(226, Math.max(150, Math.round(wrapW * 0.28)));
    var cw = Math.max(160, wrapW - chipW - gap - padX);
    mainChart.resize(cw, ch);
    chipChart.resize(chipW, ch);
    var mw = el('mini-wrap');
    // 上证指数栏与主图个股 K 线同宽、左缘对齐（两者 padL/padR 一致），K 线横向位置完全对齐
    miniChart.resize(cw, Math.max(60, mw.clientHeight - 30));
    if (S) { if (multiOn) renderMulti(); else renderGame(); }
  }

  // 大盘小图（含 0AMV 可选）
  function drawMini() {
    if (!S) return;
    var ix = seriesOf(miniSel) || IX.sh_index;
    var i = seriesEndIdx(ix, DAYS[S.curIdx]);        // 当前游戏日（指数序列）下标
    miniChart.opts.title = ix.name || miniSel;
    miniChart.opts.baseIdx = HIDE ? i : null;        // 最右永远=今日，向左递减（与主图一致）
    miniChart.setData(ix, i);
    var prev = i > 0 ? ix.c[i - 1] : ix.c[i];
    var chg = prev ? (ix.c[i] - prev) / prev * 100 : 0;
    el('mini-val').textContent = ix.c[i].toFixed(2) + '  ' + pct(chg);
    el('mini-val').className = cls(chg);
  }

  // 个股在全局日期轴的索引（停牌返回 null）
  function idxAt(code, date) {
    var m = S.map[code];
    if (!m) return null;
    var i = m[date];
    return i == null ? null : i;
  }
  function pxAt(code, date) {
    var i = idxAt(code, date);
    return i == null ? null : KL.stocks[code];
  }
  function lastPx(code, date) {
    // 停牌时沿用最近一次收盘
    var st = KL.stocks[code], m = S.map[code];
    var i = m[date];
    if (i != null) return st.c[i];
    var keys = st.d, best = null;
    for (var q = 0; q < keys.length; q++) { if (keys[q] <= date) best = q; else break; }
    return best == null ? st.c[0] : st.c[best];
  }
  function prevClose(code, date) {
    var st = KL.stocks[code], m = S.map[code];
    var i = m[date];
    if (i == null) return null;
    return i > 0 ? st.c[i - 1] : st.c[0];
  }

  // ---------- 游戏主渲染 ----------
  function renderGame() {
    if (!S || S.over) return;
    var date = DAYS[S.curIdx];
    var st = KL.stocks[S.sel], i = idxAt(S.sel, date);

    // 顶栏
    var eq = equityNow();
    var ret = (eq - INIT_CASH) / INIT_CASH * 100;
    el('hud-date').textContent = HIDE
      ? ('第 ' + S.day + '/' + GAME_BARS + ' 天 · ' + relDay(date))
      : (fmtDate(date) + ' · 第' + S.day + '/' + GAME_BARS + '天');
    el('hud-eq').textContent = money(eq);
    el('hud-cash').textContent = money(S.cash);
    el('hud-ret').textContent = pct(ret);
    el('hud-ret').className = cls(ret);
    // 更换股票池按钮：用过即隐藏
    el('btn-repool').style.display = S.repoolUsed ? 'none' : '';

    // 主图 / 筹码峰 / 大盘
    var mi = i != null ? i : lastIdxBefore(S.sel, date);   // 当前游戏日（个股序列）下标
    mainChart.opts.title = st.name + ' ' + S.sel;
    mainChart.opts.baseIdx = HIDE ? mi : null;             // 以当前游戏日为基准：最右永远=今日，向左 T-1/T-2…
    mainChart.setData(st, mi);
    chipChart.hideDate = HIDE;
    chipChart.setData(S.sel, date, (mainChart._lo != null)
      ? { lo: mainChart._lo, hi: mainChart._hi, top: mainChart._priceTop, bot: mainChart._priceBot }
      : null);
    drawMini();

    // 股票列表
    var html = '';
    S.pool.forEach(function (p) {
      var pst = KL.stocks[p.code], pi = idxAt(p.code, date);
      var pos = S.positions.filter(function (x) { return x.code === p.code; })[0];
      var susp = pi == null;
      var px = lastPx(p.code, date);
      var pc = prevClose(p.code, date);
      var chg = (pc && px) ? (px - pc) / pc * 100 : 0;
      var pl = pos && px ? (px - pos.cost) / pos.cost * 100 : 0;
      html += '<div class="st-item' + (p.code === S.sel ? ' on' : '') + '" data-code="' + p.code + '">' +
        '<div class="si-l"><div class="si-n">' + p.name + '</div>' +
        '<div class="si-c">' + p.code + (susp ? ' <i>停牌</i>' : '') + ' <span class="tag t-' + p.cat + '">' + ({ white: '白马', blue: '蓝筹', monster: '妖股', st: 'ST', cycle: '周期', etf: 'ETF' })[p.cat] + '</span></div></div>' +
        '<div class="si-r"><div class="si-p ' + cls(chg) + '">' + px.toFixed(2) + '</div>' +
        '<div class="si-g ' + cls(chg) + '">' + (susp ? '--' : pct(chg)) + '</div></div>' +
        (pos ? '<div class="si-hold">持' + pos.shares + '股 <span class="' + cls(pl) + '">' + pct(pl) + '</span></div>' : '') +
        '</div>';
    });
    el('stock-list').innerHTML = html;
    Array.prototype.forEach.call(el('stock-list').children, function (node) {
      node.onclick = function () { S.sel = node.getAttribute('data-code'); renderGame(); };
    });

    renderPos();
    renderNews(date);
    renderTradeBox();
  }

  function lastIdxBefore(code, date) {
    var st = KL.stocks[code];
    for (var q = st.d.length - 1; q >= 0; q--) if (st.d[q] <= date) return q;
    return 0;
  }

  function equityNow() {
    var v = S.cash - S.marginDebt;
    var date = DAYS[S.curIdx];
    S.positions.forEach(function (p) { v += lastPx(p.code, date) * p.shares; });
    return v;
  }

  function renderPos() {
    var date = DAYS[S.curIdx];
    var h = '';
    // ---- 当前持仓（上） ----
    if (!S.positions.length) {
      h += '<div class="empty">暂无持仓</div>';
    } else {
      S.positions.forEach(function (p) {
        var px = lastPx(p.code, date), st = KL.stocks[p.code];
        var mv = px * p.shares, cost = p.cost * p.shares;
        var pl = mv - cost, plr = pl / cost * 100;
        var days = S.curIdx - p.buyIdx;
        h += '<div class="pos-item" data-code="' + p.code + '">' +
          '<div class="po-n">' + st.name + '<span class="po-d">' + days + '天</span></div>' +
          '<div class="po-p">持仓' + p.shares + '股 · 成本' + p.cost.toFixed(2) + ' 现价' + px.toFixed(2) + '</div>' +
          '<div class="po-pl ' + cls(pl) + '">' + money(pl) + ' (' + pct(plr) + ')</div></div>';
      });
    }
    // ---- 历史交易记录（下，同一滚动框，最新在上） ----
    h += '<div class="tr-hd">交易记录 · ' + S.trades.length + ' 笔</div>';
    if (!S.trades.length) {
      h += '<div class="empty">暂无交易</div>';
    } else {
      S.trades.slice().reverse().forEach(function (t) {
        var r2 = (t.sell - t.cost) / t.cost * 100;
        h += '<div class="pl-tr" data-code="' + t.code + '">' +
          '<span class="tn">' + t.name + '</span>' +
          '<span class="ti">' + t.shares + '股 · ' + t.days + '天</span>' +
          '<span class="tp ' + cls(t.pl) + '">' + money(t.pl) + ' (' + pct(r2) + ')</span>' +
          (t.forced ? '<span class="forced">强平</span>' : '') + '</div>';
      });
    }
    el('pos-list').innerHTML = h;
    el('pos-cnt').textContent = '持' + S.positions.length + '只 · ' + S.trades.length + '笔';
    Array.prototype.forEach.call(el('pos-list').querySelectorAll('.pos-item'), function (node) {
      node.onclick = function () { S.sel = node.getAttribute('data-code'); renderGame(); };
    });
    Array.prototype.forEach.call(el('pos-list').querySelectorAll('.pl-tr'), function (node) {
      node.onclick = function () {
        var c = node.getAttribute('data-code');
        if (KL.stocks[c]) { S.sel = c; renderGame(); }
      };
    });
  }

  function renderNews(date) {
    var m = (NW.market || []).filter(function (n) { return n.d === date; });
    var c = (NW.stocks[S.sel] || []).filter(function (n) { return n.d === date; });
    var h = '<div class="news-date">' + (HIDE
      ? ('第 ' + S.day + ' 交易日 · ' + relDay(date))
      : (fmtDate(date) + ' · 第' + S.day + '天')) + '</div>';
    if (!m.length && !c.length) {
      // 无当日新闻时，显示最近3条市场新闻（灰色提示历史）
      var recent = (NW.market || []).filter(function (n) { return n.d <= date; }).slice(-3).reverse();
      if (!recent.length) h += '<div class="news-none">今日无重大新闻</div>';
      else {
        h += '<div class="news-hint">近期要闻</div>';
        recent.forEach(function (n) { h += newsItem(n, true); });
      }
    } else {
      if (m.length) { h += '<div class="news-hint">市场要闻</div>'; m.forEach(function (n) { h += newsItem(n); }); }
      if (c.length) { h += '<div class="news-hint">' + KL.stocks[S.sel].name + '</div>'; c.forEach(function (n) { h += newsItem(n); }); }
    }
    el('news-box').innerHTML = h;
    el('news-box').scrollTop = 0;
  }
  function newsItem(n, old) {
    return '<div class="news-item' + (old ? ' old' : '') + '">' +
      '<a href="' + (n.u || '#') + '" target="_blank" rel="noopener">' + n.ti + '</a>' +
      '<div class="ni-m">' + (old ? dayLabel(n.d) + ' · ' : '') + (n.s || '') + '</div></div>';
  }

  function renderTradeBox() {
    var st = KL.stocks[S.sel], date = DAYS[S.curIdx];
    var i = idxAt(S.sel, date), px = lastPx(S.sel, date);
    var pos = S.positions.filter(function (x) { return x.code === S.sel; })[0];
    el('tb-name').textContent = st.name + ' ' + S.sel;
    el('tb-px').textContent = px.toFixed(2) + (i == null ? ' (停牌不可交易)' : '');
    var lim = limitOf(S.sel, st.cat);
    var pc = prevClose(S.sel, date), upP = pc ? (pc * (1 + lim)) : 0, dnP = pc ? (pc * (1 - lim)) : 0;
    el('tb-limit').textContent = '涨' + upP.toFixed(2) + ' 跌' + dnP.toFixed(2) + ' (' + (lim * 100) + '%)';
    el('tb-avail').textContent = money(S.cash);
    el('tb-hold').textContent = pos ? pos.shares + '股' : '0股';
    el('tb-sellable').textContent = (pos && pos.buyIdx < S.curIdx) ? pos.shares + '股' : '0股(T+1)';
  }

  // ---------- 交易 ----------
  function buy() {
    var code = S.sel, date = DAYS[S.curIdx], st = KL.stocks[code];
    var i = idxAt(code, date);
    if (i == null) return toast('停牌中，无法交易');
    var px = st.c[i], pc = i > 0 ? st.c[i - 1] : st.c[0], lim = limitOf(code, st.cat);
    if (px >= pc * (1 + lim) - 1e-6) return toast('涨停封板，无法买入');
    var shares = parseInt(el('tb-num').value, 10) * 100;
    if (!shares || shares <= 0) return toast('请输入买入数量（手）');
    var amount = px * shares;
    var fee = Math.max(5, amount * 0.00025);
    if (amount + fee > S.cash) return toast('资金不足（需 ' + money(amount + fee) + '）');
    S.cash -= amount + fee;
    var pos = S.positions.filter(function (x) { return x.code === code; })[0];
    if (pos) {
      pos.shares += shares;
      pos.cost = (pos.cost * (pos.shares - shares) + amount) / pos.shares;
      pos.buyIdx = S.curIdx;   // 加仓部分受T+1限制
    } else {
      S.positions.push({ code: code, shares: shares, cost: px, buyIdx: S.curIdx });
    }
    toast('买入 ' + st.name + ' ' + shares + '股 @' + px.toFixed(2));
    renderGame();
    saveProgress();
  }

  function sell() {
    var code = S.sel, date = DAYS[S.curIdx], st = KL.stocks[code];
    var i = idxAt(code, date);
    if (i == null) return toast('停牌中，无法交易');
    var pos = S.positions.filter(function (x) { return x.code === code; })[0];
    if (!pos) return toast('无持仓');
    if (pos.buyIdx >= S.curIdx) return toast('T+1 限制：当日买入不可卖出');
    var px = st.c[i], pc = i > 0 ? st.c[i - 1] : st.c[0], lim = limitOf(code, st.cat);
    if (px <= pc * (1 - lim) + 1e-6) return toast('跌停封板，无法卖出');
    var shares = parseInt(el('tb-num').value, 10) * 100;
    if (!shares || shares <= 0) return toast('请输入卖出数量（手）');
    if (shares > pos.shares) shares = pos.shares;
    var amount = px * shares;
    var fee = Math.max(5, amount * 0.00025) + (st.cat === 'etf' ? 0 : amount * 0.0005) + amount * 0.00001;
    S.cash += amount - fee;
    S.trades.push({
      code: code, name: st.name, shares: shares,
      cost: pos.cost, sell: px, buyIdx: pos.buyIdx, sellIdx: S.curIdx,
      pl: (px - pos.cost) * shares - fee, days: S.curIdx - pos.buyIdx,
      fee: fee
    });
    pos.shares -= shares;
    if (pos.shares <= 0) S.positions = S.positions.filter(function (x) { return x.code !== code; });
    toast('卖出 ' + st.name + ' ' + shares + '股 @' + px.toFixed(2));
    renderGame();
    saveProgress();
  }

  function sellAll() {
    var pos = S.positions.filter(function (x) { return x.code === S.sel; })[0];
    if (!pos) return toast('无持仓');
    el('tb-num').value = Math.floor(pos.shares / 100);
    sell();
  }
  function buyMax() {
    var code = S.sel, px = lastPx(code, DAYS[S.curIdx]);
    var lots = Math.floor(S.cash / (px * 100 * 1.0003));
    el('tb-num').value = lots;
    if (lots > 0) buy(); else toast('资金不足一手');
  }

  // ---------- 推进 ----------
  function nextDay(n) {
    n = n || 1;
    if (!S || S.over) return;
    var target = Math.min(S.startIdx + GAME_BARS, S.curIdx + n);
    while (S.curIdx < target) {
      S.curIdx++; S.day++;
      var date = DAYS[S.curIdx];
      var eq = equityNow();
      S.equity.push({ d: date, v: eq });
      // 融资解锁 & 强平
      if (!S.marginUnlocked && eq >= 500000) S.marginUnlocked = true;
      if (S.marginDebt > 0) {
        var ratio = eq / S.marginDebt * 100;
        if (ratio < 110) forceClose('维持担保比例低于110%，触发强制平仓');
        else if (ratio < 130) toast('警告：维持担保比例 ' + ratio.toFixed(0) + '%，低于130%警戒线');
      }
    }
    if (S.curIdx >= S.startIdx + GAME_BARS) { settle(); return; }
    if (multiOn) { multiView.date = DAYS[S.curIdx]; renderMulti(); }
    renderGame();
    saveProgress();
  }

  function forceClose(msg) {
    var date = DAYS[S.curIdx];
    S.positions.slice().forEach(function (p) {
      var px = lastPx(p.code, date);
      var amount = px * p.shares;
      var fee = Math.max(5, amount * 0.00025) + (KL.stocks[p.code].cat === 'etf' ? 0 : amount * 0.0005);
      S.cash += amount - fee;
      S.trades.push({ code: p.code, name: KL.stocks[p.code].name, shares: p.shares, cost: p.cost,
        sell: px, buyIdx: p.buyIdx, sellIdx: S.curIdx, pl: (px - p.cost) * p.shares - fee,
        days: S.curIdx - p.buyIdx, fee: fee, forced: true });
    });
    S.positions = [];
    S.marginDebt = 0;
    toast(msg);
  }

  function borrow() {
    if (!S.marginUnlocked) return toast('总资产达50万后才解锁融资');
    var avail = INIT_CASH - S.marginDebt;
    if (avail <= 0) return toast('融资额度已用尽');
    S.marginDebt += avail; S.cash += avail; S.marginUsed += avail;
    toast('融资 ' + money(avail) + '，维持担保比例 ' + (equityNow() / S.marginDebt * 100).toFixed(0) + '%');
    renderGame();
  }
  function repay() {
    if (S.marginDebt <= 0) return toast('无融资负债');
    var pay = Math.min(S.marginDebt, S.cash);
    S.cash -= pay; S.marginDebt -= pay;
    toast('还款 ' + money(pay));
    renderGame();
  }

  // ---------- 更换股票池（每局一次） ----------
  function openRepoolModal() {
    if (!S || S.over) return;
    if (S.repoolUsed) return toast('本局已使用过更换股票池');
    el('modal-repool').style.display = 'flex';
  }
  function closeRepoolModal() { el('modal-repool').style.display = 'none'; }
  function doRepool() {
    closeRepoolModal();
    if (!S || S.over || S.repoolUsed) return;
    S.repoolUsed = true;
    // 1) 按现价强平全部持仓（与强制平仓同规则计费）
    var date = DAYS[S.curIdx];
    S.positions.slice().forEach(function (p) {
      var px = lastPx(p.code, date);
      var amount = px * p.shares;
      var fee = Math.max(5, amount * 0.00025) + (KL.stocks[p.code].cat === 'etf' ? 0 : amount * 0.0005);
      S.cash += amount - fee;
      S.trades.push({ code: p.code, name: KL.stocks[p.code].name, shares: p.shares, cost: p.cost,
        sell: px, buyIdx: p.buyIdx, sellIdx: S.curIdx, pl: (px - p.cost) * p.shares - fee,
        days: S.curIdx - p.buyIdx, fee: fee, forced: true });
    });
    S.positions = [];
    // 2) 重新抽池
    pickPool();
    S.map = {};
    S.pool.forEach(function (p) { S.map[p.code] = buildMap(KL.stocks[p.code]); });
    S.sel = S.pool[0].code;
    // 3) 退出多图对比并刷新下拉（避免残留旧池代码）
    if (multiOn) toggleMulti();
    multiItems = [];
    fillMultiAdds();
    toast('已更换股票池，原持仓已按现价平仓');
    renderGame();
    saveProgress();
  }

  // ---------- 统计 ----------
  function returns() {
    var r = [];
    for (var i = 1; i < S.equity.length; i++) {
      var p = S.equity[i - 1].v;
      if (p > 0) r.push((S.equity[i].v - p) / p);
    }
    return r;
  }
  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function std(a) {
    if (a.length < 2) return 0;
    var m = mean(a);
    return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1));
  }
  function sharpeNow() {
    var r = returns();
    if (r.length < 5) return NaN;
    var sd = std(r);
    if (sd === 0) return 0;
    return (mean(r) * 252 - RF) / (sd * Math.sqrt(252));
  }
  function maxDrawdown() {
    var peak = -Infinity, mdd = 0;
    S.equity.forEach(function (e) {
      if (e.v > peak) peak = e.v;
      var dd = (peak - e.v) / peak;
      if (dd > mdd) mdd = dd;
    });
    return mdd;
  }
  function alphaBeta() {
    // 相对沪深300，按同期日收益对齐
    var bmap = {}, bd = IX.hs300.d, bc = IX.hs300.c;
    for (var i = 0; i < bd.length; i++) bmap[bd[i]] = i;
    var rp = [], rb = [];
    for (var i = 1; i < S.equity.length; i++) {
      var d0 = S.equity[i - 1].d, d1 = S.equity[i].d;
      var i0 = bmap[d0], i1 = bmap[d1];
      if (i0 == null || i1 == null) continue;
      var prev = S.equity[i - 1].v;
      if (prev <= 0) continue;
      rp.push((S.equity[i].v - prev) / prev);
      rb.push((bc[i1] - bc[i0]) / bc[i0]);
    }
    if (rp.length < 5) return { a: NaN, b: NaN };
    var mp = mean(rp), mb = mean(rb);
    var cov = 0, vb = 0;
    for (var i = 0; i < rp.length; i++) { cov += (rp[i] - mp) * (rb[i] - mb); vb += (rb[i] - mb) * (rb[i] - mb); }
    var beta = vb > 0 ? cov / vb : 0;
    return { a: (mp - beta * mb) * 252, b: beta };
  }
  function rankOf(sh) {
    if (!isFinite(sh)) return '--';
    if (sh >= 5) return 'S';
    if (sh >= 2.5) return 'A';
    if (sh >= 1.8) return 'B';
    if (sh >= 1.1) return 'C';
    return 'D';
  }

  // ---------- 择时 / 选股能力评分 ----------
  // 用户规则（方差法）：大盘次日 50% 涨跌、踩中中位数 80% 概率 = 择时满分(100%)；
  // 个股次日 50% 涨跌、踩中中位数 80% 概率 = 选股前 50 分；另 50 分按期望日均收益
  // 0.5% = 满分 50、0% = 25 分。此处用「实际是否正确站位/选中」替代显式预测：
  //   择时 = 大盘涨日是否持仓、跌日是否空仓；选股 = 持仓个股当日收益是否≥池内中位数。
  function abilityScores() {
    if (S.equity.length < 2) return { timing: 0, timingHit: 0, select: 0, hitA: 0, retB: 0, scoreA: 0, scoreB: 0 };
    // 由成交流水重建每日持仓集合（buyIdx..sellIdx 为 DAYS 下标）
    var heldByDay = {};
    S.trades.forEach(function (t) {
      for (var d = t.buyIdx; d <= t.sellIdx; d++) (heldByDay[d] = heldByDay[d] || {})[t.code] = true;
    });
    var tHit = 0, tTot = 0, sHit = 0, sTot = 0, retSum = 0, retCnt = 0;
    for (var di = S.startIdx + 1; di <= S.curIdx; di++) {
      var d1 = DAYS[di - 1], d2 = DAYS[di];
      // 大盘当日收益
      var i0 = seriesEndIdx(IX.hs300, d1), i1 = seriesEndIdx(IX.hs300, d2);
      var mkt = (IX.hs300.c[i1] - IX.hs300.c[i0]) / IX.hs300.c[i0];
      var longDay = !!(heldByDay[di] && Object.keys(heldByDay[di]).length);
      // 择时命中：涨日持仓 / 跌日空仓
      tTot++;
      if (mkt > 0 && longDay) tHit++;
      else if (mkt < 0 && !longDay) tHit++;
      else if (mkt === 0) tHit++;
      // 选股 A：池内当日收益中位数
      var poolRet = [];
      S.pool.forEach(function (p) {
        var a = lastPx(p.code, d1), b = lastPx(p.code, d2);
        if (a > 0) poolRet.push((b - a) / a);
      });
      var median = 0;
      if (poolRet.length) { poolRet.sort(function (x, y) { return x - y; }); median = poolRet[Math.floor(poolRet.length / 2)]; }
      if (heldByDay[di]) {
        Object.keys(heldByDay[di]).forEach(function (code) {
          var a = lastPx(code, d1), b = lastPx(code, d2);
          if (a <= 0) return;
          sTot++; if ((b - a) / a >= median) sHit++;
        });
      }
      // 收益期望分量（玩家当日收益）
      var eqPrev = S.equity[di - 1 - S.startIdx].v, eqCur = S.equity[di - S.startIdx].v;
      retSum += (eqCur - eqPrev) / eqPrev; retCnt++;
    }
    var timingHitRate = tTot ? tHit / tTot : 0;
    var timing = clamp(timingHitRate / 0.80 * 100, 0, 100);     // 80% 命中 = 满分
    var stockHitRate = sTot ? sHit / sTot : 0;
    var scoreA = clamp(stockHitRate / 0.80 * 50, 0, 50);        // 80% 命中 = 50 分
    var avgDailyPct = retCnt ? retSum / retCnt * 100 : 0;
    var scoreB = clamp(25 + (avgDailyPct / 0.5) * 25, 0, 50);   // 0.5%/日=50分，0%=25分
    return {
      timing: timing, timingHit: timingHitRate * 100,
      select: scoreA + scoreB, hitA: stockHitRate * 100,
      retB: avgDailyPct, scoreA: scoreA, scoreB: scoreB
    };
  }

  // ---------- 结算 ----------
  function settle() {
    if (S.over && S.stats) { renderSettle(); return; }
    S.over = true;
    var date = DAYS[S.curIdx];
    // 强制平仓所有持仓（按收盘价）
    var posVal = 0;
    S.positions.slice().forEach(function (p) {
      var px = lastPx(p.code, date);
      posVal += px * p.shares;
      S.trades.push({ code: p.code, name: KL.stocks[p.code].name, shares: p.shares, cost: p.cost,
        sell: px, buyIdx: p.buyIdx, sellIdx: S.curIdx, pl: (px - p.cost) * p.shares,
        days: S.curIdx - p.buyIdx, fee: 0, forced: false });
    });
    S.positions = [];
    var finalEq = S.cash + posVal - S.marginDebt;
    var totalRet = (finalEq - INIT_CASH) / INIT_CASH * 100;
    var years = GAME_BARS / 242;
    var annual = (Math.pow(finalEq / INIT_CASH, 1 / years) - 1) * 100;
    var r = returns(), sd = std(r);
    var sh = r.length >= 5 ? (mean(r) * 252 - RF) / (sd * Math.sqrt(252)) : NaN;
    var mdd = maxDrawdown() * 100;
    var ab = alphaBeta();
    var wins = S.trades.filter(function (t) { return t.pl > 0; });
    var losses = S.trades.filter(function (t) { return t.pl <= 0; });
    var avgWin = wins.length ? mean(wins.map(function (t) { return t.pl; })) : 0;
    var avgLoss = losses.length ? mean(losses.map(function (t) { return Math.abs(t.pl); })) : 0;
    var plRatio = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? Infinity : 0);
    // 最大单笔盈利只统计盈利单笔，无盈利交易时为 0
    var maxWin = wins.length ? Math.max.apply(null, wins.map(function (t) { return t.pl; })) : 0;
    // 最惨单笔
    var maxLoss = losses.length ? Math.min.apply(null, losses.map(function (t) { return t.pl; })) : 0;
    var daysArr = S.trades.map(function (t) { return t.days; });
    var maxHold = daysArr.length ? Math.max.apply(null, daysArr) : 0;
    var avgHold = daysArr.length ? mean(daysArr) : 0;
    var winRate = S.trades.length ? wins.length / S.trades.length * 100 : 0;
    var benchRet = benchReturn();
    var abil = abilityScores();

    S.stats = {
      finalEq: finalEq, totalRet: totalRet, annual: annual, sharpe: sh, mdd: mdd,
      alpha: ab.a, beta: ab.b, plRatio: plRatio, winRate: winRate,
      maxWin: maxWin, maxLoss: maxLoss, maxHold: maxHold, avgHold: avgHold,
      wins: wins.length, losses: losses.length, nTrades: S.trades.length,
      posVal: posVal, benchRet: benchRet, rank: rankOf(sh),
      timing: abil.timing, timingHit: abil.timingHit,
      select: abil.select, hitA: abil.hitA, retB: abil.retB, scoreA: abil.scoreA, scoreB: abil.scoreB
    };
    saveProgress();   // 结算后也存盘（over 局下次打开可"继续"进结算报告）
    renderSettle();
  }

  // 同期沪深300涨幅（对照基准）
  function benchReturn() {
    var bd = IX.hs300.d, bc = IX.hs300.c;
    var i0 = seriesEndIdx(IX.hs300, DAYS[S.startIdx]);
    var i1 = seriesEndIdx(IX.hs300, DAYS[S.curIdx]);
    if (!bc[i0]) return NaN;
    return (bc[i1] - bc[i0]) / bc[i0] * 100;
  }

  function renderSettle() {
    var st = S.stats, rank = st.rank;
    // 揭晓后补充 0AMV 活跃市值区间数据
    var os = oamvStats(), oamvHtml = '';
    if (os) {
      oamvHtml = '<div style="flex-basis:100%;margin-top:8px;color:var(--dim);font-size:12px">' +
        '0AMV 活跃市值：开局 <b style="color:var(--text)">' + os.s.toFixed(0) + ' 亿</b> → 收官 <b style="color:var(--text)">' + os.e.toFixed(0) + ' 亿</b> ' +
        '<span class="' + cls(os.chg) + '">(' + pct(os.chg) + ')</span>' +
        ' · 区间 ' + os.min.toFixed(0) + '~' + os.max.toFixed(0) + ' 亿</div>';
    }
    var html = '<h2>结算报告</h2>' +
      '<div class="st-reveal">' +
      (S.revealed
        ? '<span class="lb" style="color:var(--dim);font-size:12px">本局区间</span>' +
          '<b>' + fmtDate(DAYS[S.startIdx]) + '</b> → <b>' + fmtDate(DAYS[S.curIdx]) + '</b>' +
          '<span class="note">共 ' + GAME_BARS + ' 个交易日 · 同期沪深300 ' +
          (isFinite(st.benchRet) ? pct(st.benchRet) : '--') + '</span>' + oamvHtml
        : '<button id="btn-reveal">🔍 显示真实日期</button>' +
          '<span class="note">本局真实起止日期待揭晓（不影响重开新局）</span>') +
      '</div>' +
      '<div class="st-top"><div class="st-rank rank-' + rank + '">' + rank + '</div>' +
      '<div class="st-sum"><div class="st-eq ' + cls(st.finalEq - INIT_CASH) + '">' + money(st.finalEq) + '</div>' +
      '<div class="st-sub">总收益 <b class="' + cls(st.totalRet) + '">' + pct(st.totalRet) + '</b> · 年化 <b class="' +
      cls(st.annual) + '">' + pct(st.annual) + '</b></div></div></div>' +
      '<table class="st-table"><tbody>' +
      row('夏普比率', isFinite(st.sharpe) ? st.sharpe.toFixed(3) : '--', '评级阈值 S≥5 / A≥2.5 / B≥1.8 / C≥1.1') +
      row('择时能力', st.timing.toFixed(1) + '%', '大盘方向踩中 ' + st.timingHit.toFixed(0) + '%（80%命中=满分100%）', true) +
      row('选股能力', st.select.toFixed(1) + '%', '中位数命中 ' + st.hitA.toFixed(0) + '%(+50) · 日均 ' + pct(st.retB) + '(0.5%/日=+50)', true) +
      row('最大回撤', '-' + st.mdd.toFixed(2) + '%') +
      row('阿尔法 α (年化)', isFinite(st.alpha) ? pct(st.alpha * 100) : '--', '相对沪深300') +
      row('贝塔 β', isFinite(st.beta) ? st.beta.toFixed(3) : '--', '相对沪深300') +
      row('盈亏比', isFinite(st.plRatio) ? st.plRatio.toFixed(2) : (st.plRatio === Infinity ? '∞' : '--'), '平均盈利 / 平均亏损') +
      row('胜率', st.winRate.toFixed(1) + '%', '盈利 ' + st.wins + ' / 亏损 ' + st.losses + ' 笔') +
      row('最大单笔盈利', money(st.maxWin)) +
      row('最大单笔亏损', money(st.maxLoss)) +
      row('最大持仓天数', st.maxHold + ' 天') +
      row('平均持仓天数', st.avgHold.toFixed(1) + ' 天') +
      row('交易笔数', st.nTrades + ' 笔') +
      row('期末持股市值', money(st.posVal)) +
      '</tbody></table>';

    if (S.trades.length) {
      html += '<h3>交易明细</h3><div class="st-trades">' + S.trades.map(function (t) {
        var r2 = (t.sell - t.cost) / t.cost * 100;
        var dt = S.revealed ? '<span class="tr-d">' + fmtDate(DAYS[t.buyIdx]) + '→' + fmtDate(DAYS[t.sellIdx]) + '</span>' : '';
        return '<div class="tr-row"><span>' + t.name + '</span><span>' + t.days + '天</span>' +
          '<span class="' + cls(t.pl) + '">' + money(t.pl) + ' (' + pct(r2) + ')</span>' +
          dt + (t.forced ? '<span class="forced">强平</span>' : '') + '</div>';
      }).join('') + '</div>';
    }
    el('settle-box').innerHTML = html;
    if (!S.revealed && el('btn-reveal')) {
      el('btn-reveal').onclick = function () { S.revealed = true; renderSettle(); };
    }
    el('screen-game').style.display = 'none';
    el('screen-settle').style.display = 'block';
  }
  function row(k, v, note, hl) {
    return '<tr' + (hl ? ' class="hl"' : '') + '><td class="k">' + k + '</td><td class="v">' + v + '</td><td class="note">' + (note || '') + '</td></tr>';
  }

  // ---------- 提示 ----------
  var toastTimer = null;
  function toast(msg) {
    var t = el('toast');
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.style.display = 'none'; }, 2200);
  }

  // ---------- 绑定 ----------
  function bind() {
    el('btn-start').onclick = function () { clearSave(); startGame(); };   // 开新局：放弃旧存档
    el('btn-resume').onclick = function () {                               // 继续上次存档
      if (loadProgress()) { startGame(); toast('已读取上次存档'); }
      else { clearSave(); el('btn-resume').style.display = 'none'; toast('没有可用存档'); }
    };
    el('btn-clear').onclick = function () { clearSave(); toast('已清除存档'); };
    el('btn-again').onclick = function () { clearSave(); newGame(); };     // 再来一局：清档+重抽
    el('btn-next').onclick = function () { nextDay(1); };
    el('btn-f5').onclick = function () { nextDay(5); };
    el('btn-f20').onclick = function () { nextDay(20); };
    el('btn-buy').onclick = buy;
    el('btn-sell').onclick = sell;
    el('btn-buymax').onclick = buyMax;
    el('btn-sellall').onclick = sellAll;
    el('btn-again').onclick = function () { newGame(); };
    el('btn-settle').onclick = openSettleModal;
    el('modal-settle-cancel').onclick = closeSettleModal;
    el('modal-settle-ok').onclick = function () { closeSettleModal(); settle(); };
    el('btn-compare').onclick = toggleMulti;
    el('btn-compare-off').onclick = toggleMulti;
    el('btn-repool').onclick = openRepoolModal;
    el('modal-repool-cancel').onclick = closeRepoolModal;
    el('modal-repool-ok').onclick = doRepool;
    el('modal-repool').addEventListener('click', function (e) { if (e.target === this) closeRepoolModal(); });
    el('multi-add-ix').onchange = function () { if (this.value) { addMulti('index', this.value); this.value = ''; } };
    el('multi-add-st').onchange = function () { if (this.value) { addMulti('stock', null, this.value); this.value = ''; } };
    el('modal-settle').addEventListener('click', function (e) { if (e.target === this) closeSettleModal(); });
    el('btn-sub-vol').onclick = function () { toggleSub('vol'); };
    el('btn-sub-macd').onclick = function () { toggleSub('macd'); };
    el('btn-sub-kdj').onclick = function () { toggleSub('kdj'); };
    el('btn-boll').onclick = function () { mainChart.opts.showBoll = !mainChart.opts.showBoll; renderGame(); };
    document.addEventListener('keydown', function (e) {
      if (el('screen-game').style.display === 'none') return;
      if (el('modal-settle').style.display !== 'none') return;
      if (el('modal-repool').style.display !== 'none') return;
      if (multiOn) return;
      if (e.key === 'ArrowRight') nextDay(1);
      if (e.key === 'ArrowDown') nextDay(5);
      if (e.key === 'b' || e.key === 'B') buy();
      if (e.key === 's' || e.key === 'S') sell();
    });
  }
  function toggleSub(k) {
    var subs = mainChart.opts.subs;
    var i = subs.indexOf(k);
    if (i >= 0) { if (subs.length <= 1) return; subs.splice(i, 1); }
    else { if (subs.length >= 3) return; subs.push(k); }
    mainChart.draw();
    el('btn-sub-vol').className = subs.indexOf('vol') >= 0 ? 'on' : '';
    el('btn-sub-macd').className = subs.indexOf('macd') >= 0 ? 'on' : '';
    el('btn-sub-kdj').className = subs.indexOf('kdj') >= 0 ? 'on' : '';
  }

  // ---------- 结算确认弹窗 ----------
  function openSettleModal() {
    if (!S || S.over) return;
    el('modal-settle').style.display = 'flex';
  }
  function closeSettleModal() { el('modal-settle').style.display = 'none'; }

  // ---------- 多图对比（内联，保留左/下/右栏，范围与主图同步） ----------
  var multiOn = false, multiItems = [], multiId = 0;
  var multiView = { viewBars: 120, date: null };

  function onMultiView(viewBars, date) {
    if (viewBars) multiView.viewBars = viewBars;
    if (date) multiView.date = date;
    renderMulti();
  }
  function fillMultiAdds() {
    if (!S) return;
    var sel = el('multi-add-st');
    if (sel) {
      var h = '<option value="">+ 个股（池内）</option>';
      S.pool.forEach(function (p) { h += '<option value="' + p.code + '">' + p.name + ' ' + p.code + '</option>'; });
      sel.innerHTML = h;
    }
    var ix = el('multi-add-ix');
    if (ix) {
      var h2 = '<option value="">+ 指数 / ETF</option>';
      IDX_OPTIONS.forEach(function (o) { h2 += '<option value="' + o.k + '">' + o.n + '</option>'; });
      ix.innerHTML = h2;
    }
  }
  function toggleMulti() {
    if (!S || S.over || !mainChart || !mainChart.data) return;
    multiOn = !multiOn;
    if (multiOn) {
      // 进入：以当前主图视图（缩放 + 截止日）为基准
      multiView.viewBars = mainChart.viewBars;
      multiView.date = mainChart.data.d[mainChart.endIdx];
      if (!multiItems.length) {
        addMulti('stock', null, S.sel);
        panelSel.forEach(function (k) { addMulti('index', k); });
      }
      el('chart-wrap').style.display = 'none';
      el('multi-panel').style.display = 'flex';
      el('btn-compare').classList.add('on');
      renderMulti();
    } else {
      el('chart-wrap').style.display = 'flex';
      el('multi-panel').style.display = 'none';
      el('btn-compare').classList.remove('on');
      layout();
      renderGame();
    }
  }
  function addMulti(kind, key, code) {
    multiItems.push({ id: ++multiId, kind: kind, key: key, code: code, card: null, head: null, canvas: null, chart: null });
    renderMulti();
  }
  function removeMulti(id) {
    for (var i = 0; i < multiItems.length; i++) {
      if (multiItems[i].id === id) {
        if (multiItems[i].card && multiItems[i].card.parentNode) multiItems[i].card.parentNode.removeChild(multiItems[i].card);
        multiItems.splice(i, 1);
        break;
      }
    }
    renderMulti();
  }
  function buildCard(it) {
    var card = document.createElement('div');
    card.className = 'mc-card';
    var head = document.createElement('div');
    head.className = 'mc-head';
    var title = document.createElement('span');
    title.className = 'mc-t';
    var series = it.kind === 'stock' ? KL.stocks[it.code] : seriesOf(it.key);
    title.textContent = series ? series.name : it.key;
    head.appendChild(title);
    if (it.kind === 'stock') {
      var sel = document.createElement('select');
      sel.className = 'mc-sel';
      S.pool.forEach(function (p) {
        var o = document.createElement('option');
        o.value = p.code; o.textContent = p.name;
        if (p.code === it.code) o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = function () { it.code = this.value; renderMulti(); };
      head.appendChild(sel);
    }
    var x = document.createElement('button');
    x.className = 'mc-x'; x.textContent = '×';
    x.onclick = function () { removeMulti(it.id); };
    head.appendChild(x);
    card.appendChild(head);
    var cv = document.createElement('canvas');
    cv.className = 'mc-cv';
    card.appendChild(cv);
    el('multi-grid').appendChild(card);
    it.card = card; it.head = head; it.canvas = cv;
  }
  function renderMulti() {
    if (!multiOn || !S) return;
    var grid = el('multi-grid');
    var gw = grid.clientWidth, gh = grid.clientHeight;
    if (gw <= 0 || gh <= 0) return;
    var gap = 8, cols = 2;
    var n = multiItems.length || 1;
    var rows = Math.ceil(n / cols);
    var rowH = Math.max(150, Math.floor((gh - (rows + 1) * gap) / rows));
    var cw = Math.floor((gw - (cols + 1) * gap) / cols);
    multiItems.forEach(function (it) { if (!it.canvas) buildCard(it); });
    multiItems.forEach(function (it) {
      var headH = it.head ? it.head.offsetHeight : 24;
      var h = Math.max(80, rowH - headH - 6);
      if (!it.chart) it.chart = new ChartEng.KChart(it.canvas, { subs: ['vol'], showMa: true, showBoll: false, onView: onMultiView });
      var series = it.kind === 'stock' ? KL.stocks[it.code] : seriesOf(it.key);
      if (!series) return;
      var end = seriesEndIdx(series, multiView.date);
      var maxI = seriesEndIdx(series, DAYS[S.curIdx]);   // 防未来函数：不超过当前游戏日
      it.chart.opts.title = (it.kind === 'stock' ? KL.stocks[it.code].name + ' ' + it.code : series.name);
      it.chart.opts.baseIdx = HIDE ? maxI : null;        // 以当前游戏日为基准：最右永远=今日
      it.chart.viewBars = multiView.viewBars;
      it.chart.resize(cw - 2, h - 2);
      it.chart.setData(series, end);
      it.chart.maxIdx = maxI;
    });
  }

  // ---------- 启动 ----------
  global.GameApp = {
    boot: function () {
      if (!KL || !IX) { document.body.innerHTML = '<p style="color:#f66;padding:40px">数据包未加载</p>'; return; }
    bind();
    buildPanelSelects();
    var vb = el('ver-badge'); if (vb) vb.textContent = GAME_VERSION;
    var vbs = el('ver-badge-sel'); if (vbs) vbs.textContent = GAME_VERSION;
    var rb = el('btn-resume'); if (rb) rb.style.display = hasSave() ? '' : 'none';  // 有存档才显示"继续上次"
    newGame();
    }
  };
})(window);
