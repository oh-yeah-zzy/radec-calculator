/**
 * starmap.js —— 背景星图（Canvas 实时绘制）
 *
 * 功能：
 *   · 用球极投影（stereographic，保角、无接缝）绘制真实星空：约 5000 颗 ≤6 等亮星（按 B−V 色指数着色）、
 *     银河、星座连线与星座名、亮星星名（中文界面用中文名，英文界面用拉丁星座名与英文星名）、赤经赤纬网格、天赤道与黄道；
 *   · 可叠加观测地的地平线：地平线以下罩一层暗色"地面"，并标出东南西北；
 *   · 标出目标天体（以及"角距离"功能里的第二个天体和两者之间的大圆弧）；
 *   · 支持拖动平移、滚轮/双指缩放、点击拾取坐标、鼠标悬停显示星名；
 *   · 只在画面需要变化时才重绘（requestAnimationFrame 按需驱动），静止时不占用 CPU。
 *
 * 画面约定：北在上、东在左（与仰望星空时一致，也是星图的标准画法），所有坐标为 J2000。
 *
 * 依赖：数据文件 data/*.js 提供的 RaDecData（stars、starNames、constellations、milkyWay）。
 */
(function (root) {
  'use strict';

  var D2R = Math.PI / 180;
  var R2D = 180 / Math.PI;
  var TAU = Math.PI * 2;
  var OBLIQUITY_J2000 = 23.4392911 * D2R; // J2000 平黄赤交角，用于画黄道
  var FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif';
  // 界面语言（见 js/i18n.js）：决定星名、星座名与方位字的写法；单独使用本模块时为中文
  var I18n = root.RaDec && root.RaDec.I18n;
  var EN = !!(I18n && I18n.isEn);
  function T(s) {
    return I18n ? I18n.t(s) : s;
  }

  function clamp(x, lo, hi) {
    return x < lo ? lo : x > hi ? hi : x;
  }
  function vec(raDeg, decDeg) {
    var a = raDeg * D2R, d = decDeg * D2R, cd = Math.cos(d);
    return [cd * Math.cos(a), cd * Math.sin(a), Math.sin(d)];
  }
  function toRaDec(v) {
    var ra = Math.atan2(v[1], v[0]) * R2D;
    if (ra < 0) ra += 360;
    return { ra: ra, dec: Math.asin(clamp(v[2], -1, 1)) * R2D };
  }
  /** 球面线性插值：在两个单位向量之间按比例 t 取大圆上的点 */
  function slerp(a, b, t) {
    var d = clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1);
    var w = Math.acos(d);
    if (w < 1e-9) return a.slice();
    var s = Math.sin(w);
    var ka = Math.sin((1 - t) * w) / s, kb = Math.sin(t * w) / s;
    return [ka * a[0] + kb * b[0], ka * a[1] + kb * b[1], ka * a[2] + kb * b[2]];
  }
  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  // 北银极方向（J2000）。银河只分布在银道面附近，逐像素绘制银河时先用它求出银纬，远离银道面的像素直接跳过
  var NGP = vec(192.8594812065348, 27.12825118085622);
  // ImageData 按 R、G、B、A 的字节顺序存放；用 Uint32Array 一次写入整个像素时要考虑字节序（主流设备都是小端）
  var LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
  var ALPHA_SHIFT = LITTLE_ENDIAN ? 24 : 0;
  /** 把 RGBA 打包成一个 32 位整数，对应 Uint32Array 视图下 ImageData 的一个像素 */
  function packRGBA(r, g, b, a) {
    return (LITTLE_ENDIAN ? (a << 24 | b << 16 | g << 8 | r) : (r << 24 | g << 16 | b << 8 | a)) >>> 0;
  }
  // 地面遮罩的颜色（不含透明度，逐像素按深度叠加透明度）：地平线以下的"地面"、地平线上方的大气辉光
  var GROUND_RGB = packRGBA(10, 14, 16, 0);
  var GLOW_RGB = packRGBA(70, 100, 150, 0);

  /**
   * B−V 色指数 → 恒星颜色（参考 Mitchell Charity "What color are the stars?" 的色表，分段线性插值）
   * 蓝白色的热星 B−V 为负，橙红色的冷星 B−V 大于 1.4
   */
  var BV_STOPS = [
    [-0.4, [155, 178, 255]], [-0.1, [182, 200, 255]], [0.15, [222, 230, 255]], [0.4, [250, 248, 255]],
    [0.65, [255, 241, 222]], [0.95, [255, 223, 184]], [1.3, [255, 204, 150]], [1.7, [255, 182, 120]], [2.1, [255, 160, 100]]
  ];
  function bvColor(bv) {
    if (bv <= BV_STOPS[0][0]) return BV_STOPS[0][1];
    for (var i = 1; i < BV_STOPS.length; i++) {
      if (bv <= BV_STOPS[i][0]) {
        var a = BV_STOPS[i - 1], b = BV_STOPS[i], t = (bv - a[0]) / (b[0] - a[0]);
        return [0, 1, 2].map(function (k) { return Math.round(a[1][k] + (b[1][k] - a[1][k]) * t); });
      }
    }
    return BV_STOPS[BV_STOPS.length - 1][1];
  }

  /** 不同视场下的网格间隔：[赤经间隔(度), 赤纬间隔(度)] */
  function gridSteps(fov) {
    if (fov > 110) return [30, 20];
    if (fov > 45) return [15, 10];
    if (fov > 18) return [7.5, 5];
    return [2.5, 2];
  }

  /* =====================================================================
   * 构造函数
   * @param {HTMLCanvasElement} canvas  全屏背景画布
   * @param {object} data               RaDecData
   * @param {object} opts               { markers: {名称: DOM 元素}, onHover(info|null), onClick(info), onViewChange() }
   * ===================================================================== */
  function StarMap(canvas, data, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts || {};
    // 视图状态：中心赤经赤纬（度）、视场（度，指"焦点区域"短边对应的角直径）
    this.ra0 = 83.8;
    this.dec0 = -5.4;
    this.fov = 100;
    this.W = 0;
    this.H = 0;
    this.focus = null; // 焦点区域（CSS 像素），投影中心放在其中心
    this.layers = { milkyway: true, grid: true, lines: true, names: true, horizon: true };
    this.markers = {}; // 名称 → {v: 向量, el: DOM 元素}
    this.arc = null; // 两个标记之间的大圆弧 {a, b, label}
    this.horizon = null; // 地平线 {zenith, north}（J2000 单位向量）
    this.anim = null; // 进行中的飞行动画
    this.zoomTo = null; // 平滑缩放的目标视场（null 表示没有进行中的缩放）
    this._lastFrame = 0; // 动画进行中上一帧的时间戳（空闲时为 0），用于按真实时间推进缩放动画
    this.interacting = false; // 正在拖动/缩放（此时用低分辨率银河以保证流畅）
    this._raf = 0;
    this._hiresTimer = 0;
    this.reduceMotion = !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);

    this._prepareStars(data);
    this._prepareConstellations(data);
    this._prepareMilkyWay(data);
    this._bindEvents();
    this.resize();
  }

  var P = StarMap.prototype;

  /* ---------------------------------------------------------------------
   * 数据预处理（只在初始化时执行一次）
   * --------------------------------------------------------------------- */

  /** 把扁平数组形式的星表转成类型化数组，并预先算好每颗星的颜色分组 */
  P._prepareStars = function (data) {
    var s = data.stars;
    var n = s.length / 4;
    this.starCount = n;
    this.sx = new Float64Array(n);
    this.sy = new Float64Array(n);
    this.sz = new Float64Array(n);
    this.smag = new Float32Array(n);
    this.sra = new Float64Array(n);
    this.sdec = new Float64Array(n);
    this.sbucket = new Uint8Array(n);
    this.px = new Float32Array(n); // 每帧的屏幕坐标（不可见时为 NaN），供悬停/点击命中检测
    this.py = new Float32Array(n);
    this.pr = new Float32Array(n);
    // 颜色按 B−V 分 12 档、亮度按星等分 4 档，同一组的星合并成一条路径一次填充，减少绘制调用
    this.bucketStyles = [];
    var alphas = [0.55, 0.72, 0.88, 1];
    for (var c = 0; c < 12; c++) {
      var rgb = bvColor(-0.4 + c * 0.22);
      for (var a = 0; a < 4; a++) {
        this.bucketStyles.push('rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alphas[a] + ')');
      }
    }
    this.starRgb = [];
    for (var i = 0; i < n; i++) {
      var ra = s[4 * i], dec = s[4 * i + 1], mag = s[4 * i + 2], bv = s[4 * i + 3];
      var v = vec(ra, dec);
      this.sx[i] = v[0];
      this.sy[i] = v[1];
      this.sz[i] = v[2];
      this.sra[i] = ra;
      this.sdec[i] = dec;
      this.smag[i] = mag;
      var cIdx = clamp(Math.round((bv + 0.4) / 0.22), 0, 11);
      var aIdx = mag < 2.5 ? 3 : mag < 4 ? 2 : mag < 5.2 ? 1 : 0;
      this.sbucket[i] = cIdx * 4 + aIdx;
      this.starRgb.push(bvColor(bv));
    }
    // 星名表：序号 → {zh, en, bayer, flam, con, hip}
    this.names = new Map();
    this.labelStars = []; // 有当前语言星名的星（序号已按星等由亮到暗）
    var recs = (data.starNames || '').split(';');
    for (var k = 0; k < recs.length; k++) {
      if (!recs[k]) continue;
      var f = recs[k].split('|');
      var idx = +f[0];
      this.names.set(idx, { zh: f[1], en: f[2], bayer: f[3], flam: f[4], con: f[5], hip: f[6] });
      if (EN ? f[2] : f[1]) this.labelStars.push(idx);
    }
    this.labelStars.sort(function (x, y) { return x - y; });
  };

  /** 星座连线：把每段折线加密成间隔 ≤ 2° 的点列，使长线段也能画成正确的大圆弧 */
  P._prepareConstellations = function (data) {
    this.cons = (data.constellations || []).map(function (c) {
      var lines = c.lines.map(function (flat) {
        var pts = [];
        for (var i = 0; i + 1 < flat.length; i += 2) {
          var v = vec(flat[i], flat[i + 1]);
          if (pts.length) {
            var prev = pts[pts.length - 1];
            var ang = Math.acos(clamp(prev[0] * v[0] + prev[1] * v[1] + prev[2] * v[2], -1, 1)) * R2D;
            var nSub = Math.ceil(ang / 2);
            for (var k = 1; k < nSub; k++) pts.push(slerp(prev, v, k / nSub));
          }
          pts.push(v);
        }
        return pts;
      });
      // name：星图上显示的星座名（中文名或拉丁名）
      return { ab: c.ab, zh: c.zh, name: EN ? c.la : c.zh, rank: c.rank, label: vec(c.label[0], c.label[1]), lines: lines };
    });
  };

  /**
   * 银河亮度图：base64 → Uint8Array（等距圆柱投影，1° 分辨率），并预先算好：
   *   · 银河离银道面最远的银纬（更远的方向没有银河，逐像素绘制时直接跳过）；
   *   · 亮度 → 颜色的查找表（免去每个像素一次幂运算）。
   */
  P._prepareMilkyWay = function (data) {
    var mw = data.milkyWay;
    if (!mw) return;
    var bin = root.atob(mw.data);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    // 有亮度的格子中，离银道面最远的一个（用 |sin 银纬| 表示）
    var maxSinB = 0;
    for (var j = 0; j < mw.h; j++) {
      for (var k = 0; k < mw.w; k++) {
        if (arr[j * mw.w + k] < 2) continue;
        var v = vec(k + 0.5, 89.5 - j); // 格子中心
        var sb = Math.abs(v[0] * NGP[0] + v[1] * NGP[1] + v[2] * NGP[2]);
        if (sb > maxSinB) maxSinB = sb;
      }
    }
    // 再放宽 2°：格子本身宽 1°，双线性取样还会向外扩散约 1°
    var bLimit = Math.min(90, Math.asin(maxSinB) * R2D + 2);
    // 亮度（0~255）→ 颜色：暗处偏蓝、亮处偏暖白，模拟银河的颜色层次；亮度低于约 0.4% 时完全透明
    var lut = new Uint32Array(256);
    for (var n = 2; n < 256; n++) {
      var b = n / 255;
      lut[n] = packRGBA(Math.round(150 + 95 * b), Math.round(168 + 72 * b), Math.round(235 - 15 * b),
        Math.round(Math.min(255, 255 * 0.62 * Math.pow(b, 0.85))));
    }
    this.mw = { w: mw.w, h: mw.h, data: arr, lut: lut, sinBLimit: Math.sin(bLimit * D2R) };
  };

  /* ---------------------------------------------------------------------
   * 公共接口
   * --------------------------------------------------------------------- */

  /** 画布尺寸变化时调用（同时考虑高分屏的 devicePixelRatio） */
  P.resize = function () {
    var rect = this.canvas.getBoundingClientRect();
    this.W = Math.max(1, Math.round(rect.width));
    this.H = Math.max(1, Math.round(rect.height));
    this.dpr = Math.min(root.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    if (!this.focus) this.focus = { x: 0, y: 0, w: this.W, h: this.H };
    this.requestRender();
  };

  /** 设置"焦点区域"：投影中心与目标会放在这个矩形的中心（桌面端是右侧未被面板遮挡的区域） */
  P.setFocusRect = function (r) {
    this.focus = { x: r.x, y: r.y, w: Math.max(50, r.w), h: Math.max(50, r.h) };
    this.requestRender();
  };

  P.setLayers = function (layers) {
    for (var k in layers) this.layers[k] = !!layers[k];
    this.requestRender();
  };

  /** 立即切换视图中心/视场 */
  P.setView = function (ra, dec, fov) {
    this.anim = null;
    this.zoomTo = null;
    this.ra0 = ra;
    this.dec0 = clamp(dec, -90, 90);
    if (fov) this.fov = clamp(fov, 8, 200);
    this.requestRender();
  };

  /** 平滑飞行到指定中心（沿大圆插值），可同时改变视场 */
  P.flyTo = function (ra, dec, o) {
    o = o || {};
    var to = vec(ra, dec);
    var from = vec(this.ra0, this.dec0);
    // 若正在平滑缩放，以缩放的目标视场为准，并交给飞行动画一起完成
    var fov1 = o.fov ? clamp(o.fov, 8, 200) : (this.zoomTo != null ? this.zoomTo : this.fov);
    this.zoomTo = null;
    if (this.reduceMotion || o.duration === 0) {
      this.setView(ra, dec, fov1);
      return;
    }
    var ang = Math.acos(clamp(from[0] * to[0] + from[1] * to[1] + from[2] * to[2], -1, 1)) * R2D;
    // 几乎对跖的两点之间大圆不唯一，先经过一个侧向中间点
    if (ang > 179) from = slerp(from, [0, 0, from[2] >= 0 ? 1 : -1], 0.01);
    this.anim = {
      from: from, to: to, fov0: this.fov, fov1: fov1, t0: performance.now(),
      dur: o.duration || clamp(500 + ang * 7, 600, 1600)
    };
    this.requestRender();
  };

  /**
   * 缩放视场（factor < 1 放大，> 1 缩小）。
   * 默认平滑过渡（滚轮、按钮：一次滚动不再"跳"一下）；immediate 为 true 时立即生效（双指缩放需要跟手）
   */
  P.zoomBy = function (factor, immediate) {
    if (this.anim) {
      // 飞行途中缩放：调整飞行终点的视场，由飞行动画平滑过渡过去
      this.anim.fov1 = clamp(this.anim.fov1 * factor, 8, 200);
      this.requestRender();
      return;
    }
    var target = clamp((this.zoomTo != null ? this.zoomTo : this.fov) * factor, 8, 200);
    if (immediate || this.reduceMotion) {
      this.fov = target;
      this.zoomTo = null;
    } else {
      this.zoomTo = target; // 在 _frame() 中逐帧逼近
    }
    this._markInteracting();
    this.requestRender();
  };

  /** 设置/清除标记（target、secondary 等），DOM 元素在构造时通过 opts.markers 传入 */
  P.setMarker = function (name, pos) {
    var el = this.opts.markers && this.opts.markers[name];
    if (!pos) {
      delete this.markers[name];
      if (el) el.hidden = true;
    } else {
      this.markers[name] = { v: vec(pos.ra, pos.dec), el: el };
    }
    this.requestRender();
  };

  /** 设置两个天体之间的大圆弧（角距离），label 显示在弧的中点 */
  P.setArc = function (a, b, label) {
    this.arc = a && b ? { a: vec(a.ra, a.dec), b: vec(b.ra, b.dec), label: label || '' } : null;
    this.requestRender();
  };

  /** 设置地平线：zenith 为天顶方向、north 为北点方向（均为 J2000 单位向量）；传 null 取消 */
  P.setHorizon = function (h) {
    this.horizon = h;
    this.requestRender();
  };

  /** 屏幕坐标 → 天球坐标 {ra, dec}（J2000，度） */
  P.screenToSky = function (x, y) {
    this._updateBasis();
    return toRaDec(this._unproject(x, y));
  };

  /** 星的详细信息（用于悬停提示和搜索） */
  P.starInfo = function (i) {
    var n = this.names.get(i) || {};
    var desig = '';
    if (n.bayer) desig = n.bayer + ' ' + n.con;
    else if (n.flam) desig = n.flam + ' ' + n.con;
    return {
      index: i, ra: this.sra[i], dec: this.sdec[i], mag: this.smag[i],
      zh: n.zh || '', en: n.en || '', bayer: n.bayer || '', flam: n.flam || '', con: n.con || '',
      hip: n.hip || '', desig: desig
    };
  };

  /** 所有有名称的星的序号 */
  P.namedStars = function () {
    return Array.from(this.names.keys());
  };

  /** 请求重绘（同一帧内多次调用只会绘制一次） */
  P.requestRender = function () {
    if (this._raf) return;
    var self = this;
    this._raf = root.requestAnimationFrame(function (t) {
      self._raf = 0;
      self._frame(t);
    });
  };

  /* ---------------------------------------------------------------------
   * 投影
   * --------------------------------------------------------------------- */

  /** 根据当前视图中心计算投影基向量：ec 指向中心，ee 指向东，en 指向北 */
  P._updateBasis = function () {
    var a = this.ra0 * D2R, d = this.dec0 * D2R;
    var ca = Math.cos(a), sa = Math.sin(a), cd = Math.cos(d), sd = Math.sin(d);
    this.ec = [cd * ca, cd * sa, sd];
    this.ee = [-sa, ca, 0];
    this.en = [-sd * ca, -sd * sa, cd];
    var f = this.focus || { x: 0, y: 0, w: this.W, h: this.H };
    var R = Math.min(f.w, f.h) / 2;
    // 球极投影：离中心角距 c 的点到中心的距离 r = scale·2·tan(c/2)；令视场边缘落在焦点区域短边的一半处
    this.scale = R / (2 * Math.tan(this.fov * D2R / 4));
    this.cx = f.x + f.w / 2;
    this.cy = f.y + f.h / 2;
    // 屏幕最远角对应的角距，超过它的点不必计算（最多到 165°，避免对跖点附近的数值发散）
    var dx = Math.max(this.cx, this.W - this.cx), dy = Math.max(this.cy, this.H - this.cy);
    var cmax = Math.min(2 * Math.atan((Math.sqrt(dx * dx + dy * dy) + 30) / (2 * this.scale)), 165 * D2R);
    this.zCut = Math.cos(cmax);
  };

  /** 单位向量 → 屏幕坐标，写入 out[0], out[1]；在可见范围外返回 false */
  P._project = function (v, out) {
    var ec = this.ec, ee = this.ee, en = this.en;
    var Z = v[0] * ec[0] + v[1] * ec[1] + v[2] * ec[2];
    if (Z < this.zCut) return false;
    var X = v[0] * ee[0] + v[1] * ee[1];
    var Y = v[0] * en[0] + v[1] * en[1] + v[2] * en[2];
    var k = 2 * this.scale / (1 + Z);
    out[0] = this.cx - k * X; // 东在左
    out[1] = this.cy - k * Y; // 北在上
    return true;
  };

  /** 屏幕坐标 → 单位向量（球极投影的逆变换） */
  P._unproject = function (x, y) {
    var Xp = (this.cx - x) / this.scale, Yp = (this.cy - y) / this.scale;
    var r2 = Xp * Xp + Yp * Yp;
    var Z = (4 - r2) / (4 + r2);
    var f = (1 + Z) / 2;
    var X = Xp * f, Y = Yp * f;
    var ec = this.ec, ee = this.ee, en = this.en;
    return [X * ee[0] + Y * en[0] + Z * ec[0], X * ee[1] + Y * en[1] + Z * ec[1], Y * en[2] + Z * ec[2]];
  };

  /* ---------------------------------------------------------------------
   * 渲染主流程
   * --------------------------------------------------------------------- */

  P._frame = function (now) {
    // 距上一帧的毫秒数（最多按 100ms 计）；动画开始后的第一帧（之前处于空闲）按 16ms 计，避免一下子跳太多
    var dt = this._lastFrame ? clamp(now - this._lastFrame, 1, 100) : 16;
    // 推进飞行动画
    if (this.anim) {
      var a = this.anim;
      var t = clamp((now - a.t0) / a.dur, 0, 1);
      var e = easeInOutCubic(t);
      var c = toRaDec(slerp(a.from, a.to, e));
      this.ra0 = c.ra;
      this.dec0 = c.dec;
      this.fov = a.fov0 + (a.fov1 - a.fov0) * e;
      if (t >= 1) {
        this.anim = null;
        this._scheduleHires();
      }
    }
    // 平滑缩放：视场按指数方式逼近目标（时间常数约 60ms），在对数空间插值，使放大和缩小的手感一致
    if (this.zoomTo != null) {
      var kz = 1 - Math.exp(-dt / 60);
      this.fov = Math.exp(Math.log(this.fov) + (Math.log(this.zoomTo) - Math.log(this.fov)) * kz);
      if (Math.abs(this.fov / this.zoomTo - 1) < 0.002) {
        this.fov = this.zoomTo;
        this.zoomTo = null;
      }
      this._markInteracting();
    }
    this._render();
    // 动画还没结束就预约下一帧，并记下本帧时间；结束后清零，下次动画从"第一帧"开始计时
    if (this.anim || this.zoomTo != null) {
      this._lastFrame = now;
      this.requestRender();
    } else {
      this._lastFrame = 0;
    }
  };

  P._render = function () {
    var ctx = this.ctx, W = this.W, H = this.H;
    this._updateBasis();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // 1) 深空背景：以焦点为中心的径向渐变（渐变对象只在中心或画布尺寸变化时重建）
    var bgKey = this.cx + ',' + this.cy + ',' + W + ',' + H;
    if (this._bgKey !== bgKey) {
      var g = ctx.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, Math.max(W, H) * 0.9);
      g.addColorStop(0, '#0b1533');
      g.addColorStop(0.55, '#060b1d');
      g.addColorStop(1, '#02040b');
      this._bg = g;
      this._bgKey = bgKey;
    }
    ctx.fillStyle = this._bg;
    ctx.fillRect(0, 0, W, H);

    // 2) 银河与"地面"遮罩：低分辨率逐像素计算后放大（天然柔和）。
    //    纹理的像素总数有上限——交互时（拖动、缩放、飞行）约 4.5 万、静止时约 16 万，
    //    屏幕再大每帧的计算量也基本不变；停下来后再补画一帧更精细的版本
    var lowres = this.anim || this.interacting;
    var area = W * H;
    var step = lowres ? Math.max(5, Math.sqrt(area / 45000)) : Math.max(4, Math.sqrt(area / 160000));
    this._renderSkyTexture(step);
    // 交互时用双线性放大（开销小），静止时用高质量插值；只放大银河所在的那一块（视野里没有银河就不画）
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = lowres ? 'low' : 'high';
    if (this.layers.milkyway && this.mw) this._drawTexture(this.mwCanvas, this.mwBox, step);

    // 3) 坐标网格、天赤道、黄道
    this.gridLabels = [];
    if (this.layers.grid) this._drawGrid();

    // 4) 星座连线
    if (this.layers.lines) this._drawConstellationLines();

    // 5) 恒星
    this._drawStars();

    // 6) 地平线以下的地面遮罩（画在星星之后，让地平线下的星变暗）；同样只放大有内容的那一块
    var showHorizon = this.layers.horizon && this.horizon;
    if (showHorizon) {
      this._drawTexture(this.groundCanvas, this.groundBox, step);
      this._drawHorizon();
    }

    // 7) 文字标注
    if (this.layers.names) this._drawLabels();
    if (this.layers.grid) this._drawGridLabels();

    // 8) 两个目标之间的大圆弧，以及 DOM 标记的位置
    if (this.arc) this._drawArc();
    this._positionMarkers();

    if (this.opts.onViewChange) this.opts.onViewChange(this);
  };

  /**
   * 把低分辨率纹理中 box（[起始列, 起始行, 结束列, 结束行]）这一块放大画到屏幕上。
   * 纹理第 i 列的中心对应屏幕 (i + 0.5)·step；向外多取 1 个纹理像素，让边缘平滑过渡到透明。
   * 放大是软件绘制时最耗时的操作之一，只画有内容的部分能省下不少时间。
   */
  P._drawTexture = function (canvas, box, step) {
    if (!box) return;
    var sx = Math.max(0, box[0] - 1), sy = Math.max(0, box[1] - 1);
    var sw = Math.min(this.texW, box[2] + 2) - sx, sh = Math.min(this.texH, box[3] + 2) - sy;
    this.ctx.drawImage(canvas, sx, sy, sw, sh, sx * step, sy * step, sw * step, sh * step);
  };

  /**
   * 逐像素（低分辨率）计算银河亮度和地平线遮罩：
   * 对每个低分辨率像素做逆投影得到天球方向，再在 1° 分辨率的银河亮度图上双线性取样。
   * 这种"逆向重投影"不受投影方式影响，也不存在多边形跨 0h/24h 的接缝问题。
   * 这是每帧最耗时的一步，为此做了几处优化：
   *   · 先用 3 次乘法求出银纬，远离银道面（没有银河）的像素直接跳过，不做反三角函数和取样；
   *   · 亮度 → 颜色用查找表，每个像素通过 Uint32Array 一次写入；
   *   · 记下银河、地面遮罩中有内容的范围（mwBox、groundBox），绘制时只放大这一块。
   * @param {number} step 一个纹理像素对应的屏幕像素数（可以是小数）
   */
  P._renderSkyTexture = function (step) {
    var W = this.W, H = this.H;
    var w = Math.max(1, Math.ceil(W / step)), h = Math.max(1, Math.ceil(H / step));
    if (!this.mwCanvas || this.mwCanvas.width !== w || this.mwCanvas.height !== h) {
      this.mwCanvas = document.createElement('canvas');
      this.mwCanvas.width = w;
      this.mwCanvas.height = h;
      this.mwCtx = this.mwCanvas.getContext('2d');
      this.mwImg = this.mwCtx.createImageData(w, h);
      this.mwBuf = new Uint32Array(this.mwImg.data.buffer); // 同一块内存的 32 位视图：一次写一个像素
      this.groundCanvas = document.createElement('canvas');
      this.groundCanvas.width = w;
      this.groundCanvas.height = h;
      this.groundCtx = this.groundCanvas.getContext('2d');
      this.groundImg = this.groundCtx.createImageData(w, h);
      this.groundBuf = new Uint32Array(this.groundImg.data.buffer);
    }
    this.texW = w;
    this.texH = h;
    var mw = this.mw;
    var doMw = !!(this.layers.milkyway && mw);
    var zen = this.layers.horizon && this.horizon ? this.horizon.zenith : null;
    if (!doMw && !zen) return; // 两个图层都关闭时无需逐像素计算
    var out = this.mwBuf, gout = this.groundBuf;
    var ec = this.ec, ee = this.ee, en = this.en, scale = this.scale, cx = this.cx, cy = this.cy, zCut = this.zCut;
    var MW = mw ? mw.w : 0, MH = mw ? mw.h : 0, md = mw ? mw.data : null, lut = mw ? mw.lut : null;
    var sinB = mw ? mw.sinBLimit : 0;
    // 像素方向 v = X·ee + Y·en + Z·ec。预先算好三个基向量与北银极、天顶的点积，
    // 每个像素的 sin(银纬)、sin(高度角) 就只需 3 次乘法
    var ge = ee[0] * NGP[0] + ee[1] * NGP[1] + ee[2] * NGP[2];
    var gn = en[0] * NGP[0] + en[1] * NGP[1] + en[2] * NGP[2];
    var gc = ec[0] * NGP[0] + ec[1] * NGP[1] + ec[2] * NGP[2];
    var ze = 0, zn = 0, zc = 0;
    if (zen) {
      ze = ee[0] * zen[0] + ee[1] * zen[1] + ee[2] * zen[2];
      zn = en[0] * zen[0] + en[1] * zen[1] + en[2] * zen[2];
      zc = ec[0] * zen[0] + ec[1] * zen[1] + ec[2] * zen[2];
    }
    // 银河、地面遮罩中有内容的范围：列 x0~x1、行 y0~y1
    var mx0 = w, mx1 = -1, my0 = h, my1 = -1;
    var gx0 = w, gx1 = -1, gy0 = h, gy1 = -1;

    var k = 0; // 当前像素在纹理中的序号
    for (var j = 0; j < h; j++) {
      var Yp = (cy - (j + 0.5) * step) / scale;
      var Y2 = Yp * Yp;
      for (var i = 0; i < w; i++, k++) {
        // 球极投影的逆变换：得到局部坐标 X（东）、Y（北）、Z（指向视图中心）
        var Xp = (cx - (i + 0.5) * step) / scale;
        var r2 = Xp * Xp + Y2;
        var q = 1 / (4 + r2);
        var Z = (4 - r2) * q;
        if (Z < zCut) {
          out[k] = 0;
          gout[k] = 0;
          continue;
        }
        var X = 4 * Xp * q, Y = 4 * Yp * q;

        if (doMw) {
          var sb = X * ge + Y * gn + Z * gc; // sin(银纬)
          if (sb > sinB || sb < -sinB) {
            out[k] = 0; // 远离银道面，没有银河
          } else {
            var vx = X * ee[0] + Y * en[0] + Z * ec[0];
            var vy = X * ee[1] + Y * en[1] + Z * ec[1];
            var vz = Y * en[2] + Z * ec[2];
            var ra = Math.atan2(vy, vx) * R2D;
            if (ra < 0) ra += 360;
            var dec = Math.asin(vz > 1 ? 1 : vz < -1 ? -1 : vz) * R2D;
            // 在亮度图上双线性取样（赤经方向首尾相接）
            var u = ra - 0.5, vv = 89.5 - dec;
            var i0 = Math.floor(u), j0 = Math.floor(vv);
            var fu = u - i0, fv = vv - j0;
            var ia = (i0 + MW) % MW, ib = (i0 + 1 + MW) % MW;
            var ja = j0 < 0 ? 0 : j0 >= MH ? MH - 1 : j0;
            var jb = j0 + 1 >= MH ? MH - 1 : j0 + 1 < 0 ? 0 : j0 + 1;
            var val = (md[ja * MW + ia] * (1 - fu) + md[ja * MW + ib] * fu) * (1 - fv) +
              (md[jb * MW + ia] * (1 - fu) + md[jb * MW + ib] * fu) * fv;
            var c = lut[(val + 0.5) | 0];
            out[k] = c;
            if (c !== 0) {
              if (i < mx0) mx0 = i;
              if (i > mx1) mx1 = i;
              if (j < my0) my0 = j;
              my1 = j;
            }
          }
        }

        if (zen) {
          var s = X * ze + Y * zn + Z * zc; // sin(高度角)
          if (s < 0.14) {
            if (s < 0) {
              // 地平线以下：越往下越暗
              var depth = -s / 0.12;
              gout[k] = GROUND_RGB | ((255 * (0.5 + 0.32 * (depth > 1 ? 1 : depth))) << ALPHA_SHIFT);
            } else {
              // 地平线附近的一抹大气辉光
              gout[k] = GLOW_RGB | ((255 * 0.12 * (1 - s / 0.14)) << ALPHA_SHIFT);
            }
            if (i < gx0) gx0 = i;
            if (i > gx1) gx1 = i;
            if (j < gy0) gy0 = j;
            gy1 = j;
          } else {
            gout[k] = 0;
          }
        }
      }
    }
    if (doMw) {
      this.mwBox = mx1 >= 0 ? [mx0, my0, mx1, my1] : null;
      if (this.mwBox) this.mwCtx.putImageData(this.mwImg, 0, 0);
    }
    if (zen) {
      this.groundBox = gx1 >= 0 ? [gx0, gy0, gx1, gy1] : null;
      if (this.groundBox) this.groundCtx.putImageData(this.groundImg, 0, 0);
    }
  };

  /**
   * 沿一串单位向量描折线：遇到不可见的点或跨度异常大的线段时断开，避免出现横穿屏幕的直线；
   * 两端都在屏幕同一侧之外的线段不可能经过屏幕，也直接跳过，减少浏览器描边的工作量
   */
  P._tracePath = function (ctx, points) {
    var p = [0, 0];
    var pen = false, lx = 0, ly = 0, lc = 0;
    var W = this.W, H = this.H, M = 40; // M：屏幕边缘外留出的余量（像素）
    var maxJump = Math.max(W, H) * 0.7;
    for (var i = 0; i < points.length; i++) {
      if (!this._project(points[i], p)) {
        pen = false;
        continue;
      }
      // 点在屏幕外的哪一侧：左 1、右 2、上 4、下 8（在屏幕内为 0）
      var c = (p[0] < -M ? 1 : p[0] > W + M ? 2 : 0) | (p[1] < -M ? 4 : p[1] > H + M ? 8 : 0);
      if (pen && (c & lc) === 0 && Math.abs(p[0] - lx) + Math.abs(p[1] - ly) < maxJump) {
        ctx.lineTo(p[0], p[1]);
      } else {
        ctx.moveTo(p[0], p[1]);
      }
      pen = true;
      lx = p[0];
      ly = p[1];
      lc = c;
    }
  };

  /**
   * 网格线、天赤道、黄道上的采样点（每 2° 一个）。它们只与网格间隔有关、与视图无关，
   * 按间隔缓存起来，避免每帧重新创建上万个小数组（也减少垃圾回收造成的卡顿）
   */
  P._gridPoints = function (raStep, decStep) {
    var key = raStep + '/' + decStep;
    if (this._grid && this._grid.key === key) return this._grid;
    var mer = [], par = [], eq = [], ecl = [];
    for (var ra = 0; ra < 360 - 1e-6; ra += raStep) {
      var pts = [];
      for (var d = -88; d <= 88; d += 2) pts.push(vec(ra, d));
      mer.push({ ra: ra, pts: pts });
    }
    for (var dec = -90 + decStep; dec < 90 - 1e-6; dec += decStep) {
      if (Math.abs(dec) < 1e-6) continue; // 天赤道单独画
      var pts2 = [];
      for (var r = 0; r <= 360; r += 2) pts2.push(vec(r, dec));
      par.push({ dec: dec, pts: pts2 });
    }
    var ce = Math.cos(OBLIQUITY_J2000), se = Math.sin(OBLIQUITY_J2000);
    for (var e = 0; e <= 360; e += 2) {
      eq.push(vec(e, 0));
      var l = e * D2R;
      ecl.push([Math.cos(l), Math.sin(l) * ce, Math.sin(l) * se]); // 黄道（J2000）
    }
    this._grid = { key: key, mer: mer, par: par, eq: eq, ecl: ecl };
    return this._grid;
  };

  /** 赤经赤纬网格 + 天赤道 + 黄道，同时记录网格线与焦点区域边缘的交点，用于放标签 */
  P._drawGrid = function () {
    var ctx = this.ctx;
    var steps = gridSteps(this.fov);
    var raStep = steps[0];
    var G = this._gridPoints(steps[0], steps[1]);
    var f = this.focus;
    var labelY = f.y + f.h - 16; // 赤经标签放在焦点区域底边附近
    var labelX = f.x + 10; // 赤纬标签放在焦点区域左边附近
    var self = this;
    var p = [0, 0], q = [0, 0];

    // 赤经线（子午圈）
    ctx.beginPath();
    for (var a = 0; a < G.mer.length; a++) {
      var ra = G.mer[a].ra, pts = G.mer[a].pts;
      this._tracePath(ctx, pts);
      // 找这条线与底边的交点
      for (var k = 0; k + 1 < pts.length; k++) {
        if (this._project(pts[k], p) && this._project(pts[k + 1], q) &&
          (p[1] - labelY) * (q[1] - labelY) <= 0 && p[1] !== q[1]) {
          var x = p[0] + (q[0] - p[0]) * (labelY - p[1]) / (q[1] - p[1]);
          if (x > f.x + 40 && x < f.x + f.w - 20) {
            self.gridLabels.push({ x: x, y: labelY, text: self._raLabel(ra, raStep), align: 'center' });
            break;
          }
        }
      }
    }
    ctx.strokeStyle = 'rgba(120, 160, 255, 0.13)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 赤纬线（赤纬圈），天赤道单独加亮
    ctx.beginPath();
    for (var b = 0; b < G.par.length; b++) {
      var dec = G.par[b].dec, pts2 = G.par[b].pts;
      this._tracePath(ctx, pts2);
      for (var m = 0; m + 1 < pts2.length; m++) {
        if (this._project(pts2[m], p) && this._project(pts2[m + 1], q) &&
          (p[0] - labelX) * (q[0] - labelX) <= 0 && p[0] !== q[0]) {
          var y = p[1] + (q[1] - p[1]) * (labelX - p[0]) / (q[0] - p[0]);
          if (y > f.y + 20 && y < f.y + f.h - 36) {
            self.gridLabels.push({ x: labelX, y: y, text: (dec > 0 ? '+' : '') + dec + '°', align: 'left' });
            break;
          }
        }
      }
    }
    ctx.stroke();

    // 天赤道
    ctx.beginPath();
    this._tracePath(ctx, G.eq);
    ctx.strokeStyle = 'rgba(120, 175, 255, 0.32)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // 黄道（J2000）
    ctx.beginPath();
    this._tracePath(ctx, G.ecl);
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(240, 190, 90, 0.38)';
    ctx.lineWidth = 1.1;
    ctx.stroke();
    ctx.setLineDash([]);
  };

  P._raLabel = function (raDeg, step) {
    var h = raDeg / 15;
    if (step >= 15) return Math.round(h) + 'h';
    var hh = Math.floor(h + 1e-9), mm = Math.round((h - hh) * 60);
    if (mm === 60) { hh += 1; mm = 0; }
    return hh + 'h' + (mm ? (mm < 10 ? '0' : '') + mm + 'm' : '');
  };

  P._drawGridLabels = function () {
    var ctx = this.ctx;
    ctx.font = '11px ' + FONT;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(150, 185, 255, 0.55)';
    for (var i = 0; i < this.gridLabels.length; i++) {
      var L = this.gridLabels[i];
      ctx.textAlign = L.align;
      ctx.fillText(L.text, L.x, L.y);
    }
  };

  P._drawConstellationLines = function () {
    var ctx = this.ctx;
    ctx.beginPath();
    for (var i = 0; i < this.cons.length; i++) {
      var lines = this.cons[i].lines;
      for (var k = 0; k < lines.length; k++) this._tracePath(ctx, lines[k]);
    }
    ctx.strokeStyle = 'rgba(125, 170, 255, 0.30)';
    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';
    ctx.stroke();
  };

  /** 恒星：按颜色/亮度分组合并路径；亮星额外加柔和的光晕 */
  P._drawStars = function () {
    var ctx = this.ctx, W = this.W, H = this.H;
    var n = this.starCount;
    var ec = this.ec, ee = this.ee, en = this.en, zCut = this.zCut, scale2 = 2 * this.scale, cx = this.cx, cy = this.cy;
    // 视场越小（放大）星点越大一些，但不过分夸张
    var sizeK = clamp(Math.pow(100 / this.fov, 0.3), 0.8, 2.0);
    // 半径小于约 1.2 个设备像素的暗星（通常占可见星的九成以上）画成等面积的小方块：
    // 抗锯齿后看上去和圆点一样，但浏览器光栅化方块比圆快得多
    var tiny = 1.2 / this.dpr;
    var paths = new Array(this.bucketStyles.length);
    var glows = [];
    for (var i = n - 1; i >= 0; i--) {
      var x0 = this.sx[i], y0 = this.sy[i], z0 = this.sz[i];
      var Z = x0 * ec[0] + y0 * ec[1] + z0 * ec[2];
      if (Z < zCut) {
        this.px[i] = NaN;
        continue;
      }
      var k = scale2 / (1 + Z);
      var x = cx - k * (x0 * ee[0] + y0 * ee[1]);
      var y = cy - k * (x0 * en[0] + y0 * en[1] + z0 * en[2]);
      if (x < -8 || y < -8 || x > W + 8 || y > H + 8) {
        this.px[i] = NaN;
        continue;
      }
      var m = this.smag[i];
      var r = Math.max(0.5, (6.6 - m) * 0.4) * sizeK;
      this.px[i] = x;
      this.py[i] = y;
      this.pr[i] = r;
      var b = this.sbucket[i];
      var path = paths[b] || (paths[b] = new Path2D());
      if (r < tiny) {
        var hs = r * 0.8862; // 半边长 = r·√π / 2，使方块面积等于圆面积
        path.rect(x - hs, y - hs, hs * 2, hs * 2);
      } else {
        path.moveTo(x + r, y);
        path.arc(x, y, r, 0, TAU);
      }
      if (m < 2.3) glows.push(i);
    }
    for (var s = 0; s < paths.length; s++) {
      if (!paths[s]) continue;
      ctx.fillStyle = this.bucketStyles[s];
      ctx.fill(paths[s]);
    }
    // 亮星光晕（叠加混合）
    ctx.globalCompositeOperation = 'lighter';
    for (var gi = 0; gi < glows.length; gi++) {
      var idx = glows[gi];
      var gx = this.px[idx], gy = this.py[idx], gr = this.pr[idx] * 4.2;
      var rgb = this.starRgb[idx];
      var strength = clamp((2.3 - this.smag[idx]) / 3.5, 0.08, 0.45);
      var grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
      grad.addColorStop(0, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + strength + ')');
      grad.addColorStop(1, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0)');
      ctx.fillStyle = grad;
      ctx.fillRect(gx - gr, gy - gr, gr * 2, gr * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
  };

  /** 地平线（大圆）与东南西北方位标注 */
  P._drawHorizon = function () {
    var ctx = this.ctx;
    var z = this.horizon.zenith;
    // 地平圈上的采样点和四个方位点只在地平线变化时（约每 10 秒）重新计算
    if (this._hzFor !== this.horizon) {
      var nrt = this.horizon.north;
      // 东方向 = 北 × 天顶
      var east = [nrt[1] * z[2] - nrt[2] * z[1], nrt[2] * z[0] - nrt[0] * z[2], nrt[0] * z[1] - nrt[1] * z[0]];
      var around = function (deg) {
        var t = deg * D2R, c = Math.cos(t), s = Math.sin(t);
        return [c * nrt[0] + s * east[0], c * nrt[1] + s * east[1], c * nrt[2] + s * east[2]];
      };
      var ring = [];
      for (var a = 0; a <= 360; a += 2) ring.push(around(a));
      this._hzRing = ring;
      this._hzCards = [[T('北'), around(0)], [T('东'), around(90)], [T('南'), around(180)], [T('西'), around(270)]];
      this._hzFor = this.horizon;
    }
    ctx.beginPath();
    this._tracePath(ctx, this._hzRing);
    ctx.strokeStyle = 'rgba(140, 230, 180, 0.55)';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    var cards = this._hzCards;
    var p = [0, 0];
    ctx.font = '600 13px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var i = 0; i < cards.length; i++) {
      var v = cards[i][1];
      if (!this._project(v, p)) continue;
      ctx.fillStyle = 'rgba(8, 20, 16, 0.75)';
      ctx.beginPath();
      ctx.arc(p[0], p[1], 11, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(160, 240, 195, 0.95)';
      ctx.fillText(cards[i][0], p[0], p[1] + 0.5);
    }
    // 天顶
    if (this._project(z, p)) {
      ctx.strokeStyle = 'rgba(140, 230, 180, 0.6)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(p[0] - 6, p[1]);
      ctx.lineTo(p[0] + 6, p[1]);
      ctx.moveTo(p[0], p[1] - 6);
      ctx.lineTo(p[0], p[1] + 6);
      ctx.stroke();
      ctx.font = '11px ' + FONT;
      ctx.fillStyle = 'rgba(160, 240, 195, 0.8)';
      ctx.fillText(T('天顶'), p[0], p[1] + 16);
    }
  };

  /** 星座名与亮星星名；用简单的矩形碰撞检测避免文字互相重叠 */
  P._drawLabels = function () {
    var ctx = this.ctx;
    var placed = [];
    function free(x, y, w, h) {
      for (var i = 0; i < placed.length; i++) {
        var r = placed[i];
        if (x < r[0] + r[2] && x + w > r[0] && y < r[1] + r[3] && y + h > r[1]) return false;
      }
      placed.push([x, y, w, h]);
      return true;
    }
    var p = [0, 0];
    // 目标准星及其名称标签所在区域预先占位，避免星图自身的星名与之重叠
    for (var mk in this.markers) {
      var mm = this.markers[mk];
      if (!this._project(mm.v, p)) continue;
      placed.push([p[0] - 24, p[1] - 24, 48, 48]); // 准星本身
      var lab = mm.el && mm.el.querySelector('.marker__label');
      var lw = lab ? lab.textContent.length * 12 + 20 : 80; // 按文字长度估算标签宽度（不读取布局，避免强制重排）
      placed.push([p[0] + 14, p[1] - 38, lw, 24]);
    }
    // 星座名：视场大时只显示主要星座
    var maxRank = this.fov > 140 ? 1 : this.fov > 80 ? 2 : 3;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var i = 0; i < this.cons.length; i++) {
      var c = this.cons[i];
      if (c.rank > maxRank || !this._project(c.label, p)) continue;
      var size = c.rank === 1 ? 14 : c.rank === 2 ? 13 : 12;
      ctx.font = size + 'px ' + FONT;
      var w = this._textWidth(ctx, size, c.name);
      if (!free(p[0] - w / 2 - 2, p[1] - size / 2 - 2, w + 4, size + 4)) continue;
      ctx.fillStyle = 'rgba(150, 180, 245, 0.5)';
      ctx.fillText(c.name, p[0], p[1]);
    }
    // 亮星星名
    var magLimit = this.fov > 140 ? 1.3 : this.fov > 90 ? 1.9 : this.fov > 50 ? 2.6 : this.fov > 25 ? 3.4 : 4.5;
    ctx.font = '12px ' + FONT;
    ctx.textAlign = 'left';
    for (var k = 0; k < this.labelStars.length; k++) {
      var idx = this.labelStars[k];
      if (this.smag[idx] > magLimit) break;
      var x = this.px[idx];
      if (x !== x) continue; // NaN：不可见
      var y = this.py[idx], r = this.pr[idx];
      var nm = this.names.get(idx);
      var name = EN ? nm.en : nm.zh;
      var tw = this._textWidth(ctx, 12, name);
      if (!free(x + r + 3, y - 8, tw + 2, 16)) continue;
      ctx.fillStyle = 'rgba(235, 225, 200, 0.78)';
      ctx.fillText(name, x + r + 4, y + 1);
    }
  };

  /** 文字宽度：按"字号 + 文字"缓存（星名、星座名是固定的一批），避免每帧重复测量 */
  P._textWidth = function (ctx, size, text) {
    var cache = this._widths || (this._widths = new Map());
    var key = size + '|' + text;
    var w = cache.get(key);
    if (w === undefined) {
      w = ctx.measureText(text).width;
      cache.set(key, w);
    }
    return w;
  };

  /** 两个目标之间的大圆弧（虚线）及中点处的角距离文字 */
  P._drawArc = function () {
    var ctx = this.ctx, a = this.arc.a, b = this.arc.b;
    var ang = Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1)) * R2D;
    var n = Math.max(2, Math.ceil(ang / 1));
    var pts = [];
    for (var i = 0; i <= n; i++) pts.push(slerp(a, b, i / n));
    ctx.beginPath();
    this._tracePath(ctx, pts);
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = 'rgba(120, 210, 255, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
    var p = [0, 0], pa = [0, 0], pb = [0, 0];
    if (this.arc.label && this._project(slerp(a, b, 0.5), p)) {
      // 标签沿弧线的垂直方向偏移一段距离，避免两个目标很近时压住准星
      if (this._project(a, pa) && this._project(b, pb)) {
        var dx = pb[0] - pa[0], dy = pb[1] - pa[1], len = Math.sqrt(dx * dx + dy * dy) || 1;
        var nx = -dy / len, ny = dx / len;
        if (ny > 0) { nx = -nx; ny = -ny; } // 统一偏向画面上方
        var off = len < 160 ? 26 : 14;
        p[0] += nx * off;
        p[1] += ny * off;
      }
      ctx.font = '600 12px ' + FONT;
      var w = ctx.measureText(this.arc.label).width + 12;
      ctx.fillStyle = 'rgba(6, 14, 30, 0.82)';
      ctx.fillRect(p[0] - w / 2, p[1] - 11, w, 22);
      ctx.fillStyle = 'rgba(150, 225, 255, 0.95)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.arc.label, p[0], p[1] + 0.5);
    }
  };

  /** 把 DOM 标记（目标准星）移动到对应的屏幕位置 */
  P._positionMarkers = function () {
    var p = [0, 0];
    for (var name in this.markers) {
      var m = this.markers[name];
      if (!m.el) continue;
      if (this._project(m.v, p) && p[0] > -40 && p[1] > -40 && p[0] < this.W + 40 && p[1] < this.H + 40) {
        m.el.hidden = false;
        m.el.style.transform = 'translate(' + p[0].toFixed(1) + 'px,' + p[1].toFixed(1) + 'px)';
      } else {
        m.el.hidden = true;
      }
    }
  };

  /* ---------------------------------------------------------------------
   * 交互：拖动、缩放、点击、悬停
   * --------------------------------------------------------------------- */

  /** 交互期间用低分辨率银河，停止 180ms 后再画一次高质量版本 */
  P._markInteracting = function () {
    this.interacting = true;
    this._scheduleHires();
  };
  P._scheduleHires = function () {
    var self = this;
    clearTimeout(this._hiresTimer);
    this._hiresTimer = setTimeout(function () {
      self.interacting = false;
      self.requestRender();
    }, 180);
  };

  /** 找离屏幕坐标最近的可见恒星（命中半径随星点大小增加） */
  P._hitStar = function (x, y) {
    var best = -1, bestD = Infinity;
    for (var i = 0; i < this.starCount; i++) {
      var px = this.px[i];
      if (px !== px) continue;
      var dx = px - x, dy = this.py[i] - y;
      var d2 = dx * dx + dy * dy;
      var rr = Math.max(9, this.pr[i] + 6);
      if (d2 <= rr * rr && d2 < bestD) {
        bestD = d2;
        best = i;
      }
    }
    return best;
  };

  P._bindEvents = function () {
    var self = this, cv = this.canvas;
    var pointers = new Map(); // 正在按下的指针（支持双指缩放）
    var drag = null; // {x, y, moved}
    var pinchDist = 0;

    function localXY(e) {
      var r = cv.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    }

    cv.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      try {
        cv.setPointerCapture(e.pointerId); // 拖出画布外也能继续收到移动事件
      } catch (err) { /* 个别浏览器/指针类型不支持捕获，不影响基本功能 */ }
      var xy = localXY(e);
      pointers.set(e.pointerId, xy);
      self.anim = null; // 用户接管视图时停止飞行动画
      if (pointers.size === 1) {
        drag = { x: xy[0], y: xy[1], sx: xy[0], sy: xy[1], moved: false };
      } else if (pointers.size === 2) {
        var ps = Array.from(pointers.values());
        pinchDist = Math.hypot(ps[0][0] - ps[1][0], ps[0][1] - ps[1][1]);
        if (drag) drag.moved = true;
      }
      if (self.opts.onHover) self.opts.onHover(null);
    });

    cv.addEventListener('pointermove', function (e) {
      var xy = localXY(e);
      if (pointers.has(e.pointerId)) {
        pointers.set(e.pointerId, xy);
        if (pointers.size >= 2) {
          // 双指缩放
          var ps = Array.from(pointers.values());
          var d = Math.hypot(ps[0][0] - ps[1][0], ps[0][1] - ps[1][1]);
          if (pinchDist > 0 && d > 0) self.zoomBy(pinchDist / d, true); // 双指缩放要跟手，立即生效
          pinchDist = d;
          return;
        }
        if (!drag) return;
        var dx = xy[0] - drag.x, dy = xy[1] - drag.y;
        if (!drag.moved && Math.hypot(xy[0] - drag.sx, xy[1] - drag.sy) < 4) return;
        drag.moved = true;
        drag.x = xy[0];
        drag.y = xy[1];
        // 屏幕位移 → 视图中心的赤经赤纬变化（中心附近 1 弧度对应 scale 像素）
        var cosd = Math.max(0.12, Math.cos(self.dec0 * D2R));
        self.ra0 = ((self.ra0 + dx / self.scale * R2D / cosd) % 360 + 360) % 360;
        self.dec0 = clamp(self.dec0 + dy / self.scale * R2D, -90, 90);
        self._markInteracting();
        self.requestRender();
        cv.classList.add('is-dragging');
      } else if (self.opts.onHover && e.pointerType === 'mouse') {
        // 悬停：显示最近的恒星信息
        var i = self._hitStar(xy[0], xy[1]);
        self.opts.onHover(i >= 0 ? { x: xy[0], y: xy[1], star: self.starInfo(i) } : null);
        cv.style.cursor = i >= 0 ? 'pointer' : '';
      }
    });

    function end(e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      cv.classList.remove('is-dragging');
      if (pointers.size === 0) {
        if (drag && !drag.moved && e.type === 'pointerup' && self.opts.onClick) {
          var xy = localXY(e);
          var i = self._hitStar(xy[0], xy[1]);
          var sky = self.screenToSky(xy[0], xy[1]);
          self.opts.onClick({
            x: xy[0], y: xy[1],
            ra: i >= 0 ? self.sra[i] : sky.ra, dec: i >= 0 ? self.sdec[i] : sky.dec,
            star: i >= 0 ? self.starInfo(i) : null
          });
        }
        drag = null;
        pinchDist = 0;
      }
    }
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', function () {
      if (self.opts.onHover && pointers.size === 0) self.opts.onHover(null);
    });

    // 滚轮缩放（只在星图上生效，不影响左侧面板滚动）
    cv.addEventListener('wheel', function (e) {
      e.preventDefault();
      var delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      self.zoomBy(Math.exp(clamp(delta, -200, 200) * 0.0015));
    }, { passive: false });
  };

  root.RaDec = root.RaDec || {};
  root.RaDec.StarMap = StarMap;
})(typeof globalThis !== 'undefined' ? globalThis : this);
