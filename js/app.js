/**
 * app.js —— 页面交互逻辑：把各个模块串起来
 *
 * 依赖（按加载顺序）：
 *   js/i18n.js          RaDec.I18n：界面语言（中文 / English），在 <head> 中最先加载
 *   data/*.js           RaDecData：星表、星座、银河、常用天体
 *   js/angle.js         RaDec.Angle：坐标文本解析与格式化
 *   js/astro.js         RaDec.Astro：天文计算
 *   js/starmap.js       RaDec.StarMap：背景星图
 *   js/altchart.js      RaDec.AltChart：高度角曲线图
 *
 * 本文件的组织：
 *   一、通用工具（DOM、复制、提示、本地存储）
 *   二、时区工具（任意 IANA 时区的"墙上时间" ↔ UTC）
 *   三、设置与状态
 *   四、历元选择器组件
 *   五、天体搜索（本地星表 + SIMBAD 在线查询）
 *   六、坐标输入组件（目标 A、目标 B 共用）
 *   七、观测时间与地点
 *   八、结果渲染（坐标转换 / 历元岁差 / 地平坐标 / 角距离）
 *   九、星图联动（目标标记、地平线、悬停提示、点击拾取、控件）
 *   十、时钟与实时刷新、URL 分享、初始化
 */
