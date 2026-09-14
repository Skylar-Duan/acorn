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
// v1.15.0 改了这件事的做法（用户：「像 notability 一样可以真的把这个卡片拖着到处跑，
// 拖到下面其他位置，其他卡片自动上移」）：落点不再是「在目标行上缘画一条线」，
// 而是卡片跟着手指走、其余的行实时让位，空出来的那一格就是落点。
// 于是这份测试多了一节 ②′ ——**几何那几个纯函数**。为什么必须是纯函数：
// jsdom 里 getBoundingClientRect 一律返回 0，「拖到第几格」挂在钩子上根本测不出来。
//
// 样式只能用 node:fs 读：vitest 默认不处理 CSS，`import x from "a.css?raw"` 读回来是空串，
// 那样断言会变成对着空字符串「全过」。类型见 tests/node-fs.d.ts。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  EDGE_PX, EDGE_STEP_PX, LIFT_SCALE, LONG_PRESS_MS, type RowBox,
  clampDy, dropKeyOf, eatNextClick, edgeScroll, readSortKey, settleDy, shiftOf, slotOf, useCardSort,
} from "../src/core/touchSort";
import { dur1 } from "../src/core/motion";
import { addList, appStore, moveList } from "../src/core/store";
import { defaultData } from "../src/core/model";

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
// ②′ 拖动的几何：卡片走到哪儿算第几格（v1.15.0）
//
// 这一节钉的是「其他卡片自动上移」那套算法本身。它必须是纯函数：jsdom 没有布局，
// getBoundingClientRect 一律返回 0，挂在钩子上跑是永远测不出算错了的。
// 一张三行的表，每行 60 高，上沿 0 / 60 / 120——下面全按这张表说话。
// ══════════════════════════════════════════════════════════════════════════

const H = 60;
/** n 行的一张表，每行 60 高、紧挨着 */
const table = (n: number): RowBox[] =>
  Array.from({ length: n }, (_, i) => ({ key: "abcdef"[i], top: i * H, height: H }));

describe("②′ slotOf：卡片跟着手指走了这么远，它该排第几格", () => {
  it("没挪动就还在自己那一格", () => {
    expect(slotOf(table(3), 0, 0)).toBe(0);
    expect(slotOf(table(3), 1, 0)).toBe(1);
    expect(slotOf(table(3), 2, 0)).toBe(2);
  });

  it("🔴 手指和落点是 1:1 的：走满一行的距离才换一格（越过下一行的中线那一刻）", () => {
    const t = table(3);
    expect(slotOf(t, 0, H - 1)).toBe(0); // 还差一点，没越过 b 的中线
    expect(slotOf(t, 0, H + 1)).toBe(1); // 越过了，b 让开
    expect(slotOf(t, 0, H * 2 + 1)).toBe(2);
  });

  it("往上拖同理，方向反过来", () => {
    const t = table(3);
    expect(slotOf(t, 2, -(H - 1))).toBe(2);
    expect(slotOf(t, 2, -(H + 1))).toBe(1);
    expect(slotOf(t, 2, -(H * 2 + 1))).toBe(0);
  });

  it("拖过头也出不了这张表（格子数就那么多）", () => {
    const t = table(3);
    expect(slotOf(t, 0, 9999)).toBe(2);
    expect(slotOf(t, 2, -9999)).toBe(0);
  });

  it("🔴 一路拖到表尾 / 表头，真的够得着最后一格和第一格", () => {
    // 真机上手指走多远都先过 clampDy：卡片被拦在最后一行的位置上，两条中线正好压在一起。
    // 这一刀切成「没过」的话，最后那一格就永远够不着——拖到底松手却停在倒数第二格
    const t = table(3);
    expect(slotOf(t, 0, clampDy(t, 0, 9999))).toBe(2);
    expect(slotOf(t, 2, clampDy(t, 2, -9999))).toBe(0);
  });
});

describe("②′ shiftOf：其余的行往哪边让一格", () => {
  it("🔴 往下拖：被越过的那些行往上顶，其余的站着不动", () => {
    // [a b c]，a 拖到第 1 格：b 顶上去，c 不动
    expect(shiftOf(0, 0, 1)).toBe(0); // 拎着的那张自己不算
    expect(shiftOf(1, 0, 1)).toBe(-1);
    expect(shiftOf(2, 0, 1)).toBe(0);
  });

  it("🔴 往上拖：让出位置的那些行往下退", () => {
    // [a b c]，c 拖到第 0 格：a、b 一起往下退一格
    expect(shiftOf(0, 2, 0)).toBe(1);
    expect(shiftOf(1, 2, 0)).toBe(1);
    expect(shiftOf(2, 2, 0)).toBe(0);
  });

  it("原地没动，谁都不用让", () => {
    for (const j of [0, 1, 2]) expect(shiftOf(j, 1, 1)).toBe(0);
  });
});

