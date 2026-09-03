// v1.11.2 · 手机端整体观感统一到「方向 A · 软糯可爱」+ 顶栏后面那片主题风景。
//
// PM 在三张质感画板里选了 A（原话：「1 明显好于 2 和 3，但是那个加号被遮住了是什么问题，
// 然后主题图像倒是可以加在后面（3 那种的）」）。这份测试钉的是那次拍板落到代码里的四件事：
//
//   ① --m-* 那批 token 的**名字和值**——习惯 / 四象限 / 更多那几页在 mobile-pages.css 里
//      引的是同一批名字，改名等于把别人的页面拆了；
//   ② A 的长相：22px 圆角、60px 行、26px 打卡圈、胶囊段标题、44×30 导航胶囊、两层投影；
//   ③ 纸纹撤干净（A 是干净的），但**桌面那几张纸一个字没动**；
//   ④ 「幽灵圆」：桌面那幅贴在主区底部的风景不许在手机上挂——它会从底部导航条上沿
//      露出小半个太阳（实测 390×844：风景 708→844、导航 784→844，露在外面 76px）。
//      手机上这片风景改挂在顶栏后面（.mhead-scene）。
//
// 跟 mobile-shell.test.ts 一个路数：这些东西在 jsdom 里一个像素都量不出来（没有布局引擎、
// 没有媒体查询），所以钉的是「改法还在不在源码里」。真的像素在 Playwright 那一轮量。
// 样式只能用 node:fs 读：vitest 默认不处理 CSS，`import x from "a.css?raw"` 读回来是空串。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import appSource from "../src/App.tsx?raw";
import headSource from "../src/mobile/MobileHead.tsx?raw";
import todaySource from "../src/views/Today.tsx?raw";

const read = (p: string) => readFileSync(p, "utf8");
const mobileCss = read("src/styles/mobile.css");
const shellCss = read("src/styles/mobile-shell.css");
const sheetCss = read("src/styles/mobile-sheet.css");
const appCss = read("src/styles/app.css");

/** 仓库里 CRLF / LF 混着用，断言不许把行尾当内容的一部分 */
const nl = (s: string) => s.replace(/\r\n/g, "\n");

describe("① 方向 A 的那批 --m-* token：名字和值都不许悄悄改", () => {
  // 名字是**跨文件的约定**：mobile-pages.css（习惯 / 四象限 / 更多）引的就是这几个。
  // 值抄自画板 方案/手机端设计稿/PolishA.dc.html
  const EXPECT: [string, string][] = [
    ["--m-row-h", "60px"],
    ["--m-card-radius", "22px"],
    ["--m-sheet-radius", "26px"],
    ["--m-cb", "26px"],
    ["--m-cb-bw", "2px"],
  ];

  for (const [name, value] of EXPECT) {
    it(`${name} = ${value}`, () => {
      expect(mobileCss).toContain(`${name}: ${value};`);
    });
  }

  it("颜色那几个 token 都在，而且都是从 themes.css 的 token 兑出来的", () => {
    for (const name of ["--m-cb-border", "--m-sep", "--m-pill-bg", "--m-chip-bg"]) {
      expect(mobileCss, name).toContain(`${name}:`);
    }
    // 保底值一律 var(...)，六主题 × 深浅自动成立
    expect(mobileCss).toContain("--m-cb-border: var(--hair);");
    expect(mobileCss).toContain("--m-sep: var(--hair);");
    expect(mobileCss).toContain("--m-pill-bg: var(--accent-soft);");
  });

  it("--m-radius 是 --m-card-radius 的旧名字，两个名字永远同一个值", () => {
    expect(mobileCss).toContain("--m-radius: var(--m-card-radius);");
  });

  it("🔴 custom property 里不许藏 color-mix：升级那一档写在 @supports 里", () => {
    // 老 WebView 不认 color-mix 时，写在自定义属性里的值不会「降级到上一条声明」，
    // 而是让**用到它的那条属性整个作废**（invalid at computed-value time）——边框直接消失。
    // 所以 :root 里那套必须是纯 var()/字面值，color-mix 只出现在 @supports 块里
    const root = mobileCss.slice(mobileCss.indexOf(":root {"), mobileCss.indexOf("@supports"));
    expect(root).not.toContain("color-mix");
    expect(mobileCss).toContain("@supports (color: color-mix(in srgb, #000 50%, #fff)) {");
    const up = mobileCss.slice(mobileCss.indexOf("@supports"));
    expect(up).toContain("--m-cb-border: color-mix(in srgb, var(--accent) 35%, var(--card));");
  });

  it("投影两层，深色模式换成更深的 alpha（别在深底上露白边）", () => {
    expect(mobileCss).toContain(
      "--m-card-shadow: 0 2px 6px rgba(62, 74, 52, .06), 0 12px 28px rgba(62, 74, 52, .06);",
    );
    const dark = mobileCss.slice(mobileCss.indexOf('[data-mode="dark"] {'));
    expect(dark).toContain("--m-card-shadow: 0 2px 6px rgba(0, 0, 0, .26), 0 12px 28px rgba(0, 0, 0, .34);");
  });

  it("尺度都从 token 来，壳子里不再写死那几个数", () => {
    for (const v of ["--m-card-radius", "--m-card-shadow", "--m-cb", "--m-cb-border", "--m-sep", "--m-pill-bg"]) {
      expect(shellCss, v).toContain(`var(${v})`);
    }
    expect(sheetCss).toContain("var(--m-cb-border)");
  });
});

