/**
 * i18n.js —— 界面语言：简体中文 / English
 *
 * 约定：
 *   · 代码里的界面文字仍直接写中文，并用 T('中文', {参数}) 包起来。中文界面原样返回（行为与原来完全一致），
 *     英文界面按下方对照表 EN 替换；对照表里漏掉的文字只会显示成中文，不会出错。
 *   · 文字中的 {名称} 是占位符，由参数替换，因此中英文可以有不同的语序。
 *   · index.html 里的静态文字在页面解析完成时由 translateDom() 按同一张表替换
 *     （文字节点，以及 title / aria-label / placeholder 属性），HTML 本身不需要额外标记。
 *   · 语言的确定顺序：地址栏 ?lang=en|zh → 上次的选择（localStorage）→ 浏览器首选语言（中文 → 中文，其余 → 英文）。
 *   · 切换语言时保存选择并刷新页面；目标、地点、精度等设置本来就保存在本地，刷新后保留。
 *
 * 本文件在 <head> 中加载：英文界面在翻译完成前先隐藏页面（html.i18n-pending），避免闪现中文。
 */
(function (root) {
  'use strict';

  var STORE_KEY = 'radec.lang';

  /** 确定界面语言 */
  function detect() {
    try {
      var q = new URLSearchParams(root.location.search).get('lang');
      if (q === 'en' || q === 'zh') return q;
    } catch (e) { /* 忽略 */ }
    try {
      var saved = root.localStorage.getItem(STORE_KEY);
      if (saved === 'en' || saved === 'zh') return saved;
    } catch (e) { /* 隐私模式等情况下存储不可用 */ }
    var nav = root.navigator || {};
    var first = String((nav.languages && nav.languages[0]) || nav.language || '').toLowerCase();
    if (!first) return 'zh';
    return first.indexOf('zh') === 0 ? 'zh' : 'en';
  }

  var lang = detect();
  var isEn = lang === 'en';

  /* ------------------------------------------------------------------
   * 英文对照表：键为代码 / 页面中的中文原文，值为英文。
   * 值开头的空格是有意的：中文句子直接相连，英文需要空格分隔。
   * ------------------------------------------------------------------ */
  var EN = {
    // ---- 页面标题、顶栏 ----
    '赤经赤纬计算器': 'RA/Dec Calculator',
    'RA · Dec Calculator': 'Celestial Coordinates',
    '赤经赤纬（RA/Dec）在线计算：格式转换，赤道/银道/黄道坐标转换，J2000、B1950 与任意日期历元的岁差和视位置，地平坐标与升落时刻，角距离；以真实星表绘制的星图为背景。':
      'Online RA/Dec calculator: format conversion, equatorial/galactic/ecliptic conversion, precession and apparent places for J2000, B1950 or any date, altitude/azimuth and rise/set times, and angular separation — over a star map drawn from a real star catalog.',
    '本地': 'Local',
    '地方恒星时': 'LST',
    '红光夜视模式（保护暗适应）': 'Red night-vision mode (preserves dark adaptation)',
    '红光夜视模式': 'Night-vision mode',
    '隐藏面板，全屏查看星图': 'Hide panels and view the full star map',
    '全屏星图': 'Full-screen star map',

    // ---- 星图与标记 ----
    '星图背景：可拖动平移、滚轮缩放，点击可拾取该处坐标': 'Star map: drag to pan, scroll to zoom, click to pick coordinates',
    '目标': 'Target',
    '星图拾取的坐标': 'Picked coordinates',
    '设为目标': 'Set as target',
    '设为目标 B': 'Set as target B',
    '关闭': 'Close',
    '拖动平移 · 滚轮缩放 · 点击星图拾取坐标': 'Drag to pan · Scroll to zoom · Click to pick coordinates',
    '拖动平移 · 双指缩放 · 轻点星图拾取坐标': 'Drag to pan · Pinch to zoom · Tap to pick coordinates',
    '星图控制': 'Star map controls',
    '放大': 'Zoom in',
    '缩小': 'Zoom out',
    '回到目标': 'Back to target',
    '图层': 'Layers',
    '银河': 'Milky Way',
    '星座连线': 'Constellation lines',
    '星名与星座名': 'Star & constellation names',
    '赤经赤纬网格': 'RA/Dec grid',
    '地平线': 'Horizon',
    '北': 'N',
    '东': 'E',
    '南': 'S',
    '西': 'W',
    '天顶': 'Zenith',
    '等待输入坐标': 'Waiting for coordinates',
    '自定义坐标': 'Custom coordinates',
    '高度 {alt}° · 方位 {az}°': 'Alt {alt}° · Az {az}°',
    '星等 {mag}': 'Mag {mag}',
    '天球位置': 'Sky position',
    '{mag} 等': 'mag {mag}',

    // ---- 目标输入 ----
    '目标天体': 'Target',
    '搜索天体：M31、天狼星、Vega、α Ori、NGC 7000…': 'Search: M31, Sirius, Vega, α Ori, NGC 7000…',
    '坐标系': 'Coordinate system',
    '赤道': 'Equatorial',
    '银道': 'Galactic',
    '黄道': 'Ecliptic',
    '地平': 'Alt/Az',
    '输入方位角、高度角，按观测时间与地点反算赤经赤纬': 'Enter azimuth and altitude to get RA/Dec for the observation time and location',
    '纯数字赤经按': 'Plain-number RA in',
    '度': 'degrees',
    '小时': 'hours',
    '赤经 α': 'RA α',
    '赤纬 δ': 'Dec δ',
    '银经 l': 'Longitude l',
    '银纬 b': 'Latitude b',
    '黄经 λ': 'Longitude λ',
    '黄纬 β': 'Latitude β',
    '方位角 A': 'Azimuth A',
    '高度角 h': 'Altitude h',
    '赤道坐标': 'Equatorial',
    '银道坐标': 'Galactic',
    '黄道坐标': 'Ecliptic',
    '地平坐标': 'Alt/Az',
    '银经': 'Galactic longitude',
    '银纬': 'Galactic latitude',
    '黄经': 'Ecliptic longitude',
    '黄纬': 'Ecliptic latitude',
    '方位角': 'Azimuth',
    '高度角': 'Altitude',
    '赤纬': 'Declination',
    '方位角从正北起算、向东为正（东 90°、南 180°、西 270°）。按下方“观测时间与地点”换算：{obs}；高度角视为含大气折射的观测值。':
      'Azimuth is measured from north toward east (E 90°, S 180°, W 270°). Converted with “Time & location” below: {obs}; altitude is treated as observed (including refraction).',
    '方位角从正北起算、向东为正（东 90°、南 180°、西 270°）。按下方“观测时间与地点”换算：{obs}；不计大气折射。':
      'Azimuth is measured from north toward east (E 90°, S 180°, W 270°). Converted with “Time & location” below: {obs}; refraction is not applied.',
    '无法解析': 'Cannot parse',
    '识别为{desc}': 'Read as {desc}',
    '时分秒': 'hours, minutes, seconds',
    '十进制小时': 'decimal hours',
    '度分秒': 'degrees, minutes, seconds',
    '十进制度': 'decimal degrees',
    '已自动拆分为两部分': 'Split into two fields automatically',
    '正在查询 SIMBAD…': 'Querying SIMBAD…',
    '在线查询“{q}”': 'Look up “{q}” online',
    '{type} {mag} 等': '{type} · mag {mag}',
    '已从 SIMBAD 获取：{name}': 'Retrieved from SIMBAD: {name}',
    '在线查询超时，请检查网络连接': 'Online lookup timed out — check your network connection',
    '在线查询失败：需要联网访问 cds.unistra.fr': 'Online lookup failed: internet access to cds.unistra.fr is required',
    'SIMBAD 中没有找到“{name}”': 'Not found in SIMBAD: “{name}”',

    // ---- 天体类型 ----
    '恒星': 'Star',
    '双星': 'Double star',
    '变星': 'Variable star',
    '超新星遗迹': 'Supernova remnant',
    '星云': 'Nebula',
    '疏散星团': 'Open cluster',
    '球状星团': 'Globular cluster',
    '行星状星云': 'Planetary nebula',
    '星系': 'Galaxy',
    '黑洞': 'Black hole',
    '类星体': 'Quasar',

    // ---- 坐标解析的错误提示（来自 angle.js） ----
    '请输入数值': 'Please enter a value',
    '纬度只能用 N/S（北/南）': 'Latitude can only use N/S',
    '经度只能用 E/W（东/西）': 'Longitude can only use E/W',
    '正负号只能写在最前面': 'The sign must come first',
    '无法识别的字符「{c}」': 'Unrecognized character “{c}”',
    '数字段太多：最多为"时(度) 分 秒"三段': 'Too many numbers: at most three parts (hours/degrees, minutes, seconds)',
    '只有最后一段可以带小数': 'Only the last part can have decimals',
    '单位顺序有误（"时/度"只能出现在第一段）': 'Units out of order (hours/degrees must come first)',
    '单位顺序有误，应为"时(度) 分 秒"': 'Units out of order: use hours/degrees, minutes, seconds',
    '"分"必须小于 60': 'Minutes must be less than 60',
    '"秒"必须小于 60': 'Seconds must be less than 60',
    '赤经不能为负数': 'RA cannot be negative',
    '赤经必须在 0 ~ 24 时之间': 'RA must be between 0h and 24h',
    '赤经必须在 0° ~ 360° 之间': 'RA must be between 0° and 360°',
    '{label}不能用"时"作单位': '{label} cannot be given in hours',
    '{label}必须在 −90° ~ +90° 之间': '{label} must be between −90° and +90°',
    '{label}必须在 0° ~ 360° 之间': '{label} must be between 0° and 360°',
    '纬度不能用"时"作单位': 'Latitude cannot be given in hours',
    '不要同时使用正负号和 N/S': 'Use either a sign or N/S, not both',
    '纬度必须在 −90° ~ +90° 之间': 'Latitude must be between −90° and +90°',
    '不要同时使用正负号和 E/W': 'Use either a sign or E/W, not both',
    '经度必须在 −180° ~ +180° 之间': 'Longitude must be between −180° and +180°',

    // ---- 历元选择器 ----
    '历元': 'Epoch',
    '目标历元': 'Target epoch',
    '观测时刻（JNow）': 'Observation time (JNow)',
    '指定日期…': 'Date…',
    '儒略历元…': 'Julian epoch…',
    '历元对应的日期时间（所选时区）': 'Epoch date and time (selected time zone)',
    '儒略历元，例如 2050.0': 'Julian epoch, e.g. 2050.0',
    '勾选表示输入的是该时刻的视位置（例如赤道仪/望远镜显示的 JNow 坐标），未勾选表示平位置':
      'Checked: the input is the apparent place at that time (e.g. JNow coordinates shown by a mount or telescope). Unchecked: mean place.',
    '视位置': 'Apparent place',
    '平位置': 'Mean place',
    '请填写有效的日期时间': 'Please enter a valid date and time',
    '请输入有效的儒略历元，例如 2050.0': 'Please enter a valid Julian epoch, e.g. 2050.0',
    '观测时刻 {date}': 'Observation time {date}',

    // ---- 观测时间与地点 ----
    '观测时间与地点': 'Time & location',
    '时间': 'Time',
    '时间模式': 'Time mode',
    '实时': 'Live',
    '指定时间': 'Custom',
    '观测时间（所选时区）': 'Observation time (selected time zone)',
    '现在': 'Now',
    '今晚 22:00': 'Tonight 22:00',
    '时区': 'Time zone',
    '地点': 'Location',
    '使用浏览器定位': 'Use browser geolocation',
    '定位': 'Locate',
    '纬度': 'Latitude',
    '39.9042 或 39°54′N': '40.7128 or 40°42′N',
    '经度（东经为正）': 'Longitude (east positive)',
    '116.4074 或 116°24′E': '-74.0060 or 74°00′W',
    '海拔（米）': 'Elevation (m)',
    '计入大气折射（影响高度角与升落时刻）': 'Include atmospheric refraction (affects altitude and rise/set times)',
    '本机时区 · {label}': 'This device · {label}',
    '时区已切换为当地时间：{tz}（{off}）': 'Time zone switched to local time: {tz} ({off})',
    '自定义': 'Custom',
    '当前位置': 'Current location',
    '当前浏览器不支持定位': 'This browser does not support geolocation',
    '正在获取位置…': 'Getting your location…',
    '已使用当前位置': 'Using your current location',
    '定位权限被拒绝，请手动输入经纬度': 'Location permission denied — enter latitude and longitude manually',
    '无法获取位置，请手动输入经纬度': 'Could not get your location — enter latitude and longitude manually',

    // ---- 结果区：通用 ----
    '计算结果': 'Results',
    '功能': 'Tools',
    '坐标转换': 'Convert',
    '历元岁差': 'Precession',
    '角距离': 'Separation',
    '显示精度': 'Precision',
    '低（0.1s / 1″）': 'Low (0.1s / 1″)',
    '标准（0.01s / 0.1″）': 'Standard (0.01s / 0.1″)',
    '高（0.001s / 0.01″）': 'High (0.001s / 0.01″)',
    '换算到': 'Convert to',
    '修改时间/地点': 'Change time/location',
    '已复制：{text}': 'Copied: {text}',
    '复制失败，请手动选择文本复制': 'Copy failed — select the text and copy it manually',
    '点击复制': 'Click to copy',
    '复制': 'Copy',
    '复制{label}': 'Copy {label}',
    '请输入{what}的坐标，或在上方搜索天体名称': 'Enter coordinates for {what}, or search for an object above',
    '请检查{what}坐标的输入格式（输入框下方有提示）': 'Check the format of the coordinates for {what} (see the hints below the input boxes)',
    '详细数值': 'Details',

    // ---- 坐标转换 ----
    '格式转换': 'Formats',
    '赤经 时分秒': 'RA (h m s)',
    '赤经 冒号格式': 'RA (colons)',
    '赤经 十进制小时': 'RA (decimal hours)',
    '赤经 十进制度': 'RA (decimal degrees)',
    '赤纬 度分秒': 'Dec (d m s)',
    '赤纬 冒号格式': 'Dec (colons)',
    '赤纬 十进制度': 'Dec (decimal degrees)',
    '整行（空格）': 'One line (spaces)',
    '整行（十进制度）': 'One line (decimal degrees)',
    '{label} 度分秒': '{label} (d m s)',
    '{label} 十进制': '{label} (decimal)',
    '坐标系转换': 'Coordinate systems',
    '赤道 J2000': 'Equatorial J2000',
    '赤道 B1950': 'Equatorial B1950',
    '银道 l, b': 'Galactic l, b',
    '黄道 λ, β': 'Ecliptic λ, β',
    '所在星座': 'Constellation',
    '赤道 视位置': 'Equatorial apparent',
    '时角 HA': 'Hour angle HA',
    'J2000 即 ICRS 赤道坐标；B1950 为 FK4 参考系（含 E 项改正），按 SLALIB FK45Z/FK54Z 算法换算。':
      'J2000 means ICRS equatorial coordinates; B1950 is in the FK4 frame (with E-terms), converted with the SLALIB FK45Z/FK54Z algorithms.',
    '银道坐标采用 IAU 1958 定义；黄道坐标为 J2000 平黄道、平春分点。其他历元请到“历元岁差”页查看。':
      'Galactic coordinates follow the IAU 1958 definition; ecliptic coordinates use the J2000 mean ecliptic and equinox. For other epochs, see the “Precession” tab.',
    '地平坐标按观测时间与地点换算：由方位角、高度角求出时角和视赤纬（勾选大气折射时先扣除折射），视赤经 = 地方视恒星时 − 时角，再换算到 J2000。':
      'Alt/Az input is converted for the observation time and location: azimuth and altitude give the hour angle and apparent declination (refraction is removed first if enabled); apparent RA = local apparent sidereal time − hour angle, then converted to J2000.',
    '实时模式下结果每秒更新。': ' In live mode the result updates every second.',

    // ---- 历元岁差 ----
    '输入（J2000）': 'Input (J2000)',
    'J2000.0 位置': 'J2000.0 position',
    '赤经变化 Δα': 'Change in RA Δα',
    '{dt}（{da} 天球上）': '{dt} ({da} on the sky)',
    '赤纬变化 Δδ': 'Change in Dec Δδ',
    '该历元': 'of date',
    '换算结果': 'Result',
    '历元信息': 'Epoch',
    '儒略日与历元': 'Julian date & epoch',
    '章动 Δψ, Δε': 'Nutation Δψ, Δε',
    '平黄赤交角 ε': 'Mean obliquity ε',
    '平位置：该历元的平赤道与平春分点（只改正岁差，IAU 2006 模型）。':
      'Mean place: mean equator and equinox of the epoch (precession only, IAU 2006 model).',
    '视位置：在平位置基础上再改正章动与周年光行差，为地心视位置（不含周日光行差与大气折射）。':
      'Apparent place: the mean place corrected for nutation and annual aberration, i.e. the geocentric apparent place (no diurnal aberration or refraction).',
    '未计入天体自行；对高自行恒星，请使用对应历元的星表坐标。':
      'Proper motion is not applied; for high-proper-motion stars, use catalog coordinates for the matching epoch.',
    'B1950.0 采用 FK4 参考系（含 E 项改正），并假定天体在 FK5 中没有自行。':
      'B1950.0 uses the FK4 frame (with E-terms) and assumes zero proper motion in FK5.',

    // ---- 地平坐标 ----
    '当日': 'same day',
    '高度角（含折射）': 'Altitude (refracted)',
    '地平线以上': 'Above horizon',
    '地平线以下': 'Below horizon',
    '方位角（北起顺时针）': 'Azimuth (from N, clockwise)',
    '升起': 'Rise',
    '上中天': 'Transit',
    '落下': 'Set',
    '最高 {max}° · {note}': 'max {max}° · {note}',
    '拱极天体：在该地终日不落。上中天 {time}（{note}），最高 {max}°，最低 {min}°。':
      'Circumpolar: never sets at this location. Transit {time} ({note}), max {max}°, min {min}°.',
    '在该地终年不会升起：上中天时最高也只有 {max}°。': 'Never rises at this location: even at transit it only reaches {max}°.',
    '高度角 度分秒': 'Altitude (d m s)',
    '方位角 度分秒': 'Azimuth (d m s)',
    '（东侧，尚未中天）': ' (east, before transit)',
    '（西侧，已过中天）': ' (west, past transit)',
    '地方视恒星时': 'Local apparent sidereal time',
    '地方平恒星时': 'Local mean sidereal time',
    '格林尼治视恒星时': 'Greenwich apparent sidereal time',
    '格林尼治平恒星时': 'Greenwich mean sidereal time',
    '视赤经、视赤纬': 'Apparent RA, Dec',
    '大气质量': 'Airmass',
    '—（地平线以下）': '— (below horizon)',
    '大气折射': 'Refraction',
    '0（地平线以下不计）': '0 (not applied below the horizon)',
    '未计入': 'Not applied',
    '星位角 q': 'Parallactic angle q',
    '高度角 · {md} 12:00 至次日 12:00': 'Altitude · {md} 12:00 to next day 12:00',
    '{name}的高度角曲线：最高 {max}°，出现在 {time}': 'Altitude curve of {name}: max {max}° at {time}',

    // ---- 高度角曲线图（altchart.js） ----
    '白天': 'Day',
    '民用晨昏': 'Civil twilight',
    '航海晨昏': 'Nautical twilight',
    '天文晨昏': 'Astronomical twilight',
    '夜间': 'Night',
    '今夜高度角': 'Altitude tonight',
    '表格': 'Table',
    '曲线': 'Chart',
    '中天 {alt}° {time}': 'Transit {alt}° {time}',
    '当前 {alt}°': 'Now {alt}°',
    '高度角曲线': 'Altitude curve',
    '{time} · 高度角': '{time} · Altitude',
    '方位 {az}': 'Az {az}',
    '天空：{sky}（太阳 {sun}°）': 'Sky: {sky} (Sun {sun}°)',
    '天空': 'Sky',

    // ---- 角距离 ----
    '计算目标 A（上方输入）与目标 B 之间的角距离和位置角。': 'Angular separation and position angle between target A (entered above) and target B.',
    '目标 A': 'Target A',
    '目标 B': 'Target B',
    '位置角 PA（B 相对 A）': 'Position angle PA (B from A)',
    '从北向东量 · 偏{dir}': 'measured from N through E · toward {dir}',
    '角距离（度）': 'Separation (degrees)',
    '角距离（角分）': 'Separation (arcmin)',
    '角距离（角秒）': 'Separation (arcsec)',
    '位置角 PA': 'Position angle PA',
    '向东偏移 ξ': 'Offset east ξ',
    '向北偏移 η': 'Offset north η',
    'A（J2000）': 'A (J2000)',
    'B（J2000）': 'B (J2000)',
    '两个坐标会先各自换算到 ICRS（J2000）再计算，因此可以混用不同坐标系和历元。':
      'Both positions are converted to ICRS (J2000) first, so you can mix coordinate systems and epochs.',
    'ξ、η 为以 A 为切点的标准坐标（切平面投影），适合望远镜视场内的偏移计算。':
      'ξ and η are standard coordinates on the tangent plane at A (gnomonic projection), useful for offsets within a telescope field.',

    // ---- 页脚 ----
    '星表：XHIP（Anderson & Francis 2012），经': 'Star catalog: XHIP (Anderson & Francis 2012), compiled by',
    '（BSD-3-Clause）整理；星座边界：Roman（1987）；常用天体坐标与在线查询：':
      ' (BSD-3-Clause); constellation boundaries: Roman (1987); object coordinates and online lookup:',
    'SIMBAD / Sesame（CDS）': 'SIMBAD / Sesame (CDS)',
    '。': '.',
    '算法：IAU 2006 岁差、IAU 1980 章动（主要 34 项）、周年光行差、FK4/FK5 转换（SLALIB 算法）。精度约 0.1″（忽略 UT1−UTC、极移、周日光行差与自行）。':
      'Algorithms: IAU 2006 precession, IAU 1980 nutation (34 main terms), annual aberration, FK4/FK5 conversion (SLALIB). Accuracy about 0.1″ (UT1−UTC, polar motion, diurnal aberration and proper motion are ignored).'
  };

  var has = Object.prototype.hasOwnProperty;

  /**
   * 取界面文字
   * @param {string} zh 中文原文（也是对照表的键）
   * @param {object} [params] 占位符 {名称} 的取值
   */
  function t(zh, params) {
    var s = isEn && has.call(EN, zh) ? EN[zh] : zh;
    if (params) {
      s = s.replace(/\{(\w+)\}/g, function (m, k) { return has.call(params, k) ? String(params[k]) : m; });
    }
    return s;
  }

  /** 括号注释：中文用全角括号紧贴前文，英文用半角括号并加空格 */
  function paren(s) {
    return isEn ? ' (' + s + ')' : '（' + s + '）';
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /** 月日：中文 "10月21日"，英文 "Oct 21" */
  function monthDay(mo, d) {
    return isEn ? MONTHS[mo - 1] + ' ' + d : mo + '月' + d + '日';
  }

  /* ------------------------------------------------------------------
   * 静态页面的翻译：遍历文字节点和几个文字属性，整段匹配对照表（保留首尾空白）
   * ------------------------------------------------------------------ */
  var ATTRS = ['title', 'aria-label', 'placeholder'];
  function translateText(raw) {
    var core = raw.trim();
    if (!core || !has.call(EN, core)) return null;
    var i = raw.indexOf(core);
    return raw.slice(0, i) + EN[core] + raw.slice(i + core.length);
  }
  function walk(node) {
    if (node.nodeType === 3) {
      var s = translateText(node.data);
      if (s !== null) node.data = s;
      return;
    }
    if (node.nodeType === 1) {
      if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;
      for (var i = 0; i < ATTRS.length; i++) {
        var v = node.getAttribute(ATTRS[i]);
        if (v) {
          var tv = translateText(v);
          if (tv !== null) node.setAttribute(ATTRS[i], tv);
        }
      }
      if (node.tagName === 'TEMPLATE') walk(node.content); // 模板内容不在普通子节点里
    }
    for (var c = node.firstChild; c; c = c.nextSibling) walk(c);
  }
  function translateDom(node) {
    if (isEn) walk(node || root.document.body);
  }

  /** 切换语言：保存选择后刷新页面（地址栏里带 ?lang= 时一并改掉，否则它会覆盖新的选择） */
  function setLang(next) {
    var stored = false;
    try {
      root.localStorage.setItem(STORE_KEY, next);
      stored = root.localStorage.getItem(STORE_KEY) === next;
    } catch (e) { /* 存储不可用：改用地址栏参数传递语言 */ }
    var url = new URL(root.location.href);
    if (url.searchParams.has('lang') || !stored) {
      url.searchParams.set('lang', next);
      root.location.replace(url.toString());
    } else {
      root.location.reload();
    }
  }

  // <html lang> 与页面标题；英文界面在静态文字翻译完成前先隐藏页面
  var docEl = root.document && root.document.documentElement;
  if (docEl) {
    docEl.lang = isEn ? 'en' : 'zh-CN';
    if (isEn) {
      docEl.classList.add('i18n-pending');
      root.document.addEventListener('DOMContentLoaded', function () {
        try {
          translateDom(root.document.body);
          root.document.title = t(root.document.title);
          var meta = root.document.querySelector('meta[name="description"]');
          if (meta) meta.setAttribute('content', t(meta.getAttribute('content')));
        } finally {
          docEl.classList.remove('i18n-pending');
        }
      });
    }
  }

  root.RaDec = root.RaDec || {};
  root.RaDec.I18n = {
    lang: lang,
    isEn: isEn,
    t: t,
    paren: paren,
    monthDay: monthDay,
    translateDom: translateDom,
    setLang: setLang
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
