// v1.14.1 · 手机上的两件事：底部导航「已完成 ↔ 四象限」对调，以及「更多」页里
// 清单 / 需求方**按住一行就能拖着换顺序**。
//
// 分三路钉：
//   ① 换位置这件事要换干净 —— 导航上是四象限、「更多」里是已完成，
//      两边都不许留下过时的图标 import / 过时的入口 / 反了的返回箭头
//      （动了入口就要全局扫一遍：第一轮漏掉的正是页头那颗箭头）
//   ② 长按换顺序的新逻辑 —— readSortKey（认得出「这一行是谁」）和 eatNextClick
//      （排完序那一下 click 要吞掉，否则松手就跳进这张清单），都是真跑
//   ③ 整条手势在真 React 里跑一遍 —— 按住 → 到点拎起来 → 挪到另一行 → 松手落位，
//      落库调的是 store 那个现成的重排函数，松手那一下不许变成点击
//
// 样式只能用 node:fs 读：vitest 默认不处理 CSS，`import x from "a.css?raw"` 读回来是空串，
// 那样断言会变成对着空字符串「全过」。类型见 tests/node-fs.d.ts。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { act, createElement as h, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LONG_PRESS_MS, eatNextClick, readSortKey, useLongPressSort } from "../src/core/touchSort";

const read = (p: string) => readFileSync(p, "utf8");

/** 注释里写了什么不算数——这份测试钉的是真代码。切注释是因为下面「不许出现 onBack」
 *  那两条正好要从注释里读到「不带返回箭头」这几个字，不切就自己把自己钉红了 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const shellSource = read("src/mobile/MobileShell.tsx");
const moreSource = read("src/views/MobileMore.tsx");
const sidebarSource = read("src/components/Sidebar.tsx");
const storeSource = read("src/core/store.ts");
const appSource = read("src/App.tsx");
const pagesCss = read("src/styles/mobile-pages.css");

// ══════════════════════════════════════════════════════════════════════════
// ① 已完成 ↔ 四象限：换干净，不留下半个旧入口
// ══════════════════════════════════════════════════════════════════════════

/** src 底下所有 .tsx，用来做「全仓只有一处」这类扫描 */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** 从 `import { … } from "…/icons"` 里把图标名字读出来，再返回 import 之后的正文 */
function icons(src: string): { names: string[]; body: string } {
  const m = src.match(/import\s*\{([^}]+)\}\s*from\s*"[^"]*icons";/);
  if (!m) return { names: [], body: src };
  return {
    names: m[1].split(",").map((s) => s.trim()).filter(Boolean),
    body: src.slice((m.index ?? 0) + m[0].length),
  };
}

