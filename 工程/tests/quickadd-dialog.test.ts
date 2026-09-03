// v1.11.2 · 桌面：「随手记」这个视图退场，换成侧栏一颗「＋ 记一条」+ 居中弹窗。
//
// 用户原话（2026-09-03）：「电脑上随手记其实就是等于手机上那个加号，
// 事实上电脑版都可以用加号＋弹窗输入替代掉随手记，也更符合我说的『现代感』」。
//
// 这一份钉三件事：
//   ① 开关走 store（侧栏按钮 / Ctrl+1 / 命令面板三个入口同一个口，不许各记各的）
//   ② 「随手记」这个视图没有桌面入口了，但 ViewId 一个字没删——老设置里存着 "inbox"
//      的照样开得起来（落到「计划」），这是产品原则：永不拒绝用户的老数据
//   ③ 桌面界面上不再有「随手记」这个词
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { defaultData, newTask } from "../src/core/model";
import { addList, appStore, deleteList, setQuickAddOpen } from "../src/core/store";
import appSource from "../src/App.tsx?raw";
import sidebarSource from "../src/components/Sidebar.tsx?raw";
import dialogSource from "../src/components/QuickAddDialog.tsx?raw";
import paletteSource from "../src/components/CommandPalette.tsx?raw";
import searchSource from "../src/components/SearchOverlay.tsx?raw";
import ctxMenuSource from "../src/components/ContextMenu.tsx?raw";
import taskCardSource from "../src/components/TaskCard.tsx?raw";
import guideSource from "../src/components/GuideContent.tsx?raw";
import settingsSource from "../src/views/Settings.tsx?raw";

// 样式只能用 node:fs 读：vitest 不处理 CSS，`import x from "a.css?raw"` 读回来是空串
const appCss = readFileSync("src/styles/app.css", "utf8");
const dialogCss = readFileSync("src/styles/quickadd-dialog.css", "utf8");

