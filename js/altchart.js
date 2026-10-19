/**
 * altchart.js —— "高度角-时间"曲线图（SVG）
 *
 * 展示目标天体在一个夜晚（当地正午到次日正午）内的高度角变化，用于判断什么时候适合观测：
 *   · 背景色带表示天空状态：白天 / 民用晨昏 / 航海晨昏 / 天文晨昏 / 夜间（同一色相、由亮到暗）；
 *   · 金色曲线为目标高度角，曲线下方淡色填充；地平线以下区域压暗；
 *   · 竖线 + 圆点标出当前观测时刻，并标注上中天（最高点）；
 *   · 鼠标/触摸移动时显示十字准线和提示框；键盘 ←/→ 可逐点移动；
 *   · 提供"表格"视图（逐小时列出高度角、方位角、天空状态），便于无障碍阅读。
 *
 * 用法：
 *   var chart = RaDec.AltChart.create(containerElement);
 *   chart.update(model);   // model 结构见 update() 的注释
 */
(function (root) {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  var SKY_NAMES = ['白天', '民用晨昏', '航海晨昏', '天文晨昏', '夜间'];
  var SKY_CLASS = ['day', 'civil', 'nautical', 'astro', 'night'];
  var Y_MIN = -30, Y_MAX = 90; // 纵轴范围（度）
  var PAD = { top: 14, right: 12, bottom: 26, left: 38 }; // 绘图区四周留白（含坐标轴标签带）
  var PLOT_H = 190; // 绘图区高度

  /** 根据太阳高度角判断天空状态（0 白天 … 4 夜间） */
  function skyState(sunAlt) {
    if (sunAlt > -0.833) return 0;
    if (sunAlt > -6) return 1;
    if (sunAlt > -12) return 2;
    if (sunAlt > -18) return 3;
    return 4;
  }

  function el(name, attrs, parent) {
    var e = document.createElementNS(SVGNS, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function create(container) {
    container.classList.add('altchart');
    container.innerHTML = '';

    // ---- 头部：标题 + 视图切换按钮 ----
    var head = document.createElement('div');
    head.className = 'altchart__head';
    var title = document.createElement('div');
    title.className = 'altchart__title';
    title.textContent = '今夜高度角';
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'chip-btn';
    toggle.textContent = '表格';
    toggle.setAttribute('aria-pressed', 'false');
    head.appendChild(title);
    head.appendChild(toggle);
    container.appendChild(head);

    // ---- 图表区 ----
    var plotWrap = document.createElement('div');
    plotWrap.className = 'altchart__plot';
    plotWrap.tabIndex = 0;
    plotWrap.setAttribute('role', 'img');
    container.appendChild(plotWrap);
    var svg = el('svg', { class: 'altchart__svg' }, plotWrap);
    var tip = document.createElement('div');
    tip.className = 'altchart__tip';
    tip.hidden = true;
    plotWrap.appendChild(tip);

    // ---- 图例（背景色带的含义） ----
    var legend = document.createElement('div');
    legend.className = 'altchart__legend';
    SKY_NAMES.forEach(function (name, i) {
      var item = document.createElement('span');
      var sw = document.createElement('i');
      sw.className = 'sw sw--' + SKY_CLASS[i];
      item.appendChild(sw);
      item.appendChild(document.createTextNode(name));
      legend.appendChild(item);
    });
    container.appendChild(legend);

    // ---- 表格视图 ----
    var tableWrap = document.createElement('div');
    tableWrap.className = 'altchart__table';
    tableWrap.hidden = true;
    container.appendChild(tableWrap);

    var model = null;
    var geom = null; // 当前绘制的几何信息（坐标换算用）
    var hoverIdx = -1;

    toggle.addEventListener('click', function () {
      var showTable = tableWrap.hidden;
      tableWrap.hidden = !showTable;
      plotWrap.hidden = showTable;
      legend.hidden = showTable;
      toggle.textContent = showTable ? '曲线' : '表格';
      toggle.setAttribute('aria-pressed', showTable ? 'true' : 'false');
      if (showTable) renderTable();
      else draw();
    });

    /** 横轴（儒略日）→ 像素 */
    function xOf(jd) {
      return geom.x0 + (jd - model.jdStart) / (model.jdEnd - model.jdStart) * geom.w;
    }
    /** 纵轴（高度角）→ 像素；clampIt 为 true 时限制在绘图区内（用于圆点、标签） */
    function yOf(alt, clampIt) {
      var a = clampIt === false ? alt : Math.max(Y_MIN, Math.min(Y_MAX, alt));
      return geom.y0 + (Y_MAX - a) / (Y_MAX - Y_MIN) * PLOT_H;
    }

    function draw() {
      if (!model || plotWrap.hidden) return;
      var width = Math.max(260, plotWrap.clientWidth || 360);
      var height = PAD.top + PLOT_H + PAD.bottom;
      geom = { x0: PAD.left, y0: PAD.top, w: width - PAD.left - PAD.right };
      svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      svg.setAttribute('width', width);
      svg.setAttribute('height', height);
      svg.innerHTML = '';
      var s = model.samples;

      // 1) 天空状态色带：把相邻同状态的采样点合并成一个矩形
      var bands = el('g', { class: 'bands' }, svg);
      var start = 0;
      for (var i = 1; i <= s.length; i++) {
        if (i === s.length || skyState(s[i].sunAlt) !== skyState(s[start].sunAlt)) {
          var st = skyState(s[start].sunAlt);
          var xa = xOf(s[start].jd), xb = xOf(s[Math.min(i, s.length - 1)].jd);
          if (st !== 4) {
            el('rect', { x: xa, y: geom.y0, width: Math.max(0, xb - xa), height: PLOT_H, class: 'band band--' + SKY_CLASS[st] }, bands);
          }
          start = i;
        }
      }
      // 2) 地平线以下压暗；说明文字放在曲线不经过的一侧（左右都会被曲线挡住时不显示）
      el('rect', { x: geom.x0, y: yOf(0), width: geom.w, height: yOf(Y_MIN) - yOf(0), class: 'below' }, svg);
      var edge = Math.round(s.length * 0.22);
      var clearOf = function (from, to) {
        for (var q = from; q < to; q++) if (s[q].alt < 3 && s[q].alt > -16) return false;
        return true;
      };
      if (clearOf(0, edge)) {
        el('text', { x: geom.x0 + 6, y: yOf(0) + 14, class: 'note' }, svg).textContent = '地平线以下';
      } else if (clearOf(s.length - edge, s.length)) {
        el('text', { x: geom.x0 + geom.w - 6, y: yOf(0) + 14, class: 'note', 'text-anchor': 'end' }, svg).textContent = '地平线以下';
      }

      // 3) 网格线与纵轴刻度（实线细线，保持低调）
      var grid = el('g', { class: 'grid' }, svg);
      [30, 60, 90].forEach(function (a) {
        el('line', { x1: geom.x0, x2: geom.x0 + geom.w, y1: yOf(a), y2: yOf(a) }, grid);
      });
      el('line', { x1: geom.x0, x2: geom.x0 + geom.w, y1: yOf(0), y2: yOf(0), class: 'baseline' }, svg);
      [0, 30, 60, 90].forEach(function (a) {
        el('text', { x: geom.x0 - 6, y: yOf(a) + 4, class: 'tick tick--y' }, svg).textContent = a + '°';
      });
      // 横轴刻度（由调用方按所选时区给出整点位置与文字）；刻度太密时隔一个标一个，避免文字挤在一起
      var ticks = model.ticks || [];
      var gap = ticks.length > 1 ? Math.abs(xOf(ticks[1].jd) - xOf(ticks[0].jd)) : 999;
      var every = gap < 46 ? 2 : 1;
      ticks.forEach(function (t, ti) {
        var x = xOf(t.jd);
        el('line', { x1: x, x2: x, y1: yOf(Y_MIN), y2: yOf(Y_MIN) + 4, class: 'tickmark' }, svg);
        if (ti % every === 0) el('text', { x: x, y: yOf(Y_MIN) + 17, class: 'tick tick--x' }, svg).textContent = t.label;
      });

      // 4) 高度角曲线与其下方的淡色填充（只填地平线以上的部分）。
      //    曲线不做数值截断，而是用裁剪区域限制在绘图区内，低于 −30° 时自然地从底边出入
      var uid = Math.random().toString(36).slice(2, 8);
      var defs = el('defs', {}, svg);
      var clipAbove = el('clipPath', { id: 'alt-above-' + uid }, defs);
      el('rect', { x: geom.x0, y: geom.y0, width: geom.w, height: yOf(0) - geom.y0 }, clipAbove);
      var clipPlot = el('clipPath', { id: 'alt-plot-' + uid }, defs);
      el('rect', { x: geom.x0, y: geom.y0 - 2, width: geom.w, height: PLOT_H + 4 }, clipPlot);
      var line = '', area = '';
      for (var k = 0; k < s.length; k++) {
        var px = xOf(s[k].jd).toFixed(1), py = yOf(s[k].alt, false).toFixed(1);
        line += (k ? 'L' : 'M') + px + ' ' + py;
      }
      area = line + 'L' + xOf(s[s.length - 1].jd).toFixed(1) + ' ' + yOf(0) + 'L' + xOf(s[0].jd).toFixed(1) + ' ' + yOf(0) + 'Z';
      el('path', { d: area, class: 'area', 'clip-path': 'url(#alt-above-' + uid + ')' }, svg);
      el('path', { d: line, class: 'line', 'clip-path': 'url(#alt-plot-' + uid + ')' }, svg);

      // 5) 上中天标注（选择性直接标注：只标最高点）
      if (model.transit && model.transit.jd >= model.jdStart && model.transit.jd <= model.jdEnd) {
        var tx = xOf(model.transit.jd), ty = yOf(model.transit.alt);
        var label = '中天 ' + model.transit.alt.toFixed(1) + '° ' + model.formatTime(model.transit.jd);
        var anchor = tx > geom.x0 + geom.w - 90 ? 'end' : tx < geom.x0 + 90 ? 'start' : 'middle';
        el('text', { x: tx, y: Math.max(geom.y0 + 10, ty - 10), class: 'label', 'text-anchor': anchor }, svg).textContent = label;
      }

      // 6) 当前观测时刻
      if (model.nowJd >= model.jdStart && model.nowJd <= model.jdEnd) {
        var nx = xOf(model.nowJd);
        el('line', { x1: nx, x2: nx, y1: geom.y0, y2: yOf(Y_MIN), class: 'now' }, svg);
        var ny = yOf(model.nowAlt);
        el('circle', { cx: nx, cy: ny, r: 4.5, class: 'dot' }, svg);
        var nAnchor = nx > geom.x0 + geom.w - 70 ? 'end' : 'start';
        el('text', { x: nx + (nAnchor === 'end' ? -8 : 8), y: ny < geom.y0 + 24 ? ny + 16 : ny - 8, class: 'label', 'text-anchor': nAnchor }, svg)
          .textContent = '当前 ' + model.nowAlt.toFixed(1) + '°';
      }

      // 7) 悬停层：十字准线
      var cross = el('line', { class: 'cross', y1: geom.y0, y2: yOf(Y_MIN) }, svg);
      var crossDot = el('circle', { r: 4.5, class: 'dot dot--hover' }, svg);
      cross.style.display = 'none';
      crossDot.style.display = 'none';
      geom.cross = cross;
      geom.crossDot = crossDot;
      if (hoverIdx >= 0) showHover(hoverIdx);

      plotWrap.setAttribute('aria-label', model.summary || '高度角曲线');
    }

    /** 显示第 i 个采样点的十字准线与提示框 */
    function showHover(i) {
      if (!model || !geom || !geom.cross) return;
      hoverIdx = Math.max(0, Math.min(model.samples.length - 1, i));
      var p = model.samples[hoverIdx];
      var x = xOf(p.jd), y = yOf(p.alt);
      geom.cross.setAttribute('x1', x);
      geom.cross.setAttribute('x2', x);
      geom.cross.style.display = '';
      geom.crossDot.setAttribute('cx', x);
      geom.crossDot.setAttribute('cy', y);
      geom.crossDot.style.display = '';
      // 提示框：数值在前（强调），说明文字在后
      tip.innerHTML = '';
      var v = document.createElement('div');
      v.className = 'altchart__tip-value';
      v.textContent = p.alt.toFixed(1) + '°';
      var l1 = document.createElement('div');
      l1.className = 'altchart__tip-row';
      l1.textContent = model.formatTime(p.jd) + ' · 高度角';
      var l2 = document.createElement('div');
      l2.className = 'altchart__tip-row';
      l2.textContent = '方位 ' + model.formatAz(p.az);
      var l3 = document.createElement('div');
      l3.className = 'altchart__tip-row';
      l3.textContent = '天空：' + SKY_NAMES[skyState(p.sunAlt)] + '（太阳 ' + p.sunAlt.toFixed(0) + '°）';
      tip.appendChild(v);
      tip.appendChild(l1);
      tip.appendChild(l2);
      tip.appendChild(l3);
      tip.hidden = false;
      var tw = tip.offsetWidth || 150;
      var left = x + 14;
      if (left + tw > geom.x0 + geom.w) left = x - tw - 14;
      tip.style.left = Math.max(0, left) + 'px';
      tip.style.top = Math.max(0, Math.min(y - 30, PLOT_H - 40)) + 'px';
    }
    function hideHover() {
      hoverIdx = -1;
      tip.hidden = true;
      if (geom && geom.cross) {
        geom.cross.style.display = 'none';
        geom.crossDot.style.display = 'none';
      }
    }

    // 指针移动：吸附到最近的采样点
    plotWrap.addEventListener('pointermove', function (e) {
      if (!model || !geom) return;
      var r = svg.getBoundingClientRect();
      var x = e.clientX - r.left;
      if (x < geom.x0 - 4 || x > geom.x0 + geom.w + 4) {
        hideHover();
        return;
      }
      var frac = (x - geom.x0) / geom.w;
      showHover(Math.round(frac * (model.samples.length - 1)));
    });
    plotWrap.addEventListener('pointerleave', hideHover);
    // 键盘：←/→ 逐点移动（按住 Shift 每次移动 1 小时），Esc 隐藏
    plotWrap.addEventListener('keydown', function (e) {
      if (!model) return;
      var stepPerHour = Math.round((model.samples.length - 1) / 24);
      var d = e.shiftKey ? stepPerHour : 1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        var base = hoverIdx >= 0 ? hoverIdx : Math.round((model.nowJd - model.jdStart) / (model.jdEnd - model.jdStart) * (model.samples.length - 1));
        showHover(base + (e.key === 'ArrowRight' ? d : -d));
      } else if (e.key === 'Escape') {
        hideHover();
      }
    });
    plotWrap.addEventListener('blur', hideHover);

    /** 表格视图：逐小时列出数值 */
    function renderTable() {
      tableWrap.innerHTML = '';
      if (!model) return;
      var table = document.createElement('table');
      table.className = 'data-table';
      var thead = document.createElement('thead');
      var hr = document.createElement('tr');
      ['时间', '高度角', '方位角', '天空'].forEach(function (h) {
        var th = document.createElement('th');
        th.textContent = h;
        hr.appendChild(th);
      });
      thead.appendChild(hr);
      table.appendChild(thead);
      var tb = document.createElement('tbody');
      var stepPerHour = Math.round((model.samples.length - 1) / 24);
      for (var i = 0; i < model.samples.length; i += stepPerHour) {
        var p = model.samples[i];
        var tr = document.createElement('tr');
        [model.formatTime(p.jd), p.alt.toFixed(1) + '°', model.formatAz(p.az), SKY_NAMES[skyState(p.sunAlt)]].forEach(function (c) {
          var td = document.createElement('td');
          td.textContent = c;
          tr.appendChild(td);
        });
        tb.appendChild(tr);
      }
      table.appendChild(tb);
      tableWrap.appendChild(table);
    }

    // 容器宽度变化时重绘
    if (root.ResizeObserver) {
      new root.ResizeObserver(function () { draw(); }).observe(plotWrap);
    }

    return {
      /**
       * @param {object} m {
       *   samples: [{jd, alt, az, sunAlt}],   // 由 Astro.altitudeTrack 生成
       *   jdStart, jdEnd,                     // 横轴范围（UTC 儒略日）
       *   nowJd, nowAlt,                      // 当前观测时刻与高度角
       *   transit: {jd, alt} | null,          // 上中天
       *   ticks: [{jd, label}],               // 横轴刻度
       *   formatTime(jd) → 'HH:MM', formatAz(az) → 文本,
       *   title, summary                      // 标题与无障碍描述
       * }
       */
      update: function (m) {
        model = m;
        title.textContent = m.title || '今夜高度角';
        draw();
        if (!tableWrap.hidden) renderTable();
      }
    };
  }

  root.RaDec = root.RaDec || {};
  root.RaDec.AltChart = { create: create, skyState: skyState, SKY_NAMES: SKY_NAMES };
})(typeof globalThis !== 'undefined' ? globalThis : this);