describe("① 底部导航：四象限上来，已完成收进「更多」", () => {
  it("常驻那格现在是四象限，已完成一个字都不留在导航里", () => {
    const tabs = shellSource.slice(shellSource.indexOf("const TABS = ["), shellSource.indexOf("] as const;"));
    expect([...tabs.matchAll(/id: "(\w+)"/g)].map((m) => m[1])).toEqual(["today", "habits", "plan", "quadrant"]);
    expect(tabs).toContain("Icon: IcoQuad");
    expect(tabs).not.toContain('id: "done"');
    expect(tabs).not.toContain("已完成");
  });

  it("「更多」那四宫格换成 日历 / 已完成 / 统计 / 回收站，四象限不再摆两遍", () => {
    for (const v of ["calendar", "done", "stats", "trash"]) {
      expect(moreSource, v).toContain(`navigate("${v}")`);
    }
    expect(moreSource).not.toContain('navigate("quadrant")');
    expect(moreSource).toContain("<IcoDone size={24} />");
  });

  it("🔴 换了入口就把死图标一起带走：这两个文件里 import 进来的图标都还在用", () => {
    // 上一轮的教训（用户点名）：入口挪走了，旧图标 / 旧注释还赖在原处。
    // 这条不是只盯 IcoDone / IcoQuad，是把两个文件的图标 import 整个对一遍。
    for (const [name, src] of [["MobileShell", shellSource], ["MobileMore", moreSource]] as const) {
      const { names, body } = icons(src);
      expect(names.length, name).toBeGreaterThan(0);
      for (const ico of names) expect(body, `${name} 里的 ${ico}`).toContain(ico);
    }
    // 点名钉死这一轮换掉的那两个：换过去了就不能还留在原处
    expect(icons(shellSource).names).not.toContain("IcoDone");
    expect(icons(moreSource).names).not.toContain("IcoQuad");
  });

  it("＋ 跟着换位置走：四象限页有，已完成页没有", () => {
    const noFab = shellSource.slice(shellSource.indexOf("const NO_FAB"), shellSource.indexOf("export default function MobileShell"));
    expect(noFab).toContain('"done"');
    expect(noFab).not.toContain('"quadrant"');
  });

  it("全仓只有一处定义底部那五格，不存在第二张过时的表", () => {
    const files = walk("src").filter((f) => read(f).includes("const TABS = ["));
    expect(files).toEqual(["src/mobile/MobileShell.tsx"]);
  });

  it("「更多」页那句副标题跟着格子改了口（还写着四象限就是骗人）", () => {
    expect(moreSource).toContain("日历、已完成、清单，和你的账号");
    expect(moreSource).not.toContain("日历、四象限、清单");
  });

  // ── 换位置真正难扫干净的那一处：页头那颗返回箭头 ──
  //
  // 「有没有返回箭头」在这个 App 里不是各页的自由，是**这一页从哪儿来**决定的：
  //   · 底部导航那几格 = 常驻的地方，你随时就在那儿，没有「回去」这回事 → 不画箭头
  //   · 「更多」四宫格点进去的 = 子页 → 画箭头，否则进去了没有明显的路回来
  // 四象限和已完成这一轮正好互换了身份，两页的箭头就都反了。第一轮只扫了图标 import
  // 和注释，没扫页头——所以这两条按**规矩**钉，不按当时那两个文件钉：以后谁再动导航，
  // 忘了改页头一样会红。
  it("🔴 底部导航那几页都不画返回箭头（常驻页没有「回去」这回事）", () => {
    const tabs = shellSource.slice(shellSource.indexOf("const TABS = ["), shellSource.indexOf("] as const;"));
    const ids = [...tabs.matchAll(/id: "(\w+)"/g)].map((m) => m[1]);
    expect(ids.length).toBe(4);
    for (const id of ids) {
      // 从 App.tsx 那张路由表反查这一格画的是谁：手机上是 `isMobile ? <A /> : <B />` 的取 A
      const line = appSource.split("\n").find((l) => l.includes(`case "${id}":`));
      expect(line, id).toBeTruthy();
      const comp = (line as string).match(/isMobile \? <(\w+)|return <(\w+)/);
      const name = comp?.[1] ?? comp?.[2];
      expect(name, id).toBeTruthy();
      expect(stripComments(read(`src/views/${name}.tsx`)), `${id} → ${name}.tsx`).not.toContain("onBack");
    }
  });

  it("🔴 反过来：「更多」里点进去的四页都画返回箭头，一页都不能漏", () => {
    // 回收站走的是 ListView（kind="trash"），跟清单页共用一个文件
    for (const [tile, file] of [
      ["日历", "src/views/Calendar.tsx"],
      ["已完成", "src/views/Done.tsx"],
      ["统计", "src/views/StatsView.tsx"],
      ["回收站", "src/views/ListView.tsx"],
    ] as const) {
      expect(stripComments(read(file)), tile).toContain('onBack={() => navigate("today")}');
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ② 长按换顺序的两块新逻辑
// ══════════════════════════════════════════════════════════════════════════

describe("② readSortKey：一行上写着的「我是谁」", () => {
  it("认得出同一张表里的行", () => {
    expect(readSortKey("list", "list:abc")).toBe("abc");
    expect(readSortKey("who", "who:小明")).toBe("小明");
  });

  it("🔴 清单拖不到需求方头上去，反过来也一样", () => {
    expect(readSortKey("list", "who:小明")).toBeNull();
    expect(readSortKey("who", "list:abc")).toBeNull();
  });

  it("名字里带冒号也不会被切坏（清单名是用户随便起的）", () => {
    expect(readSortKey("list", "list:a:b")).toBe("a:b");
    expect(readSortKey("who", "who:研发:一组")).toBe("研发:一组");
  });

  it("空的 / 没有这个属性 / 只有前缀，一律当没压着东西", () => {
    expect(readSortKey("list", null)).toBeNull();
    expect(readSortKey("list", undefined)).toBeNull();
    expect(readSortKey("list", "")).toBeNull();
    expect(readSortKey("list", "list:")).toBeNull();
    expect(readSortKey("list", "listx:abc")).toBeNull();
  });
});

describe("② eatNextClick：排完序松手那一下点击要吞掉", () => {
  let seen = 0;
  const count = () => { seen += 1; };

  beforeEach(() => {
    seen = 0;
    vi.useFakeTimers();
    document.body.addEventListener("click", count);
  });
  afterEach(() => {
    document.body.removeEventListener("click", count);
    vi.useRealTimers();
  });

  const click = () => document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));

  it("🔴 吞掉紧接着那一下：换完位置不许顺带跳进这张清单", () => {
    eatNextClick();
    click();
    expect(seen).toBe(0);
  });

  it("只吞一下——下一次好端端的点击照常生效", () => {
    eatNextClick();
    click();
    click();
    expect(seen).toBe(1);
  });

  it("🔴 那一下 click 压根没来（手指抬在空处）也要自己撤掉，否则界面就成了「点不动」", () => {
    eatNextClick(400);
    vi.advanceTimersByTime(401);
    click();
    expect(seen).toBe(1);
  });

  it("返回的撤销函数能提前摘掉监听（组件卸载时要用）", () => {
    const off = eatNextClick();
    off();
    click();
    expect(seen).toBe(1);
    off(); // 再调一次不许炸
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ③ 整条手势在真 React 里跑一遍
// ══════════════════════════════════════════════════════════════════════════

/** 一张两行的小表，行为跟「更多」页那两张一模一样：既能点开，也能按住换位置 */
function Rows({ onDrop, onOpen }: { onDrop: (a: string, b: string) => void; onOpen: (id: string) => void }) {
  const [over, setOver] = useState<string | null>(null);
  const sort = useLongPressSort("list", onDrop, { over, set: setOver });
  return h(
    "div",
    null,
    ["a", "b"].map((id) =>
      h(
        "button",
        {
          key: id,
          id,
          className: `mli${sort.lifted(id) ? " lifted" : ""}${over === `list:${id}` ? " move-over" : ""}`,
          onClick: () => onOpen(id),
          ...sort.props(id),
        },
        id,
      ),
    ),
  );
}

describe("③ 按住 → 拎起来 → 挪一行 → 松手落位", () => {
  let host: HTMLDivElement;
  let root: Root;
  let drops: [string, string][];
  let opens: string[];
  const realFromPoint = document.elementFromPoint;

  /** jsdom 没有布局，命中测试只能自己摆：y 大于 50 就当手指压在第二行上 */
  function fakeHitTest() {
    (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint =
      (_x, y) => host.querySelector(y > 50 ? "#b" : "#a");
  }

  function fire(el: Element, type: string, x = 0, y = 0) {
    act(() => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
    });
  }

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    drops = [];
    opens = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    fakeHitTest();
    root = createRoot(host);
    act(() => {
      root.render(h(Rows, { onDrop: (a, b) => drops.push([a, b]), onOpen: (id) => opens.push(id) }));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    (document as unknown as { elementFromPoint: unknown }).elementFromPoint = realFromPoint;
    vi.useRealTimers();
  });

  const row = (id: string) => host.querySelector(`#${id}`) as HTMLElement;

  it("每一行都带着「我是谁」，前缀分得开两张表", () => {
    expect(row("a").getAttribute("data-sort")).toBe("list:a");
    expect(row("b").getAttribute("data-sort")).toBe("list:b");
  });

  it("🔴 按住到点，这一行浮起来（不浮起来用户不知道自己已经拎住了东西）", () => {
    fire(row("a"), "pointerdown", 0, 0);
    expect(row("a").className).not.toContain("lifted");
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 10); });
    expect(row("a").className).toContain("lifted");
  });

  it("🔴 挪到另一行头上，那一行画出落点；松手真的换了位置", () => {
    fire(row("a"), "pointerdown", 0, 0);
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 10); });
    fire(row("a"), "pointermove", 0, 80);
    expect(row("b").className).toContain("move-over");
    fire(row("a"), "pointerup", 0, 80);
    expect(drops).toEqual([["a", "b"]]);
    // 落完位一切归零：没有行还浮着，也没有落点线赖着不走
    expect(host.innerHTML).not.toContain("lifted");
    expect(host.innerHTML).not.toContain("move-over");
  });

  it("🔴 松手不许顺带跳进那一行（拖完那一下 click 被吞掉）", () => {
    fire(row("a"), "pointerdown", 0, 0);
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 10); });
    fire(row("a"), "pointermove", 0, 80);
    fire(row("a"), "pointerup", 0, 80);
    fire(row("b"), "click");
    expect(opens).toEqual([]);
  });

  it("拎起来又放回原处（没挪到别人头上）：不换位置，但那一下 click 一样吞掉", () => {
    fire(row("a"), "pointerdown", 0, 0);
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 10); });
    fire(row("a"), "pointerup", 0, 0);
    expect(drops).toEqual([]);
    fire(row("a"), "click");
    expect(opens).toEqual([]);
  });

  it("🔴 没按够时长就抬手 = 普通点击，照常进这张清单", () => {
    fire(row("a"), "pointerdown", 0, 0);
    act(() => { vi.advanceTimersByTime(100); });
    fire(row("a"), "pointerup", 0, 0);
    fire(row("a"), "click");
    expect(drops).toEqual([]);
    expect(opens).toEqual(["a"]);
  });

  it("🔴 按下就往下滑 = 在滚页面，不许变成排序", () => {
    fire(row("a"), "pointerdown", 0, 0);
    fire(row("a"), "pointermove", 0, 60);
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 10); });
    expect(row("a").className).not.toContain("lifted");
    fire(row("a"), "pointerup", 0, 60);
    expect(drops).toEqual([]);
  });

  it("鼠标不走这套（桌面上有 HTML5 拖拽，两套手势不许同时上）", () => {
    act(() => {
      row("a").dispatchEvent(
        Object.assign(new MouseEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0 }), { pointerType: "mouse" }),
      );
    });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 10); });
    expect(row("a").className).not.toContain("lifted");
  });

  it("手势被系统打断（来电 / 多指），状态清干净不留半截", () => {
    fire(row("a"), "pointerdown", 0, 0);
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 10); });
    fire(row("a"), "pointermove", 0, 80);
    fire(row("a"), "pointercancel", 0, 80);
    expect(host.innerHTML).not.toContain("lifted");
    expect(host.innerHTML).not.toContain("move-over");
    fire(row("a"), "pointerup", 0, 80);
    expect(drops).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ④ 接线：手势和落库都不在手机上另写一套
