/**
 * astro.js —— 天文计算核心库
 *
 * 提供本网站用到的全部天文算法（纯函数，不依赖 DOM，可在浏览器和 Node.js 中运行）：
 *   · 时间：儒略日、TT−UTC（闰秒表）、儒略/贝塞尔历元
 *   · 恒星时：地球自转角 ERA、格林尼治平恒星时 GMST（IAU 2006）、视恒星时 GAST
 *   · 岁差：IAU 2006（Fukushima-Williams 四角）
 *   · 章动：IAU 1980 章动序列的主要 34 项（精度约 0.01″）
 *   · 周年光行差：含地球轨道偏心率项
 *   · 参考系：ICRS/FK5 J2000 ↔ FK4 B1950（含 E 项，算法同 SLALIB FK45Z/FK54Z）
 *   · 坐标系：赤道 ↔ 银道（IAU 1958 银道系）↔ 黄道（任意历元平黄道）
 *   · 地平坐标：时角、高度角、方位角、大气折射、大气质量、星位角；以及由方位角/高度角反算赤经赤纬
 *   · 升起/中天/落下时刻、太阳位置（低精度）、角距离与位置角、所在星座（Roman 1987）
 *
 * 约定：
 *   · 对外接口的角度一律使用"度"，内部计算使用弧度；
 *   · 天球方向用单位向量 [x, y, z] 表示，x 指向春分点，z 指向北天极；
 *   · 视 ICRS 与 FK5 J2000 相同（两者相差约 0.02″，对本工具可以忽略）；
 *   · 忽略 UT1−UTC（< 0.9 秒）、极移、周日光行差与引力光线偏折，
 *     这些因素对一般观测用途的影响都在 1″ 以内。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api; // Node.js 环境（用于测试）
  } else {
    root.RaDec = root.RaDec || {};
    root.RaDec.Astro = api; // 浏览器环境
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* =====================================================================
   * 一、常量
   * ===================================================================== */
  var PI = Math.PI;
  var TAU = 2 * PI;
  var D2R = PI / 180; // 度 → 弧度
  var R2D = 180 / PI; // 弧度 → 度
  var AS2R = D2R / 3600; // 角秒 → 弧度
  var J2000 = 2451545.0; // J2000.0 对应的儒略日（TT）
  var DJC = 36525.0; // 一个儒略世纪的天数
  var DJY = 365.25; // 一个儒略年的天数
  var JD_UNIX = 2440587.5; // 1970-01-01T00:00:00Z 的儒略日
  var JD_B1950 = 2433282.4235; // B1950.0 的儒略日
  var JD_B1875 = 2405889.258550475; // B1875.0（IAU 星座边界所用分点）
  var SIDEREAL_RATE = 1.00273790935; // 恒星时流逝速率：每个平太阳日对应的恒星日圈数

  /* =====================================================================
   * 二、基础数学工具
   * ===================================================================== */

  /** 把角度规整到 [0, 360) */
  function wrap360(d) {
    d %= 360;
    return d < 0 ? d + 360 : d;
  }
  /** 把弧度规整到 [0, 2π) */
  function wrapTau(r) {
    r %= TAU;
    return r < 0 ? r + TAU : r;
  }
  /** 把弧度规整到 (−π, π] */
  function wrapPi(r) {
    r = wrapTau(r);
    return r > PI ? r - TAU : r;
  }
  function clamp(x, lo, hi) {
    return x < lo ? lo : x > hi ? hi : x;
  }

  /** 由赤经、赤纬（度）得到单位向量 */
  function vecFromRaDec(raDeg, decDeg) {
    var a = raDeg * D2R;
    var d = decDeg * D2R;
    var cd = Math.cos(d);
    return [cd * Math.cos(a), cd * Math.sin(a), Math.sin(d)];
  }
  /** 由向量得到球面坐标 {ra: 0~360°, dec: −90~90°}（对任意坐标系的经纬度同样适用） */
  function raDecFromVec(v) {
    var r = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
    var ra = r === 0 ? 0 : wrap360(Math.atan2(v[1], v[0]) * R2D);
    var dec = Math.atan2(v[2], r) * R2D;
    return { ra: ra, dec: dec };
  }
  function normalize(v) {
    var n = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    return [v[0] / n, v[1] / n, v[2] / n];
  }
  function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  /** 矩阵 × 向量 */
  function mxv(m, v) {
    return [
      m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
      m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
      m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]
    ];
  }
  /** 矩阵的转置 × 向量（旋转矩阵的逆变换） */
  function mtxv(m, v) {
    return [
      m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
      m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
      m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2]
    ];
  }
  /** 矩阵 × 矩阵 */
  function mxm(a, b) {
    var r = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (var i = 0; i < 3; i++) {
      for (var j = 0; j < 3; j++) {
        r[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
      }
    }
    return r;
  }
  function transpose(m) {
    return [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]];
  }
  function identity() {
    return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  }
  /*
   * 坐标系旋转（与 IAU SOFA 库约定一致）：返回 R(角度) × m。
   * 正角度表示坐标轴绕对应轴逆时针旋转（从轴的正方向朝原点看）。
   */
  function rotX(phi, m) {
    var s = Math.sin(phi), c = Math.cos(phi);
    return mxm([[1, 0, 0], [0, c, s], [0, -s, c]], m);
  }
  function rotY(theta, m) {
    var s = Math.sin(theta), c = Math.cos(theta);
    return mxm([[c, 0, -s], [0, 1, 0], [s, 0, c]], m);
  }
  function rotZ(psi, m) {
    var s = Math.sin(psi), c = Math.cos(psi);
    return mxm([[c, s, 0], [-s, c, 0], [0, 0, 1]], m);
  }

  /* =====================================================================
   * 三、时间
   * ===================================================================== */

  /** JS Date（UTC 时刻）→ 儒略日 */
  function jdFromDate(date) {
    return date.getTime() / 86400000 + JD_UNIX;
  }
  /** 儒略日 → JS Date */
  function dateFromJd(jd) {
    return new Date((jd - JD_UNIX) * 86400000);
  }

  // 闰秒表：[年, 月, TAI−UTC（秒）]，自该月 1 日 0 时（UTC）起生效。2017 年以后至今没有新增闰秒。
  var LEAP_TABLE = [
    [1972, 1, 10], [1972, 7, 11], [1973, 1, 12], [1974, 1, 13], [1975, 1, 14], [1976, 1, 15],
    [1977, 1, 16], [1978, 1, 17], [1979, 1, 18], [1980, 1, 19], [1981, 7, 20], [1982, 7, 21],
    [1983, 7, 22], [1985, 7, 23], [1988, 1, 24], [1990, 1, 25], [1991, 1, 26], [1992, 7, 27],
    [1993, 7, 28], [1994, 7, 29], [1996, 1, 30], [1997, 7, 31], [1999, 1, 32], [2006, 1, 33],
    [2009, 1, 34], [2012, 7, 35], [2015, 7, 36], [2017, 1, 37]
  ].map(function (r) {
    return [Date.UTC(r[0], r[1] - 1, 1) / 86400000 + JD_UNIX, r[2]];
  });

  /**
   * TT − UTC（秒）。1972 年以后用闰秒表精确计算（TT = TAI + 32.184 s）；
   * 1972 年以前没有闰秒制度，用 Morrison & Stephenson (2004) 的长期公式近似 ΔT。
   * 该值只影响岁差、章动等慢变量的时间参数，几十秒的误差对结果没有可见影响。
   */
  function ttMinusUtc(jdUtc) {
    if (jdUtc >= LEAP_TABLE[0][0]) {
      var tai = LEAP_TABLE[0][1];
      for (var i = 1; i < LEAP_TABLE.length && jdUtc >= LEAP_TABLE[i][0]; i++) tai = LEAP_TABLE[i][1];
      return tai + 32.184;
    }
    var u = (2000 + (jdUtc - J2000) / DJY - 1820) / 100;
    return -20 + 32 * u * u;
  }
  /** UTC 儒略日 → TT 儒略日 */
  function jdTTFromUtc(jdUtc) {
    return jdUtc + ttMinusUtc(jdUtc) / 86400;
  }
  /** 儒略历元（如 2026.8）↔ 儒略日（TT） */
  function julianEpoch(jdTT) {
    return 2000 + (jdTT - J2000) / DJY;
  }
  function jdFromJulianEpoch(ep) {
    return J2000 + (ep - 2000) * DJY;
  }
  /** 贝塞尔历元（如 1950.0）↔ 儒略日 */
  function besselianEpoch(jd) {
    return 1900 + (jd - 2415020.31352) / 365.242198781;
  }
  function jdFromBesselianEpoch(ep) {
    return 2415020.31352 + (ep - 1900) * 365.242198781;
  }

  /* =====================================================================
   * 四、岁差（IAU 2006，Fukushima-Williams 四角表示）
   * ===================================================================== */

  /** IAU 2006 平黄赤交角 εA（弧度） */
  function obl06(jdTT) {
    var t = (jdTT - J2000) / DJC;
    return (84381.406 + (-46.836769 + (-0.0001831 + (0.00200340 + (-0.000000576 + -0.0000000434 * t) * t) * t) * t) * t) * AS2R;
  }

  /** Fukushima-Williams 岁差角 γ̄、φ̄、ψ̄ 与 εA（弧度），系数取自 IAU SOFA iauPfw06 */
  function pfw06(jdTT) {
    var t = (jdTT - J2000) / DJC;
    return {
      gamb: (-0.052928 + (10.556378 + (0.4932044 + (-0.00031238 + (-0.000002788 + 0.0000000260 * t) * t) * t) * t) * t) * AS2R,
      phib: (84381.412819 + (-46.811016 + (0.0511268 + (0.00053289 + (-0.000000440 + -0.0000000176 * t) * t) * t) * t) * t) * AS2R,
      psib: (-0.041775 + (5038.481484 + (1.5584175 + (-0.00018522 + (-0.000026452 + -0.0000000148 * t) * t) * t) * t) * t) * AS2R,
      epsa: obl06(jdTT)
    };
  }

  /** 由 F-W 四角构造旋转矩阵（同 SOFA iauFw2m） */
  function fw2m(gamb, phib, psi, eps) {
    var r = identity();
    r = rotZ(gamb, r);
    r = rotX(phib, r);
    r = rotZ(-psi, r);
    r = rotX(-eps, r);
    return r;
  }

  // t = 0 时的 F-W 矩阵就是"参考架偏差"矩阵 B；岁差矩阵 P = FW(t)·Bᵀ，保证 P(J2000) 恰为单位阵
  var FW_J2000_T = (function () {
    var a = pfw06(J2000);
    return transpose(fw2m(a.gamb, a.phib, a.psib, a.epsa));
  })();

  // 岁差矩阵缓存：同一时刻会被反复使用（例如星图、多个结果卡片）
  var precCache = { jd: NaN, m: null };

  /** 岁差矩阵：J2000 平赤道/平春分点 → 指定时刻（TT）的平赤道/平春分点 */
  function precessionMatrix(jdTT) {
    if (jdTT === precCache.jd) return precCache.m;
    var m;
    if (jdTT === J2000) {
      m = identity();
    } else {
      var a = pfw06(jdTT);
      m = mxm(fw2m(a.gamb, a.phib, a.psib, a.epsa), FW_J2000_T);
    }
    precCache = { jd: jdTT, m: m };
    return m;
  }

  /* =====================================================================
   * 五、章动（IAU 1980 序列中振幅最大的 34 项，截断误差约 0.01″）
   * 每行：[D, M, M′, F, Ω, Δψ 系数, Δψ 的 T 项, Δε 系数, Δε 的 T 项]，单位 0.0001″
   * ===================================================================== */
  var NUT80 = [
    [0, 0, 0, 0, 1, -171996, -174.2, 92025, 8.9],
    [-2, 0, 0, 2, 2, -13187, -1.6, 5736, -3.1],
    [0, 0, 0, 2, 2, -2274, -0.2, 977, -0.5],
    [0, 0, 0, 0, 2, 2062, 0.2, -895, 0.5],
    [0, 1, 0, 0, 0, 1426, -3.4, 54, -0.1],
    [0, 0, 1, 0, 0, 712, 0.1, -7, 0],
    [-2, 1, 0, 2, 2, -517, 1.2, 224, -0.6],
    [0, 0, 0, 2, 1, -386, -0.4, 200, 0],
    [0, 0, 1, 2, 2, -301, 0, 129, -0.1],
    [-2, -1, 0, 2, 2, 217, -0.5, -95, 0.3],
    [-2, 0, 1, 0, 0, -158, 0, 0, 0],
    [-2, 0, 0, 2, 1, 129, 0.1, -70, 0],
    [0, 0, -1, 2, 2, 123, 0, -53, 0],
    [2, 0, 0, 0, 0, 63, 0, 0, 0],
    [0, 0, 1, 0, 1, 63, 0.1, -33, 0],
    [2, 0, -1, 2, 2, -59, 0, 26, 0],
    [0, 0, -1, 0, 1, -58, -0.1, 32, 0],
    [0, 0, 1, 2, 1, -51, 0, 27, 0],
    [-2, 0, 2, 0, 0, 48, 0, 0, 0],
    [0, 0, -2, 2, 1, 46, 0, -24, 0],
    [2, 0, 0, 2, 2, -38, 0, 16, 0],
    [0, 0, 2, 2, 2, -31, 0, 13, 0],
    [0, 0, 2, 0, 0, 29, 0, 0, 0],
    [-2, 0, 1, 2, 2, 29, 0, -12, 0],
    [0, 0, 0, 2, 0, 26, 0, 0, 0],
    [-2, 0, 0, 2, 0, -22, 0, 0, 0],
    [0, 0, -1, 2, 1, 21, 0, -10, 0],
    [0, 2, 0, 0, 0, 17, -0.1, 0, 0],
    [2, 0, -1, 0, 1, 16, 0, -8, 0],
    [-2, 2, 0, 2, 2, -16, 0.1, 7, 0],
    [0, 1, 0, 0, 1, -15, 0, 9, 0],
    [-2, 0, 1, 0, 1, -13, 0, 7, 0],
    [0, -1, 0, 0, 1, -12, 0, 6, 0],
    [0, 0, 2, -2, 0, 11, 0, 0, 0]
  ];

  var nutCache = { jd: NaN, v: null };

  /**
   * 黄经章动 Δψ、交角章动 Δε（弧度），以及月球升交点平黄经 Ω
   */
  function nutation(jdTT) {
    if (jdTT === nutCache.jd) return nutCache.v;
    var T = (jdTT - J2000) / DJC;
    var T2 = T * T, T3 = T2 * T;
    // 基本幅角（Meeus《天文算法》第 22 章）
    var D = (297.85036 + 445267.111480 * T - 0.0019142 * T2 + T3 / 189474) * D2R; // 月日平角距
    var M = (357.52772 + 35999.050340 * T - 0.0001603 * T2 - T3 / 300000) * D2R; // 太阳平近点角
    var Mp = (134.96298 + 477198.867398 * T + 0.0086972 * T2 + T3 / 56250) * D2R; // 月球平近点角
    var F = (93.27191 + 483202.017538 * T - 0.0036825 * T2 + T3 / 327270) * D2R; // 月球纬度参数
    var Om = (125.04452 - 1934.136261 * T + 0.0020708 * T2 + T3 / 450000) * D2R; // 月球升交点平黄经
    var dpsi = 0, deps = 0;
    for (var i = 0; i < NUT80.length; i++) {
      var r = NUT80[i];
      var arg = r[0] * D + r[1] * M + r[2] * Mp + r[3] * F + r[4] * Om;
      dpsi += (r[5] + r[6] * T) * Math.sin(arg);
      deps += (r[7] + r[8] * T) * Math.cos(arg);
    }
    var v = { dpsi: dpsi * 1e-4 * AS2R, deps: deps * 1e-4 * AS2R, omega: Om };
    nutCache = { jd: jdTT, v: v };
    return v;
  }

  /** 章动矩阵：平赤道/平春分点 → 真赤道/真春分点（同 SOFA iauNumat） */
  function nutationMatrix(jdTT) {
    var n = nutation(jdTT);
    var epsa = obl06(jdTT);
    var r = identity();
    r = rotX(epsa, r);
    r = rotZ(-n.dpsi, r);
    r = rotX(-(epsa + n.deps), r);
    return r;
  }

  /** 二分差（赤经章动）：GAST − GMST（弧度），含两项最大的补充项 */
  function equationOfEquinoxes(jdTT) {
    var n = nutation(jdTT);
    return n.dpsi * Math.cos(obl06(jdTT)) + (0.00264096 * Math.sin(n.omega) + 0.00006352 * Math.sin(2 * n.omega)) * AS2R;
  }

  /* =====================================================================
   * 六、周年光行差
   * ===================================================================== */

  /**
   * 地球公转速度与光速之比 v/c（单位向量的位移量，约 1e-4），表示在该时刻的平赤道坐标系中。
   * 采用经典公式：太阳真黄经 ☉、地球轨道偏心率 e、近日点黄经 ϖ、光行差常数 κ = 20.49552″。
   * 视方向 = 归一化(真方向 + v/c)。
   */
  function aberrationVector(jdTT) {
    var T = (jdTT - J2000) / DJC;
    var L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T; // 太阳平黄经
    var Mr = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * D2R; // 太阳平近点角
    var e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T; // 地球轨道偏心率
    var C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mr) +
      (0.019993 - 0.000101 * T) * Math.sin(2 * Mr) + 0.000289 * Math.sin(3 * Mr); // 中心差
    var sun = (L0 + C) * D2R; // 太阳真黄经
    var peri = (102.93735 + 1.71946 * T + 0.00046 * T * T) * D2R; // 近日点黄经
    var k = 20.49552 * AS2R;
    var eps = obl06(jdTT);
    // 黄道坐标中的速度方向，再绕 x 轴转回赤道坐标
    var vx = k * (Math.sin(sun) - e * Math.sin(peri));
    var vy = -k * (Math.cos(sun) - e * Math.cos(peri));
    return [vx, vy * Math.cos(eps), vy * Math.sin(eps)];
  }

  /* =====================================================================
   * 七、视位置（岁差 + 光行差 + 章动）
   * ===================================================================== */

  /** ICRS(J2000) 方向 → 指定时刻的视方向（真赤道、真春分点，地心） */
  function apparentFromICRS(v, jdTT) {
    var vm = mxv(precessionMatrix(jdTT), v);
    var ab = aberrationVector(jdTT);
    var va = normalize([vm[0] + ab[0], vm[1] + ab[1], vm[2] + ab[2]]);
    return mxv(nutationMatrix(jdTT), va);
  }

  /** 视方向 → ICRS(J2000)：apparentFromICRS 的逆运算（光行差部分迭代求解） */
  function icrsFromApparent(vt, jdTT) {
    var va = mtxv(nutationMatrix(jdTT), vt);
    var ab = aberrationVector(jdTT);
    var vm = normalize([va[0] - ab[0], va[1] - ab[1], va[2] - ab[2]]);
    for (var i = 0; i < 3; i++) {
      var f = normalize([vm[0] + ab[0], vm[1] + ab[1], vm[2] + ab[2]]);
      vm = normalize([vm[0] + va[0] - f[0], vm[1] + va[1] - f[1], vm[2] + va[2] - f[2]]);
    }
    return mtxv(precessionMatrix(jdTT), vm);
  }

  /* =====================================================================
   * 八、FK4 (B1950.0) ↔ FK5 (J2000.0)
   * 算法与常数取自 SLALIB sla_FK45Z / sla_FK524（Standish 1982；Aoki et al. 1983），
   * 假定天体在 FK5 中没有自行，FK4 坐标的观测历元为 B1950.0。
   * ===================================================================== */
  var PMF = 100 * 60 * 60 * 360 / TAU; // 弧度/年 → 角秒/世纪
  var ETERM_A = [-1.62557e-6, -0.31919e-6, -0.13843e-6]; // E 项（椭圆光行差）向量 A
  var ETERM_AD = [1.245e-3, -1.580e-3, -0.659e-3]; // E 项变化率 Ȧ（角秒/世纪）
  // FK4 → FK5 的 6×3 矩阵（6×6 矩阵中作用于位置的前三列）
  var EM = [
    [0.9999256782, -0.0111820611, -0.0048579477],
    [0.0111820610, 0.9999374784, -0.0000271765],
    [0.0048579479, -0.0000271474, 0.9999881997],
    [-0.000551, -0.238565, 0.435739],
    [0.238514, -0.002667, -0.008541],
    [-0.435623, 0.012254, 0.002117]
  ];
  // FK5 → FK4 的 6×6 矩阵中，作用于位置的 3×3 子矩阵（FK5 无自行时速度分量为 0）
  var EMI = [
    [0.9999256795, 0.0111814828, 0.0048590039],
    [-0.0111814828, 0.9999374849, -0.0000271771],
    [-0.0048590040, -0.0000271557, 0.9999881946]
  ];

  /** FK4 B1950.0 坐标（度）→ ICRS/FK5 J2000 单位向量 */
  function fk4ToICRS(raDeg, decDeg) {
    var r0 = vecFromRaDec(raDeg, decDeg);
    var bepoch = 1950.0;
    // 调整 E 项向量（观测历元 = 1950 时修正量为 0）
    var w0 = (bepoch - 1950) / PMF;
    var a1 = [ETERM_A[0] + w0 * ETERM_AD[0], ETERM_A[1] + w0 * ETERM_AD[1], ETERM_A[2] + w0 * ETERM_AD[2]];
    // 去掉 E 项
    var w = dot(r0, a1);
    var v1 = [r0[0] - a1[0] + w * r0[0], r0[1] - a1[1] + w * r0[1], r0[2] - a1[2] + w * r0[2]];
    // 转换到 FK5 坐标系（位置 + 虚拟自行）
    var v2 = [];
    for (var i = 0; i < 6; i++) v2.push(EM[i][0] * v1[0] + EM[i][1] * v1[1] + EM[i][2] * v1[2]);
    // FK4 中的"虚拟自行"：把位置从观测历元推到 J2000.0
    var wt = (julianEpoch(jdFromBesselianEpoch(bepoch)) - 2000) / PMF;
    return normalize([v2[0] + wt * v2[3], v2[1] + wt * v2[4], v2[2] + wt * v2[5]]);
  }

  /** ICRS/FK5 J2000 单位向量 → FK4 B1950.0 坐标（度） */
  function icrsToFk4(v) {
    var x = EMI[0][0] * v[0] + EMI[0][1] * v[1] + EMI[0][2] * v[2];
    var y = EMI[1][0] * v[0] + EMI[1][1] * v[1] + EMI[1][2] * v[2];
    var z = EMI[2][0] * v[0] + EMI[2][1] * v[1] + EMI[2][2] * v[2];
    var A = ETERM_A;
    // 加上 E 项：先用初值求模长，再用修正后的模长重新计算（同 sla_FK524）
    var rxyz = Math.sqrt(x * x + y * y + z * z);
    var w = x * A[0] + y * A[1] + z * A[2];
    var x1 = x + A[0] * rxyz - w * x;
    var y1 = y + A[1] * rxyz - w * y;
    var z1 = z + A[2] * rxyz - w * z;
    rxyz = Math.sqrt(x1 * x1 + y1 * y1 + z1 * z1);
    w = x * A[0] + y * A[1] + z * A[2];
    var out = [x + A[0] * rxyz - w * x, y + A[1] * rxyz - w * y, z + A[2] * rxyz - w * z];
    return raDecFromVec(out);
  }

  /* =====================================================================
   * 九、银道坐标（IAU 1958 银道系，FK5 J2000 下的定义）
   * 北银极 α = 192.85948°、δ = 27.12825°，北天极的银经 = 122.93192°
   * ===================================================================== */
  var GAL_MATRIX = (function () {
    var ngpRa = 192.8594812065348, ngpDec = 27.12825118085622, lonNcp = 122.9319185680026;
    var r = identity();
    r = rotZ(ngpRa * D2R, r); // x 轴转到北银极的赤经方向
    r = rotY((90 - ngpDec) * D2R, r); // z 轴转到北银极
    r = rotZ((180 - lonNcp) * D2R, r); // 使北天极的银经为 122.93°
    return r;
  })();

  /* =====================================================================
   * 十、坐标系统一转换接口
   *
   * 历元（epoch）描述对象：
   *   { kind: 'J2000' }                       J2000.0（ICRS / FK5）
   *   { kind: 'B1950' }                       B1950.0（FK4，含 E 项）
   *   { kind: 'jd', jdTT: 数值 }              指定时刻的平赤道、平春分点（"平位置"）
   *   { kind: 'jd', jdTT: 数值, apparent: true }  指定时刻的视位置（真赤道、真春分点，含光行差）
   * ===================================================================== */

  /** 历元对应的 TT 儒略日（B1950 返回其儒略日，仅用于显示/黄道计算） */
  function epochJd(epoch) {
    if (!epoch || epoch.kind === 'J2000') return J2000;
    if (epoch.kind === 'B1950') return JD_B1950;
    return epoch.jdTT;
  }

  /** 赤道坐标（指定历元）→ ICRS 单位向量 */
  function equatorialToICRS(raDeg, decDeg, epoch) {
    if (!epoch || epoch.kind === 'J2000') return vecFromRaDec(raDeg, decDeg);
    if (epoch.kind === 'B1950') return fk4ToICRS(raDeg, decDeg);
    var v = vecFromRaDec(raDeg, decDeg);
    if (epoch.apparent) return icrsFromApparent(v, epoch.jdTT);
    return mtxv(precessionMatrix(epoch.jdTT), v);
  }

  /** ICRS 单位向量 → 赤道坐标（指定历元），返回 {ra, dec}（度） */
  function icrsToEquatorial(v, epoch) {
    if (!epoch || epoch.kind === 'J2000') return raDecFromVec(v);
    if (epoch.kind === 'B1950') return icrsToFk4(v);
    if (epoch.apparent) return raDecFromVec(apparentFromICRS(v, epoch.jdTT));
    return raDecFromVec(mxv(precessionMatrix(epoch.jdTT), v));
  }

  /** 黄道坐标（该历元的平黄道、平春分点）→ ICRS 单位向量 */
  function eclipticToICRS(lonDeg, latDeg, epoch) {
    var jd = epochJd(epoch);
    var e = vecFromRaDec(lonDeg, latDeg);
    var eq = rotXVec(-obl06(jd), e); // 黄道 → 该历元平赤道
    return mtxv(precessionMatrix(jd), eq);
  }

  /** ICRS 单位向量 → 黄道坐标（该历元的平黄道、平春分点），返回 {lon, lat} */
  function icrsToEcliptic(v, epoch) {
    var jd = epochJd(epoch);
    var eq = mxv(precessionMatrix(jd), v);
    var r = raDecFromVec(rotXVec(obl06(jd), eq));
    return { lon: r.ra, lat: r.dec };
  }

  /** 向量绕 x 轴的坐标系旋转（只用于黄赤转换，避免构造矩阵） */
  function rotXVec(phi, v) {
    var s = Math.sin(phi), c = Math.cos(phi);
    return [v[0], c * v[1] + s * v[2], -s * v[1] + c * v[2]];
  }

  /** 银道坐标 → ICRS 单位向量 */
  function galacticToICRS(lDeg, bDeg) {
    return mtxv(GAL_MATRIX, vecFromRaDec(lDeg, bDeg));
  }
  /** ICRS 单位向量 → 银道坐标 {l, b} */
  function icrsToGalactic(v) {
    var r = raDecFromVec(mxv(GAL_MATRIX, v));
    return { l: r.ra, b: r.dec };
  }

  /**
   * 通用入口：任意坐标系 → ICRS 单位向量
   * @param {'equatorial'|'galactic'|'ecliptic'} sys
   * @param {number} a 经度类分量（赤经/银经/黄经，度）
   * @param {number} b 纬度类分量（赤纬/银纬/黄纬，度）
   * @param {object} epoch 历元描述（银道坐标忽略此参数）
   */
  function toICRS(sys, a, b, epoch) {
    if (sys === 'galactic') return galacticToICRS(a, b);
    if (sys === 'ecliptic') return eclipticToICRS(a, b, epoch);
    return equatorialToICRS(a, b, epoch);
  }

  /* =====================================================================
   * 十一、恒星时
   * ===================================================================== */

  /** 地球自转角 ERA（弧度），参数为 UT1 儒略日（同 SOFA iauEra00） */
  function earthRotationAngle(jdUt1) {
    var f = jdUt1 % 1.0;
    var t = jdUt1 - J2000;
    return wrapTau(TAU * (f + 0.7790572732640 + 0.00273781191135448 * t));
  }

  /** 格林尼治平恒星时 GMST（弧度，IAU 2006，同 SOFA iauGmst06） */
  function gmst(jdUt1, jdTT) {
    var t = (jdTT - J2000) / DJC;
    return wrapTau(earthRotationAngle(jdUt1) +
      (0.014506 + (4612.156534 + (1.3915817 + (-0.00000044 + (-0.000029956 + -0.0000000368 * t) * t) * t) * t) * t) * AS2R);
  }

  /** 格林尼治视恒星时 GAST（弧度）= GMST + 二分差 */
  function gast(jdUt1, jdTT) {
    return wrapTau(gmst(jdUt1, jdTT) + equationOfEquinoxes(jdTT));
  }

  /* =====================================================================
   * 十二、地平坐标与观测量
   * ===================================================================== */

  /**
   * 时角/赤纬 → 高度角/方位角（弧度）。方位角从正北起算、向东为正（同 SOFA iauHd2ae）
   */
  function horizontal(ha, dec, lat) {
    var sh = Math.sin(ha), ch = Math.cos(ha);
    var sd = Math.sin(dec), cd = Math.cos(dec);
    var sl = Math.sin(lat), cl = Math.cos(lat);
    var x = -ch * cd * sl + sd * cl; // 指向北
    var y = -sh * cd; // 指向东
    var z = ch * cd * cl + sd * sl; // 指向天顶
    var r = Math.sqrt(x * x + y * y);
    return { alt: Math.atan2(z, r), az: r === 0 ? 0 : wrapTau(Math.atan2(y, x)) };
  }

  /**
   * 方位角/高度角 → 时角/赤纬（弧度）：horizontal() 的逆运算（同 SOFA iauAe2hd）
   * @param {number} az 方位角（弧度，北 0、东 π/2）
   * @param {number} alt 高度角（弧度）
   * @param {number} lat 地理纬度（弧度）
   * @returns {{ha:number, dec:number}} 时角 (−π, π]（向西为正）与赤纬
   */
  function equatorialFromHorizontal(az, alt, lat) {
    var sa = Math.sin(az), ca = Math.cos(az);
    var se = Math.sin(alt), ce = Math.cos(alt);
    var sl = Math.sin(lat), cl = Math.cos(lat);
    var x = -ca * ce * sl + se * cl; // 指向子午圈与天赤道的交点（时角 0）
    var y = -sa * ce; // 指向时角 +6h（正西）
    var z = ca * ce * cl + se * sl; // 指向北天极
    var r = Math.sqrt(x * x + y * y);
    return { ha: r === 0 ? 0 : Math.atan2(y, x), dec: Math.atan2(z, r) };
  }

  /** 星位角 q（弧度）：天体处"指向天顶方向"与"指向北天极方向"的夹角（同 SOFA iauHd2pa） */
  function parallacticAngle(ha, dec, lat) {
    var cl = Math.cos(lat);
    var y = Math.sin(ha) * cl;
    var x = Math.sin(lat) * Math.cos(dec) - Math.cos(ha) * Math.sin(dec) * cl;
    return (y !== 0 || x !== 0) ? Math.atan2(y, x) : 0;
  }

  /**
   * 大气折射（度）：由真高度角求折射量（Sæmundsson 1986 公式），
   * 并按气压、气温修正。高度角低于 −1° 时返回 0（天体已在地平线下）。
   */
  function refraction(altTrueDeg, pressureHpa, tempC) {
    if (altTrueDeg < -1) return 0;
    var p = pressureHpa == null ? 1010 : pressureHpa;
    var t = tempC == null ? 10 : tempC;
    var R = 1.02 / Math.tan((altTrueDeg + 10.3 / (altTrueDeg + 5.11)) * D2R); // 角分
    return Math.max(0, R * (p / 1010) * (283 / (273 + t))) / 60;
  }

  /**
   * 观测高度角（含大气折射）→ 真高度角（度）：refraction() 的逆运算。
   * 真高度角 h ≥ −1° 时 h + R(h) 随 h 单调递增，用二分法求解（折射量不超过 1°，区间取 [观测值 − 1°, 观测值]）；
   * 观测值低于 −1° 时与 refraction() 一致，按无折射处理。
   * 注：refraction() 在 −1° 处截断，观测值落在约 −1° ~ −0.35° 之间（天体已在地平线下）时没有精确解，结果收敛到 −1°。
   */
  function unrefract(altObsDeg, pressureHpa, tempC) {
    if (altObsDeg < -1) return altObsDeg;
    var lo = altObsDeg - 1, hi = altObsDeg;
    for (var i = 0; i < 40; i++) {
      var mid = (lo + hi) / 2;
      if (mid + refraction(mid, pressureHpa, tempC) > altObsDeg) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  }

  /** 大气质量（Kasten & Young 1989），高度角 ≤ 0 时返回 null */
  function airmass(altDeg) {
    if (altDeg <= 0) return null;
    return 1 / (Math.sin(altDeg * D2R) + 0.50572 * Math.pow(altDeg + 6.07995, -1.6364));
  }

  /** 由海拔估算标准气压（hPa），用于折射修正 */
  function pressureFromElevation(elevM) {
    return 1013.25 * Math.exp(-(elevM || 0) / 8434.5);
  }

  /**
   * 计算天体在某时刻、某地的完整观测量
   * @param {number[]} v ICRS 单位向量
   * @param {Date} date 观测时刻
   * @param {object} site { lat, lon（东经为正，度）, elev（米，可选） }
   * @param {object} [opts] { refraction: true/false, temperature: ℃ }
   */
  function observe(v, date, site, opts) {
    opts = opts || {};
    var jdUtc = jdFromDate(date);
    var jdTT = jdTTFromUtc(jdUtc);
    var vt = apparentFromICRS(v, jdTT);
    var app = raDecFromVec(vt);
    var gmstR = gmst(jdUtc, jdTT);
    var gastR = wrapTau(gmstR + equationOfEquinoxes(jdTT));
    var lon = site.lon * D2R, lat = site.lat * D2R;
    var last = wrapTau(gastR + lon);
    var ha = wrapPi(last - app.ra * D2R);
    var hz = horizontal(ha, app.dec * D2R, lat);
    var altDeg = hz.alt * R2D;
    var refr = opts.refraction === false ? 0 : refraction(altDeg, pressureFromElevation(site.elev), opts.temperature);
    var altApp = altDeg + refr;
    return {
      jdUtc: jdUtc,
      jdTT: jdTT,
      raApp: app.ra,
      decApp: app.dec,
      gmst: gmstR * R2D / 15, // 小时
      gast: gastR * R2D / 15,
      lmst: wrapTau(gmstR + lon) * R2D / 15,
      last: last * R2D / 15,
      ha: ha * R2D / 15, // 小时，(−12, 12]
      alt: altApp, // 显示用高度角（含折射，若开启）
      altGeometric: altDeg,
      refraction: refr,
      az: hz.az * R2D,
      airmass: airmass(altApp),
      parallactic: parallacticAngle(ha, app.dec * D2R, lat) * R2D
    };
  }

  /**
   * 地平坐标 → ICRS 单位向量：observe() 的逆运算。
   * 步骤：开启折射时先把观测高度角还原为真高度角 → 由方位角、高度角求时角与视赤纬 →
   *       视赤经 = 地方视恒星时 − 时角 → 由视位置（真赤道、真春分点，含光行差）还原到 ICRS。
   * 同一方位角、高度角在不同时刻对应不同的赤经赤纬（约每秒 15″），因此必须给出观测时刻。
   * @param {number} azDeg 方位角（度，北 0°、东 90°）
   * @param {number} altDeg 高度角（度）；opts.refraction 不为 false 时视为含大气折射的观测值
   * @param {Date} date 观测时刻
   * @param {object} site { lat, lon（东经为正，度）, elev（米，可选） }
   * @param {object} [opts] { refraction: true/false, temperature: ℃ }
   */
  function horizontalToICRS(azDeg, altDeg, date, site, opts) {
    opts = opts || {};
    var jdUtc = jdFromDate(date);
    var jdTT = jdTTFromUtc(jdUtc);
    var alt = opts.refraction === false ? altDeg : unrefract(altDeg, pressureFromElevation(site.elev), opts.temperature);
    var hd = equatorialFromHorizontal(azDeg * D2R, alt * D2R, site.lat * D2R);
    var last = gast(jdUtc, jdTT) + site.lon * D2R;
    var vt = vecFromRaDec(wrapTau(last - hd.ha) * R2D, hd.dec * R2D);
    return icrsFromApparent(vt, jdTT);
  }

  /**
   * 升起 / 上中天 / 落下时刻（UTC 儒略日）
   * 以 jdStart 之后的第一次上中天为准，升起在其之前、落下在其之后。
   * 恒星的视位置一天内几乎不变，因此直接用解析公式求解。
   * @param {number} raAppDeg, decAppDeg 视赤经、视赤纬（度）
   * @param {object} site { lat, lon }
   * @param {number} jdStart 起算时刻（UTC 儒略日）
   * @param {number} h0Deg 升落判据高度（考虑折射时取 −0.5667°）
   */
  function riseTransitSet(raAppDeg, decAppDeg, site, jdStart, h0Deg) {
    var jdTT = jdTTFromUtc(jdStart);
    var theta0 = gast(jdStart, jdTT) + site.lon * D2R; // 起算时刻的地方视恒星时
    var ra = raAppDeg * D2R, dec = decAppDeg * D2R, lat = site.lat * D2R;
    var rate = TAU * SIDEREAL_RATE; // 恒星时每天走过的弧度
    var transit = jdStart + wrapTau(ra - theta0) / rate;
    var sl = Math.sin(lat), cl = Math.cos(lat), sd = Math.sin(dec), cd = Math.cos(dec);
    var res = {
      transit: transit,
      maxAlt: Math.asin(clamp(sl * sd + cl * cd, -1, 1)) * R2D, // 上中天高度
      minAlt: Math.asin(clamp(sl * sd - cl * cd, -1, 1)) * R2D // 下中天高度
    };
    var h0 = (h0Deg == null ? -0.5667 : h0Deg);
    if (res.minAlt > h0) {
      res.circumpolar = true; // 拱极：整天都在地平线上
    } else if (res.maxAlt < h0) {
      res.neverRises = true; // 整天都在地平线下
    } else {
      var cosH0 = clamp((Math.sin(h0 * D2R) - sl * sd) / (cl * cd), -1, 1);
      var H0 = Math.acos(cosH0);
      res.rise = transit - H0 / rate;
      res.set = transit + H0 / rate;
    }
    return res;
  }

  /**
   * 太阳视位置（低精度，约 0.01°；Meeus 第 25 章），返回 {ra, dec}（度）
   */
  function sunApparent(jdTT) {
    var T = (jdTT - J2000) / DJC;
    var L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
    var Mr = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * D2R;
    var C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mr) +
      (0.019993 - 0.000101 * T) * Math.sin(2 * Mr) + 0.000289 * Math.sin(3 * Mr);
    var om = (125.04 - 1934.136 * T) * D2R;
    var lam = (L0 + C - 0.00569 - 0.00478 * Math.sin(om)) * D2R; // 视黄经
    var eps = obl06(jdTT) + 0.00256 * D2R * Math.cos(om);
    return {
      ra: wrap360(Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) * R2D),
      dec: Math.asin(Math.sin(eps) * Math.sin(lam)) * R2D
    };
  }

  /**
   * 计算一段时间内天体与太阳的高度角曲线（用于"高度角-时间"图）
   * @returns {Array<{jd:number, alt:number, sunAlt:number, az:number}>}
   */
  function altitudeTrack(v, site, jdStart, jdEnd, steps, opts) {
    opts = opts || {};
    var out = [];
    var jdMid = (jdStart + jdEnd) / 2;
    var jdTTMid = jdTTFromUtc(jdMid);
    // 一天之内天体视位置变化可以忽略，取中点时刻的视位置
    var app = raDecFromVec(apparentFromICRS(v, jdTTMid));
    var lat = site.lat * D2R, lon = site.lon * D2R;
    var press = pressureFromElevation(site.elev);
    for (var i = 0; i <= steps; i++) {
      var jd = jdStart + (jdEnd - jdStart) * i / steps;
      var jdTT = jdTTFromUtc(jd);
      var th = gast(jd, jdTT) + lon;
      var hz = horizontal(wrapPi(th - app.ra * D2R), app.dec * D2R, lat);
      var alt = hz.alt * R2D;
      if (opts.refraction !== false) alt += refraction(alt, press);
      var sun = sunApparent(jdTT);
      var sz = horizontal(wrapPi(th - sun.ra * D2R), sun.dec * D2R, lat);
      out.push({ jd: jd, alt: alt, az: hz.az * R2D, sunAlt: sz.alt * R2D });
    }
    return out;
  }

  /* =====================================================================
   * 十三、角距离、位置角、所在星座
   * ===================================================================== */

  /** 两个单位向量之间的角距离（度）。用 atan2(|a×b|, a·b)，在极小和接近 180° 时都数值稳定 */
  function separation(v1, v2) {
    var c = cross(v1, v2);
    return Math.atan2(Math.sqrt(dot(c, c)), dot(v1, v2)) * R2D;
  }

  /** B 相对 A 的位置角（度，0~360，从北经东量） */
  function positionAngle(ra1Deg, dec1Deg, ra2Deg, dec2Deg) {
    var d1 = dec1Deg * D2R, d2 = dec2Deg * D2R, da = (ra2Deg - ra1Deg) * D2R;
    var y = Math.sin(da) * Math.cos(d2);
    var x = Math.cos(d1) * Math.sin(d2) - Math.sin(d1) * Math.cos(d2) * Math.cos(da);
    return wrap360(Math.atan2(y, x) * R2D);
  }

  /**
   * 判断 ICRS 方向位于哪个 IAU 星座（Roman 1987 算法）：
   * 先把坐标岁差到 B1875.0 分点，再在边界表里自北向南查找第一个满足条件的区域。
   * @param {number[]} v ICRS 单位向量
   * @param {Array} bounds 边界表 [[赤经下限h, 赤经上限h, 赤纬下限°, 缩写], ...]
   * @returns {string|null} 星座缩写
   */
  function constellationOf(v, bounds) {
    var p = raDecFromVec(mxv(precessionMatrix(JD_B1875), v));
    var raH = p.ra / 15;
    for (var i = 0; i < bounds.length; i++) {
      var b = bounds[i];
      if (p.dec >= b[2] && raH >= b[0] && raH < b[1]) return b[3];
    }
    return null;
  }

  return {
    // 常量
    D2R: D2R, R2D: R2D, J2000: J2000, JD_B1950: JD_B1950,
    // 工具
    wrap360: wrap360, wrapTau: wrapTau, wrapPi: wrapPi, clamp: clamp,
    vecFromRaDec: vecFromRaDec, raDecFromVec: raDecFromVec, normalize: normalize,
    dot: dot, cross: cross, mxv: mxv, mtxv: mtxv, mxm: mxm, transpose: transpose,
    // 时间
    jdFromDate: jdFromDate, dateFromJd: dateFromJd, ttMinusUtc: ttMinusUtc, jdTTFromUtc: jdTTFromUtc,
    julianEpoch: julianEpoch, jdFromJulianEpoch: jdFromJulianEpoch,
    besselianEpoch: besselianEpoch, jdFromBesselianEpoch: jdFromBesselianEpoch,
    // 岁差章动光行差
    obl06: obl06, precessionMatrix: precessionMatrix, nutation: nutation, nutationMatrix: nutationMatrix,
    equationOfEquinoxes: equationOfEquinoxes, aberrationVector: aberrationVector,
    apparentFromICRS: apparentFromICRS, icrsFromApparent: icrsFromApparent,
    // 参考系与坐标系
    fk4ToICRS: fk4ToICRS, icrsToFk4: icrsToFk4,
    epochJd: epochJd, equatorialToICRS: equatorialToICRS, icrsToEquatorial: icrsToEquatorial,
    eclipticToICRS: eclipticToICRS, icrsToEcliptic: icrsToEcliptic,
    galacticToICRS: galacticToICRS, icrsToGalactic: icrsToGalactic, toICRS: toICRS,
    // 恒星时与地平坐标
    earthRotationAngle: earthRotationAngle, gmst: gmst, gast: gast,
    horizontal: horizontal, equatorialFromHorizontal: equatorialFromHorizontal, parallacticAngle: parallacticAngle,
    refraction: refraction, unrefract: unrefract, airmass: airmass,
    pressureFromElevation: pressureFromElevation, observe: observe, horizontalToICRS: horizontalToICRS,
    riseTransitSet: riseTransitSet,
    sunApparent: sunApparent, altitudeTrack: altitudeTrack,
    // 其他
    separation: separation, positionAngle: positionAngle, constellationOf: constellationOf
  };
});
