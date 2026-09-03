// v1.11.2 · 手机端四件事：习惯页重排、四象限独立成页、「更多」的格子、「随手记」退场。
//
// 跟 mobile-shell / mobile-layout 一个路数：这一轮改的东西**在 jsdom 里一个像素都量不出来**
// （没有布局引擎、没有媒体查询、没有触摸），所以这份测试钉的是「改法还在不在源码里」。
// 每一条都对应一件用户点过名、或者在 360 / 390 / 430 三个宽度上真量过的事：
//
//   ① 习惯页：一件一行绝不折行，加习惯走右下角那颗 ＋（用户：「那个加号被遮住了是什么问题」）
//   ② 「加一个习惯」那张纸：新建 / 编辑一套件，删除按两下
//   ③ 四象限：手机上自己一页，桌面上还是「计划」里的一个 tab
//   ④ 「更多」：习惯撤了（它已经在底部导航上），换成四象限
//   ⑤ 「随手记」这个词在手机端一处不剩，但那份数据一条没少
//   ⑥ 自由伸缩：新写的布局里没有会撑破 360 的固定宽度
//   ⑦ 桌面一个像素不许变
//
// 样式只能用 node:fs 读：vitest 默认不处理 CSS，`import x from "a.css?raw"` 读回来是空串，
// 那样断言会变成对着空字符串「全过」。类型见 tests/node-fs.d.ts。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

const habitsSource = read("src/views/Habits.tsx");
const habitSheetSource = read("src/mobile/HabitSheet.tsx");
const quadrantSource = read("src/views/Quadrant.tsx");
const planSource = read("src/views/Plan.tsx");
const moreSource = read("src/views/MobileMore.tsx");
const shellSource = read("src/mobile/MobileShell.tsx");
const sheetStoreSource = read("src/mobile/sheetStore.ts");
const iconsSource = read("src/mobile/icons.tsx");
const appSource = read("src/App.tsx");
const storeSource = read("src/core/store.ts");
const pagesCss = read("src/styles/mobile-pages.css");
const shellCss = read("src/styles/mobile-shell.css");
const mobileCss = read("src/styles/mobile.css");

/** 仓库里 CRLF / LF 混着用，断言不许把行尾当内容的一部分 */
const nl = (s: string) => s.replace(/\r\n/g, "\n");
/** 写给后人的注释里出现什么都不算数，看的是真代码 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/.*$/gm, "");

/** 手机分支那一段（从 isMobile 分叉起，到桌面那份 .view-body 之前） */
function mobileBranch(src: string, until: string): string {
  const a = nl(src).indexOf("{isMobile ? (");
  const b = nl(src).indexOf(until);
  expect(a, "找不到 isMobile 分支").toBeGreaterThan(-1);
  expect(b, `找不到 ${until}`).toBeGreaterThan(a);
  return nl(src).slice(a, b);
}