(function () {
  'use strict';

  var Angle = RaDec.Angle;
  var Astro = RaDec.Astro;
  var Data = globalThis.RaDecData;
  // 界面语言（js/i18n.js）：T('中文', {参数}) 取当前语言的文字；paren() 生成括号注释（中文全角、英文半角）
  var I18n = RaDec.I18n;
  var T = I18n.t;
  var paren = I18n.paren;

  /* =====================================================================
   * 一、通用工具
   * ===================================================================== */

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  /**
   * 创建 DOM 元素。字符串子节点一律作为纯文本插入（textContent），避免注入风险。
   * attrs 支持：class、text、hidden、onXxx 事件以及普通属性。
   */
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'hidden') el.hidden = true;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2).toLowerCase(), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    (children || []).forEach(function (c) {
      if (c == null || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  function debounce(fn, ms) {
    var t = 0;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function pad(n, w) {
    var s = String(Math.abs(n));
    while (s.length < (w || 2)) s = '0' + s;
    return (n < 0 ? '-' : '') + s;
  }

  /** 本地存储（隐私模式等情况下可能不可用，所有读写都包在 try/catch 里） */
  var store = {
    get: function (key, def) {
      try {
        var v = localStorage.getItem('radec.' + key);
        return v == null ? def : JSON.parse(v);
      } catch (e) {
        return def;
      }
    },
    set: function (key, val) {
      try {
        localStorage.setItem('radec.' + key, JSON.stringify(val));
      } catch (e) { /* 忽略：存储不可用时只是不记住设置 */ }
    }
  };

  /** 底部提示条 */
  var toastTimer = 0;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2400);
  }

  /** 复制文本到剪贴板（优先使用 Clipboard API，不可用时退回 execCommand） */
  function copyText(text) {
    function fallback() {
      var ta = h('textarea', { style: 'position:fixed;left:-9999px;opacity:0' });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      toast(ok ? T('已复制：{text}', { text: text }) : T('复制失败，请手动选择文本复制'));
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { toast(T('已复制：{text}', { text: text })); }, fallback);
    } else {
      fallback();
    }
  }

  var COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';

  /* =====================================================================
   * 二、时区工具
   * 浏览器原生只支持"本机时区"和 UTC，这里借助 Intl.DateTimeFormat 实现任意 IANA 时区的换算，
   * 用于：观测时间输入、升落时刻显示、高度角曲线的横轴。
   * ===================================================================== */

  var browserTz = (function () {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch (e) {
      return 'UTC';
    }
  })();

  function isValidTz(tz) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch (e) {
      return false;
    }
  }

  var dtfCache = {};
  /** 某时刻在时区 tz 下的年月日时分秒 */
  function zonedParts(date, tz) {
    var f = dtfCache[tz] || (dtfCache[tz] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }));
    var p = {};
    f.formatToParts(date).forEach(function (x) { p[x.type] = x.value; });
    return { y: +p.year, mo: +p.month, d: +p.day, h: (+p.hour) % 24, mi: +p.minute, s: +p.second };
  }
  /** 时区 tz 在某时刻相对 UTC 的偏移（分钟，东正西负） */
  function tzOffsetMin(date, tz) {
    var p = zonedParts(date, tz);
    var asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  }
  /** 时区 tz 下的"墙上时间" → 对应的 UTC 时刻（两次迭代可正确处理夏令时切换） */
  function zonedToDate(y, mo, d, hh, mi, ss, tz) {
    var guess = Date.UTC(y, mo - 1, d, hh, mi, ss || 0);
    var off = tzOffsetMin(new Date(guess), tz);
    var t = guess - off * 60000;
    var off2 = tzOffsetMin(new Date(t), tz);
    if (off2 !== off) t = guess - off2 * 60000;
    return new Date(t);
  }
  /** 解析 datetime-local 输入框的值（按时区 tz 理解） */
  function parseLocalInput(value, tz) {
    var m = /^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value || '');
    if (!m) return null;
    return zonedToDate(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0), tz);
  }
  /** 时刻 → datetime-local 输入框的值（按时区 tz） */
  function toLocalInput(date, tz) {
    var p = zonedParts(date, tz);
    return pad(p.y, 4) + '-' + pad(p.mo) + '-' + pad(p.d) + 'T' + pad(p.h) + ':' + pad(p.mi) + ':' + pad(p.s);
  }
  function fmtOffset(min) {
    var sign = min >= 0 ? '+' : '-';
    var a = Math.abs(min);
    return 'UTC' + sign + Math.floor(a / 60) + (a % 60 ? ':' + pad(a % 60) : '');
  }
  function fmtDateTime(date, tz, withSeconds) {
    var p = zonedParts(date, tz);
    return pad(p.y, 4) + '-' + pad(p.mo) + '-' + pad(p.d) + ' ' + pad(p.h) + ':' + pad(p.mi) + (withSeconds ? ':' + pad(p.s) : '');
  }
  function fmtClock(date, tz) {
    var p = zonedParts(date, tz);
    return pad(p.h) + ':' + pad(p.mi) + ':' + pad(p.s);
  }
  /** 时:分。先四舍五入到整分钟——直接取"时:分"会把秒舍掉，显示的时刻最多会早 59 秒 */
  function fmtHM(date, tz) {
    var p = zonedParts(roundMinute(date), tz);
    return pad(p.h) + ':' + pad(p.mi);
  }
  function roundMinute(date) {
    return new Date(Math.round(date.getTime() / 60000) * 60000);
  }
  /** 时区下拉列表的选项：本机时区、UTC 排在最前，其余按名称排序 */
  function timeZoneList() {
    var list = [];
    try {
      if (Intl.supportedValuesOf) list = Intl.supportedValuesOf('timeZone').slice();
    } catch (e) { list = []; }
    if (!list.length) {
      list = ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Urumqi', 'Asia/Tokyo', 'Asia/Seoul',
        'Asia/Singapore', 'Asia/Kolkata', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
        'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Santiago',
        'Pacific/Honolulu', 'Australia/Sydney', 'Pacific/Auckland'];
    }
    list = list.filter(function (z) { return z !== browserTz && z !== 'UTC'; });
    return [browserTz, 'UTC'].concat(list);
  }

  /* =====================================================================
   * 三、设置与状态
   * ===================================================================== */

  // 预设观测地点（坐标为近似值，可在输入框中手动修改）；tz 为当地时区，选择预设地点时会自动切换。
  // name 为中文名（同时用作保存设置时的标识，保持与旧版本兼容），en 为英文界面显示的名称
  var SITES = [
    { name: '北京', en: 'Beijing', lat: 39.9042, lon: 116.4074, elev: 44, tz: 'Asia/Shanghai' },
    { name: '上海', en: 'Shanghai', lat: 31.2304, lon: 121.4737, elev: 4, tz: 'Asia/Shanghai' },
    { name: '广州', en: 'Guangzhou', lat: 23.1291, lon: 113.2644, elev: 21, tz: 'Asia/Shanghai' },
    { name: '成都', en: 'Chengdu', lat: 30.5728, lon: 104.0668, elev: 500, tz: 'Asia/Shanghai' },
    { name: '西安', en: "Xi'an", lat: 34.3416, lon: 108.9398, elev: 400, tz: 'Asia/Shanghai' },
    { name: '乌鲁木齐', en: 'Urumqi', lat: 43.8256, lon: 87.6168, elev: 800, tz: 'Asia/Shanghai' },
    { name: '拉萨', en: 'Lhasa', lat: 29.6525, lon: 91.1721, elev: 3656, tz: 'Asia/Shanghai' },
    { name: '香港', en: 'Hong Kong', lat: 22.3193, lon: 114.1694, elev: 30, tz: 'Asia/Hong_Kong' },
    { name: '台北', en: 'Taipei', lat: 25.0330, lon: 121.5654, elev: 10, tz: 'Asia/Taipei' },
    { name: '兴隆观测基地（河北）', en: 'Xinglong Observatory (Hebei)', lat: 40.3942, lon: 117.5750, elev: 960, tz: 'Asia/Shanghai' },
    { name: '丽江高美古观测站（云南）', en: 'Lijiang Gaomeigu Observatory (Yunnan)', lat: 26.6951, lon: 100.0300, elev: 3200, tz: 'Asia/Shanghai' },
    { name: '冷湖赛什腾山（青海）', en: 'Lenghu, Saishiteng Mountain (Qinghai)', lat: 38.6068, lon: 93.8961, elev: 4200, tz: 'Asia/Shanghai' },
    // 美国：城市在前，这样按本机时区选默认地点时优先选中城市
    { name: '纽约', en: 'New York', lat: 40.7128, lon: -74.0060, elev: 10, tz: 'America/New_York' },
    { name: '芝加哥', en: 'Chicago', lat: 41.8781, lon: -87.6298, elev: 181, tz: 'America/Chicago' },
    { name: '丹佛', en: 'Denver', lat: 39.7392, lon: -104.9903, elev: 1609, tz: 'America/Denver' },
    { name: '菲尼克斯', en: 'Phoenix', lat: 33.4484, lon: -112.0740, elev: 331, tz: 'America/Phoenix' },
    { name: '洛杉矶', en: 'Los Angeles', lat: 34.0522, lon: -118.2437, elev: 89, tz: 'America/Los_Angeles' },
    { name: '基特峰国家天文台（亚利桑那）', en: 'Kitt Peak National Observatory (Arizona)', lat: 31.9583, lon: -111.5967, elev: 2096, tz: 'America/Phoenix' },
    { name: '帕洛玛天文台（加利福尼亚）', en: 'Palomar Observatory (California)', lat: 33.3564, lon: -116.8650, elev: 1712, tz: 'America/Los_Angeles' },
    { name: '麦克唐纳天文台（得克萨斯）', en: 'McDonald Observatory (Texas)', lat: 30.6714, lon: -104.0225, elev: 2070, tz: 'America/Chicago' },
    { name: '格林尼治（伦敦）', en: 'Greenwich (London)', lat: 51.4769, lon: -0.0005, elev: 46, tz: 'Europe/London' },
    { name: '莫纳克亚（夏威夷）', en: 'Mauna Kea (Hawaii)', lat: 19.8207, lon: -155.4681, elev: 4205, tz: 'Pacific/Honolulu' },
    { name: '帕拉纳尔（智利）', en: 'Paranal (Chile)', lat: -24.6275, lon: -70.4044, elev: 2635, tz: 'America/Santiago' },
    { name: '悉尼', en: 'Sydney', lat: -33.8688, lon: 151.2093, elev: 58, tz: 'Australia/Sydney' }
  ];

  // 首次打开时的默认地点：与本机时区相同的预设地点（例如本机为北京时间 → 北京）；
  // 没有时取当前 UTC 偏移相同的预设地点（例如 America/Detroit → 纽约）；都没有则中文界面用北京、英文界面用格林尼治
  var defaultSite = SITES.filter(function (s) { return s.tz === browserTz; })[0] || (function () {
    var now = new Date(), off = tzOffsetMin(now, browserTz);
    return SITES.filter(function (s) { return tzOffsetMin(now, s.tz) === off; })[0];
  })() || SITES.filter(function (s) { return I18n.isEn && s.tz === 'Europe/London'; })[0] || SITES[0];

  /** 地点的显示名称：预设地点按当前语言显示，"自定义""当前位置"也翻译 */
  function siteName(s) {
    var p = SITES.filter(function (x) { return x.name === s.name && x.lat === s.lat && x.lon === s.lon; })[0];
    if (p) return I18n.isEn ? p.en : p.name;
    return T(s.name);
  }

  var DEFAULTS = {
    site: defaultSite,
    tz: browserTz,
    refraction: true,
    precision: 'std',
    radecDeg: false, // 结果区的赤经赤纬是否显示为十进制度（否则为时分秒 / 度分秒）
    tab: 'convert',
    night: false,
    layers: { milkyway: true, lines: true, names: true, grid: true, horizon: true }
  };
  var settings = Object.assign({}, DEFAULTS, store.get('settings', {}));
  settings.layers = Object.assign({}, DEFAULTS.layers, settings.layers);
  if (!isValidTz(settings.tz)) settings.tz = browserTz;
  if (!settings.site || !isFinite(settings.site.lat) || !isFinite(settings.site.lon)) settings.site = DEFAULTS.site;
  function saveSettings() {
    store.set('settings', settings);
  }

  // 观测时间：实时（每秒刷新）或用户指定的时刻。不保存，每次打开页面都从"实时"开始
  var timeState = { mode: 'live', custom: new Date() };
  function obsDate() {
    return timeState.mode === 'live' ? new Date() : timeState.custom;
  }

  // 解析后的目标 A / 目标 B（结构见 createCoordInput 中的 parse()）
  var A = { ok: false };
  var B = { ok: false };

  // 显示精度：[赤经秒的小数位, 赤纬角秒的小数位]
  var PRECISION = { low: [1, 0], std: [2, 1], high: [3, 2] };
  function prec() {
    return PRECISION[settings.precision] || PRECISION.std;
  }
  function fRA(deg, style) {
    return Angle.formatHMS(deg / 15, prec()[0], style);
  }
  function fDec(deg, style) {
    return Angle.formatDMS(deg, prec()[1], style);
  }
  function fLon(deg) {
    return Angle.formatDMS(deg, prec()[1], 'dms', false);
  }
  function fDeg(deg, signed) {
    return Angle.formatDecimal(deg, prec()[0] + 4, signed) + '°';
  }
  /**
   * 结果区的一对赤经赤纬 → [赤经文字, 赤纬文字, 复制文字]。
   * 按"赤经赤纬显示为十进制度"开关：时分秒 + 度分秒，或十进制度（小数位与 fDeg 相同，随显示精度变化）。
   * 十进制度复制时不带 ° 符号，与"整行（十进制度）"一致，便于粘贴到其他软件
   */
  function radecParts(ra, dec) {
    if (settings.radecDeg) {
      var n = prec()[0] + 4;
      var a = Angle.formatDecimal(ra, n), d = Angle.formatDecimal(dec, n, true);
      if (+a >= 360) a = (0).toFixed(n); // 赤经紧挨 360° 时，舍入后可能变成 360，统一显示为 0
      return [a + '°', d + '°', a + ' ' + d];
    }
    var r = fRA(ra), s = fDec(dec);
    return [r, s, r + ' ' + s];
  }
  /** 结果表（kv）中的一行赤经赤纬：[标签, 两段坐标, 复制文字, 是否强调] */
  function radecRow(label, ra, dec, strong, note) {
    var p = radecParts(ra, dec);
    return [label, pair(p[0], p[1], note), p[2], strong];
  }
  /** 带符号的时分秒（时角、赤经差等） */
  function fHMSsigned(hours, decimals) {
    return (hours < 0 ? '-' : '+') + Angle.formatHMS(Math.abs(hours), decimals == null ? prec()[0] - 1 : decimals);
  }
  /** 赤经差（度）→ "+1m 12.35s" */
  function fDeltaTime(deg) {
    var sec = deg * 240;
    var sign = sec < 0 ? '-' : '+';
    var a = Math.abs(sec);
    var m = Math.floor(a / 60);
    var s = a - m * 60;
    var d = prec()[0] + 1;
    if (+s.toFixed(d) >= 60) { m += 1; s = 0; }
    return sign + (m ? m + 'm ' : '') + s.toFixed(d) + 's';
  }
  /** 角度差（度）→ "+4′ 12.3″" */
  function fDeltaArc(deg) {
    var sign = deg < 0 ? '-' : '+';
    var a = Math.abs(deg);
    if (a >= 1) return sign + Angle.formatDMS(a, prec()[1], 'dms', false);
    var as = a * 3600;
    var m = Math.floor(as / 60);
    var s = as - m * 60;
    var d = prec()[1] + 1;
    if (+s.toFixed(d) >= 60) { m += 1; s = 0; }
    return sign + (m ? m + '′ ' : '') + s.toFixed(d) + '″';
  }
  /** 方位 → 八方位名（中文界面"北 N"，英文界面"N"） */
  function compass8(az) {
    var names = I18n.isEn ? ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
      : ['北 N', '东北 NE', '东 E', '东南 SE', '南 S', '西南 SW', '西 W', '西北 NW'];
    return names[Math.round((((az % 360) + 360) % 360) / 45) % 8];
  }

  // IAU 缩写 → 星座信息
  var CON_BY_AB = {};
  (Data.constellations || []).forEach(function (c) {
    if (!CON_BY_AB[c.ab]) CON_BY_AB[c.ab] = c;
  });
  function constellationName(ab) {
    var c = CON_BY_AB[ab];
    return c ? (I18n.isEn ? c.la : c.zh) : ab; // 英文界面用拉丁名，例如 Andromeda
  }

  /** 常用天体的显示名称与副标题（中文界面：中文名 + 英文名；英文界面：英文名 + 第一个非中文别名，如 M31、α CMa） */
  function objName(o) {
    return I18n.isEn ? o.en : o.zh;
  }
  function objSub(o) {
    if (!I18n.isEn) return o.en;
    var alias = (o.alias || []).filter(function (a) { return !/[\u4e00-\u9fff]/.test(a) && a !== o.en; });
    return alias[0] || '';
  }
  /** 星表恒星的显示名称：优先当前语言的星名，再退到拜耳/弗兰斯蒂德名、HIP 编号；都没有时显示"恒星" */
  function starLabel(s) {
    return (I18n.isEn ? s.en : (s.zh || s.en)) || s.desig || (s.hip ? 'HIP ' + s.hip : T('恒星'));
  }

  /** 坐标解析错误的提示（按当前语言重新生成，参数中的分量名称如"赤纬"也一并翻译） */
  function errText(e) {
    if (!(e instanceof Angle.ParseError) || !e.key) return e.message;
    var p = e.params ? Object.assign({}, e.params) : null;
    if (p && p.label) p.label = T(p.label);
    return T(e.key, p);
  }

  /* =====================================================================
   * 四、历元选择器组件
   * ===================================================================== */

  var EPOCH_OPTIONS = [
    ['J2000', 'J2000.0' + paren('ICRS')],
    ['B1950', 'B1950.0' + paren('FK4')],
    ['obs', T('观测时刻（JNow）')],
    ['date', T('指定日期…')],
    ['jepoch', T('儒略历元…')]
  ];

  /**
   * @param {HTMLElement} container
   * @param {object} opts { label, defaultMode, allowApparent, onChange }
   */
  function createEpochPicker(container, opts) {
    opts = opts || {};
    var nm = opts.name || 'epoch';
    var sel = h('select', { name: nm + '-mode', id: nm + '-mode', 'aria-label': opts.label || T('历元') });
    EPOCH_OPTIONS.forEach(function (o) { sel.appendChild(h('option', { value: o[0], text: o[1] })); });
    var dateIn = h('input', { type: 'datetime-local', name: nm + '-date', step: '1', 'aria-label': T('历元对应的日期时间（所选时区）'), hidden: true });
    var numIn = h('input', { type: 'number', name: nm + '-jepoch', step: '0.1', inputmode: 'decimal', placeholder: '2050.0', 'aria-label': T('儒略历元，例如 2050.0'), hidden: true });
    var appCb = h('input', { type: 'checkbox', name: nm + '-apparent' });
    var appWrap = h('label', { class: 'check', hidden: true, title: T('勾选表示输入的是该时刻的视位置（例如赤道仪/望远镜显示的 JNow 坐标），未勾选表示平位置') },
      [appCb, h('span', { text: T('视位置') })]);
    var note = h('div', { class: 'epoch__note', hidden: true });
    var wrap = h('div', { class: 'epoch' }, [h('span', { class: 'epoch__label', text: opts.label || T('历元') }), sel, dateIn, numIn, appWrap, note]);
    container.appendChild(wrap);

    sel.value = opts.defaultMode || 'J2000';
    numIn.value = '2050.0';
    dateIn.value = toLocalInput(new Date(), settings.tz);

    function sync() {
      var m = sel.value;
      dateIn.hidden = m !== 'date';
      numIn.hidden = m !== 'jepoch';
      appWrap.hidden = !opts.allowApparent || !(m === 'obs' || m === 'date' || m === 'jepoch');
    }
    function changed() {
      sync();
      if (opts.onChange) opts.onChange();
    }
    sel.addEventListener('change', changed);
    dateIn.addEventListener('change', changed);
    numIn.addEventListener('input', debounce(changed, 250));
    appCb.addEventListener('change', changed);
    sync();

    return {
      el: wrap,
      /** 当前选择 → { ok, epoch（传给 Astro 的历元对象）, label, jdTT, timeDependent, fk4 } */
      resolve: function () {
        var m = sel.value;
        if (m === 'J2000') return { ok: true, epoch: { kind: 'J2000' }, label: 'J2000.0', jdTT: Astro.J2000 };
        if (m === 'B1950') return { ok: true, epoch: { kind: 'B1950' }, label: 'B1950.0' + paren('FK4'), jdTT: Astro.JD_B1950, fk4: true };
        var jdTT, label, date = null;
        if (m === 'obs' || m === 'date') {
          date = m === 'obs' ? obsDate() : parseLocalInput(dateIn.value, settings.tz);
          if (!date || isNaN(date.getTime())) return { ok: false, error: T('请填写有效的日期时间') };
          jdTT = Astro.jdTTFromUtc(Astro.jdFromDate(date));
          var dt = fmtDateTime(date, settings.tz);
          label = (m === 'obs' ? T('观测时刻 {date}', { date: dt }) : dt) + paren('J' + Astro.julianEpoch(jdTT).toFixed(3));
        } else {
          var ep = parseFloat(numIn.value);
          if (!isFinite(ep) || ep < -4000 || ep > 8000) return { ok: false, error: T('请输入有效的儒略历元，例如 2050.0') };
          jdTT = Astro.jdFromJulianEpoch(ep);
          date = Astro.dateFromJd(jdTT);
          label = 'J' + (Math.round(ep * 10) === ep * 10 ? ep.toFixed(1) : String(ep));
        }
        var apparent = !!(opts.allowApparent && appCb.checked);
        return {
          ok: true, epoch: { kind: 'jd', jdTT: jdTT, apparent: apparent }, label: label + (apparent ? ' · ' + T('视位置') : ''),
          jdTT: jdTT, date: date, timeDependent: m === 'obs'
        };
      },
      /** 黄道坐标不支持 FK4，切换坐标系时禁用 B1950 选项 */
      setAllowB1950: function (allow) {
        var opt = sel.querySelector('option[value="B1950"]');
        opt.disabled = !allow;
        if (!allow && sel.value === 'B1950') {
          sel.value = 'J2000';
          sync();
        }
      },
      setNote: function (text, isError) {
        note.hidden = !text;
        note.textContent = text || '';
        note.classList.toggle('is-error', !!isError);
      },
      mode: function () {
        return sel.value;
      },
      setMode: function (m) {
        sel.value = m;
        if (m !== 'obs' && m !== 'date' && m !== 'jepoch') appCb.checked = false;
        sync();
      }
    };
  }

  /* =====================================================================
   * 五、天体搜索：常用天体（SIMBAD 精确坐标）+ 星表中有名称的恒星；找不到时可在线查询 SIMBAD
   * ===================================================================== */

  var Search = (function () {
    var GREEK = {
      alpha: 'α', alf: 'α', beta: 'β', bet: 'β', gamma: 'γ', gam: 'γ', delta: 'δ', del: 'δ', epsilon: 'ε', eps: 'ε',
      zeta: 'ζ', zet: 'ζ', eta: 'η', theta: 'θ', tet: 'θ', iota: 'ι', iot: 'ι', kappa: 'κ', kap: 'κ', lambda: 'λ',
      lam: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', omi: 'ο', pi: 'π', rho: 'ρ', sigma: 'σ', sig: 'σ', tau: 'τ',
      upsilon: 'υ', ups: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', ome: 'ω'
    };
    var greekRe = new RegExp('(^|[^a-z])(' + Object.keys(GREEK).sort(function (a, b) { return b.length - a.length; }).join('|') + ')(?![a-z])', 'g');
    // 星座中文名（含/不含"座"）→ 缩写，长名字优先替换（例如"南三角座"先于"三角座"）
    var conPairs = [];
    (Data.constellations || []).forEach(function (c) {
      conPairs.push([c.zh, c.ab.toLowerCase()]);
      conPairs.push([c.zh.replace(/座$/, ''), c.ab.toLowerCase()]);
    });
    conPairs.sort(function (a, b) { return b[0].length - a[0].length; });

    /** 统一检索用的规范化：全角转半角、小写、希腊字母名→字母、星座中文名→缩写、去掉空白和标点 */
    function norm(s) {
      s = String(s || '');
      if (s.normalize) s = s.normalize('NFKC');
      s = s.toLowerCase().replace(greekRe, function (m, pre, g) { return pre + GREEK[g]; });
      for (var i = 0; i < conPairs.length; i++) {
        if (s.indexOf(conPairs[i][0]) >= 0) s = s.split(conPairs[i][0]).join(conPairs[i][1]);
      }
      return s.replace(/[\s·.\-_'’()（）]/g, '');
    }

    var entries = [];
    var built = false;

    function build(map) {
      if (built) return;
      built = true;
      // 1) 常用天体
      (Data.objects || []).forEach(function (o) {
        entries.push({
          label: objName(o), sub: objSub(o), type: o.type, mag: o.mag, ra: o.ra, dec: o.dec, priority: 2,
          keys: [o.zh, o.en, o.id].concat(o.alias || []).map(norm)
        });
      });
      // 2) 星表中有名称的恒星；与常用天体重合的（30″ 以内）只把名称并入常用天体条目
      var curatedStars = entries.filter(function (e) { return e.type === '恒星' || e.type === '双星' || e.type === '变星'; })
        .map(function (e) { return { e: e, v: Astro.vecFromRaDec(e.ra, e.dec) }; });
      map.namedStars().forEach(function (i) {
        var s = map.starInfo(i);
        var keys = [];
        if (s.zh) keys.push(s.zh);
        if (s.en) keys.push(s.en);
        if (s.bayer) {
          keys.push(s.bayer + s.con, s.con + s.bayer);
          var plain = s.bayer.replace(/\d+$/, '');
          if (plain !== s.bayer) keys.push(plain + s.con, s.con + plain);
        }
        if (s.flam) keys.push(s.flam + s.con, s.con + s.flam);
        if (s.hip) keys.push('hip' + s.hip);
        keys = keys.map(norm);
        var v = Astro.vecFromRaDec(s.ra, s.dec);
        for (var k = 0; k < curatedStars.length; k++) {
          if (Astro.separation(v, curatedStars[k].v) < 30 / 3600) {
            curatedStars[k].e.keys = curatedStars[k].e.keys.concat(keys);
            return;
          }
        }
        var label = starLabel(s);
        var sub = (I18n.isEn ? [s.en ? s.desig : '', s.hip ? 'HIP ' + s.hip : '']
          : [s.zh ? s.en : '', s.desig, s.hip ? 'HIP ' + s.hip : '']).filter(Boolean).join(' · ');
        entries.push({ label: label, sub: sub, type: '恒星', mag: s.mag, ra: s.ra, dec: s.dec, priority: 1, keys: keys });
      });
    }

    /** 本地检索：完全匹配 > 前缀匹配 > 包含匹配；同级时常用天体优先、亮星优先 */
    function find(q, limit) {
      var nq = norm(q);
      if (!nq) return [];
      var scored = [];
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i], best = 0;
        for (var k = 0; k < e.keys.length; k++) {
          var key = e.keys[k];
          if (!key) continue;
          if (key === nq) { best = 3; break; }
          var pos = key.indexOf(nq);
          if (pos === 0) best = Math.max(best, 2);
          else if (pos > 0 && nq.length >= 2) best = Math.max(best, 1);
        }
        if (best) scored.push({ e: e, s: best * 10 + e.priority, m: e.mag == null ? 99 : e.mag });
      }
      scored.sort(function (a, b) { return b.s - a.s || a.m - b.m; });
      return scored.slice(0, limit).map(function (x) { return x.e; });
    }

    /** 在线查询（CDS Sesame 名称解析服务，依次查 SIMBAD、NED、VizieR），返回 ICRS J2000 坐标 */
    function online(name) {
      var url = 'https://cds.unistra.fr/cgi-bin/nph-sesame/-oI/SNV?' + encodeURIComponent(name);
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 10000);
      return fetch(url, ctrl ? { signal: ctrl.signal } : {})
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text();
        }, function (err) {
          throw new Error(err && err.name === 'AbortError' ? T('在线查询超时，请检查网络连接') : T('在线查询失败：需要联网访问 cds.unistra.fr'));
        })
        .then(function (text) {
          clearTimeout(timer);
          var m = /^%J\s+([\d.]+)\s+([+-]?[\d.]+)/m.exec(text);
          if (!m) throw new Error(T('SIMBAD 中没有找到“{name}”', { name: name }));
          var id = /^%I\.0\s+(.+)$/m.exec(text);
          var main = id ? id[1].trim().replace(/\s+/g, ' ').replace(/^NAME /, '') : name;
          return { ra: +m[1], dec: +m[2], name: main };
        }, function (err) {
          clearTimeout(timer);
          throw err;
        });
    }

    return { build: build, find: find, online: online };
  })();

  /* =====================================================================
   * 六、坐标输入组件（目标 A 与目标 B 共用一个模板）
   * ===================================================================== */

  var SYS_TEXT = {
    equatorial: { a: T('赤经 α'), b: T('赤纬 δ'), pa: '05h34m31.9s · 5:34:31.9 · 83.633', pb: '+22°00′52″ · +22 00 52 · 22.0145', name: T('赤道坐标') },
    galactic: { a: T('银经 l'), b: T('银纬 b'), pa: '184.5575 · 184°33′27″', pb: '-5.7843 · -05°47′03″', name: T('银道坐标') },
    ecliptic: { a: T('黄经 λ'), b: T('黄纬 β'), pa: '84.0974 · 84°05′51″', pb: '-1.2944 · -01°17′40″', name: T('黄道坐标') },
    // 地平坐标：按"观测时间与地点"反算赤经赤纬（方位角从正北起算、向东为正）
    horizontal: { a: T('方位角 A'), b: T('高度角 h'), pa: '135.5 · 135°30′', pb: '+45.2 · +45°12′', name: T('地平坐标') }
  };
  // 经度类、纬度类分量的名称（用于解析出错时的提示；保持中文，显示时由 errText() 翻译）
  var SYS_PARTS = { galactic: ['银经', '银纬'], ecliptic: ['黄经', '黄纬'], horizontal: ['方位角', '高度角'] };

  /**
   * @param {HTMLElement} mount 挂载点
   * @param {object} opts { id, onChange(parsed) }
   */
  function createCoordInput(mount, opts) {
    mount.appendChild($('#tpl-coord').content.cloneNode(true));
    var root = mount.querySelector('.coord');
    function role(r) {
      return root.querySelector('[data-role="' + r + '"]');
    }
    var search = role('search'), list = role('search-list');
    var segBtns = $$('[data-sys]', role('sys'));
    var inA = role('in-a'), inB = role('in-b');
    var lblA = role('lbl-a'), lblB = role('lbl-b'), hintA = role('hint-a'), hintB = role('hint-b');
    var bareWrap = role('bare-wrap'), bareSel = role('bare-unit');
    var hzNote = role('hz-note'); // 地平坐标的说明（换算所用的时间、地点）
    var fieldA = inA.closest('.field'), fieldB = inB.closest('.field');
    list.id = opts.id + '-list';
    search.setAttribute('aria-controls', list.id);
    // 两个组件实例共用模板，这里为表单控件补上唯一的 id / name
    search.id = search.name = opts.id + '-search';
    inA.id = inA.name = opts.id + '-lon';
    inB.id = inB.name = opts.id + '-lat';
    bareSel.id = bareSel.name = opts.id + '-bare-unit';

    var sys = 'equatorial';
    var name = null; // 来自搜索/星图拾取的天体名称；手动修改坐标后清空
    var epoch = createEpochPicker(role('epoch'), { name: opts.id + '-epoch', allowApparent: true, onChange: emit });

    function setSys(s, silent) {
      sys = s;
      segBtns.forEach(function (b) { b.setAttribute('aria-checked', b.dataset.sys === s ? 'true' : 'false'); });
      var t = SYS_TEXT[s];
      lblA.textContent = t.a;
      lblB.textContent = t.b;
      inA.placeholder = t.pa;
      inB.placeholder = t.pb;
      bareWrap.hidden = s !== 'equatorial';
      // 银道坐标与历元无关；地平坐标使用"观测时间与地点"中的时刻，也不需要历元
      epoch.el.hidden = s === 'galactic' || s === 'horizontal';
      hzNote.hidden = s !== 'horizontal';
      epoch.setAllowB1950(s === 'equatorial');
      if (!silent) emit();
    }
    segBtns.forEach(function (b) {
      b.addEventListener('click', function () {
        if (sys === b.dataset.sys) return;
        // 切换坐标系时，把当前坐标换算到新坐标系填入（保持同一天体）
        var cur = parse();
        setSys(b.dataset.sys, true);
        if (cur.ok) {
          if (sys === 'horizontal') {
            // 换算成当前观测时间、地点下的方位角和高度角（与"地平坐标"页的口径一致）
            var o = Astro.observe(cur.v, obsDate(), settings.site, { refraction: settings.refraction });
            fill(o.az, o.alt);
            // 固定的方位角、高度角不会跟着天体移动（实时模式下很快就偏离），因此不再沿用天体名称
            name = null;
          } else if (sys === 'galactic') {
            var g = Astro.icrsToGalactic(cur.v);
            fill(g.l, g.b);
          } else {
            var ep = epoch.resolve();
            if (ep.ok && sys === 'ecliptic') {
              var e = Astro.icrsToEcliptic(cur.v, ep.epoch);
              fill(e.lon, e.lat);
            } else if (ep.ok) {
              var q = Astro.icrsToEquatorial(cur.v, ep.epoch);
              fill(q.ra, q.dec);
            }
          }
        }
        emit();
      });
    });
    // 方向键切换坐标系（单选按钮组的键盘操作）
    role('sys').addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var i = segBtns.findIndex(function (b) { return b.dataset.sys === sys; });
      var n = segBtns[(i + (e.key === 'ArrowRight' ? 1 : segBtns.length - 1)) % segBtns.length];
      n.click();
      n.focus();
    });

    /** 把数值以高精度文本填入两个输入框（与当前坐标系对应） */
    function fill(a, b) {
      if (sys === 'equatorial') {
        inA.value = Angle.formatHMS(a / 15, 3);
        inB.value = Angle.formatDMS(b, 2);
      } else {
        inA.value = Angle.formatDecimal(a, 6);
        inB.value = Angle.formatDecimal(b, 6, true);
      }
    }

    function parseFirst(text) {
      return sys === 'equatorial' ? Angle.parseRA(text, { bareUnit: bareSel.value })
        : Angle.parseLongitudeLike(text, SYS_PARTS[sys][0]);
    }
    function parseSecond(text) {
      return sys === 'equatorial' ? Angle.parseDec(text) : Angle.parseLatitudeLike(text, SYS_PARTS[sys][1]);
    }
    /** 地平坐标输入框下方的说明：方位角的起算方向，以及换算所用的时间、地点 */
    function updateHzNote() {
      var text = T(settings.refraction
        ? '方位角从正北起算、向东为正（东 90°、南 180°、西 270°）。按下方“观测时间与地点”换算：{obs}；高度角视为含大气折射的观测值。'
        : '方位角从正北起算、向东为正（东 90°、南 180°、西 270°）。按下方“观测时间与地点”换算：{obs}；不计大气折射。', { obs: obsLabel() });
      if (hzNote.textContent !== text) hzNote.textContent = text;
    }
    function setFieldState(field, hint, text, err, okText) {
      field.classList.toggle('is-error', !!(text && err));
      hint.textContent = text ? (err || okText || '') : '';
    }

    /**
     * 解析当前输入
     * @returns {{ok:boolean, sys, a, b, v(ICRS 单位向量), icrs:{ra,dec}, epoch, epochInfo, name, descA, descB}}
     */
    function parse() {
      var ta = inA.value.trim(), tb = inB.value.trim();
      var pa = null, pb = null, ea = null, eb = null;
      try {
        if (ta) pa = parseFirst(ta);
      } catch (e) {
        ea = e instanceof Angle.ParseError ? errText(e) : T('无法解析');
      }
      try {
        if (tb) pb = parseSecond(tb);
      } catch (e) {
        eb = e instanceof Angle.ParseError ? errText(e) : T('无法解析');
      }
      // pa.desc 是中文描述（如"十进制度"），显示时再翻译
      setFieldState(fieldA, hintA, ta, ea, pa && (T('识别为{desc}', { desc: T(pa.desc) }) + (sys === 'equatorial' && pa.desc !== '十进制度' ? ' = ' + Angle.formatDecimal(pa.deg, 4) + '°' : '')));
      setFieldState(fieldB, hintB, tb, eb, pb && T('识别为{desc}', { desc: T(pb.desc) }));
      var ep;
      if (sys === 'galactic') {
        ep = { ok: true, epoch: null, label: '' };
      } else if (sys === 'horizontal') {
        // 同一方位角、高度角对应的赤经赤纬随时间变化（约每秒 15″），实时模式下由 tick() 每秒重新解析
        ep = { ok: true, epoch: null, label: obsLabel(), timeDependent: true };
        updateHzNote();
      } else {
        ep = epoch.resolve();
      }
      epoch.setNote(ep.ok ? '' : ep.error, !ep.ok);
      if (!pa || !pb || !ep.ok) return { ok: false, empty: !ta && !tb, sys: sys };
      var v = sys === 'horizontal'
        ? Astro.horizontalToICRS(pa.deg, pb.deg, obsDate(), settings.site, { refraction: settings.refraction })
        : Astro.toICRS(sys, pa.deg, pb.deg, ep.epoch);
      return {
        ok: true, sys: sys, a: pa.deg, b: pb.deg, descA: pa.desc, descB: pb.desc,
        epoch: ep.epoch, epochInfo: ep, epochLabel: ep.label,
        v: v, icrs: Astro.raDecFromVec(v), name: name
      };
    }

    function emit() {
      if (opts.onChange) opts.onChange(parse());
    }
    var emitSoon = debounce(emit, 150);

    /** 粘贴整行坐标（如 "05 34 31.9 +22 00 52"）时自动拆分到两个输入框 */
    function trySplit(text, viaPaste, inp) {
      try {
        if (inp === inA) parseFirst(text);
        else parseSecond(text);
        return false; // 本身就是合法的单个值，不拆分
      } catch (e) { /* 继续尝试拆分 */ }
      var pair = Angle.splitPair(text);
      if (!pair) return false;
      try {
        parseFirst(pair[0]);
        parseSecond(pair[1]);
      } catch (e) {
        return false;
      }
      // 把标准化后的单位字母还原成易读的符号
      function pretty(s) {
        return /h/.test(s) ? s : s.replace(/d/g, '°').replace(/m/g, '′').replace(/s/g, '″');
      }
      inA.value = pretty(pair[0]);
      inB.value = pretty(pair[1]);
      if (viaPaste) toast(T('已自动拆分为两部分'));
      return true;
    }
    [inA, inB].forEach(function (inp) {
      inp.addEventListener('input', function () {
        name = null;
        emitSoon();
      });
      inp.addEventListener('paste', function (e) {
        var text = (e.clipboardData || window.clipboardData).getData('text');
        if (text && trySplit(text.trim(), true, inp)) {
          e.preventDefault();
          name = null;
          emit();
        }
      });
      inp.addEventListener('blur', function () {
        if (trySplit(inp.value.trim(), false, inp)) emit();
      });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          trySplit(inp.value.trim(), false, inp);
          emit();
        }
      });
    });
    bareSel.addEventListener('change', emit);

    /* ---------- 搜索框 ---------- */
    var results = [];
    var active = -1;
    var busy = false;

    function closeList() {
      list.hidden = true;
      search.setAttribute('aria-expanded', 'false');
      search.removeAttribute('aria-activedescendant');
      active = -1;
    }
    function renderList() {
      list.innerHTML = '';
      results.forEach(function (r, i) {
        var li;
        if (r.online) {
          li = h('li', { class: 'search__item search__item--online', role: 'option', id: opts.id + '-opt-' + i }, [
            h('div', { class: 'search__main' }, [h('span', { class: 'search__name', text: busy ? T('正在查询 SIMBAD…') : T('在线查询“{q}”', { q: r.query }) }),
              h('span', { class: 'search__alt', text: 'SIMBAD / NED' })])
          ]);
        } else {
          li = h('li', { class: 'search__item', role: 'option', id: opts.id + '-opt-' + i }, [
            h('div', { class: 'search__main' }, [h('span', { class: 'search__name', text: r.label }), r.sub ? h('span', { class: 'search__alt', text: r.sub }) : null]),
            h('span', { class: 'search__meta', text: r.mag != null ? T('{type} {mag} 等', { type: T(r.type), mag: r.mag.toFixed(1) }) : T(r.type) })
          ]);
        }
        li.setAttribute('aria-selected', i === active ? 'true' : 'false');
        li.addEventListener('pointerdown', function (e) {
          e.preventDefault(); // 防止输入框失焦导致列表先关闭
          choose(i);
        });
        list.appendChild(li);
      });
      list.hidden = !results.length;
      search.setAttribute('aria-expanded', results.length ? 'true' : 'false');
      if (active >= 0) search.setAttribute('aria-activedescendant', opts.id + '-opt-' + active);
    }
    function suggest() {
      var q = search.value.trim();
      if (!q) {
        closeList();
        return;
      }
      results = Search.find(q, 8);
      results.push({ online: true, query: q });
      active = results.length > 1 ? 0 : -1;
      renderList();
    }
    function choose(i) {
      var r = results[i];
      if (!r) return;
      if (r.online) {
        lookupOnline(r.query);
        return;
      }
      closeList();
      setEquatorialJ2000(r.ra, r.dec, r.label);
      search.value = '';
    }
    function lookupOnline(q) {
      if (busy) return;
      busy = true;
      renderList();
      Search.online(q).then(function (res) {
        busy = false;
        closeList();
        search.value = '';
        setEquatorialJ2000(res.ra, res.dec, res.name);
        toast(T('已从 SIMBAD 获取：{name}', { name: res.name }));
      }, function (err) {
        busy = false;
        renderList();
        toast(err.message);
      });
    }
    search.addEventListener('input', debounce(suggest, 60));
    search.addEventListener('focus', function () {
      if (search.value.trim()) suggest();
    });
    search.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (list.hidden) suggest();
        if (!results.length) return;
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length;
        renderList();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (list.hidden) suggest();
        choose(active >= 0 ? active : 0);
      } else if (e.key === 'Escape') {
        closeList();
      }
    });
    search.addEventListener('blur', function () {
      setTimeout(function () { if (!busy) closeList(); }, 150);
    });

    /** 以 J2000 赤道坐标设置目标（搜索、星图拾取、URL 参数都走这里） */
    function setEquatorialJ2000(ra, dec, nm) {
      setSys('equatorial', true);
      epoch.setMode('J2000');
      fill(ra, dec);
      name = nm || null;
      emit();
    }

    setSys('equatorial', true);
    return {
      parse: parse,
      setEquatorialJ2000: setEquatorialJ2000,
      epoch: epoch,
      emit: emit
    };
  }

  /* =====================================================================
   * 七、观测时间与地点
   * ===================================================================== */

  function initObserver() {
    var toggle = $('#obs-toggle'), body = $('#obs-body');
    toggle.addEventListener('click', function () {
      var open = body.hidden;
      body.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    $('#edit-site').addEventListener('click', function () {
      body.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      toggle.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // ---- 时间模式：实时 / 指定时间 ----
    var modeBtns = $$('#time-mode [data-mode]');
    var timeInput = $('#obs-time');
    function setMode(mode) {
      timeState.mode = mode;
      modeBtns.forEach(function (b) { b.setAttribute('aria-checked', b.dataset.mode === mode ? 'true' : 'false'); });
      $('#time-custom-row').hidden = mode !== 'custom';
      if (mode === 'custom') timeInput.value = toLocalInput(timeState.custom, settings.tz);
      onObserverChange();
    }
    modeBtns.forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.mode === 'custom' && timeState.mode === 'live') timeState.custom = new Date();
        setMode(b.dataset.mode);
      });
    });
    timeInput.addEventListener('change', function () {
      var d = parseLocalInput(timeInput.value, settings.tz);
      if (d && !isNaN(d.getTime())) {
        timeState.custom = d;
        onObserverChange();
      }
    });
    $('#obs-now').addEventListener('click', function () {
      timeState.custom = new Date();
      timeInput.value = toLocalInput(timeState.custom, settings.tz);
      onObserverChange();
    });
    $('#obs-tonight').addEventListener('click', function () {
      var p = zonedParts(new Date(), settings.tz);
      timeState.custom = zonedToDate(p.y, p.mo, p.d, 22, 0, 0, settings.tz);
      timeInput.value = toLocalInput(timeState.custom, settings.tz);
      onObserverChange();
    });

    // ---- 时区 ----
    var tzSel = $('#obs-tz');
    var now = new Date();
    timeZoneList().forEach(function (tz, i) {
      var label = tz + paren(fmtOffset(tzOffsetMin(now, tz)));
      if (i === 0) label = T('本机时区 · {label}', { label: label });
      tzSel.appendChild(h('option', { value: tz, text: label }));
    });
    if (!tzSel.querySelector('option[value="' + settings.tz + '"]')) settings.tz = browserTz;
    tzSel.value = settings.tz;
    tzSel.addEventListener('change', function () {
      settings.tz = tzSel.value;
      saveSettings();
      if (timeState.mode === 'custom') timeInput.value = toLocalInput(timeState.custom, settings.tz);
      onObserverChange();
    });

    // ---- 地点 ----
    var siteSel = $('#obs-site');
    SITES.forEach(function (s, i) { siteSel.appendChild(h('option', { value: String(i), text: siteName(s) })); });
    siteSel.appendChild(h('option', { value: 'custom', text: T('自定义坐标') }));
    var latIn = $('#obs-lat'), lonIn = $('#obs-lon'), elevIn = $('#obs-elev');

    function showSite() {
      var s = settings.site;
      var idx = SITES.findIndex(function (x) { return x.name === s.name && x.lat === s.lat && x.lon === s.lon; });
      siteSel.value = idx >= 0 ? String(idx) : 'custom';
      latIn.value = Angle.formatDecimal(s.lat, 4);
      lonIn.value = Angle.formatDecimal(s.lon, 4);
      elevIn.value = String(Math.round(s.elev || 0));
      $('#obs-lat-hint').textContent = '';
      $('#obs-lon-hint').textContent = '';
    }
    siteSel.addEventListener('change', function () {
      if (siteSel.value === 'custom') {
        latIn.focus();
        return;
      }
      settings.site = Object.assign({}, SITES[+siteSel.value]);
      // 预设地点自带时区：自动切换，使升落时刻、曲线横轴都显示为当地时间
      var siteTz = settings.site.tz;
      if (siteTz && isValidTz(siteTz) && !tzSel.querySelector('option[value="' + siteTz + '"]')) {
        tzSel.appendChild(h('option', { value: siteTz, text: siteTz + paren(fmtOffset(tzOffsetMin(new Date(), siteTz))) }));
      }
      if (siteTz && siteTz !== settings.tz && tzSel.querySelector('option[value="' + siteTz + '"]')) {
        settings.tz = siteTz;
        tzSel.value = siteTz;
        if (timeState.mode === 'custom') timeInput.value = toLocalInput(timeState.custom, settings.tz);
        toast(T('时区已切换为当地时间：{tz}（{off}）', { tz: siteTz, off: fmtOffset(tzOffsetMin(new Date(), siteTz)) }));
      }
      saveSettings();
      showSite();
      onObserverChange();
    });
    var readSiteInputs = debounce(function () {
      var lat, lon, ok = true;
      try {
        lat = Angle.parseObserverLat(latIn.value).deg;
        $('#obs-lat-hint').textContent = '';
        latIn.closest('.field').classList.remove('is-error');
      } catch (e) {
        ok = false;
        $('#obs-lat-hint').textContent = errText(e);
        latIn.closest('.field').classList.add('is-error');
      }
      try {
        lon = Angle.parseObserverLon(lonIn.value).deg;
        $('#obs-lon-hint').textContent = '';
        lonIn.closest('.field').classList.remove('is-error');
      } catch (e) {
        ok = false;
        $('#obs-lon-hint').textContent = errText(e);
        lonIn.closest('.field').classList.add('is-error');
      }
      var elev = parseFloat(elevIn.value);
      if (!isFinite(elev)) elev = 0;
      if (!ok) return;
      settings.site = { name: '自定义', lat: lat, lon: lon, elev: elev }; // 名称存中文，显示时由 siteName() 翻译
      siteSel.value = 'custom';
      saveSettings();
      onObserverChange();
    }, 350);
    [latIn, lonIn, elevIn].forEach(function (el) { el.addEventListener('input', readSiteInputs); });

    $('#obs-geo').addEventListener('click', function () {
      if (!navigator.geolocation) {
        toast(T('当前浏览器不支持定位'));
        return;
      }
      toast(T('正在获取位置…'));
      navigator.geolocation.getCurrentPosition(function (pos) {
        settings.site = {
          name: '当前位置', lat: pos.coords.latitude, lon: pos.coords.longitude,
          elev: pos.coords.altitude != null ? pos.coords.altitude : 0
        };
        saveSettings();
        showSite();
        onObserverChange();
        toast(T('已使用当前位置'));
      }, function (err) {
        toast(err.code === 1 ? T('定位权限被拒绝，请手动输入经纬度') : T('无法获取位置，请手动输入经纬度'));
      }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
    });

    var refr = $('#obs-refraction');
    refr.checked = settings.refraction;
    refr.addEventListener('change', function () {
      settings.refraction = refr.checked;
      saveSettings();
      onObserverChange();
    });

    showSite();
    setMode('live');
  }

  /** 观测设置的一行摘要 */
  function siteText() {
    var s = settings.site;
    var lat = Math.abs(s.lat).toFixed(2) + '°' + (s.lat >= 0 ? 'N' : 'S');
    var lon = Math.abs(s.lon).toFixed(2) + '°' + (s.lon >= 0 ? 'E' : 'W');
    return siteName(s) + paren(lat + ', ' + lon + (s.elev ? ', ' + Math.round(s.elev) + ' m' : ''));
  }
  /** 观测时刻与地点的简短说明，如"实时 · 北京"或"2026-10-19 22:00:00 · 北京"（地平坐标输入、结果标题用） */
  function obsLabel() {
    return (timeState.mode === 'live' ? T('实时') : fmtDateTime(obsDate(), settings.tz)) + ' · ' + siteName(settings.site);
  }
  function updateObserverSummary() {
    var d = obsDate();
    var tzLabel = fmtOffset(tzOffsetMin(d, settings.tz));
    var t = timeState.mode === 'live' ? T('实时') : fmtDateTime(d, settings.tz);
    $('#obs-summary').textContent = t + ' · ' + tzLabel + ' · ' + siteText();
    $('#out-site').textContent = siteText() + ' · ' + t + paren(tzLabel);
  }

  function onObserverChange() {
    updateObserverSummary();
    // 观测时刻可能影响"观测时刻（JNow）"历元，所以重新解析两个输入
    if (coordA) A = coordA.parse();
    if (coordB) B = coordB.parse();
    renderAll();
    updateHorizonOnMap();
    tick(true);
  }

  /* =====================================================================
   * 八、结果渲染
   * ===================================================================== */

  /**
   * 键值行列表
   * @param {Array} rows 每行 [标签, 值(文本或节点), 复制文本, 是否强调, 引用键]；
   *                     复制文本为 false 时不显示复制按钮，为空时复制显示的文字
   * @param {object} [refs] 传入时，带"引用键"的行会登记到 refs[键] = {val}，
   *                        之后可直接改 val.textContent 与 data-copy 实现原地更新（实时刷新时不重建 DOM）
   */
  function kv(rows, refs) {
    var g = h('div', { class: 'kv' });
    rows.forEach(function (r) {
      if (!r) return;
      g.appendChild(h('div', { class: 'kv__k', text: r[0] }));
      var cls = 'kv__v' + (r[3] ? ' kv__v--strong' : '');
      var val = typeof r[1] === 'string' ? h('div', { class: cls, text: r[1] }) : h('div', { class: cls }, [r[1]]);
      g.appendChild(val);
      if (refs && r[4]) refs[r[4]] = { val: val };
      if (r[2] === false) {
        g.appendChild(h('span', { class: 'copy-spacer' }));
        return;
      }
      // 要复制的文字记在 data-copy 上（为空表示复制显示的文字），点击由 initCopy() 统一处理。
      // 不给每个元素单独绑定事件，这样结果被"原地更新"后复制的仍是最新数值
      val.setAttribute('data-copy', r[2] || '');
      val.title = T('点击复制');
      val.style.cursor = 'copy';
      var btn = h('button', { type: 'button', class: 'copy-btn', title: T('复制'), 'aria-label': T('复制{label}', { label: r[0] }) });
      btn.innerHTML = COPY_ICON;
      g.appendChild(btn);
    });
    return g;
  }
  /** 结果区的复制（事件委托）：点击数值本身，或点击数值右侧的复制按钮 */
  function initCopy() {
    document.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('.kv__v[data-copy], .copy-btn') : null;
      if (!t) return;
      var val = t.classList.contains('copy-btn') ? t.previousElementSibling : t;
      if (!val || !val.hasAttribute('data-copy')) return;
      copyText(val.getAttribute('data-copy') || val.textContent.trim());
    });
  }
  /** 一对坐标（两段文字，窄屏时自动换行） */
  function pair(x, y, note) {
    return h('span', {}, [
      h('span', { style: 'white-space:nowrap', text: x }), '  ',
      h('span', { style: 'white-space:nowrap', text: y }),
      note ? h('small', { text: note }) : null
    ]);
  }
  function sectionTitle(text) {
    return h('div', { class: 'section-title', text: text });
  }
  function emptyState(parsed, what) {
    // 英文句子里默认的"目标"写作 the target；"目标 A/B"按专名翻译
    var w = I18n.isEn ? (what ? T(what) : 'the target') : (what || '目标');
    var msg = parsed && parsed.empty ? T('请输入{what}的坐标，或在上方搜索天体名称', { what: w })
      : T('请检查{what}坐标的输入格式（输入框下方有提示）', { what: w });
    return h('div', { class: 'empty', text: msg });
  }
  function notes(lines) {
    return h('div', { class: 'notes' }, lines.map(function (t) { return h('p', { text: t }); }));
  }
  /**
   * 清空容器并返回它，供渲染函数往里填内容。
   * 在 renderPatched() 期间例外：不动页面上的容器，而是返回一个同类型的空白临时容器，
   * 渲染结束后再把临时容器的内容"合并"到页面上（见 morphChildren）。
   */
  var patchList = null;
  function clear(el) {
    if (patchList) {
      var tmp = el.cloneNode(false);
      patchList.push([el, tmp]);
      return tmp;
    }
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  }

  /**
   * 以"原地更新"方式执行渲染函数（实时刷新用）。
   * 每秒都清空重建 DOM 的话，键盘焦点、鼠标悬停状态和选中的文字都会丢失；
   * 这里只修改有变化的文字和属性，结构不变的节点原样保留。
   * 注意：不要用于地平坐标页——它登记了元素引用，由 patchHorizon() 自行原地更新。
   */
  function renderPatched(fn) {
    patchList = [];
    try {
      fn();
    } finally {
      var list = patchList;
      patchList = null;
      list.forEach(function (p) { morphChildren(p[0], p[1]); });
    }
  }
  /** 把 next 的子节点合并进 cur：节点类型、标签相同则同步文字和属性并递归处理子节点，不同则替换 */
  function morphChildren(cur, next) {
    var src = Array.prototype.slice.call(next.childNodes);
    for (var i = 0; i < src.length; i++) {
      var old = cur.childNodes[i], node = src[i];
      if (!old) {
        cur.appendChild(node);
      } else if (old.nodeType !== node.nodeType || old.nodeName !== node.nodeName) {
        cur.replaceChild(node, old);
      } else if (node.nodeType === 3) {
        if (old.data !== node.data) old.data = node.data; // 文字节点
      } else if (node.nodeType === 1) {
        syncAttrs(old, node);
        morphChildren(old, node);
      }
    }
    while (cur.childNodes.length > src.length) cur.removeChild(cur.lastChild);
  }
  function syncAttrs(old, node) {
    var i, a;
    for (i = old.attributes.length - 1; i >= 0; i--) {
      a = old.attributes[i];
      if (!node.hasAttribute(a.name)) old.removeAttribute(a.name);
    }
    for (i = 0; i < node.attributes.length; i++) {
      a = node.attributes[i];
      if (old.getAttribute(a.name) !== a.value) old.setAttribute(a.name, a.value);
    }
  }

  /* ---------- 坐标转换 ---------- */
  function renderConvert() {
    var fmt = clear($('#out-format')), sysEl = clear($('#out-systems'));
    if (!A.ok) {
      fmt.appendChild(emptyState(A));
      return;
    }
    var epochNote = A.sys === 'galactic' ? '' : paren(A.epochLabel);
    fmt.appendChild(sectionTitle(T('格式转换') + ' · ' + SYS_TEXT[A.sys].name + epochNote));
    var rows;
    if (A.sys === 'equatorial') {
      var ra = A.a, dec = A.b;
      var hrs = Angle.formatDecimal(ra / 15, prec()[0] + 5);
      rows = [
        [T('赤经 时分秒'), fRA(ra), fRA(ra), true],
        [T('赤经 冒号格式'), fRA(ra, 'colon'), fRA(ra, 'colon')],
        [T('赤经 十进制小时'), hrs + ' h', hrs],
        [T('赤经 十进制度'), fDeg(ra), Angle.formatDecimal(ra, prec()[0] + 4)],
        [T('赤纬 度分秒'), fDec(dec), fDec(dec), true],
        [T('赤纬 冒号格式'), fDec(dec, 'colon'), fDec(dec, 'colon')],
        [T('赤纬 十进制度'), fDeg(dec, true), Angle.formatDecimal(dec, prec()[0] + 4, true)],
        [T('整行（空格）'), fRA(ra, 'space') + ' ' + fDec(dec, 'space'), fRA(ra, 'space') + ' ' + fDec(dec, 'space')],
        [T('整行（十进制度）'), Angle.formatDecimal(ra, prec()[0] + 4) + ' ' + Angle.formatDecimal(dec, prec()[0] + 4, true),
          Angle.formatDecimal(ra, prec()[0] + 4) + ' ' + Angle.formatDecimal(dec, prec()[0] + 4, true)]
      ];
    } else {
      var t = SYS_TEXT[A.sys];
      var la = Angle.formatDecimal(A.a, prec()[0] + 4), lb = Angle.formatDecimal(A.b, prec()[0] + 4, true);
      rows = [
        [T('{label} 度分秒', { label: t.a }), fLon(A.a), fLon(A.a), true],
        [T('{label} 十进制', { label: t.a }), la + '°', la],
        [T('{label} 度分秒', { label: t.b }), fDec(A.b), fDec(A.b), true],
        [T('{label} 十进制', { label: t.b }), lb + '°', lb],
        [T('整行（十进制度）'), la + ' ' + lb, la + ' ' + lb]
      ];
    }
    fmt.appendChild(kv(rows));

    // ---- 各坐标系 ----
    sysEl.appendChild(sectionTitle(T('坐标系转换')));
    var v = A.v;
    var j = A.icrs;
    var b1950 = Astro.icrsToFk4(v);
    var gal = Astro.icrsToGalactic(v);
    var ecl = Astro.icrsToEcliptic(v, { kind: 'J2000' });
    var con = Astro.constellationOf(v, Data.constellationBounds);
    var isHz = A.sys === 'horizontal'; // 由地平坐标反算时，赤经赤纬就是要找的结果，加粗显示
    var sysRows = [
      radecRow(T('赤道 J2000'), j.ra, j.dec, isHz),
      radecRow(T('赤道 B1950'), b1950.ra, b1950.dec),
      [T('银道 l, b'), pair(fDeg(gal.l), fDeg(gal.b, true)), Angle.formatDecimal(gal.l, prec()[0] + 4) + ' ' + Angle.formatDecimal(gal.b, prec()[0] + 4, true)],
      [T('黄道 λ, β'), pair(fDeg(ecl.lon), fDeg(ecl.lat, true), 'J2000'), Angle.formatDecimal(ecl.lon, prec()[0] + 4) + ' ' + Angle.formatDecimal(ecl.lat, prec()[0] + 4, true)],
      [T('所在星座'), con ? constellationName(con) + paren(con) : '—', con ? constellationName(con) : '']
    ];
    var sysNotes = [
      T('J2000 即 ICRS 赤道坐标；B1950 为 FK4 参考系（含 E 项改正），按 SLALIB FK45Z/FK54Z 算法换算。'),
      T('银道坐标采用 IAU 1958 定义；黄道坐标为 J2000 平黄道、平春分点。其他历元请到“历元岁差”页查看。')
    ];
    if (isHz) {
      // 地平坐标输入：另外给出观测时刻的视赤经赤纬（赤道仪、望远镜控制软件常用的 JNow 坐标）和时角
      var o = Astro.observe(v, obsDate(), settings.site, { refraction: settings.refraction });
      sysRows.splice(1, 0,
        radecRow(T('赤道 视位置'), o.raApp, o.decApp, true, 'JNow'),
        [T('时角 HA'), fHMSsigned(o.ha), fHMSsigned(o.ha)]);
      sysNotes.unshift(T('地平坐标按观测时间与地点换算：由方位角、高度角求出时角和视赤纬（勾选大气折射时先扣除折射），' +
        '视赤经 = 地方视恒星时 − 时角，再换算到 J2000。') + (timeState.mode === 'live' ? T('实时模式下结果每秒更新。') : ''));
    }
    sysEl.appendChild(kv(sysRows));
    sysEl.appendChild(notes(sysNotes));
  }

  /* ---------- 历元岁差 ---------- */
  var epochOut = null; // 输出历元选择器（在 init 中创建）
  function renderEpoch() {
    var out = clear($('#out-epoch'));
    if (!A.ok) {
      out.appendChild(emptyState(A));
      return;
    }
    var r = epochOut.resolve();
    epochOut.setNote(r.ok ? '' : r.error, !r.ok);
    if (!r.ok) return;
    var v = A.v;
    var j = A.icrs;
    var rows = [];
    rows.push(radecRow(T('输入（J2000）'), j.ra, j.dec));
    var main;
    if (r.epoch.kind === 'J2000') {
      main = j;
      rows.push(radecRow(T('J2000.0 位置'), j.ra, j.dec, true));
    } else if (r.epoch.kind === 'B1950') {
      main = Astro.icrsToFk4(v);
      rows.push(radecRow('B1950.0' + paren('FK4'), main.ra, main.dec, true));
    } else {
      main = Astro.icrsToEquatorial(v, { kind: 'jd', jdTT: r.jdTT });
      var app = Astro.icrsToEquatorial(v, { kind: 'jd', jdTT: r.jdTT, apparent: true });
      rows.push(radecRow(T('平位置'), main.ra, main.dec, true));
      rows.push(radecRow(T('视位置'), app.ra, app.dec, true));
    }
    var dRa = ((main.ra - j.ra + 540) % 360) - 180;
    var dDec = main.dec - j.dec;
    rows.push([T('赤经变化 Δα'), T('{dt}（{da} 天球上）', { dt: fDeltaTime(dRa), da: fDeltaArc(dRa * Math.cos(j.dec * Math.PI / 180)) }), fDeltaTime(dRa)]);
    rows.push([T('赤纬变化 Δδ'), fDeltaArc(dDec), fDeltaArc(dDec)]);
    if (r.epoch.kind === 'jd') {
      var ecl = Astro.icrsToEcliptic(v, { kind: 'jd', jdTT: r.jdTT });
      rows.push([T('黄道 λ, β'), pair(fDeg(ecl.lon), fDeg(ecl.lat, true), T('该历元')), Angle.formatDecimal(ecl.lon, 6) + ' ' + Angle.formatDecimal(ecl.lat, 6, true)]);
    }
    out.appendChild(sectionTitle(T('换算结果') + ' · ' + r.label));
    out.appendChild(kv(rows));

    // 历元信息
    var jd = r.jdTT;
    var info = 'JD(TT) ' + jd.toFixed(5) + ' · J' + Astro.julianEpoch(jd).toFixed(4) + ' · B' + Astro.besselianEpoch(jd).toFixed(4);
    out.appendChild(sectionTitle(T('历元信息')));
    var infoRows = [[T('儒略日与历元'), info, jd.toFixed(5)]];
    if (r.epoch.kind === 'jd') {
      var jdUtc = Astro.jdFromDate(r.date);
      infoRows.push(['TT − UTC', Astro.ttMinusUtc(jdUtc).toFixed(3) + ' s']);
      var n = Astro.nutation(jd);
      infoRows.push([T('章动 Δψ, Δε'), (n.dpsi * 206264.806).toFixed(3) + '″, ' + (n.deps * 206264.806).toFixed(3) + '″']);
      infoRows.push([T('平黄赤交角 ε'), Angle.formatDMS(Astro.obl06(jd) * 180 / Math.PI, 3, 'dms', false)]);
    }
    out.appendChild(kv(infoRows));
    var lines = [
      T('平位置：该历元的平赤道与平春分点（只改正岁差，IAU 2006 模型）。'),
      T('视位置：在平位置基础上再改正章动与周年光行差，为地心视位置（不含周日光行差与大气折射）。'),
      T('未计入天体自行；对高自行恒星，请使用对应历元的星表坐标。')
    ];
    if (r.fk4 || A.epoch && A.epoch.kind === 'B1950') lines.push(T('B1950.0 采用 FK4 参考系（含 E 项改正），并假定天体在 FK5 中没有自行。'));
    out.appendChild(notes(lines));
  }

  /* ---------- 地平坐标 ---------- */
  var chart = null;
  var lastChartKey = '';
  var hz = null; // 已构建的地平坐标视图 { kind, refs }，实时刷新时原地更新文字

  /** 计算地平坐标页需要的全部数值（文本形式），与 DOM 无关 */
  function horizonModel() {
    var date = obsDate();
    var site = settings.site;
    var o = Astro.observe(A.v, date, site, { refraction: settings.refraction });
    // 升起 / 上中天 / 落下：以所选日期当地 0 时之后的第一次上中天为准
    var p = zonedParts(date, settings.tz);
    var dayStart = zonedToDate(p.y, p.mo, p.d, 0, 0, 0, settings.tz);
    var rts = Astro.riseTransitSet(o.raApp, o.decApp, site, Astro.jdFromDate(dayStart), settings.refraction ? -0.5667 : 0);
    // 最高/最低高度也按同样的方式计入大气折射，与上方的高度角口径一致
    var press = Astro.pressureFromElevation(site.elev);
    var refrMax = settings.refraction ? Astro.refraction(rts.maxAlt, press) : 0;
    var refrMin = settings.refraction ? Astro.refraction(rts.minAlt, press) : 0;
    function when(jd) {
      // 先四舍五入到分钟，再判断是否当日（否则 23:59:40 会显示成 00:00 却标"当日"）
      var d = roundMinute(Astro.dateFromJd(jd));
      var q = zonedParts(d, settings.tz);
      var sameDay = q.y === p.y && q.mo === p.mo && q.d === p.d;
      return { time: fmtHM(d, settings.tz), note: sameDay ? T('当日') : I18n.monthDay(q.mo, q.d) };
    }
    var t = {}; // 引用键 → 显示文字
    // 高度角、方位角的小数位随"显示精度"变化：低 3 位（约 3.6″）、标准 4 位（约 0.36″）、高 5 位
    var hd = prec()[1] + 3;
    // 方位角紧挨正北时，舍入后可能变成 360，统一显示为 0
    var azDec = o.az.toFixed(hd), azDms = fLon(o.az);
    if (+azDec >= 360) azDec = (0).toFixed(hd);
    if (/^360/.test(azDms)) azDms = fLon(0);
    t.altLabel = settings.refraction ? T('高度角（含折射）') : T('高度角');
    t.alt = (o.alt >= 0 ? '+' : '') + o.alt.toFixed(hd) + '°';
    t.altState = o.alt > 0 ? T('地平线以上') : T('地平线以下');
    t.az = azDec + '°';
    t.azDir = compass8(o.az);
    var tr = when(rts.transit);
    var kind = rts.circumpolar ? 'circ' : rts.neverRises ? 'never' : 'normal';
    if (kind === 'circ') {
      t.rtsNote = T('拱极天体：在该地终日不落。上中天 {time}（{note}），最高 {max}°，最低 {min}°。',
        { time: tr.time, note: tr.note, max: (rts.maxAlt + refrMax).toFixed(1), min: (rts.minAlt + refrMin).toFixed(1) });
    } else if (kind === 'never') {
      t.rtsNote = T('在该地终年不会升起：上中天时最高也只有 {max}°。', { max: (rts.maxAlt + refrMax).toFixed(1) });
    } else {
      var rise = when(rts.rise), set = when(rts.set);
      t.rise = rise.time;
      t.riseNote = rise.note;
      t.transit = tr.time;
      t.transitNote = T('最高 {max}° · {note}', { max: (rts.maxAlt + refrMax).toFixed(1), note: tr.note });
      t.set = set.time;
      t.setNote = set.note;
    }
    // 详细数值：[标签, 文字, 复制文字, 强调, 引用键]；精度都随"显示精度"变化
    var sd = prec()[0]; // 恒星时秒的小数位，与赤经一致
    var appPos = radecParts(o.raApp, o.decApp); // 视赤经赤纬：按开关显示时分秒/度分秒或十进制度
    var rows = [
      [T('高度角 度分秒'), fDec(o.alt), fDec(o.alt), false, 'altDms'],
      [T('方位角 度分秒'), azDms, azDms, false, 'azDms'],
      [T('时角 HA'), fHMSsigned(o.ha) + (o.ha < 0 ? T('（东侧，尚未中天）') : T('（西侧，已过中天）')), fHMSsigned(o.ha), false, 'ha'],
      [T('地方视恒星时'), Angle.formatHMS(o.last, sd), Angle.formatHMS(o.last, sd), false, 'last'],
      [T('地方平恒星时'), Angle.formatHMS(o.lmst, sd), Angle.formatHMS(o.lmst, sd), false, 'lmst'],
      [T('格林尼治视恒星时'), Angle.formatHMS(o.gast, sd), Angle.formatHMS(o.gast, sd), false, 'gast'],
      [T('格林尼治平恒星时'), Angle.formatHMS(o.gmst, sd), Angle.formatHMS(o.gmst, sd), false, 'gmst'],
      [T('视赤经、视赤纬'), appPos[0] + '  ' + appPos[1], appPos[2], false, 'app'],
      [T('大气质量'), o.airmass ? o.airmass.toFixed(3) : T('—（地平线以下）'), o.airmass ? o.airmass.toFixed(3) : '', false, 'airmass'],
      [T('大气折射'), settings.refraction ? (o.refraction > 0 ? '+' + (o.refraction * 60).toFixed(2) + '′' : T('0（地平线以下不计）')) : T('未计入'), false, false, 'refr'],
      [T('星位角 q'), Angle.formatDecimal(o.parallactic, hd - 1, true) + '°', Angle.formatDecimal(o.parallactic, hd - 1, true), false, 'pa']
    ];
    return { date: date, o: o, rts: rts, kind: kind, t: t, rows: rows, up: o.alt > 0 };
  }

  /** 首次（或结构变化时）构建地平坐标视图，登记需要实时更新的元素 */
  function buildHorizon(out, m) {
    clear(out);
    var refs = {};
    function ref(key, el) {
      refs[key] = el;
      return el;
    }
    var chip = ref('altState', h('span', { class: 'status-chip' }));
    out.appendChild(h('div', { class: 'stats' }, [
      h('div', { class: 'stat stat--accent' }, [
        ref('altLabel', h('div', { class: 'stat__label' })),
        ref('alt', h('div', { class: 'stat__value' })),
        h('div', { class: 'stat__sub' }, [chip])
      ]),
      h('div', { class: 'stat' }, [
        h('div', { class: 'stat__label', text: T('方位角（北起顺时针）') }),
        ref('az', h('div', { class: 'stat__value' })),
        ref('azDir', h('div', { class: 'stat__sub' }))
      ])
    ]));
    if (m.kind === 'normal') {
      var item = function (label, k) {
        return h('div', { class: 'rts__item' }, [h('div', { class: 'rts__k', text: label }),
          ref(k, h('div', { class: 'rts__v' })), ref(k + 'Note', h('div', { class: 'rts__s' }))]);
      };
      out.appendChild(h('div', { class: 'rts' }, [item(T('升起'), 'rise'), item(T('上中天'), 'transit'), item(T('落下'), 'set')]));
    } else {
      out.appendChild(ref('rtsNote', h('div', { class: 'rts-note' })));
    }
    out.appendChild(sectionTitle(T('详细数值')));
    var rowRefs = {};
    out.appendChild(kv(m.rows, rowRefs));
    hz = { kind: m.kind, refs: refs, rows: rowRefs };
    patchHorizon(m);
  }

  /** 原地更新数值文字（不重建 DOM，键盘焦点和悬停状态都不会丢失） */
  function patchHorizon(m) {
    var r = hz.refs;
    for (var k in m.t) {
      if (r[k] && r[k].textContent !== m.t[k]) r[k].textContent = m.t[k];
    }
    r.altState.className = 'status-chip ' + (m.up ? 'status-chip--up' : 'status-chip--down');
    m.rows.forEach(function (row) {
      var ref = hz.rows[row[4]];
      if (!ref) return;
      if (ref.val.textContent !== row[1]) ref.val.textContent = row[1];
      if (row[2] !== false) ref.val.setAttribute('data-copy', row[2] || '');
    });
  }

  function renderHorizon(force) {
    var out = $('#out-horizon');
    if (!A.ok) {
      hz = null;
      clear(out).appendChild(emptyState(A));
      $('#alt-chart').hidden = true;
      return null;
    }
    $('#alt-chart').hidden = false;
    var m = horizonModel();
    if (force || !hz || hz.kind !== m.kind || !out.firstChild) buildHorizon(out, m);
    else patchHorizon(m);

    // 高度角曲线：当地正午到次日正午；只在输入变化或分钟变化时重绘
    // （地平坐标输入在实时模式下每秒都会得到新的赤经赤纬，这里按输入的方位角、高度角判断，避免每秒重画）
    var site = settings.site;
    var target = A.sys === 'horizontal' ? 'hz:' + A.a + ',' + A.b : A.v.join(',');
    var key = [target, site.lat, site.lon, site.elev, settings.tz, settings.refraction, Math.floor(m.date.getTime() / 60000)].join('|');
    if (force || key !== lastChartKey) {
      lastChartKey = key;
      renderChart(m.date);
    }
    return m.o;
  }

  function renderChart(date) {
    if (!chart) chart = RaDec.AltChart.create($('#alt-chart'));
    var tz = settings.tz;
    var p = zonedParts(date, tz);
    var noon = zonedToDate(p.y, p.mo, p.d, 12, 0, 0, tz);
    if (noon.getTime() > date.getTime()) {
      var q = zonedParts(new Date(noon.getTime() - 86400000), tz);
      noon = zonedToDate(q.y, q.mo, q.d, 12, 0, 0, tz);
    }
    var jdStart = Astro.jdFromDate(noon), jdEnd = jdStart + 1;
    var samples = Astro.altitudeTrack(A.v, settings.site, jdStart, jdEnd, 288, { refraction: settings.refraction });
    var ticks = [];
    for (var k = 0; k <= 12; k++) {
      var t = new Date(noon.getTime() + k * 2 * 3600000);
      ticks.push({ jd: Astro.jdFromDate(t), label: fmtHM(t, tz) });
    }
    // 上中天：用解析解求精确时刻（与上方"升起/上中天/落下"一致）；离窗口两端太近时不标注
    var app = Astro.icrsToEquatorial(A.v, { kind: 'jd', jdTT: Astro.jdTTFromUtc(jdStart + 0.5), apparent: true });
    var tr = Astro.riseTransitSet(app.ra, app.dec, settings.site, jdStart, 0);
    var trAlt = tr.maxAlt + (settings.refraction ? Astro.refraction(tr.maxAlt, Astro.pressureFromElevation(settings.site.elev)) : 0);
    var transit = tr.transit - jdStart > 0.02 && jdEnd - tr.transit > 0.02 ? { jd: tr.transit, alt: trAlt } : null;
    var best = samples.reduce(function (m, s) { return s.alt > m.alt ? s : m; }, samples[0]);
    var nowJd = Astro.jdFromDate(date);
    var nowSample = samples[Math.round((nowJd - jdStart) / (jdEnd - jdStart) * 288)] || samples[0];
    var pd = zonedParts(noon, tz);
    chart.update({
      samples: samples, jdStart: jdStart, jdEnd: jdEnd, nowJd: nowJd, nowAlt: nowSample.alt, transit: transit, ticks: ticks,
      formatTime: function (jd) { return fmtHM(Astro.dateFromJd(jd), tz); },
      formatAz: function (az) { return az.toFixed(1) + '°' + paren(compass8(az)); },
      title: T('高度角 · {md} 12:00 至次日 12:00', { md: I18n.monthDay(pd.mo, pd.d) }),
      summary: T('{name}的高度角曲线：最高 {max}°，出现在 {time}',
        { name: A.name || T('目标'), max: best.alt.toFixed(1), time: fmtHM(Astro.dateFromJd(best.jd), tz) })
    });
  }

  /* ---------- 角距离 ---------- */
  function renderSeparation() {
    var out = clear($('#out-sep'));
    if (!A.ok) {
      out.appendChild(emptyState(A, '目标 A'));
      return;
    }
    if (!B.ok) {
      out.appendChild(emptyState(B, '目标 B'));
      return;
    }
    var sep = Astro.separation(A.v, B.v);
    var pa = Astro.positionAngle(A.icrs.ra, A.icrs.dec, B.icrs.ra, B.icrs.dec);
    out.appendChild(h('div', { class: 'stats' }, [
      h('div', { class: 'stat stat--accent' }, [
        h('div', { class: 'stat__label', text: T('角距离') }),
        h('div', { class: 'stat__value', text: Angle.formatAngleAuto(sep) }),
        h('div', { class: 'stat__sub', text: Angle.formatDMS(sep, prec()[1] + 1, 'dms', false) })
      ]),
      h('div', { class: 'stat' }, [
        h('div', { class: 'stat__label', text: T('位置角 PA（B 相对 A）') }),
        h('div', { class: 'stat__value', text: pa.toFixed(2) + '°' }),
        h('div', { class: 'stat__sub', text: T('从北向东量 · 偏{dir}', { dir: compass8(pa).split(' ')[0] }) })
      ])
    ]));
    var rows = [
      [T('角距离（度）'), Angle.formatDecimal(sep, 6) + '°', Angle.formatDecimal(sep, 6)],
      [T('角距离（角分）'), Angle.formatDecimal(sep * 60, 4) + '′', Angle.formatDecimal(sep * 60, 4)],
      [T('角距离（角秒）'), Angle.formatDecimal(sep * 3600, 3) + '″', Angle.formatDecimal(sep * 3600, 3)],
      // 位置角卡片只显示 2 位小数，这里给出随"显示精度"变化的完整数值
      [T('位置角 PA'), Angle.formatDecimal(pa, prec()[1] + 3) + '°', Angle.formatDecimal(pa, prec()[1] + 3)]
    ];
    // 小角度（望远镜视场量级）时给出切平面偏移：以 A 为切点的标准坐标，ξ 向东、η 向北；
    // 角距离较大时切平面投影失真严重，不再显示
    if (sep < 10) {
      var d2r = Math.PI / 180;
      var a1 = A.icrs.ra * d2r, d1 = A.icrs.dec * d2r, a2 = B.icrs.ra * d2r, d2 = B.icrs.dec * d2r;
      var den = Math.sin(d2) * Math.sin(d1) + Math.cos(d2) * Math.cos(d1) * Math.cos(a2 - a1);
      var xi = Math.cos(d2) * Math.sin(a2 - a1) / den / d2r;
      var eta = (Math.sin(d2) * Math.cos(d1) - Math.cos(d2) * Math.sin(d1) * Math.cos(a2 - a1)) / den / d2r;
      rows.push([T('向东偏移 ξ'), fDeltaArc(xi), fDeltaArc(xi)]);
      rows.push([T('向北偏移 η'), fDeltaArc(eta), fDeltaArc(eta)]);
    }
    rows.push(radecRow('A' + paren('J2000'), A.icrs.ra, A.icrs.dec));
    rows.push(radecRow('B' + paren('J2000'), B.icrs.ra, B.icrs.dec));
    out.appendChild(sectionTitle(T('详细数值')));
    out.appendChild(kv(rows));
    var sepNotes = [T('两个坐标会先各自换算到 ICRS（J2000）再计算，因此可以混用不同坐标系和历元。')];
    if (sep < 10) sepNotes.push(T('ξ、η 为以 A 为切点的标准坐标（切平面投影），适合望远镜视场内的偏移计算。'));
    out.appendChild(notes(sepNotes));
  }

  /** 只渲染当前可见的标签页，其余页切换时再渲染 */
  function renderActive() {
    if (settings.tab === 'convert') renderConvert();
    else if (settings.tab === 'epoch') renderEpoch();
    else if (settings.tab === 'horizon') renderHorizon(true);
    else if (settings.tab === 'sep') renderSeparation();
  }
  function renderAll() {
    renderActive();
    updateHud();
    updateTargetOnMap();
    updateSecondaryOnMap();
  }

  /* ---------- 标签页 ---------- */
  var TABS = ['convert', 'epoch', 'horizon', 'sep'];
  function selectTab(name, focus) {
    if (TABS.indexOf(name) < 0) name = 'convert';
    settings.tab = name;
    saveSettings();
    TABS.forEach(function (t) {
      var btn = $('#tab-btn-' + t);
      btn.setAttribute('aria-selected', t === name ? 'true' : 'false');
      btn.tabIndex = t === name ? 0 : -1;
      $('#tab-' + t).hidden = t !== name;
      if (t === name && focus) btn.focus();
    });
    renderActive();
    updateSecondaryOnMap();
  }
  function initTabs() {
    TABS.forEach(function (t, i) {
      var btn = $('#tab-btn-' + t);
      btn.addEventListener('click', function () { selectTab(t); });
      btn.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          selectTab(TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length], true);
        }
      });
    });
  }

  /* =====================================================================
   * 九、星图联动
   * ===================================================================== */

  var map = null;
  var lastFly = null;

  function updateFocus() {
    var r = $('#map-stage').getBoundingClientRect();
    map.setFocusRect({ x: r.left, y: r.top, w: r.width, h: r.height });
  }

  /** 目标标记与视图：坐标明显变化时让星图飞过去 */
  var flySoon = debounce(function () {
    if (!A.ok) return;
    if (lastFly && Astro.separation(Astro.vecFromRaDec(lastFly.ra, lastFly.dec), A.v) < 0.02) return;
    lastFly = A.icrs;
    map.flyTo(A.icrs.ra, A.icrs.dec);
  }, 400);
  function updateTargetOnMap() {
    if (!map) return;
    if (A.ok) {
      map.setMarker('target', A.icrs);
      $('#marker-target-label').textContent = A.name || T('目标');
      flySoon();
    } else {
      map.setMarker('target', null);
    }
  }
  /** 第二目标与大圆弧只在"角距离"页显示，避免干扰 */
  function updateSecondaryOnMap() {
    if (!map) return;
    if (settings.tab === 'sep' && A.ok && B.ok) {
      map.setMarker('secondary', B.icrs);
      $('#marker-secondary-label').textContent = 'B' + (B.name ? ' · ' + B.name : '');
      map.setArc(A.icrs, B.icrs, Angle.formatAngleAuto(Astro.separation(A.v, B.v)));
    } else {
      map.setMarker('secondary', null);
      map.setArc(null);
    }
  }
  /** 地平线：天顶 = (地方视恒星时, 纬度)，换算到 J2000；北点为北天极在地平面上的投影方向 */
  function updateHorizonOnMap() {
    if (!map) return;
    var date = obsDate();
    var jdUtc = Astro.jdFromDate(date);
    var jdTT = Astro.jdTTFromUtc(jdUtc);
    var lst = Astro.gast(jdUtc, jdTT) * 180 / Math.PI + settings.site.lon;
    var ep = { kind: 'jd', jdTT: jdTT };
    var zen = Astro.equatorialToICRS(Astro.wrap360(lst), settings.site.lat, ep);
    var ncp = Astro.equatorialToICRS(0, 90, ep);
    var d = Astro.dot(ncp, zen);
    var north = [ncp[0] - d * zen[0], ncp[1] - d * zen[1], ncp[2] - d * zen[2]];
    var n = Math.hypot(north[0], north[1], north[2]);
    if (n < 1e-6) north = Astro.equatorialToICRS(Astro.wrap360(lst + 180), 0, ep); // 位于地球两极时北点不确定
    else north = [north[0] / n, north[1] / n, north[2] / n];
    map.setHorizon({ zenith: zen, north: north });
  }

  /** 星图右上角的信息框 */
  function updateHud(obs) {
    var name = $('#hud-name'), coord = $('#hud-coord'), meta = $('#hud-meta');
    var badge = $('#target-badge');
    if (!A.ok) {
      name.textContent = T('等待输入坐标');
      coord.textContent = '';
      meta.textContent = '';
      badge.hidden = true;
      return;
    }
    var con = Astro.constellationOf(A.v, Data.constellationBounds);
    name.textContent = A.name || T('自定义坐标');
    coord.textContent = 'α ' + Angle.formatHMS(A.icrs.ra / 15, 1) + '  δ ' + Angle.formatDMS(A.icrs.dec, 0);
    var o = obs || Astro.observe(A.v, obsDate(), settings.site, { refraction: settings.refraction });
    meta.textContent = 'J2000 · ' + (con ? constellationName(con) : '') + ' · ' +
      T('高度 {alt}° · 方位 {az}°', { alt: (o.alt >= 0 ? '+' : '') + o.alt.toFixed(1), az: Math.round(o.az) % 360 });
    badge.hidden = false;
    badge.textContent = (A.name ? A.name + ' · ' : '') + (con ? constellationName(con) : '');
  }

  function initMap() {
    map = new RaDec.StarMap($('#sky'), Data, {
      markers: { target: $('#marker-target'), secondary: $('#marker-secondary') },
      onHover: showStarTip,
      onClick: showPick
    });
    map.setLayers(settings.layers);
    updateFocus();
    window.addEventListener('resize', debounce(function () {
      map.resize();
      updateFocus();
    }, 120));

    // 控件
    $('#zoom-in').addEventListener('click', function () { map.zoomBy(0.75); });
    $('#zoom-out').addEventListener('click', function () { map.zoomBy(1.33); });
    $('#recenter').addEventListener('click', function () {
      if (A.ok) map.flyTo(A.icrs.ra, A.icrs.dec, { fov: 100 });
    });
    var layersBtn = $('#layers-btn'), layersMenu = $('#layers-menu');
    layersBtn.addEventListener('click', function () {
      var open = layersMenu.hidden;
      layersMenu.hidden = !open;
      layersBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('pointerdown', function (e) {
      if (!layersMenu.hidden && !e.target.closest('.layers')) {
        layersMenu.hidden = true;
        layersBtn.setAttribute('aria-expanded', 'false');
      }
    });
    $$('[data-layer]', layersMenu).forEach(function (cb) {
      cb.checked = settings.layers[cb.dataset.layer] !== false;
      cb.addEventListener('change', function () {
        settings.layers[cb.dataset.layer] = cb.checked;
        saveSettings();
        map.setLayers(settings.layers);
      });
    });

    // 触屏设备上的操作提示换成触摸手势；首次拖动/点击后淡出提示
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
      $('#map-hint').textContent = T('拖动平移 · 双指缩放 · 轻点星图拾取坐标');
    }
    $('#sky').addEventListener('pointerdown', function () {
      $('#map-hint').classList.add('is-faded');
      hidePick();
    }, { once: false });
  }

  /** 鼠标悬停在恒星上时显示星名、星等、坐标 */
  function showStarTip(info) {
    var tip = $('#star-tip');
    if (!info) {
      tip.hidden = true;
      return;
    }
    var s = info.star;
    clear(tip);
    tip.appendChild(h('b', { text: starLabel(s) }));
    var sub = [I18n.isEn ? '' : (s.zh && s.en ? s.en : ''), starLabel(s) !== s.desig ? s.desig : '', s.con ? constellationName(s.con) : '']
      .filter(Boolean).join(' · ');
    if (sub) tip.appendChild(h('div', { text: sub }));
    tip.appendChild(h('div', { text: T('星等 {mag}', { mag: s.mag.toFixed(2) }) + (s.hip ? ' · HIP ' + s.hip : '') }));
    tip.appendChild(h('div', { text: Angle.formatHMS(s.ra / 15, 1) + '  ' + Angle.formatDMS(s.dec, 0) }));
    tip.hidden = false;
    var x = info.x + 16, y = info.y + 16;
    if (x + tip.offsetWidth > window.innerWidth - 8) x = info.x - tip.offsetWidth - 12;
    if (y + tip.offsetHeight > window.innerHeight - 8) y = info.y - tip.offsetHeight - 12;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }

  /** 点击星图：弹出该处坐标，可设为目标 A 或 B */
  var picked = null;
  function showPick(info) {
    $('#star-tip').hidden = true;
    var pop = $('#pick-pop');
    picked = info;
    var s = info.star;
    $('#pick-title').textContent = s ? starLabel(s) + (!I18n.isEn && s.zh && s.en ? ' · ' + s.en : '') : T('天球位置');
    var coord = $('#pick-coord');
    clear(coord);
    coord.appendChild(h('div', { text: 'α ' + Angle.formatHMS(info.ra / 15, 2) + '  δ ' + Angle.formatDMS(info.dec, 1) }));
    var con = Astro.constellationOf(Astro.vecFromRaDec(info.ra, info.dec), Data.constellationBounds);
    coord.appendChild(h('div', { text: 'J2000 · ' + (con ? constellationName(con) : '') + (s ? ' · ' + T('{mag} 等', { mag: s.mag.toFixed(2) }) : '') }));
    pop.hidden = false;
    var x = Math.min(info.x + 12, window.innerWidth - pop.offsetWidth - 10);
    var y = Math.min(info.y + 12, window.innerHeight - pop.offsetHeight - 10);
    pop.style.left = Math.max(10, x) + 'px';
    pop.style.top = Math.max(10, y) + 'px';
  }
  function hidePick() {
    $('#pick-pop').hidden = true;
  }
  function pickName() {
    var s = picked && picked.star;
    return s ? starLabel(s) : null;
  }
  function initPick() {
    $('#pick-set-a').addEventListener('click', function () {
      if (!picked) return;
      coordA.setEquatorialJ2000(picked.ra, picked.dec, pickName());
      hidePick();
    });
    $('#pick-set-b').addEventListener('click', function () {
      if (!picked) return;
      coordB.setEquatorialJ2000(picked.ra, picked.dec, pickName());
      hidePick();
      selectTab('sep');
    });
    $('#pick-close').addEventListener('click', hidePick);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') hidePick();
    });
  }

  /* =====================================================================
   * 十、时钟与实时刷新、URL 分享、初始化
   * ===================================================================== */

  var tickCount = 0;
  /** 每秒执行：更新顶栏时钟；实时模式下刷新与时间相关的结果 */
  function tick(fromChange) {
    var now = new Date();
    var tz = settings.tz;
    $('#clock-utc').textContent = fmtClock(now, 'UTC');
    $('#clock-local-k').textContent = fmtOffset(tzOffsetMin(now, tz));
    $('#clock-local').textContent = fmtClock(now, tz);
    var d = obsDate();
    var jdUtc = Astro.jdFromDate(d);
    var lst = Astro.wrap360(Astro.gast(jdUtc, Astro.jdTTFromUtc(jdUtc)) * 180 / Math.PI + settings.site.lon) / 15;
    $('#clock-lst').textContent = Angle.formatHMS(lst, 0, 'colon');
    if (fromChange === true || timeState.mode !== 'live') return;
    tickCount++;
    // 输入的历元若是"观测时刻"，或输入的是地平坐标，坐标本身也随时间变化
    if (A.ok && A.epochInfo && A.epochInfo.timeDependent) A = coordA.parse();
    if (B.ok && B.epochInfo && B.epochInfo.timeDependent) B = coordB.parse();
    // 地平坐标输入：同一方位角、高度角对应的赤经赤纬约每秒变化 15″，结果页与星图标记都要每秒刷新
    var liveA = A.ok && A.sys === 'horizontal', liveB = B.ok && B.sys === 'horizontal';
    if (settings.tab === 'horizon') {
      var o = renderHorizon(false); // 地平坐标页有自己的原地更新逻辑
      updateHud(o || undefined);
    } else {
      if (liveA || liveB) renderPatched(renderActive); // 原地更新，不打断复制、选中文字等操作
      if (liveA || tickCount % 5 === 0) updateHud();
      if (settings.tab === 'epoch' && epochOut.mode() === 'obs' && tickCount % 30 === 0 && !(liveA || liveB)) renderPatched(renderEpoch);
    }
    if (liveA && map) map.setMarker('target', A.icrs); // 只移动标记，不让星图跟着飞
    if (liveA || liveB) updateSecondaryOnMap();
    if (tickCount % 10 === 0) {
      updateHorizonOnMap();
      updateObserverSummary();
    }
  }

  /** 把目标写进地址栏（#ra=…&dec=…&name=…），便于收藏和分享 */
  function updateHash() {
    if (!A.ok || !history.replaceState) return;
    var s = 'ra=' + A.icrs.ra.toFixed(6) + '&dec=' + A.icrs.dec.toFixed(6);
    if (A.name) s += '&name=' + encodeURIComponent(A.name);
    try {
      history.replaceState(null, '', '#' + s);
    } catch (e) { /* file:// 等环境下可能不允许修改地址，忽略 */ }
    store.set('lastTarget', { ra: A.icrs.ra, dec: A.icrs.dec, name: A.name || null });
  }
  function readHash() {
    if (!location.hash) return null;
    var p = new URLSearchParams(location.hash.slice(1));
    var ra = parseFloat(p.get('ra')), dec = parseFloat(p.get('dec'));
    if (isFinite(ra) && isFinite(dec) && Math.abs(dec) <= 90) return { ra: Astro.wrap360(ra), dec: dec, name: p.get('name') };
    return null;
  }

  var coordA = null, coordB = null;

  /**
   * 保存的目标名称（上次使用、分享链接里的 name）可能是另一种语言：
   * 能在常用天体或星表中找到的，换成当前语言的名称；找不到的（如 SIMBAD 名称）原样保留
   */
  function localizeName(name) {
    if (!name) return name;
    var objs = Data.objects || [];
    for (var i = 0; i < objs.length; i++) {
      if (objs[i].zh === name || objs[i].en === name) return objName(objs[i]);
    }
    var ids = map ? map.namedStars() : [];
    for (var k = 0; k < ids.length; k++) {
      var s = map.starInfo(ids[k]);
      if ((s.zh && s.zh === name) || (s.en && s.en === name)) return starLabel(s);
    }
    return name;
  }

  function init() {
    // 语言切换按钮：显示"要切换到的语言"，点击后保存选择并刷新页面
    var langBtn = $('#btn-lang');
    langBtn.textContent = I18n.isEn ? '中文' : 'EN';
    langBtn.title = I18n.isEn ? '切换到中文' : 'Switch to English';
    langBtn.setAttribute('lang', I18n.isEn ? 'zh-CN' : 'en');
    langBtn.addEventListener('click', function () { I18n.setLang(I18n.isEn ? 'zh' : 'en'); });

    // 夜视模式与精度设置
    document.documentElement.classList.toggle('night', !!settings.night);
    var nightBtn = $('#btn-night');
    nightBtn.setAttribute('aria-pressed', settings.night ? 'true' : 'false');
    nightBtn.addEventListener('click', function () {
      settings.night = !settings.night;
      saveSettings();
      document.documentElement.classList.toggle('night', settings.night);
      nightBtn.setAttribute('aria-pressed', settings.night ? 'true' : 'false');
    });
    var hideBtn = $('#btn-hide');
    hideBtn.addEventListener('click', function () {
      var hidden = !document.body.classList.contains('panels-hidden');
      document.body.classList.toggle('panels-hidden', hidden);
      hideBtn.setAttribute('aria-pressed', hidden ? 'true' : 'false');
      map.resize();
      updateFocus();
      if (A.ok) map.flyTo(A.icrs.ra, A.icrs.dec);
    });
    var precSel = $('#precision');
    precSel.value = settings.precision;
    precSel.addEventListener('change', function () {
      settings.precision = precSel.value;
      saveSettings();
      renderActive();
    });
    // 赤经赤纬显示形式开关（与显示精度一样保存在本地设置中，作用于所有标签页）
    var degChk = $('#radec-deg');
    degChk.checked = !!settings.radecDeg;
    degChk.addEventListener('change', function () {
      settings.radecDeg = degChk.checked;
      saveSettings();
      renderActive();
    });

    initMap();
    Search.build(map);
    initTabs();
    initPick();
    initCopy();

    // 输出历元选择器（历元岁差页），默认"观测时刻"
    epochOut = createEpochPicker($('#epoch-out'), { name: 'epoch-out', label: T('目标历元'), defaultMode: 'obs', allowApparent: false, onChange: renderEpoch });

    // 目标 A / 目标 B
    coordA = createCoordInput($('#coord-a'), {
      id: 'ca',
      onChange: function (p) {
        A = p;
        renderAll();
        updateHash();
      }
    });
    coordB = createCoordInput($('#coord-b'), {
      id: 'cb',
      onChange: function (p) {
        B = p;
        if (settings.tab === 'sep') renderSeparation();
        updateSecondaryOnMap();
      }
    });

    initObserver();

    // 初始目标：地址栏参数 > 上次使用 > 默认仙女座星系（M31）
    var m31 = (Data.objects || []).find(function (o) { return o.id === 'm31'; });
    var m33 = (Data.objects || []).find(function (o) { return o.id === 'm33'; });
    var start = readHash() || store.get('lastTarget', null) || (m31 && { ra: m31.ra, dec: m31.dec, name: objName(m31) });
    if (m33) coordB.setEquatorialJ2000(m33.ra, m33.dec, objName(m33));
    if (start) start.name = localizeName(start.name);
    if (start) {
      lastFly = { ra: start.ra, dec: start.dec };
      // 开场：从较大视场缓缓推近到目标
      map.setView(start.ra, start.dec, 150);
      map.flyTo(start.ra, start.dec, { fov: 100, duration: 1600 });
      coordA.setEquatorialJ2000(start.ra, start.dec, start.name);
    }
    selectTab(settings.tab);
    updateHorizonOnMap();
    tick(true);
    setInterval(function () { tick(); }, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