describe("② A 的长相铺到了列表、段标题、顶栏、导航、＋", () => {
  it("卡片 22 圆角、两层投影、不描边、不铺纸纹", () => {
    const card = shellCss.slice(shellCss.indexOf("\n.mcard {"), shellCss.indexOf(".mcard + .mcard"));
    expect(card).toContain("border-radius: var(--m-card-radius);");
    expect(card).toContain("box-shadow: var(--m-card-shadow);");
    expect(card).not.toContain("var(--paper)");
  });

  it("打卡圈 26 / 2px，底色是卡片色（画板 A 那颗圈是实心底的）", () => {
    const cb = shellCss.slice(shellCss.indexOf("\n.mrow-cb {"), shellCss.indexOf(".mrow-cb::before"));
    expect(cb).toContain("width: var(--m-cb);");
    expect(cb).toContain("border: var(--m-cb-bw) solid var(--m-cb-border);");
    expect(cb).toContain("background: var(--card);");
  });

  it("🔴 一行的视觉顺序是 圈 → 小圆点 → 标题 → 日期，四件都写了 order", () => {
    // DOM 里色条排在圈前面（MobileRow 这一版没动），靠 flex 的 order 摆对。
    // 漏写一个，它的 order 就是 0，会整个跑到 order:1 前面去
    for (const line of [
      ".mrow-cb { order: 1; }",
      ".mrow-bar { order: 2; }",
      ".mrow-title { order: 3; }",
      ".mrow-when { order: 4; }",
    ]) {
      expect(shellCss, line).toContain(line);
    }
    // 重要性从 3px 竖条改成 8px 小圆点（画板里的 .dot）
    expect(shellCss).toContain(".mrow-bar { width: 8px; height: 8px; border-radius: 50%;");
  });

  it("段标题是一颗胶囊；裸文本那两页（习惯 / 更多）靠容器自己缩成胶囊", () => {
    const gh = shellCss.slice(
      shellCss.indexOf(".mshell .group-head {"),
      shellCss.indexOf(".mshell .group-head.warn"),
    );
    expect(gh).toContain("width: max-content;");
    expect(gh).toContain("border-radius: 999px;");
    expect(gh).toContain("background: var(--m-pill-bg);");
    expect(gh).toContain("height: 26px;");
    // 「逾期」走 warn 变体
    expect(shellCss).toContain(
      ".mshell .group-head.warn { background: var(--m-pill-warn-bg); color: var(--m-pill-warn-ink); }",
    );
    // 这一路链接是 absolute 挂在胶囊右边的，所以胶囊自己不许 overflow: hidden
    const act = shellCss.slice(shellCss.indexOf(".mshell .group-head .act {"));
    expect(act.slice(0, 260)).toContain("left: 100%;");
    expect(gh).not.toContain("overflow: hidden;");
  });

  it("🔴 .split 那一路：容器满宽、胶囊在 .group-label 上、链接贴右缘（画板 A）", () => {
    const split = shellCss.slice(
      shellCss.indexOf(".mshell .group-head.split {"),
      shellCss.indexOf(".mshell .group-label {"),
    );
    expect(split).toContain("width: auto;");
    expect(split).toContain("background: none;");
    const label = shellCss.slice(
      shellCss.indexOf(".mshell .group-label {"),
      shellCss.indexOf(".mshell .group-head.warn .group-label"),
    );
    expect(label).toContain("height: 26px;");
    expect(label).toContain("border-radius: 999px;");
    expect(label).toContain("background: var(--m-pill-bg);");
    expect(shellCss).toContain(".mshell .group-head.split .act {");
    expect(shellCss.slice(shellCss.indexOf(".mshell .group-head.split .act {"), -1).slice(0, 160))
      .toContain("margin-left: auto;");
    // 四个视图都得把标题包起来并挂上 .split，否则那一页的链接又跑回胶囊旁边
    for (const [name, src] of [
      ["今天", todaySource],
      ["计划", read("src/views/Plan.tsx")],
      ["已完成", read("src/views/Done.tsx")],
      ["清单页", read("src/views/ListView.tsx")],
    ] as const) {
      expect(src, name).toContain("group-head split");
      expect(src, name).toContain('<span className="group-label">');
    }
    // 习惯 / 更多那两页是裸文本，走容器那一路——它们的 TSX 一个字没动
    expect(read("src/views/Habits.tsx")).not.toContain("group-label");
    expect(read("src/views/MobileMore.tsx")).not.toContain("group-label");
  });

  it("「已完成 · N 展开」跟 .split 一个间架，命中区靠上下 9px 垫到 44", () => {
    const fold = shellCss.slice(shellCss.indexOf("\n.mfoldrow {"), shellCss.indexOf(".mshell .mfoldrow"));
    expect(fold).toContain("width: calc(100% - 36px);");
    expect(fold).toContain("padding: 9px 0;");
    expect(shellCss).toContain(
      ".mshell .mfoldrow .group-label { background: var(--m-pill-dim-bg); color: var(--m-pill-dim-ink); }",
    );
    expect(shellCss.slice(shellCss.indexOf(".mfoldrow .more {"))).toContain("margin-left: auto;");
  });

  it("母任务前缀是一颗更小更淡的胶囊，不是灰字", () => {
    // 从 .mrow-parent 起截一段就够：.mrow-when 那个名字前面还有一条 order 的单行规则，
    // 拿它当终点会把区间截反
    const p = shellCss.slice(shellCss.indexOf(".mrow-parent {"), shellCss.indexOf(".mrow-parent {") + 400);
    expect(p).toContain("font-size: 11.5px;");
    expect(p).toContain("background: var(--m-chip-bg);");
    expect(p).toContain("border-radius: 999px;");
    expect(p).toContain("padding: 1px 8px;");
  });

  it("底部导航当前项那颗胶囊是 44×30，＋ 是 54 的圆角方块", () => {
    const ico = shellCss.slice(shellCss.indexOf(".mnav-ico {"), shellCss.indexOf(".mnav-ico svg"));
    expect(ico).toContain("width: 44px;");
    expect(ico).toContain("height: 30px;");
    const fab = shellCss.slice(shellCss.indexOf(".mfab {"), shellCss.indexOf(".mfab:active"));
    expect(fab).toContain("width: 54px;");
    expect(fab).toContain("border-radius: 18px;");
    // 画板 A 那张预览里 ＋ 的下半截被导航压住了（PM 第一眼就问的那件事）：
    // 这儿按导航的真高度往上让 16px，不照抄画板那个 bottom: 100px
    expect(fab).toContain("bottom: calc(var(--m-nav-h) + var(--m-safe-bottom) + 16px);");
  });

  it("页底那抹柔光挂在 .shell.mobile 上（挂 .mshell 会把顶栏后面那片风景盖住）", () => {
    expect(nl(shellCss)).toContain(
      "background-image: radial-gradient(120% 70% at 85% -8%, var(--accent-soft), transparent 58%);",
    );
    const glow = shellCss.slice(shellCss.indexOf("radial-gradient(120% 70%") - 400,
                                shellCss.indexOf("radial-gradient(120% 70%"));
    expect(glow).toContain(".shell.mobile {");
  });

  it("抽屉顶部圆角跟卡片一个语言（26），纸上不再铺颗粒", () => {
    expect(mobileCss).toContain("border-radius: var(--m-sheet-radius) var(--m-sheet-radius) 0 0;");
    const sheet = mobileCss.slice(mobileCss.indexOf("\n.msheet {"), mobileCss.indexOf(".msheet.in"));
    expect(sheet).not.toContain("var(--paper)");
    expect(sheetCss).not.toContain("var(--paper)");
  });
});