describe("②′ dropKeyOf：落库那句话怎么说", () => {
  // store 那两个函数的说法是「把 A 挪到 B **前面**」。所以「b 让开一格、a 站进去」
  // 这件事，落库时说的是「a 排到 c 前面」——同一件事的两种说法，别看着以为算错了
  it("落在中间：说的是「排到再下一行前面」", () => {
    expect(dropKeyOf(table(3), 0, 1)).toBe("c");
    expect(dropKeyOf(table(3), 2, 0)).toBe("a");
    expect(dropKeyOf(table(3), 2, 1)).toBe("b");
  });

  it("🔴 落在最后一格：没有「谁」可言，给 null（store 认这一档 = 排到队尾）", () => {
    // 不认这一档的话，卡片能一路拖到队尾、松手却停在倒数第二格，看着就像没拖动
    expect(dropKeyOf(table(3), 0, 2)).toBeNull();
    expect(dropKeyOf(table(4), 1, 3)).toBeNull();
  });
});

describe("②′ clampDy：拖到表头表尾就停住", () => {
  it("🔴 卡片永远出不了这张表（落点也就永远在本表内）", () => {
    const t = table(3);
    expect(clampDy(t, 0, 9999)).toBe(H * 2); // 最多走到最后一行的位置
    expect(clampDy(t, 0, -9999)).toBe(0); // 第一行往上顶到头就是原地
    expect(clampDy(t, 2, -9999)).toBe(-H * 2);
    expect(clampDy(t, 1, 5)).toBe(5); // 中间随便走
  });

  it("表里只有一行 / 量歪了，一律当没挪动，别把卡片甩出去", () => {
    expect(clampDy(table(1), 0, 80)).toBe(0);
    expect(clampDy(table(3), 9, 80)).toBe(0);
  });
});

describe("②′ settleDy：松手那一下，卡片飞回哪儿", () => {
  it("往下落：接在让开的最后一行下面", () => {
    expect(settleDy(table(3), 0, 1)).toBe(H);
    expect(settleDy(table(3), 0, 2)).toBe(H * 2);
  });

  it("往上落：占的就是落点那一行原来的位置", () => {
    expect(settleDy(table(3), 2, 0)).toBe(-H * 2);
    expect(settleDy(table(3), 2, 1)).toBe(-H);
  });

  it("没换格就飞回原位（松手弹回去，什么都没发生）", () => {
    expect(settleDy(table(3), 1, 1)).toBe(0);
  });
});

