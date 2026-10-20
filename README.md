# radec-calculator · 赤经赤纬计算器

一个纯静态的赤经赤纬（RA / Dec）计算网站，以真实星表实时绘制的星图为背景。
无需安装、无需构建：**双击 `index.html` 即可使用**，也可以直接部署到 GitHub Pages 等静态托管服务。

> **English:** A static, no-build RA/Dec calculator over a live star map: format and coordinate-system conversion,
> precession and apparent places (J2000, B1950, JNow or any date), altitude/azimuth with rise/set times,
> and angular separation. The interface is available in English and Chinese — it follows your browser language,
> and the button at the top right switches it (or open `index.html?lang=en`).

## 功能

| 功能 | 说明 |
|---|---|
| 格式转换 | 赤经：时分秒 ↔ 十进制小时 ↔ 十进制度；赤纬：度分秒 ↔ 十进制度。支持 `05h34m31.94s`、`5:34:31.9`、`05 34 31.9`、`83.633°`、`5时34分31.9秒`、全角字符等多种写法；粘贴整行坐标会自动拆分；结果一键复制。各页结果中的赤经赤纬默认显示为时分秒 / 度分秒，可在"坐标转换"页右上角勾选"赤经赤纬显示为十进制度"切换 |
| 坐标系转换 | 赤道坐标（J2000/ICRS、B1950/FK4）↔ 银道坐标（l, b）↔ 黄道坐标（λ, β），并给出所在 IAU 星座 |
| 历元岁差 | 输入和输出都可选 J2000.0、B1950.0（FK4）、观测时刻（JNow）、**指定日期**、任意儒略历元；给出平位置、视位置（含章动与周年光行差）以及赤经赤纬变化量 |
| 地平坐标 | 按观测地点与时间计算高度角、方位角、时角、地方/格林尼治恒星时、大气质量、星位角，以及升起/上中天/落下时刻；附当晚高度角曲线（含晨昏色带，可切换为表格） |
| 地平坐标反算 | 在输入区选择"地平"，输入方位角（北起向东）和高度角，按观测时间与地点反算出 J2000 赤经赤纬、观测时刻的视赤经赤纬（JNow）和时角；勾选大气折射时，高度角按含折射的观测值处理。实时模式下结果每秒更新 |
| 角距离 | 两个天体（可混用不同坐标系与历元）之间的角距离、位置角，小角度时给出切平面偏移 ξ、η |
| 天体搜索 | 本地内置 88 个常用天体（SIMBAD 精确坐标）和约 3000 颗有名称的恒星，支持中文名、英文名、拜耳名（如 `α Ori`、`猎户座α`）、HIP 编号；找不到时可在线查询 SIMBAD（需联网） |
| 星图 | 约 5000 颗 ≤6 等亮星（按 B−V 色指数着色）、银河、星座连线与星座名、赤经赤纬网格、天赤道与黄道、观测地地平线；可拖动、平滑缩放，点击拾取坐标；目标与角距离会实时标注在图上 |
| 界面语言 | 简体中文 / English：首次打开按浏览器语言自动选择，右上角按钮切换并记住选择；地址栏加 `?lang=en` 或 `?lang=zh` 可直接指定。英文界面中星名用英文名、星座名用拉丁名，搜索仍支持中文名 |
| 其他 | 红光夜视模式、全屏星图、桌面/手机自适应布局、地址栏分享目标（`#ra=…&dec=…`）、自动记住观测地点等设置；预设地点包括中国、美国的主要城市与天文台，首次打开按本机时区选择默认地点 |

## 使用

- **本地使用**：直接用浏览器打开 `index.html`（所有脚本都是普通 `<script>`，不依赖 ES 模块或 `fetch`，因此 `file://` 下也能运行）。
- **本地服务器**（可选）：`python3 -m http.server 8000`，然后访问 <http://localhost:8000>。
- **部署**：把整个目录上传到任意静态托管（如 GitHub Pages）即可。

除"在线查询 SIMBAD"外，所有计算都在本地完成，不依赖任何网络资源或第三方库。

## 计算方法与精度

| 项目 | 模型 |
|---|---|
| 岁差 | IAU 2006（Fukushima-Williams 四角） |
| 章动 | IAU 1980 序列中最大的 34 项（截断误差约 0.003″） |
| 光行差 | 周年光行差，含地球轨道偏心率项 |
| FK4 ↔ FK5 | SLALIB `FK45Z` / `FK54Z` 算法（含 E 项），假定天体在 FK5 中无自行 |
| 银道坐标 | IAU 1958 定义（FK5 J2000 下的北银极与零点） |
| 恒星时 | IAU 2006 GMST（基于地球自转角 ERA）+ 二分差 |
| 大气折射 | Sæmundsson 公式，按海拔估算气压修正 |
| 升落时刻 | 恒星的解析解，地平高度判据 −0°34′（计入折射时） |
| 地平 → 赤道 | 正向计算的精确逆运算：开启折射时先用二分法扣除折射，再由方位角、高度角求时角与视赤纬，最后由视位置还原到 J2000（往返误差 < 10⁻⁸″） |
| 星座判定 | Roman (1987) 边界表，坐标先岁差到 B1875.0 |

用 astropy 6.1 / pyerfa（IAU SOFA 算法）逐项校验：岁差矩阵、GMST、FK4/FK5、银道坐标与 SOFA 一致到 0.0001″ 以内；视位置差异约 0.03″。

有意忽略的效应（对一般观测用途影响很小）：UT1−UTC（< 0.9 秒）、极移、周日光行差、太阳引力光线偏折（距太阳 2° 以内时约 0.2″）、天体自行与视差。

## 目录结构

```
index.html              页面结构
css/style.css           样式（深空主题、响应式布局、红光夜视模式）
js/angle.js             坐标文本解析与格式化（纯函数，可在 Node.js 中测试）
js/astro.js             天文算法（纯函数，可在 Node.js 中测试）
js/starmap.js           背景星图（Canvas，球极投影）
js/altchart.js          高度角曲线图（SVG）
js/app.js               页面交互逻辑
js/i18n.js              界面语言（中文 / English）：语言选择与英文对照表
data/stars.js           亮星星表与星名（≤6 等，5044 颗）
data/constellations.js  星座连线、中文名、IAU 星座边界
data/milkyway.js        银河亮度图（由轮廓数据栅格化）
data/objects.js         常用天体列表（SIMBAD 坐标）
```

## 数据来源与致谢

- 星表、星名、星座连线、银河轮廓：[d3-celestial](https://github.com/ofrohn/d3-celestial)（BSD-3-Clause，© Olaf Frohn，许可证见 `data/LICENSE-d3-celestial.txt`）。其中恒星数据源自 XHIP（Anderson & Francis 2012，VizieR V/137D），银河轮廓源自 Jose R. Vieira 的 Milky Way Outline Catalog。星座中文名按 IAU 缩写统一为大陆标准简体名称。
- 星座边界：Roman, N. G. 1987, PASP 99, 695（VizieR VI/42）。
- 常用天体坐标与在线名称解析：This research has made use of the SIMBAD database and the Sesame name resolver, operated at CDS, Strasbourg, France.