describe("③ 纸纹撤干净了，但桌面一个字没动", () => {
  it("手机端那几张纸都不再叠 var(--paper)", () => {
    // 整个 mobile-*.css 里只剩「明确写 none」这一种用法
    for (const [name, css] of [["mobile.css", mobileCss], ["mobile-sheet.css", sheetCss]] as const) {
      expect(css, name).not.toContain("var(--paper)");
    }
    expect(shellCss).not.toContain("background-image: var(--paper)");
    expect(shellCss).toContain("background-image: none;");
  });

  it("🔴 桌面那几张纸的颗粒原样还在（base.css / themes.css 一个字没动）", () => {
    expect(read("src/styles/base.css")).toContain("background-image: var(--paper); }");
    expect(read("src/styles/themes.css")).toContain("--paper:");
    // 侧栏底纸也照旧
    expect(appCss).toContain("background-image: var(--paper), linear-gradient(180deg, var(--accent-soft), transparent 62%);");
  });
});

describe("④ 幽灵圆：底部那幅风景在手机上撤了，改挂到顶栏后面", () => {
  it("🔴 App 只在桌面挂 <ThemeScene>", () => {
    expect(appSource).toContain("{!isMobile && <ThemeScene theme={theme} />}");
    // 撤的是**挂载**，不是靠 CSS 藏：藏起来的东西迟早被下一个人「修好」
    expect(nl(appSource)).not.toMatch(/^\s*<ThemeScene theme=\{theme\} \/>\s*$/m);
  });

  it("顶栏里挂了同一个组件，跟着当前主题走", () => {
    expect(headSource).toContain('import ThemeScene from "../components/ThemeScene";');
    expect(headSource).toContain("const theme = useApp((s) => s.data.settings.theme);");
    expect(headSource).toContain('<div className="mhead-scene" aria-hidden="true">');
    expect(headSource).toContain("<ThemeScene theme={theme} />");
  });

  it("这片风景沉在内容之下、不吃点击、下沿化开", () => {
    const scene = shellCss.slice(
      shellCss.indexOf(".mshell .mhead-scene {"),
      shellCss.indexOf(".mhead-top {"),
    );
    expect(scene).toContain("z-index: -1;");
    expect(scene).toContain("pointer-events: none;");
    expect(scene).toContain("height: var(--m-scene-h);");
    expect(scene).toContain("opacity: var(--m-scene-a);");
    // 终点落在盒子底边：画的最下面是一整条实心山脊，不化到底会留一道横切线
    expect(scene).toContain("linear-gradient(to bottom, transparent 22%, var(--bg) 100%)");
    // 顶栏得是定位元素才当得了锚，但**不许有 z-index**（一有就成了层叠上下文，
    // 风景只沉得到顶栏自己底下，正文的卡片反而被它压住）
    const head = shellCss.slice(shellCss.indexOf(".mshell .mhead {"), shellCss.indexOf(".mshell .mhead-scene {"));
    expect(head).toContain("position: relative;");
    // 注释里写「不加 z-index」不算数，看的是真声明
    expect(head).not.toMatch(/^\s*z-index:/m);
  });

  it("🔴 桌面那幅贴主区底部的风景原样还在（含窄桌面窗口那一档）", () => {
    expect(appCss).toContain(".theme-scene {");
    expect(appCss).toContain("bottom: 0;");
    expect(appCss).toContain(".theme-scene { left: 0; max-height: 40vh; }");
    // 设置页主题卡里那幅小预览也没动
    expect(appCss).toContain(".theme-scene.card {");
  });
});