describe("②′ edgeScroll：手指贴到上下两头，列表自己慢慢滚", () => {
  // 可视区 0…600
  it("中间那一大片不滚", () => {
    expect(edgeScroll(300, 0, 600)).toBe(0);
  });

  it("🔴 贴上沿往上滚、贴下沿往下滚，越贴边越快", () => {
    const near = edgeScroll(600 - EDGE_PX + 10, 0, 600);
    const edge = edgeScroll(600, 0, 600);
    expect(near).toBeGreaterThan(0);
    expect(edge).toBeGreaterThan(near);
    expect(edgeScroll(EDGE_PX - 10, 0, 600)).toBeLessThan(0);
  });

  it("再快也就这么快——「慢慢滚」是用户要的，滚快了看不清落在哪儿", () => {
    expect(edgeScroll(99999, 0, 600)).toBe(EDGE_STEP_PX);
    expect(edgeScroll(-99999, 0, 600)).toBe(-EDGE_STEP_PX);
  });

  it("可视区太矮就干脆不滚：上下两截边缘叠在一起，表会在原地抖", () => {
    expect(edgeScroll(50, 0, 100)).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ③ 整条手势在真 React 里跑一遍
// ══════════════════════════════════════════════════════════════════════════

/** 一张三行的小表，行为跟「更多」页那两张一模一样：既能点开，也能按住拎起来换位置 */
function Rows({ onDrop, onOpen }: { onDrop: (a: string, b: string | null) => void; onOpen: (id: string) => void }) {
  const sort = useCardSort("list", onDrop);
  return h(
    "div",
    { className: `mcard${sort.active ? " sorting" : ""}`, ref: sort.box },
    ["a", "b", "c"].map((id) =>
      h(
        "button",
        {
          key: id,
          id,
          className: `mli${sort.cls(id)}`,
          style: sort.style(id),
          onClick: () => onOpen(id),
          ...sort.props(id),
        },
        id,
      ),
    ),
  );
}

describe("③ 按住 → 拎起来 → 卡片跟着手指走 → 松手落位", () => {
  let host: HTMLDivElement;
  let root: Root;
  let drops: [string, string | null][];
  let opens: string[];
  const realRect = Element.prototype.getBoundingClientRect;

  /** jsdom 没有布局，三行的位置只能自己摆：每行 60 高，上沿 0 / 60 / 120 */
  function fakeLayout() {
    const top: Record<string, number> = { a: 0, b: 60, c: 120 };
    Element.prototype.getBoundingClientRect = function rect(this: Element) {
      const y = top[(this as HTMLElement).id] ?? 0;
      return { x: 0, y, top: y, bottom: y + H, left: 0, right: 0, width: 300, height: H, toJSON: () => ({}) } as DOMRect;
    };
  }

  function fire(el: Element, type: string, x = 0, y = 0) {
    act(() => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
    });
  }

  /** 按住到点：这一行被拎起来了 */
  function lift(id: string, y = 0) {
    fire(row(id), "pointerdown", 0, y);
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 10); });
  }

  /** 松手之后卡片还要飞回格子里，飞完才落库——把这一程也走完 */
  function land() {
    act(() => { vi.advanceTimersByTime(dur1() + 10); });
  }

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    drops = [];
    opens = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    fakeLayout();
    root = createRoot(host);
    act(() => {
      root.render(h(Rows, { onDrop: (a, b) => drops.push([a, b]), onOpen: (id) => opens.push(id) }));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    Element.prototype.getBoundingClientRect = realRect;
    vi.useRealTimers();
  });

  const row = (id: string) => host.querySelector(`#${id}`) as HTMLElement;
  const card = () => host.firstElementChild as HTMLElement;
  const shift = (id: string) => row(id).getAttribute("style") ?? "";

  it("每一行都带着「我是谁」，前缀分得开两张表", () => {
    expect(row("a").getAttribute("data-sort")).toBe("list:a");
    expect(row("b").getAttribute("data-sort")).toBe("list:b");
  });

  it("🔴 按住到点，这一行浮起来（不浮起来用户不知道自己已经拎住了东西）", () => {
    fire(row("a"), "pointerdown", 0, 0);
    expect(row("a").className).not.toContain("lifted");
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 10); });
    expect(row("a").className).toContain("lifted");
    // 拎起来的那张要放大一点点，装它的卡也不能再裁切（否则投影被切掉半圈）
    expect(shift("a")).toContain(`scale(${LIFT_SCALE})`);
    expect(card().className).toContain("sorting");
  });

  it("🔴 卡片贴着手指走，其余的行实时让位（这就是落点，不再画线）", () => {
    lift("a");
    fire(row("a"), "pointermove", 0, 70);
    expect(shift("a")).toContain("translateY(70px)"); // 走多远就是多远，不打折
    expect(shift("b")).toContain("translateY(-60px)"); // b 自动上移一行
    expect(shift("c")).not.toContain("translateY"); // 没轮到它，站着不动
    // 画线那一套整条撤了
    expect(host.innerHTML).not.toContain("move-over");
  });

  it("🔴 松手真的换了位置：说的是「排到 c 前面」= 就是「b 让开一格」这件事", () => {
    lift("a");
    fire(row("a"), "pointermove", 0, 70);
    fire(row("a"), "pointerup", 0, 70);
    land();
    expect(drops).toEqual([["a", "c"]]);
    // 落完位一切归零：没有行还浮着，也没有谁还挂着位移
    expect(host.innerHTML).not.toContain("lifted");
    expect(shift("b")).not.toContain("translateY");
  });

  it("🔴 一路拖到表尾就是真的排到最后一个（store 认 null 这一档）", () => {
    lift("a");
    fire(row("a"), "pointermove", 0, 999);
    // 拖到表尾就停住：卡片出不了这张表，最多走到最后一行的位置
    expect(shift("a")).toContain("translateY(120px)");
    fire(row("a"), "pointerup", 0, 999);
    land();
    expect(drops).toEqual([["a", null]]);
  });

  it("🔴 拖的整个过程一次都不写数据（写了会把撤销栈和云同步刷爆）", () => {
    lift("a");
    for (const y of [20, 40, 61, 80, 100, 130]) fire(row("a"), "pointermove", 0, y);
    expect(drops).toEqual([]);
    fire(row("a"), "pointerup", 0, 130);
    expect(drops).toEqual([]); // 卡片还在飞回格子里，这会儿也还没写
    land();
    expect(drops).toHaveLength(1); // 只落这一次
  });

  it("🔴 松手不许顺带跳进那一行（拖完那一下 click 被吞掉）", () => {
    lift("a");
    fire(row("a"), "pointermove", 0, 70);
    fire(row("a"), "pointerup", 0, 70);
    fire(row("b"), "click");
    land();
    expect(opens).toEqual([]);
  });

  it("拎起来又放回原处（没换格）：不写库，但那一下 click 一样吞掉", () => {
    lift("a");
    fire(row("a"), "pointermove", 0, 10);
    fire(row("a"), "pointerup", 0, 10);
    land();
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
    land();
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

  it("手势被系统打断（来电 / 多指），卡片原样放回去，一个字都不落库", () => {
    lift("a");
    fire(row("a"), "pointermove", 0, 70);
    fire(row("a"), "pointercancel", 0, 70);
    expect(host.innerHTML).not.toContain("lifted");
    expect(shift("b")).not.toContain("translateY");
    fire(row("a"), "pointerup", 0, 70);
    land();
    expect(drops).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ④ 接线：手势和落库都不在手机上另写一套
// ══════════════════════════════════════════════════════════════════════════

describe("④ 「更多」页接的是现成的那一套", () => {
  it("🔴 落库调 store 的 moveList / moveWho，手机上一个字都不自己写库", () => {
    // v1.15.0 起接的是 useCardSort（真拖动那一版），落库仍旧是这两个现成的函数：
    // 换的是手感，不是「顺序存在哪儿」这件事
    expect(moreSource).toContain('const listSort = useCardSort("list", moveList);');
    expect(moreSource).toContain('const whoSort = useCardSort("who", moveWho);');
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
    expect(moreSource).toContain("listSort.cls(l.id)");
    expect(moreSource).toContain("whoSort.cls(who)");
    expect(moreSource).toContain('navigate("list", { listId: l.id })');
    expect(moreSource).toContain('navigate("who", { who })');
  });

  it("🔴 位移写在行内 style 上，装表的那张卡拖动中让出 ref 和 sorting", () => {
    // 每一行各走各的距离，样式表里写不出来；而 .mcard 自己 overflow: hidden，
    // 不在拖动中放开的话，浮起来那张的投影会被切掉半圈
    for (const s of ["listSort", "whoSort"]) {
      expect(moreSource, s).toContain(`style={${s}.style(`);
      expect(moreSource, s).toContain(`ref={${s}.box}`);
      expect(moreSource, s).toContain(`${s}.active ? " sorting" : ""`);
    }
    // 落点线那一套（moveOver 那个 state）整条撤了
    expect(moreSource).not.toContain("move-over");
    expect(moreSource).not.toContain("moveOver");
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

  it("🔴 「排到最后一个」这一档真的成立：落点给 null = 拖到队尾", () => {
    // 没有这一档的话，卡片能一路拖过最后一行、松手却停在倒数第二格——看着就像没拖动。
    // store 那句话是「把 A 挪到 B 前面」，队尾没有「B」可言，只能靠 null 表达
    localStorage.clear();
    appStore.setState({ ...appStore.getState(), data: { ...defaultData(), lists: [], tasks: [] } });
    const a = addList("甲", "sage");
    const b = addList("乙", "sage");
    addList("丙", "sage");
    const order = () => [...appStore.getState().data.lists].sort((x, y) => x.order - y.order).map((l) => l.name);
    expect(order()).toEqual(["甲", "乙", "丙"]);
    moveList(a, null);
    expect(order()).toEqual(["乙", "丙", "甲"]);
    // 原来那一档照旧：给一个真名字就是「排到它前面」
    moveList(a, b);
    expect(order()).toEqual(["甲", "乙", "丙"]);
    // 需求方走的是同一个 moveBefore，null 这一档两张表共用
    expect(storeSource).toContain("const to = overId === null ? next.length : next.indexOf(overId);");
    expect(storeSource).toContain("export function moveWho(dragName: string, overName: string | null)");
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

  it("被拎起来的那张浮出纸面：变色、带投影、四角圆起来（它这会儿是捏在手里的一张卡）", () => {
    expect(block).toMatch(/\.mli\.lifted\s*\{[^}]*var\(--accent-soft\)/);
    expect(block).toMatch(/\.mli\.lifted\s*\{[^}]*box-shadow:\s*var\(--shadow\)/);
    expect(block).toMatch(/\.mli\.lifted\s*\{[^}]*border-radius:\s*var\(--m-card-radius/);
    // 装它的那张卡拖动中不能再裁切，否则投影被切掉半圈
    expect(block).toContain(".mshell .mcard.sorting { overflow: visible; }");
  });

  // v1.15.0 换掉的正是这一条：原来「在目标行上缘画一条落点线」（.move-over），
  // 现在落点是**其余的行让出来的那一格**。两套说法不能并存——画着线又让着位，
  // 等于同一件事说了两遍，而且线和空位还会指向不同的地方
  it("🔴 落点线整条撤了：位置由「让出来的空位」自己说清楚", () => {
    // 扫的是规则本身，不扫注释——注释里那句「.move-over 整条撤掉」正是在交代这件事
    expect(pagesCss.replace(/\/\*[\s\S]*?\*\//g, "")).not.toContain("move-over");
  });

  // 🔴 这条曾经只扫「.mli.lifted 那一条规则的文本里没有 transform」，钉不住真正要命的事：
  // .mshell .mli[data-sort] 和 .mshell .mli.lifted **权重一样重**（各三个类），同重比先后。
  // v1.15.0 里 [data-sort] 写在后面，于是被拎起的那一行最终还是吃到了 120ms 的 transform 过渡——
  // 手指快划时卡片吊在后面几十像素，停手才滑过来对齐，「像 notability 那样把卡片拖着跑」就废了。
  // 所以下面不扫单条文本，改成**照 CSS 的规矩算一遍谁赢**（先比权重、同重比谁写在后面）。
  /** 算一条选择器的权重：这一段里没有 id 也没有伪元素，数「类 + 属性 + 伪类」就够 */
  const weigh = (sel: string) => (sel.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) ?? []).length;
  /**
   * 这一段里，一个「长按拎起来的可拖行」最终吃到的 transition 是哪一条。
   * 元素身上有的东西：.mli + .lifted + [data-sort]，外面套着 .mshell；**没有** .landing（还没松手）。
   */
  const winningTransition = () => {
    const HAS = new Set([".mli", ".lifted", "[data-sort]"]);
    const hits: { w: number; value: string }[] = [];
    for (const [, selGroup, body] of block.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const decl = [...body.matchAll(/(?:^|;)\s*transition\s*:([^;]*)/g)].pop();
      if (!decl) continue;
      for (const sel of selGroup.split(",").map((s) => s.trim()).filter(Boolean)) {
        if (!sel.includes(".mshell")) continue;
        const last = sel.split(/\s+/).pop() ?? "";         // 只有最后那一节要落在这个元素身上
        const parts = last.match(/\.[\w-]+|\[[^\]]+\]/g) ?? [];
        if (parts.length === 0 || !parts.every((p) => HAS.has(p))) continue; // .landing 那条在这儿被排掉
        hits.push({ w: weigh(sel), value: decl[1] });
      }
    }
    if (hits.length === 0) return null;
    // 先比权重、同重比谁写在后面：reduce 里 `>=` 就是「同重让后来的赢」
    return hits.reduce((a, b) => (b.w >= a.w ? b : a));
  };

  it("🔴 拎起来那张最终生效的 transition 里不许有 transform——位移跟着手指，加了过渡就拖在手指后面", () => {
    const win = winningTransition();
    expect(win, "一条都没匹配上，选择器写法变了？").not.toBeNull();
    // 这才是屏幕上真正生效的那一条：权重最高、同重里写在最后
    expect(win!.value, "被拎起的那一行吃到了 transform 过渡：卡片会吊在手指后面").not.toContain("transform");
    expect(win!.value).toContain("background");
    // 顺带钉住「为什么」：那条给别人让位用的 transform 过渡确实存在，而且**排在 .lifted 前面**
    const yield_ = block.indexOf(".mshell .mli[data-sort] {");
    const lift = block.indexOf(".mshell .mli.lifted {");
    expect(yield_).toBeGreaterThan(-1);
    expect(lift).toBeGreaterThan(-1);
    expect(yield_, "[data-sort] 那条被挪到 .lifted 后面了：同重比先后，它会盖掉 .lifted").toBeLessThan(lift);
    expect(block.slice(yield_, lift)).toContain("transition: transform var(--dur-1) var(--ease)");
    // 松手飞回格子的那一程反过来，必须有 transform 的过渡，不然是瞬移
    expect(block).toMatch(/\.mli\.lifted\.landing\s*\{[^}]*transition:[^;]*transform/);
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