describe("① 习惯页：一件一行，绝不折行", () => {
  const branch = mobileBranch(habitsSource, '<div className="view-body hb-body">');

  it("手机那份正文是自己的一块，不再借桌面那套 .hb-body", () => {
    expect(branch).toContain('<div className="view-body mhb-body">');
    // 一组一张卡，跟「今天」同一个形制
    expect(branch).toContain('<div className="mcard mhb-card">');
    expect(branch).toContain("<MobileHabitRow");
  });

  it("那张「输入框 + 周期下拉 + 加上」的卡只留给桌面（390px 上它被折成两行半）", () => {
    expect(branch).not.toContain('className="hb-add"');
    expect(branch).not.toContain("hb-add-rule");
    // 桌面那一整块一个字没动
    const desk = nl(habitsSource).slice(nl(habitsSource).indexOf('<div className="view-body hb-body">'));
    expect(desk).toContain('<div className="hb-add">');
    expect(desk).toContain("加上");
    expect(desk).toContain('className="input hb-add-rule"');
  });

  it("桌面那张卡的「失焦即提交」那道闸还在（commit-guards 钉着的那一条）", () => {
    expect(habitsSource).toContain("onBlur={(e) => {");
    const blur = habitsSource.slice(habitsSource.indexOf("onBlur={(e) => {"));
    expect(blur.indexOf("document.hasFocus()")).toBeLessThan(blur.indexOf("create();"));
  });

  it("一行是「圈 · 名字 + 小字 · 最近七天」，中间那块 flex:1 + min-width:0 + 省略号", () => {
    expect(habitsSource).toContain('className="mhb-main"');
    expect(habitsSource).toContain('className="mhb-title"');
    expect(habitsSource).toContain('className="mhb-meta"');
    expect(habitsSource).toContain('className="mhb-dots"');
    const main = pagesCss.slice(pagesCss.indexOf(".mshell .mhb-main {"), pagesCss.indexOf(".mshell .mhb-title {"));
    expect(main).toContain("flex: 1;");
    expect(main).toContain("min-width: 0;");
    for (const cls of [".mshell .mhb-title {", ".mshell .mhb-meta {"]) {
      const seg = pagesCss.slice(pagesCss.indexOf(cls), pagesCss.indexOf(cls) + 260);
      expect(seg, cls).toContain("white-space: nowrap;");
      expect(seg, cls).toContain("text-overflow: ellipsis;");
      expect(seg, cls).toContain("max-width: 100%;");
    }
  });

  it("小字是「周期 · 🔥 连续」，连续为 0 就不摆那颗火", () => {
    expect(habitsSource).toContain("describeHabitRule(habit)");
    expect(habitsSource).toContain("{n > 0 && <span className=\"mhb-streak\"> · 🔥 {n}</span>}");
  });

  it("今天该做的圈可点，今天不用做的按不动", () => {
    expect(habitsSource).toContain("disabled={!due}");
    expect(habitsSource).toContain("toggleHabitCheck(habit.id, today)");
    expect(pagesCss).toContain(".mshell .mhb-cb:disabled { opacity: .45; }");
  });

  it("最近 7 天：右起第一个是今天，做过的实心，今天套一圈虚线", () => {
    expect(habitsSource).toContain("function recentMarks(");
    expect(habitsSource).toContain("for (let i = 6; i >= 0; i--)");
    expect(habitsSource).toContain("addDays(today, -i)");
    expect(pagesCss).toContain(".mshell .mhb-dot.on { background: var(--accent); }");
    expect(pagesCss).toContain("outline: 1px dashed var(--ink-3);");
    // 一个 8px、间距 6px
    const dots = pagesCss.slice(pagesCss.indexOf(".mshell .mhb-dots {"), pagesCss.indexOf(".mshell .mhb-dot {"));
    expect(dots).toContain("gap: 6px;");
    expect(pagesCss).toContain("width: 8px;");
  });

  it("点一行 = 拉出那张纸改这个习惯；桌面那个内嵌展开面板手机上不用", () => {
    expect(habitsSource).toContain('openSheet({ kind: "habit", id: habit.id })');
    expect(branch).not.toContain("HabitDetail");
    expect(branch).not.toContain("expandedId");
  });

  it("分组标题跟今天页一个样（.group-head），两组的口径没变", () => {
    expect(branch).toContain('<div className="group-head">今天要做的 {doneCount}/{dueToday.length}</div>');
    expect(branch).toContain('<div className="group-head">今天不用做</div>');
  });

  it("空态是一张卡一句话，指的是右下角那颗 ＋", () => {
    expect(branch).toContain('<div className="mcard mhb-blank">');
    expect(branch).toContain("需要反复做的事放在这里，每天打卡。点右下角的 ＋ 加一个。");
  });
});

describe("② 「加一个习惯」那张纸", () => {
  it("抽屉栈里多了一种：没 id 是新建，有 id 是改那一个", () => {
    expect(sheetStoreSource).toContain('| { kind: "habit"; id?: string };');
    expect(habitSheetSource).toContain('const open = top?.kind === "habit";');
    // 换一个习惯要重开一份草稿，否则上一个的名字会串过来
    expect(habitSheetSource).toContain('key={id ?? "new"}');
  });

  it("周期胶囊复用全仓那一份 RULE_CHOICES，不在手机上另抄一遍", () => {
    expect(habitsSource).toContain("export const RULE_CHOICES");
    expect(habitSheetSource).toContain('import { RULE_CHOICES } from "../views/Habits";');
    // 现有周期不在预设里（比如从任务转过来的「每月 8 号」）也得看得见、也不许被悄悄改掉
    expect(habitSheetSource).toContain("describeHabitRule(habit)");
  });

  it("落库走现成的 store 动作，不另写一条", () => {
    for (const fn of ["addHabit", "setHabitRepeat", "updateTask", "deleteTasks"]) {
      expect(habitSheetSource, fn).toContain(fn);
    }
    expect(habitSheetSource).toContain('placeholder="比如「喝水 2L」"');
    expect(habitSheetSource).toContain('{editing ? "保存" : "加上"}');
  });

  it("删除按两下（手机上没有右键，也没有「刚才那下是不是点歪了」的余地）", () => {
    expect(habitSheetSource).toContain("const [confirming, setConfirming] = useState(false);");
    expect(habitSheetSource).toContain("删除这个习惯");
    expect(habitSheetSource).toContain("真的删掉");
    // deleteTasks 是软删，说的得是它真做的那件事
    expect(habitSheetSource).toContain("进回收站，30 天内能捞回来");
  });

  it("App 把这张纸挂上了树，而且只在手机上挂", () => {
    const hosts = appSource.slice(appSource.indexOf("{isMobile && ("), appSource.indexOf("<LoginPageHost />"));
    expect(hosts).toContain("<HabitSheetHost />");
  });
});