describe("⑤ 那颗小橡果只在「今天」露一次脸", () => {
  it("MobileHead 有 mascot 开关，画的是画板 PolishA 那颗 30×30", () => {
    expect(headSource).toContain("mascot?: boolean;");
    expect(headSource).toContain("function AcornMascot()");
    expect(headSource).toContain('viewBox="0 0 30 30"');
    expect(headSource).toContain("{mascot && <AcornMascot />}");
  });

  it("只有今天页传 true", () => {
    expect(todaySource).toContain("mascot");
    for (const [name, src] of [
      ["计划", read("src/views/Plan.tsx")],
      ["已完成", read("src/views/Done.tsx")],
      ["清单 / 随手记 / 回收站", read("src/views/ListView.tsx")],
      ["更多", read("src/views/MobileMore.tsx")],
      ["习惯", read("src/views/Habits.tsx")],
      ["日历", read("src/views/Calendar.tsx")],
      ["统计", read("src/views/StatsView.tsx")],
      ["设置", read("src/views/Settings.tsx")],
    ] as const) {
      expect(src, name).not.toContain("mascot");
    }
  });

  it("今天页那句副标题带上了 A 的语气", () => {
    expect(todaySource).toContain("· 还剩 ${left} 件，慢慢来");
    expect(todaySource).toContain('" · 都做完了"');
  });
});
