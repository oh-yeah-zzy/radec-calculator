/**
 * angle.js —— 角度文本的解析与格式化
 *
 * 负责两件事：
 *   1. 解析：把用户输入的各种写法（时分秒、度分秒、十进制、冒号/空格分隔、
 *      全角字符、中文单位"时/度/分/秒"、方位字母 N/S/E/W 等）转换为数值；
 *   2. 格式化：把数值输出为常见的文本格式（05h 34m 31.94s、+22° 00′ 52.2″ 等）。
 *
 * 本模块是纯函数集合，不依赖 DOM，既能在浏览器中使用（挂在 window.RaDec.Angle 下），
 * 也能在 Node.js 中 require（便于测试）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api; // Node.js 环境
  } else {
    root.RaDec = root.RaDec || {};
    root.RaDec.Angle = api; // 浏览器环境：挂到全局命名空间
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * 解析失败时抛出的错误。message 是直接展示给用户的中文提示；
   * key（带 {占位符} 的中文模板）与 params 供界面按当前语言重新生成提示（见 js/i18n.js）。
   */
  class ParseError extends Error {
    constructor(key, params) {
      super(fillTemplate(key, params));
      this.key = key;
      this.params = params || null;
    }
  }
  function fillTemplate(s, params) {
    if (!params) return s;
    return s.replace(/\{(\w+)\}/g, function (m, k) { return k in params ? params[k] : m; });
  }

  /* ------------------------------------------------------------------
   * 一、文本预处理：把五花八门的符号统一成少数几个 ASCII 记号
   *    h = 时   d = 度   m = 分   s = 秒   : = 分隔符
   * ------------------------------------------------------------------ */

  // 单字符替换表：全角数字/符号、Unicode 负号、角分角秒符号、上标 h/m/s 等
  var CHAR_MAP = {
    '０': '0', '１': '1', '２': '2', '３': '3', '４': '4',
    '５': '5', '６': '6', '７': '7', '８': '8', '９': '9',
    '．': '.', '。': '.', '：': ':', '，': ',', '；': ';', '　': ' ',
    '＋': '+', '－': '-', '−': '-', '–': '-', '—': '-', '‐': '-', '‑': '-',
    '°': 'd', 'º': 'd', '˚': 'd',
    '′': "'", '’': "'", '‘': "'", 'ʹ': "'", '´': "'",
    '″': '"', '”': '"', '“': '"', 'ʺ': '"',
    'ʰ': 'h', 'ᵐ': 'm', 'ˢ': 's', '\t': ' '
  };

  /**
   * 文本标准化：替换特殊字符、中文单位，并去掉首尾空白。
   * 注意这里【不】转小写，因为观测地点里大写 S 表示"南"，而小写 s 表示"秒"。
   */
  function normalizeText(text) {
    var s = String(text == null ? '' : text);
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      out += Object.prototype.hasOwnProperty.call(CHAR_MAP, ch) ? CHAR_MAP[ch] : ch;
    }
    out = out
      .replace(/''/g, '"') // 两个单引号当作角秒
      .replace(/小时|时/g, 'h')
      .replace(/度|deg/gi, 'd')
      .replace(/分/g, 'm')
      .replace(/秒/g, 's')
      .replace(/'/g, 'm') // 角分统一当作"分"
      .replace(/"/g, 's'); // 角秒统一当作"秒"
    return out.trim();
  }

  /* ------------------------------------------------------------------
   * 二、词法分析：把文本拆成若干 {数字, 单位} 组件
   * ------------------------------------------------------------------ */

  /**
   * @param {string} text 原始输入
   * @param {object} opts { compass: 'lat' | 'lon' | null } —— 是否允许方位字母/中文方位词
   * @returns {{sign:number, explicitSign:boolean, comps:Array, compass:string|null}}
   */
  function tokenize(text, opts) {
    opts = opts || {};
    var s = normalizeText(text);
    if (!s) throw new ParseError('请输入数值');

    // ---- 方位（仅观测地点的经纬度允许）：北纬/南纬/东经/西经、N/S/E/W ----
    var compass = null;
    if (opts.compass) {
      s = s.replace(/北纬|北/g, ' N ').replace(/南纬|南/g, ' S ')
        .replace(/东经|东/g, ' E ').replace(/西经|西/g, ' W ').trim();
      // 允许出现在开头或结尾；S 必须大写（小写 s 表示秒）。
      // 结尾的方位字母前面可以是数字、空格或单位字母 d/h/m/s（例如 116°24'E → "116d24mE"）
      var head = /^([NnSEeWw])(?![a-zA-Z])\s*/.exec(s);
      var tail = /(?:^|[^a-zA-Z]|[dhms])([NnSEeWw])$/.exec(s);
      if (head) {
        compass = head[1].toUpperCase();
        s = s.slice(head[0].length);
      } else if (tail) {
        compass = tail[1].toUpperCase();
        s = s.slice(0, s.length - 1).trim();
      }
      if (compass) {
        var okSet = opts.compass === 'lat' ? 'NS' : 'EW';
        if (okSet.indexOf(compass) < 0) {
          throw new ParseError(opts.compass === 'lat' ? '纬度只能用 N/S（北/南）' : '经度只能用 E/W（东/西）');
        }
      }
    }

    s = s.toLowerCase().trim();
    if (!s) throw new ParseError('请输入数值');

    // ---- 正负号：只允许出现在最前面 ----
    var sign = 1;
    var explicitSign = false;
    if (s[0] === '+' || s[0] === '-') {
      sign = s[0] === '-' ? -1 : 1;
      explicitSign = true;
      s = s.slice(1).trim();
    }

    // ---- 逐段扫描："数字 [单位或冒号]" ----
    var comps = [];
    var i = 0;
    var numRe = /^(\d+(?:\.\d*)?|\.\d+)/;
    while (i < s.length) {
      while (s[i] === ' ') i++;
      if (i >= s.length) break;
      var m = numRe.exec(s.slice(i));
      if (!m) {
        var bad = s[i];
        if (bad === '+' || bad === '-') throw new ParseError('正负号只能写在最前面');
        throw new ParseError('无法识别的字符「{c}」', { c: bad });
      }
      var numStr = m[1];
      i += numStr.length;
      while (s[i] === ' ') i++;
      var unit = null;
      if (i < s.length && 'hdms'.indexOf(s[i]) >= 0) {
        unit = s[i];
        i++;
        while (s[i] === ' ') i++;
        if (s[i] === ':') i++; // 容忍 "5h:34m" 这类写法
      } else if (s[i] === ':') {
        i++;
      }
      comps.push({ str: numStr, value: parseFloat(numStr), unit: unit });
    }
    if (!comps.length) throw new ParseError('请输入数值');
    return { sign: sign, explicitSign: explicitSign, comps: comps, compass: compass };
  }

  /* ------------------------------------------------------------------
   * 三、语义解析：根据组件和单位推断"时/度 分 秒"
   * ------------------------------------------------------------------ */

  /**
   * 把组件组合成一个数值（单位为 base：'h' 小时 或 'd' 度）
   * @param {object} tok tokenize 的结果
   * @param {'h'|'d'} defaultBase 没有显式单位且为多段（六十进制）时的默认单位
   * @param {'h'|'d'} bareBase 只有一个不带单位的数字时的单位
   * @returns {{value:number, base:'h'|'d', sexagesimal:boolean}}
   */
  function combine(tok, defaultBase, bareBase) {
    var comps = tok.comps;
    if (comps.length > 3) throw new ParseError('数字段太多：最多为"时(度) 分 秒"三段');
    for (var k = 0; k < comps.length - 1; k++) {
      if (comps[k].str.indexOf('.') >= 0) throw new ParseError('只有最后一段可以带小数');
    }

    var first = comps[0].unit;
    var base;
    var level; // 第一段所在层级：0=时/度，1=分，2=秒
    if (first === 'h' || first === 'd') {
      base = first;
      level = 0;
    } else if (first === 'm' || first === 's') {
      base = defaultBase; // 例如 "34m 12s" 或 "30'"
      level = first === 'm' ? 1 : 2;
    } else if (comps.length === 1) {
      base = bareBase; // 单个裸数字
      level = 0;
    } else {
      base = defaultBase; // "05 34 31.94"、"05:34:31.94"
      level = 0;
    }

    var vals = [0, 0, 0];
    vals[level] = comps[0].value;
    for (var j = 1; j < comps.length; j++) {
      var u = comps[j].unit;
      if (u === 'h' || u === 'd') throw new ParseError('单位顺序有误（"时/度"只能出现在第一段）');
      var next = u === 'm' ? 1 : u === 's' ? 2 : level + 1;
      if (next <= level || next > 2) throw new ParseError('单位顺序有误，应为"时(度) 分 秒"');
      level = next;
      vals[level] = comps[j].value;
    }
    // 只有一段时允许 "90'" 这类超过 60 的写法；多段时分、秒必须小于 60
    if (comps.length > 1) {
      if (vals[1] >= 60) throw new ParseError('"分"必须小于 60');
      if (vals[2] >= 60) throw new ParseError('"秒"必须小于 60');
    }
    var value = vals[0] + vals[1] / 60 + vals[2] / 3600;
    return { value: value, base: base, sexagesimal: comps.length > 1 || first === 'm' || first === 's' };
  }

  /** 生成"识别为 …"的说明文字，帮助用户确认解析方式 */
  function describe(r) {
    if (r.base === 'h') return r.sexagesimal ? '时分秒' : '十进制小时';
    return r.sexagesimal ? '度分秒' : '十进制度';
  }

  /**
   * 解析赤经
   * @param {string} text
   * @param {object} [opts] { bareUnit: 'deg' | 'hour' } —— 单个裸数字按度还是小时理解，默认按度
   * @returns {{deg:number, hours:number, desc:string}}
   */
  function parseRA(text, opts) {
    opts = opts || {};
    var tok = tokenize(text);
    if (tok.sign < 0) throw new ParseError('赤经不能为负数');
    var r = combine(tok, 'h', opts.bareUnit === 'hour' ? 'h' : 'd');
    var deg = r.base === 'h' ? r.value * 15 : r.value;
    if (r.base === 'h' && r.value > 24) throw new ParseError('赤经必须在 0 ~ 24 时之间');
    if (r.base === 'd' && deg > 360) throw new ParseError('赤经必须在 0° ~ 360° 之间');
    if (deg >= 360) deg -= 360; // 24h / 360° 视为 0
    return { deg: deg, hours: deg / 15, desc: describe(r) };
  }

  /**
   * 解析纬度类角度（赤纬、银纬、黄纬）：范围 −90° ~ +90°，六十进制默认按度
   */
  function parseLatitudeLike(text, label) {
    var tok = tokenize(text);
    var r = combine(tok, 'd', 'd');
    if (r.base === 'h') throw new ParseError('{label}不能用"时"作单位', { label: label });
    var deg = tok.sign * r.value;
    if (Math.abs(deg) > 90) throw new ParseError('{label}必须在 −90° ~ +90° 之间', { label: label });
    return { deg: deg, desc: describe(r) };
  }

  /** 解析赤纬 */
  function parseDec(text) {
    return parseLatitudeLike(text, '赤纬');
  }

  /**
   * 解析经度类角度（银经 l、黄经 λ）：允许负数（自动换算到 0~360°），六十进制默认按度
   */
  function parseLongitudeLike(text, label) {
    var tok = tokenize(text);
    var r = combine(tok, 'd', 'd');
    var deg = r.base === 'h' ? r.value * 15 : r.value;
    if (deg > 360) throw new ParseError('{label}必须在 0° ~ 360° 之间', { label: label });
    deg = tok.sign * deg;
    deg = ((deg % 360) + 360) % 360;
    return { deg: deg, desc: describe(r) };
  }

  /**
   * 解析观测地点纬度：支持 N/S、北纬/南纬，以及正负号
   */
  function parseObserverLat(text) {
    var tok = tokenize(text, { compass: 'lat' });
    var r = combine(tok, 'd', 'd');
    if (r.base === 'h') throw new ParseError('纬度不能用"时"作单位');
    if (tok.compass && tok.explicitSign) throw new ParseError('不要同时使用正负号和 N/S');
    var deg = tok.sign * r.value * (tok.compass === 'S' ? -1 : 1);
    if (Math.abs(deg) > 90) throw new ParseError('纬度必须在 −90° ~ +90° 之间');
    return { deg: deg, desc: describe(r) };
  }

  /**
   * 解析观测地点经度：东经为正；支持 E/W、东经/西经；0~360° 的写法会换算到 −180~180°
   */
  function parseObserverLon(text) {
    var tok = tokenize(text, { compass: 'lon' });
    var r = combine(tok, 'd', 'd');
    if (tok.compass && tok.explicitSign) throw new ParseError('不要同时使用正负号和 E/W');
    var deg = r.base === 'h' ? r.value * 15 : r.value;
    if (deg > 360) throw new ParseError('经度必须在 −180° ~ +180° 之间');
    deg = tok.sign * deg * (tok.compass === 'W' ? -1 : 1);
    if (deg > 180) deg -= 360;
    if (deg < -180) deg += 360;
    return { deg: deg, desc: describe(r) };
  }

  /**
   * 尝试把"一整行坐标"拆成两部分，例如：
   *   "05 34 31.94 +22 00 52.2"、"05:34:31.94, +22:00:52.2"、"83.633 22.0145"、
   *   "5h34m31.94s 22d00m52.2s"、"05h34m31.94s +22°00′52.2″"
   * @returns {[string, string] | null} 无法可靠拆分时返回 null
   */
  function splitPair(text) {
    var s = normalizeText(text);
    if (!s) return null;
    // 1) 逗号、分号等显式分隔
    var parts = s.split(/\s*[,;|]\s*/).filter(Boolean);
    if (parts.length === 2) return parts;
    if (parts.length > 2) return null;
    // 2) 中间出现正负号：前半是赤经，后半是赤纬
    var m = /^(.*?[\dhms.])\s*([+-]\s*[\d.].*)$/.exec(s);
    if (m && /\d/.test(m[1])) return [m[1].trim(), m[2].trim()];
    // 3) 赤经带 h…s 单位，赤纬紧随其后
    m = /^(\d[\d.\s]*h[\d.\s]*(?:m[\d.\s]*)?(?:s)?)\s+([\d.].*)$/.exec(s);
    if (m) return [m[1].trim(), m[2].trim()];
    // 4) 纯数字（或冒号分隔）：按空白分组后对半拆
    var groups = s.split(/\s+/);
    if (groups.length === 2) return groups;
    if (groups.every(function (g) { return /^[\d.]+$/.test(g); }) && (groups.length === 4 || groups.length === 6)) {
      var half = groups.length / 2;
      return [groups.slice(0, half).join(' '), groups.slice(half).join(' ')];
    }
    return null;
  }

  /* ------------------------------------------------------------------
   * 四、格式化
   * ------------------------------------------------------------------ */

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /**
   * 把"总量（以最小单位计的整数）"拆成 [大, 分, 秒字符串]，用整数运算避免 59.999→60 的进位问题
   */
  function splitSexagesimal(absValue, decimals) {
    var scale = Math.pow(10, decimals);
    var units = Math.round(absValue * 3600 * scale); // 以 10^-decimals 秒为单位的整数
    var big = Math.floor(units / (3600 * scale));
    var rem = units - big * 3600 * scale;
    var min = Math.floor(rem / (60 * scale));
    var secUnits = rem - min * 60 * scale;
    var secInt = Math.floor(secUnits / scale);
    var secFrac = secUnits - secInt * scale;
    var secStr = pad2(secInt);
    if (decimals > 0) {
      var frac = String(secFrac);
      while (frac.length < decimals) frac = '0' + frac;
      secStr += '.' + frac;
    }
    return { big: big, min: min, sec: secStr, isZero: units === 0 };
  }

  /**
   * 小时 → 时分秒文本
   * @param {number} hours
   * @param {number} [decimals=2] 秒的小数位数
   * @param {'hms'|'colon'|'space'} [style='hms']
   */
  function formatHMS(hours, decimals, style) {
    decimals = decimals == null ? 2 : decimals;
    var h = ((hours % 24) + 24) % 24;
    var p = splitSexagesimal(h, decimals);
    var big = p.big % 24; // 23:59:59.999 四舍五入后可能变成 24:00:00，回绕到 0
    if (style === 'colon') return pad2(big) + ':' + pad2(p.min) + ':' + p.sec;
    if (style === 'space') return pad2(big) + ' ' + pad2(p.min) + ' ' + p.sec;
    return pad2(big) + 'h ' + pad2(p.min) + 'm ' + p.sec + 's';
  }

  /**
   * 度 → 度分秒文本
   * @param {number} deg
   * @param {number} [decimals=1] 角秒的小数位数
   * @param {'dms'|'colon'|'space'} [style='dms']
   * @param {boolean} [signed=true] 是否总是带正负号（赤纬需要）
   */
  function formatDMS(deg, decimals, style, signed) {
    decimals = decimals == null ? 1 : decimals;
    signed = signed !== false;
    var p = splitSexagesimal(Math.abs(deg), decimals);
    var neg = deg < 0 && !p.isZero;
    var sign = neg ? '-' : signed ? '+' : '';
    var big = signed ? pad2(p.big) : String(p.big);
    if (style === 'colon') return sign + big + ':' + pad2(p.min) + ':' + p.sec;
    if (style === 'space') return sign + big + ' ' + pad2(p.min) + ' ' + p.sec;
    return sign + big + '° ' + pad2(p.min) + '′ ' + p.sec + '″';
  }

  /** 十进制数值格式化（带可选的正号） */
  function formatDecimal(value, decimals, signed) {
    var s = value.toFixed(decimals);
    if (/^-0\.?0*$/.test(s)) s = s.slice(1); // 避免显示 "-0.000"
    if (signed && s[0] !== '-') s = '+' + s;
    return s;
  }

  /**
   * 角距离的"自动单位"文本：≥1° 用度，≥1′ 用角分，否则用角秒
   */
  function formatAngleAuto(deg) {
    var a = Math.abs(deg);
    if (a >= 1) return formatDecimal(deg, 4) + '°';
    if (a >= 1 / 60) return formatDecimal(deg * 60, 3) + '′';
    return formatDecimal(deg * 3600, 2) + '″';
  }

  return {
    ParseError: ParseError,
    normalizeText: normalizeText,
    parseRA: parseRA,
    parseDec: parseDec,
    parseLatitudeLike: parseLatitudeLike,
    parseLongitudeLike: parseLongitudeLike,
    parseObserverLat: parseObserverLat,
    parseObserverLon: parseObserverLon,
    splitPair: splitPair,
    formatHMS: formatHMS,
    formatDMS: formatDMS,
    formatDecimal: formatDecimal,
    formatAngleAuto: formatAngleAuto
  };
});