// ══════════════════════════════════════════════════════════════════════════

describe("④ 「更多」页接的是现成的那一套", () => {
  it("🔴 落库调 store 的 moveList / moveWho，手机上一个字都不自己写库", () => {
    expect(moreSource).toContain('const listSort = useLongPressSort("list", moveList, moveHint);');
    expect(moreSource).toContain('const whoSort = useLongPressSort("who", moveWho, moveHint);');
    expect(moreSource).toMatch(/import \{[\s\S]*?moveList, moveWho[\s\S]*?\} from "\.\.\/core\/store";/);
    for (const bad of ["updateSettings(", "mutate(", "appStore.setState"]) {
      expect(moreSource, bad).not.toContain(bad);
    }
  });

  it("🔴 清单的顺序进撤销栈、需求方的顺序是本机设置——两者语义不同，不许混", () => {
    const ml = storeSource.slice(storeSource.indexOf("export function moveList"), storeSource.indexOf("export function moveWho"));
    const mw = storeSource.slice(storeSource.indexOf("export function moveWho"), storeSource.indexOf("export function setListColor"));
    // 清单：走 mutate（压撤销栈）+ 一句回执，Ctrl+Z 撤的就是这一下
    expect(ml).toContain("mutate(");
    expect(ml).toContain('toast: "清单顺序已调整"');
    expect(ml).not.toContain("skipUndo");
    // 需求方：存进设置，每台设备各排各的
    expect(mw).toContain("updateSettings({ whoOrder: next })");
    expect(mw).not.toContain("mutate(");
  });

  it("两张表都接上了手势，且原来的「点开」还在", () => {
    expect(moreSource).toContain("{...listSort.props(l.id)}");
    expect(moreSource).toContain("{...whoSort.props(who)}");
    expect(moreSource).toContain("listSort.lifted(l.id)");
    expect(moreSource).toContain("whoSort.lifted(who)");
    expect(moreSource).toContain('navigate("list", { listId: l.id })');
    expect(moreSource).toContain('navigate("who", { who })');
  });

  it("标签那张表不给拖：标签顺序本来就是算出来的，拖了也存不住", () => {
    const tagBlock = moreSource.slice(moreSource.indexOf('<div className="group-head">标签'));
    expect(tagBlock).not.toContain(".props(");
    expect(tagBlock).not.toContain("mgroup-hint");
  });

  it("🔴 得有一句话告诉人这件事存在（手机上没有鼠标可以「试着拖一下」）", () => {
    const hints = [...moreSource.matchAll(/<span className="mgroup-hint">([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(hints).toEqual(["按住可换位置", "按住可换位置"]);
    // 讲人话，不带工程词
    for (const t of hints) expect(t).not.toMatch(/拖拽|排序|drag|sort|随手记/i);
  });

  it("桌面侧栏一个字没动：它那套 HTML5 拖拽和落库还在原处", () => {
    expect(sidebarSource).toContain('reorderProps("list"');
    expect(sidebarSource).toContain('reorderProps("who"');
    expect(sidebarSource).toContain('useLongPressSort("list"');
    expect(sidebarSource).toContain('useLongPressSort("who"');
    expect(sidebarSource).toContain("draggable");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ⑤ 长相：只画在手机上，颜色和时长都走 token
// ══════════════════════════════════════════════════════════════════════════

describe("⑤ 拎起来的样子", () => {
  // 结尾那个锚点必须连着分隔线一起找：光写「加一个习惯」那张纸的话，
  // 文件头那行总目录里也有这几个字，切出来会是一段空的（然后下面全对着空串「全过」）
  const block = pagesCss.slice(
    pagesCss.indexOf("「更多」里清单 / 需求方按住换位置"),
    pagesCss.indexOf("═══════════ 「加一个习惯」那张纸"),
  );
  const sels = [...block.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)]
    .flatMap((m) => m[1].split(","))
    .map((s) => s.trim())
    .filter(Boolean);

  it("这一段确实在（切错了的话下面全是对着空串「全过」）", () => {
    expect(block.length).toBeGreaterThan(300);
  });

  it("被拎起来的行浮起来，落点线画在目标行上缘（跟「挪到它前面」对得上）", () => {
    expect(block).toMatch(/\.mli\.lifted\s*\{[^}]*var\(--accent-soft\)/);
    expect(block).toMatch(/\.mli\.lifted\s*\{[^}]*box-shadow:\s*var\(--shadow\)/);
    expect(block).toMatch(/\.mli\.move-over\s*\{[^}]*inset 0 2px 0 var\(--accent\)/);
  });

  it("🔴 改手机不连累桌面：这一段里每条选择器都锁在 .mshell 底下", () => {
    expect(sels.length).toBeGreaterThanOrEqual(4);
    for (const s of sels) expect(s, s).toContain(".mshell");
  });

  it("颜色只用主题 token，时长只用 --dur-1 / --ease", () => {
    const OK = new Set([
      "--card", "--bg", "--ink", "--ink-2", "--ink-3", "--accent", "--accent-soft",
      "--on-accent", "--hair", "--warn", "--ok", "--shadow", "--dur-1", "--dur-2", "--ease",
    ]);
    for (const m of block.matchAll(/var\((--[\w-]+)\)/g)) expect(OK.has(m[1]), m[1]).toBe(true);
    expect(block).toContain("var(--dur-1) var(--ease)");
    expect(block).not.toMatch(/\d+\s*ms/);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(block).not.toMatch(/rgba?\(/);
  });

  it("排序中别让长按顺手选中文字、或弹出系统那张复制菜单", () => {
    expect(block).toContain("user-select: none");
    expect(block).toContain("-webkit-touch-callout: none");
  });

  // 拖不动的行不该为排序买单：标签那张表和「新建清单」都没有 data-sort，
  // 裸 .mli 会把它们一起罩进过渡里——按下去的那点反馈从瞬时变成 120ms 的淡入，白慢半拍
  it("🔴 过渡只加在能拖的那两张表上，罩不到标签行和「新建清单」", () => {
    expect(block).toContain(".mshell .mli[data-sort] {");
    expect(block).not.toMatch(/^\.mshell \.mli \{/m);
    // 那两张表的行确实带着 data-sort（不然这条选择器等于选了个空）
    expect(moreSource).toContain("{...listSort.props(l.id)}");
    expect(moreSource).toContain("{...whoSort.props(who)}");
  });
});