describe("③ 四象限：手机上自己一页", () => {
  it("ViewId 里多了 quadrant，桌面上它等价于计划", () => {
    expect(storeSource).toContain('"quadrant"');
    expect(appSource).toContain('case "quadrant": return isMobile ? <Quadrant key={bodyKey} /> : <Plan key={bodyKey} />;');
  });

  it("手机上自己带顶栏 + 返回，桌面上还是只画格子", () => {
    expect(nl(stripComments(quadrantSource))).toMatch(
      /if \(isMobile\) \{\s*return \(\s*<section className="main">\s*<MobileHead/,
    );
    expect(quadrantSource).toContain('onBack={() => navigate("today")}');
    expect(quadrantSource).toContain("search={false}");
    expect(quadrantSource).toContain("return board;");
  });

  it("手机的「计划」永远是列表，那对 tab 不画；桌面那对一个字没动", () => {
    expect(planSource).toContain('const tab = isMobile ? "list" : tabPick;');
    expect(planSource).toContain("{!isMobile && (");
    expect(planSource).toContain('onClick={() => pickTab("quad")}>四象限</button>');
    expect(planSource).toContain("<QuadrantBoard />");
  });

  it("单列四段那套还在 quadrant.css 的窄屏块里（这份没动它，只补手感）", () => {
    const quadCss = read("src/styles/quadrant.css");
    expect(quadCss).toContain("@media (max-width: 760px)");
    expect(quadCss).toContain("grid-template-columns: 1fr;");
    expect(pagesCss).toContain(".mshell .quad-row {");
    expect(pagesCss).toContain("min-height: var(--m-touch, 44px);");
  });
});

describe("④ 「更多」：习惯撤了，换成四象限", () => {
  it("四格是 日历 / 四象限 / 统计 / 回收站", () => {
    for (const v of ["calendar", "quadrant", "stats", "trash"]) {
      expect(moreSource, v).toContain(`navigate("${v}")`);
    }
    // 习惯已经钉在底部导航上，同一个入口不摆两遍
    expect(moreSource).not.toContain('navigate("habits")');
    expect(moreSource).not.toContain("IcoHabits");
    expect(moreSource).toContain("<IcoQuad />");
    expect(moreSource).toContain("按重要和紧急分四格");
  });

  it("四象限那颗图标跟其它几颗同一套笔画（24 网格、1.8 描边，不是 emoji）", () => {
    const ico = iconsSource.slice(iconsSource.indexOf("export function IcoQuad"), iconsSource.indexOf("export function IcoStats"));
    expect(ico).toContain("<Ico size={size}>");
    expect(ico.match(/<rect /g)?.length).toBe(4);
    expect(iconsSource).toContain('viewBox="0 0 24 24"');
  });

  it("四格一样高：文案长短不一，不该有一格看着比别的重要", () => {
    expect(pagesCss).toContain(".mshell .mmore-tiles { grid-auto-rows: 1fr; }");
    expect(pagesCss).toContain(".mshell .mmore-tile { min-width: 0; }");
  });
});

describe("⑤ 「随手记」退场：词没了，数据一条没少", () => {
  it("手机端那几个件里一个都不剩", () => {
    for (const [name, p] of [
      ["更多", "src/views/MobileMore.tsx"],
      ["壳子", "src/mobile/MobileShell.tsx"],
      ["记一条", "src/mobile/QuickAddSheet.tsx"],
      ["任务详情", "src/mobile/TaskSheet.tsx"],
      ["动作单", "src/mobile/ActionSheet.tsx"],
      ["清单设置", "src/mobile/ListSettingsSheet.tsx"],
      ["加一个习惯", "src/mobile/HabitSheet.tsx"],
      ["图标", "src/mobile/icons.tsx"],
    ] as const) {
      expect(read(p), name).not.toContain("随手记");
    }
  });

  it("换上的说法说的都是「清单」这件事本身", () => {
    expect(read("src/mobile/QuickAddSheet.tsx")).toContain("先不分清单");
    expect(read("src/mobile/TaskSheet.tsx")).toContain("没有清单");
    expect(read("src/mobile/TaskSheet.tsx")).toContain("不放进清单");
    expect(read("src/mobile/ActionSheet.tsx")).toContain("移出清单");
    expect(read("src/mobile/ListSettingsSheet.tsx")).toContain("会变成没有清单");
  });

  it("那支笔的图标没人用了，跟着删掉（留着就是一颗没人认领的死代码）", () => {
    expect(iconsSource).not.toContain("IcoInbox");
  });

  it("🔴 数据语义原样：没归清单的事照常存在，ListView 那一份算法一个字没动", () => {
    expect(read("src/views/ListView.tsx")).toContain("!t.done && !t.droppedAt && !t.listId && !t.due");
    expect(read("src/core/model.ts")).toContain("null = 随手记");
  });
});

describe("⑥ 自由伸缩：360 宽也放得下", () => {
  it("新样式里没有会撑破 360 的固定宽度（只有小圆点和图标那种小件是定死的）", () => {
    const widths = [...pagesCss.matchAll(/(?<!min-|max-)width:\s*(\d+)px/g)].map((m) => Number(m[1]));
    for (const w of widths) expect(w, `${w}px`).toBeLessThanOrEqual(44);
  });

  it("尺度全从 mobile.css 那套 --m-* 变量来，而且都带回退值", () => {
    for (const v of ["--m-row-h", "--m-cb", "--m-touch"]) {
      expect(pagesCss, v).toContain(`var(${v},`);
    }
    // 样式那一版新加的几个 token 也接上了：那边调完观感，这几页自动跟上
    for (const v of ["--m-card-shadow", "--m-cb-border", "--m-cb-bw", "--m-sep"]) {
      expect(pagesCss, v).toContain(`var(${v},`);
    }
    // --m-cb-border 是**颜色**不是 border 简写：写成 `border: var(--m-cb-border)` 时
    // border-style 默认 none，打卡圈会整个消失（实测过，一度只剩打了卡的那几个看得见）
    expect(pagesCss).toContain("border: var(--m-cb-bw, 1.6px) solid var(--m-cb-border, var(--ink-3));");
    expect(mobileCss).toContain("--m-cb-border: var(--hair);");
    expect(mobileCss).toContain("--m-cb-bw:");
    expect(mobileCss).toContain("--m-row-h:");
    expect(mobileCss).toContain("--m-touch:");
  });

  it("颜色只用主题 token，一个十六进制都没有", () => {
    expect([...pagesCss.matchAll(/#[0-9A-Fa-f]{3,8}\b/g)]).toEqual([]);
    expect(pagesCss.split(/\r?\n/).filter((l: string) => /\b(rgb|hsl)a?\(/.test(l))).toEqual([]);
  });

  it("时长只认 --dur-* 和 --ease", () => {
    const lines = pagesCss.split(/\r?\n/).filter((l: string) => /\b(transition|animation):/.test(l));
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) {
      expect(line, line.trim()).toMatch(/var\(--dur-[12]\)/);
      expect(line, line.trim()).toMatch(/var\(--ease\)/);
    }
  });
});

describe("⑦ 桌面一个像素不许变", () => {
  it("新样式整份都锁在 .mshell / 抽屉里，一条都跑不到桌面上", () => {
    const rules = pagesCss
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("}")
      .map((chunk: string) => chunk.slice(chunk.lastIndexOf("\n") >= 0 ? 0 : 0, chunk.indexOf("{")).trim())
      .filter((sel: string) => sel.length > 0 && !sel.startsWith("@"));
    for (const sel of rules) {
      // 选择器要么带 .mshell（只有手机壳子里成立），要么是抽屉里那几个 .mhs-（抽屉只在手机上挂）
      expect(sel.includes(".mshell") || sel.includes(".mhs"), sel).toBe(true);
    }
  });

  it("旧的那几份样式一个字没改（要盖就在新文件里用更具体的选择器盖）", () => {
    // 习惯页桌面那套、四象限桌面那套都还在原处
    expect(read("src/styles/habits.css")).toContain(".hb-add");
    expect(shellCss).toContain(".mshell .hb-add,");
    expect(read("src/styles/quadrant.css")).toContain(".quad-grid {");
  });

  it("桌面路由 / 桌面顶栏没有被手机这一轮碰到", () => {
    // 四象限在桌面上仍然由 Plan 摆标题栏
    expect(planSource).toContain('<div className="view-head">');
    expect(habitsSource).toContain('<div className="view-head">');
    // 习惯页桌面那套展开面板还在
    expect(habitsSource).toContain("function HabitDetail(");
    expect(habitsSource).toContain("转成普通任务");
  });
});