/** 去掉行注释和块注释：只判「界面上出现的词」，源码里交代来龙去脉的注释不算 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function reset() {
  localStorage.clear();
  appStore.setState({
    data: { ...defaultData(), lists: [], tasks: [] },
    loaded: true,
    loadError: null,
    ui: {
      view: "today", listId: null, who: null, tag: null,
      expandedId: null, selectedIds: [], searchOpen: false, paletteOpen: false, toast: null,
      ctxMenu: null, foldAll: false, foldExcept: [], changelogOpen: false, quickAddOpen: false,
    },
    focus: { taskId: null, running: false, endsAt: null, totalMinutes: 0 },
    undoDepth: 0,
  });
}
beforeEach(reset);

describe("开关只有一个口：三个入口都走 store 的 quickAddOpen", () => {
  const ui = () => appStore.getState().ui;

  it("默认关着", () => {
    expect(ui().quickAddOpen).toBe(false);
  });

  it("setQuickAddOpen 开得了也关得掉", () => {
    setQuickAddOpen(true);
    expect(ui().quickAddOpen).toBe(true);
    setQuickAddOpen(false);
    expect(ui().quickAddOpen).toBe(false);
  });

  it("已经是那个状态就一个字节都不写（免得白白惊动一圈订阅者）", () => {
    const before = ui();
    setQuickAddOpen(false);
    expect(appStore.getState().ui).toBe(before);
  });

  it("三个入口（侧栏按钮 / Ctrl+1 / 命令面板）调的是同一个函数", () => {
    expect(sidebarSource).toContain("setQuickAddOpen(true)");
    expect(appSource).toContain("setQuickAddOpen(true)");
    expect(paletteSource).toContain("setQuickAddOpen(true)");
  });
});

describe("侧栏：「随手记」那个导航项没了，顶上是一颗「＋ 记一条」", () => {
  const side = stripComments(sidebarSource);

  it("导航项连同它的拖拽落点一起撤了", () => {
    expect(side).not.toContain('item("inbox"');
    // 它原来是唯一一个「拖过来清掉日期」的落点，那条路也跟着没了
    expect(side).not.toContain("dropDue(e, ids, null)");
  });

  it("那颗按钮在品牌行和 <nav> 之间，也就是「今天」上面", () => {
    const brandAt = side.indexOf('className="brand"');
    const btnAt = side.indexOf('className="side-quickadd"');
    const navAt = side.indexOf("<nav>");
    expect(btnAt).toBeGreaterThan(brandAt);
    expect(btnAt).toBeLessThan(navAt);
    expect(side).toContain("记一条");
  });

  it("它不是导航项：不 navigate、不给选中态、也不收抽屉", () => {
    const btn = side.slice(
      side.indexOf('className="side-quickadd"'),
      side.indexOf("<nav>"),
    );
    expect(btn).not.toContain("navigate(");
    expect(btn).not.toContain("onNavigate");
    expect(btn).not.toContain("view ===");
  });

  it("没人用的那个计数（counts.inbox）也删了", () => {
    expect(side).not.toContain("counts.inbox");
    expect(side).not.toContain("inbox:");
    // 剩下四个角标一个没动
    for (const k of ["today:", "plan:", "trash:", "habits:"]) expect(side).toContain(k);
  });

  it("样式按方案给的那套：整行宽、36px 高、圆角 10、accent 底", () => {
    const rule = appCss.slice(appCss.indexOf(".side-quickadd {"));
    const body = rule.slice(0, rule.indexOf("}"));
    expect(body).toContain("width: 100%;");
    expect(body).toContain("height: 36px;");
    expect(body).toContain("border-radius: 10px;");
    expect(body).toContain("background: var(--accent);");
    expect(body).toContain("color: var(--on-accent);");
    expect(appCss).toContain(".side-quickadd:hover");
  });
});

describe("弹窗本身", () => {
  it("正文就是原来那条 QuickAddBar，输入体验一个字没改（补全 / 点选 / 用法页）", () => {
    expect(dialogSource).toContain("<QuickAddBar withPickers autoFocus");
    expect(dialogSource).toContain("useGuideEntry");
    expect(dialogSource).toContain("{guide.sheet}");
  });

  it("回车记下一条之后**不关窗**：连着记几条不用重开", () => {
    const onAdded = dialogSource.slice(dialogSource.indexOf("onAdded={"));
    expect(onAdded.slice(0, 80)).not.toContain("setQuickAddOpen(false)");
    expect(dialogSource).toContain("连着记几条不用重开");
  });

  it("记下一条有回执（不是 toast——记一条不需要反悔，只需要被看见）", () => {
    expect(dialogSource).toContain("useCommitFlash");
    expect(dialogSource).toContain('flash.on ? " lit" : ""');
    expect(dialogCss).toContain(".qad-body.lit .quick-add");
    // 那个「✓」是 SyntaxInput 自己带的，这儿不许再画一个（同一件事说两遍）
    expect(dialogSource).not.toContain("<CommitMark");
  });

  it("三条关窗的路都在：Esc / × / 点遮罩", () => {
    expect(dialogSource).toMatch(/e\.key !== "Escape"[\s\S]{0,200}setQuickAddOpen\(false\)/);
    expect(dialogSource).toContain('aria-label="关闭"');
    expect(dialogSource).toMatch(/onMouseDown[\s\S]{0,120}e\.target === e\.currentTarget[\s\S]{0,60}setQuickAddOpen\(false\)/);
  });

  it("Esc 不许往外冒泡：外面那条全局键会顺手清掉选中和展开", () => {
    expect(dialogSource).toContain("e.stopPropagation();");
  });

  it("打开就把光标送进输入框", () => {
    expect(dialogSource).toContain("autoFocus");
    expect(dialogSource).toContain('.querySelector<HTMLElement>(".quick-add input, .quick-add textarea")?.focus()');
  });

  it("遮罩和外壳复用现有那套（.overlay / .modal），不另起一套弹窗体系", () => {
    expect(dialogSource).toContain('className="overlay qad-back"');
    expect(dialogSource).toContain('className="modal qad-modal"');
    expect(dialogCss).toContain("width: min(92vw, 640px);");
    expect(dialogCss).toContain("border-radius: 16px;");
    // .modal 默认 overflow:hidden，那排「点着选」的小菜单是垂下来的，一裁就只剩半个
    expect(dialogCss).toContain("overflow: visible;");
    // .modal 默认 min-width 480，窄窗口下会把卡片顶出屏幕
    expect(dialogCss).toContain("min-width: 0;");
  });

  it("同一个动作只摆一个「?」：输入框行尾那颗藏起来，留标题行上那颗", () => {
    expect(dialogSource).toContain('className="qad-help"');
    expect(dialogCss).toContain(".qad-body .qa-help { display: none; }");
  });

  it("挂在 App 上而不是 Sidebar 里（侧栏带 transform，会把 fixed 弹窗关在抽屉里）", () => {
    expect(appSource).toContain("{!isMobile && quickAddOpen && <QuickAddDialog />}");
    expect(sidebarSource).not.toContain("<QuickAddDialog");
    expect(sidebarSource).not.toContain('from "./QuickAddDialog"');
  });
});

describe("快捷键：Ctrl+1 记一条，Ctrl+2~5 还是切视图", () => {
  it("Ctrl+1 开弹窗，不再是跳「随手记」", () => {
    expect(appSource).toMatch(/mod && e\.key === "1"[\s\S]{0,120}setQuickAddOpen\(true\)/);
  });

  it("Ctrl+2~5 一格不错位：今天 / 习惯 / 计划 / 已完成", () => {
    expect(appSource).toContain('/^[2-5]$/.test(e.key)');
    expect(appSource).toContain('navigate((["today", "habits", "plan", "done"] as const)[Number(e.key) - 2]);');
  });

  it("设置页里那句提示跟着改了口（全局小窗叫「记一条」）", () => {
    expect(settingsSource).toContain("唤起「记一条」小窗");
  });
});

describe("「随手记」这个视图退场，但 ViewId 一个字没删（老数据永远读得进来）", () => {
  it("ViewId 里 inbox 还在——老设置存着它，读到不能崩", () => {
    expect(readFileSync("src/core/store.ts", "utf8")).toContain('| "inbox" | "today"');
  });

  it("桌面路由落到「计划」，手机那一页照旧（跟四象限同一个写法）", () => {
    expect(appSource).toContain(
      'case "inbox": return isMobile ? <ListView key={bodyKey} kind="inbox" /> : <Plan key={bodyKey} />',
    );
  });

  it("正看着一张清单时把它删了，人落在「计划」上（不再落进一个没有入口的视图）", () => {
    const id = addList("要删的", "green");
    const s = appStore.getState();
    appStore.setState({
      data: { ...s.data, tasks: [{ ...newTask({ title: "里面的事" }), listId: id }] },
      ui: { ...s.ui, view: "list", listId: id },
    });
    deleteList(id);
    expect(appStore.getState().ui.view).toBe("plan");
    // 里面的事一件都没丢，只是不归清单了
    const t = appStore.getState().data.tasks.find((x) => x.title === "里面的事")!;
    expect(t.listId).toBe(null);
    expect(t.deletedAt).toBeFalsy();
    // 那句 toast 说的就是它真做的这件事，不再叫「移回随手记」
    expect(appStore.getState().ui.toast?.msg).toBe("清单已删除，1 件事变成没有清单");
  });

  it("空清单删掉就一句「清单已删除」，不报一个 0 出来", () => {
    const id = addList("空的", "moss");
    deleteList(id);
    expect(appStore.getState().ui.toast?.msg).toBe("清单已删除");
  });

  it("「随手记」这一页要是还被搜索结果落到，标题也说人话了", () => {
    expect(readFileSync("src/views/ListView.tsx", "utf8"))
      .toContain('title: "还没有清单的事"');
  });

  it("搜索结果里「没日期也没清单」的事，家改在「计划」", () => {
    expect(searchSource).not.toContain('navigate("inbox")');
    expect(stripComments(searchSource)).toContain('navigate("plan")');
  });

  it("命令面板里那一项从「跳过去」换成了「记一条」（开弹窗）", () => {
    expect(paletteSource).not.toContain('["inbox"');
    expect(paletteSource).toContain('label: "记一条"');
  });
});

describe("🔴 桌面界面上一个「随手记」都不许剩", () => {
  // 注释可以留（它交代的是这一版为什么这么改），界面上出现的词一个不留
  for (const [name, src] of [
    ["主窗外壳", appSource],
    ["侧栏", sidebarSource],
    ["记一条弹窗", dialogSource],
    ["命令面板", paletteSource],
    ["全局搜索", searchSource],
    ["右键菜单", ctxMenuSource],
    ["任务卡", taskCardSource],
    ["用法说明", guideSource],
    ["设置页", settingsSource],
  ] as const) {
    it(`${name}`, () => {
      expect(stripComments(src), name).not.toContain("随手记");
    });
  }

  it("换的词各就各位：菜单里是动作，属性上是状态", () => {
    // 「移到清单 ▸」下面那一项是个动作
    expect(appSource).toContain(">移出清单<");
    expect(ctxMenuSource).toContain("移出清单");
    // 任务卡上那颗药丸显示的是「这件事现在归哪」，是个状态
    expect(taskCardSource).toContain('"未分清单"');
    // 导出的 CSV / Markdown 里那一组也是状态
    expect(settingsSource).toContain('"未分清单"');
  });
});
