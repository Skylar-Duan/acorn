// 「点开一个，另一个自动收起」——PM 2026-09-05 的原话：
// 「卡片现代化，点开一个自动收缩另一个，包括版本日志、设置里面的卡片」。
//
// 这份钉三件事：
//   ① core/useFold 的**同组互斥**：传了同一个 group 的那几块自动成手风琴，
//      不传 group 的调用方（侧栏那几块）行为一个字不变
//   ② 版本日志弹窗「更早的版本」一次只摊开一条，开合有过渡而不是硬切
//   ③ 任务卡本来就是一次只摊开一张（ui.expandedId 是单值）——别被谁悄悄改成数组
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forceFoldOpen, useFold } from "../src/core/useFold";
import { nextOpenOlder } from "../src/components/ChangelogDialog";
import { appStore, expandTask } from "../src/core/store";
import { closeAllSheets, openSheet, sheetStore, topSheet } from "../src/mobile/sheetStore";
import foldSource from "../src/core/useFold.ts?raw";
import clSource from "../src/components/ChangelogDialog.tsx?raw";
import storeSource from "../src/core/store.ts?raw";
import taskSheetSource from "../src/mobile/TaskSheet.tsx?raw";

// 样式只能用 node:fs 读：vitest 不处理 CSS，`import x from "a.css?raw"` 读回来是空串，
// 断言就成了对着空字符串「全过」（同 mobile-layout.test 的做法，类型见 tests/node-fs.d.ts）
const overlaysCss = readFileSync("src/styles/overlays.css", "utf8");

/** 把注释剥掉再找字眼——不然「原来是 details」这种说明文字会被当成代码算数 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

// useFold 是个 hook，仓库不装 testing-library，就拿 react-dom 真渲染几个空组件把它接出来
// （act 是 React 18.3 自带的，跟 updater-android 那份同一个路子）。
// 关键是几块**在同一轮渲染里一起挂上来**——真页面就是这样，互斥要在这种时候也成立。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 设置页那些节用的前缀（侧栏是默认的 acorn-side-） */
const PREFIX = "acorn-set-";

let seq = 0;
/**
 * 每个用例发一套自己的组名与键名。
 *
 * 为什么不 vi.resetModules()：那会把 react 一起重新求值，一个进程里两份 react
 * 同时跑，hook 当场就废。useFold 里「谁占着这一组」是张模块级的表，
 * 用例之间名字不重就等于互不相干，比重置模块稳得多。
 */
function fresh() {
  const g = `grp${++seq}`;
  return { group: g, key: (name: string) => `${g}-${name}` };
}

interface Panel {
  name: string;
  initial?: boolean;
  group?: string;
  prefix?: string;
}

const roots: Root[] = [];

/** 一次挂起好几块，返回「现在谁开着」和「点一下第几块」 */
function mount(panels: Panel[], key: (name: string) => string) {
  const cells = new Map<string, [boolean, () => void]>();
  // 每一次渲染都记一笔：前 panels.length 笔就是挂载那一帧，用来钉「用户眼睛看到的第一帧」。
  // 只看 act 之后的结果是不够的——effect 里补收起来的话，这里照样是对的，
  // 而用户会看见一块自己收起来的那一下
  const frames: { name: string; open: boolean }[] = [];
  function Leaf({ p }: { p: Panel }) {
    const cell = useFold(key(p.name), p.initial ?? false, p.prefix ?? PREFIX, p.group);
    frames.push({ name: p.name, open: cell[0] });
    cells.set(p.name, cell);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => {
    root.render(
      createElement(Fragment, null, ...panels.map((p) => createElement(Leaf, { key: p.name, p }))),
    );
  });
  roots.push(root);
  return {
    open: (name: string) => cells.get(name)![0],
    toggle: (name: string) => act(() => { cells.get(name)![1](); }),
    /** 挂载那一帧谁摊着（不许靠 effect 补救） */
    firstFrame: () => frames.slice(0, panels.length).filter((f) => f.open).map((f) => f.name),
  };
}

/** 这一块在本机记忆里写的是什么（没写过是 null） */
function remembered(prefix: string, lsKey: string): string | null {
  return localStorage.getItem(`${prefix}${lsKey}`);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  act(() => {
    for (const r of roots) r.unmount();
  });
  roots.length = 0;
});

// ---------- ① 同组互斥 ----------

describe("同一组里一次只摊开一块", () => {
  it("点开第二块，第一块自己收起", () => {
    const { group, key } = fresh();
    const p = mount([{ name: "a", group }, { name: "b", group }], key);

    p.toggle("a");
    expect(p.open("a")).toBe(true);
    expect(p.open("b")).toBe(false);

    p.toggle("b");
    expect(p.open("b")).toBe(true);
    expect(p.open("a")).toBe(false);
  });

  it("被挤收起的那块，记忆也跟着改口——下次进来不会又是两块都摊着", () => {
    const { group, key } = fresh();
    const p = mount([{ name: "a", group }, { name: "b", group }], key);

    p.toggle("a");
    expect(remembered(PREFIX, key("a"))).toBe("1");
    p.toggle("b");
    expect(remembered(PREFIX, key("a"))).toBe("0");
    expect(remembered(PREFIX, key("b"))).toBe("1");
  });

  it("再点一下开着的那块 = 全收起来，之后随便开哪一块都行", () => {
    const { group, key } = fresh();
    const p = mount([{ name: "a", group }, { name: "b", group }], key);

    p.toggle("a");
    p.toggle("a");
    expect(p.open("a")).toBe(false);
    expect(p.open("b")).toBe(false);

    p.toggle("b");
    expect(p.open("b")).toBe(true);
  });

  it("老用户本机记着好几块都开着：进来只留排在最前面那一块", () => {
    // 手风琴之前设置页就是可以全摊着的，这些记录还躺在本机
    const { group, key } = fresh();
    localStorage.setItem(`${PREFIX}${key("a")}`, "1");
    localStorage.setItem(`${PREFIX}${key("b")}`, "1");
    localStorage.setItem(`${PREFIX}${key("c")}`, "1");

    const p = mount([{ name: "a", group }, { name: "b", group }, { name: "c", group }], key);
    expect([p.open("a"), p.open("b"), p.open("c")]).toEqual([true, false, false]);
    expect(remembered(PREFIX, key("b"))).toBe("0");
    expect(remembered(PREFIX, key("c"))).toBe("0");
  });

  it("一块按默认开着、另一块本机记着开着：第一帧就只有一块摊着", () => {
    // 2026-09-06 的现症：从 1.14.0 升上来的机器，「通用」是新加的一节（本机从没记过、
    // 按默认开），「数据」还留着上次摊开的记录——两块都判成开，用户看得见「通用」
    // 自己收起来的那一下。收起必须在第一帧之前就分完，不能靠 effect 补救
    const { group, key } = fresh();
    localStorage.setItem(`${PREFIX}${key("b")}`, "1");

    const p = mount([{ name: "a", initial: true, group }, { name: "b", group }], key);
    expect(p.firstFrame()).toEqual(["a"]);
    expect([p.open("a"), p.open("b")]).toEqual([true, false]);
    expect(remembered(PREFIX, key("b"))).toBe("0");
  });

  it("反过来排也一样：先到的先占位，后来的第一帧就是收着的", () => {
    const { group, key } = fresh();
    localStorage.setItem(`${PREFIX}${key("a")}`, "1");

    const p = mount([{ name: "a", group }, { name: "b", initial: true, group }], key);
    expect(p.firstFrame()).toEqual(["a"]);
    expect([p.open("a"), p.open("b")]).toEqual([true, false]);
  });

  it("不同组各管各的，一个组里的动作不会传到另一个组", () => {
    const one = fresh();
    const two = fresh();
    const p = mount([{ name: "a", group: one.group }], one.key);
    const q = mount([{ name: "a", group: two.group }], two.key);

    p.toggle("a");
    q.toggle("a");
    expect(p.open("a")).toBe(true);
    expect(q.open("a")).toBe(true);
  });
});

// ---------- 不传 group 的调用方：一个字不变 ----------

describe("不分组的调用方（侧栏那几块）行为照旧", () => {
  it("想开几块开几块，互不影响", () => {
    const { key } = fresh();
    const p = mount([{ name: "a" }, { name: "b" }, { name: "c" }], key);

    p.toggle("a");
    p.toggle("b");
    expect([p.open("a"), p.open("b"), p.open("c")]).toEqual([true, true, false]);
  });

  it("本机记着都开着，进来就都开着（不会被谁挤掉）", () => {
    const { key } = fresh();
    localStorage.setItem(`${PREFIX}${key("a")}`, "1");
    localStorage.setItem(`${PREFIX}${key("b")}`, "1");

    const p = mount([{ name: "a" }, { name: "b" }], key);
    expect([p.open("a"), p.open("b")]).toEqual([true, true]);
    expect(remembered(PREFIX, key("b"))).toBe("1");
  });

  it("记忆的口径没变：键是 前缀+名字，值是 1 / 0", () => {
    const { key } = fresh();
    const p = mount([{ name: "a" }], key);
    p.toggle("a");
    expect(remembered(PREFIX, key("a"))).toBe("1");
    p.toggle("a");
    expect(remembered(PREFIX, key("a"))).toBe("0");
  });

  it("prefix 不传时默认还是 acorn-side-（登出清本机按 acorn- 前缀扫）", () => {
    const { key } = fresh();
    const cells = new Map<string, [boolean, () => void]>();
    function Leaf() {
      cells.set("a", useFold(key("a"), false));
      return null;
    }
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Leaf)));
    roots.push(root);
    act(() => { cells.get("a")![1](); });
    expect(localStorage.getItem(`acorn-side-${key("a")}`)).toBe("1");
  });
});

// ---------- forceFoldOpen：侧栏同步指示点一下要滚到「云账号」 ----------

describe("别处喊「把这一块打开」照常好使", () => {
  it("目标就在屏幕上：它开，同组别的收", () => {
    const { group, key } = fresh();
    const p = mount([{ name: "a", group }, { name: "b", group }], key);

    p.toggle("a");
    act(() => forceFoldOpen(key("b"), PREFIX));
    expect(p.open("b")).toBe(true);
    expect(p.open("a")).toBe(false);
    expect(remembered(PREFIX, key("a"))).toBe("0");
    expect(remembered(PREFIX, key("b"))).toBe("1");
  });

  it("目标那一页还没挂上来：挂载时它就是开着的那一块", () => {
    // 这正是「点侧栏的同步指示 → 跳设置页 → 滚到云账号」那条路：
    // 喊的时候设置页还没渲染，等它挂上来，云账号必须是摊开的那一块
    const { group, key } = fresh();
    localStorage.setItem(`${PREFIX}${key("a")}`, "1"); // 上次留在「外观」那一节
    forceFoldOpen(key("b"), PREFIX);

    const p = mount([{ name: "a", group }, { name: "b", group }], key);
    expect(p.open("b")).toBe(true);
    expect(p.open("a")).toBe(false);
  });

  it("被点名的那块排在后面：第一帧也不会两块一起摊着", () => {
    // 「点侧栏同步指示 → 跳设置页 → 滚到云账号」：云账号排在后面，
    // 排在它前面、本机记着开着的那一节必须在第一帧就已经收着了
    const { group, key } = fresh();
    localStorage.setItem(`${PREFIX}${key("a")}`, "1");
    forceFoldOpen(key("b"), PREFIX);

    const p = mount([{ name: "a", group }, { name: "b", group }], key);
    expect(p.firstFrame()).toEqual(["b"]);
    expect(remembered(PREFIX, key("a"))).toBe("0");
  });

  it("喊了却始终没挂载：那张占位条会过期，不会隔半天凭空抢走位子", () => {
    const { group, key } = fresh();
    localStorage.setItem(`${PREFIX}${key("a")}`, "1");
    forceFoldOpen(key("b"), PREFIX); // 目标那一页这一趟压根没渲染

    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    try {
      const p = mount([{ name: "a", group }, { name: "b", group }], key);
      // 过了保质期就当没喊过：还是「本机记着的、排在最前面的那块」说了算
      expect(p.firstFrame()).toEqual(["a"]);
      expect([p.open("a"), p.open("b")]).toEqual([true, false]);
    } finally {
      clock.mockRestore();
    }
  });

  it("不分组的目标照旧只是把自己打开，不碰别人", () => {
    const { key } = fresh();
    const p = mount([{ name: "a" }, { name: "b" }], key);

    p.toggle("a");
    act(() => forceFoldOpen(key("b"), PREFIX));
    expect(p.open("a")).toBe(true);
    expect(p.open("b")).toBe(true);
  });
});

describe("这套开合只是本机的界面记忆", () => {
  it("useFold 不碰 store，也就进不了撤销栈、跟不上云同步", () => {
    expect(foldSource).not.toMatch(/from "\.\/store"/);
    expect(foldSource).not.toContain("appStore");
    expect(foldSource).not.toContain("pushUndo");
  });

  it("头注释里写清了 group 怎么用（设置页那位同事照着传就行）", () => {
    expect(foldSource).toContain("useFold(key, initial, prefix, group?)");
  });

  it("分胜负那一步（claim）只动内存，渲染里不写本机记忆", () => {
    // claim 跑在 useState 初始化器里，也就是渲染期。写 localStorage 的活儿一律挪到 effect：
    // 并发渲染下被丢弃的那一次不该在本机留下记录
    const body = /function claim\([\s\S]*?\n}/.exec(foldSource)?.[0] ?? "";
    expect(body).toContain("take(group, lsKey)"); // 占位（内存）照旧
    expect(body).not.toContain("remember(");
    expect(body).not.toContain("localStorage.setItem");
  });
});

// ---------- ② 版本日志：更早的版本一次只摊开一条 ----------

describe("版本日志里更早的那些版本", () => {
  it("点开第二条时第一条自己收起，点已经开着的那条就是收起来", () => {
    expect(nextOpenOlder(null, "1.13.0")).toBe("1.13.0");
    expect(nextOpenOlder("1.13.0", "1.12.0")).toBe("1.12.0");
    expect(nextOpenOlder("1.12.0", "1.12.0")).toBeNull();
  });

  it("弹窗只记「现在摊开哪一版」一个值，不是每条各记各的", () => {
    expect(clSource).toContain("const [openVer, setOpenVer] = useState<string | null>(null)");
    expect(clSource).toContain("open={openVer === e.version}");
  });

  it("不再是原生 details——它的开合各管各的，也没有收起的中间态", () => {
    const code = codeOnly(clSource);
    expect(code).not.toContain("<details");
    expect(code).not.toContain("<summary");
    // 换成「按钮 + 一层只管高度的壳」，开合由外面那个 openVer 说了算
    expect(code).toContain('<button type="button" className="cl-old-btn" aria-expanded={open}');
    expect(code).toContain('<div className={`cl-old-fold${open ? "" : " shut"}`}>');
    // 样式里那几条 details 时代的选择器也得跟着走，留着就是永远不生效的死规则
    expect(overlaysCss).not.toContain(".cl-old[open]");
    expect(overlaysCss).not.toContain(".cl-old summary");
  });

  it("开合都有过渡，时长只认 token", () => {
    const fold = /^\.cl-old-fold \{[^}]*\}/m.exec(overlaysCss)?.[0] ?? "";
    expect(fold).toContain("grid-template-rows: 1fr");
    expect(fold).toContain("transition: grid-template-rows var(--dur-2) var(--ease)");
    const shut = /\.cl-old-fold\.shut \{[^}]*\}/.exec(overlaysCss)?.[0] ?? "";
    expect(shut).toContain("grid-template-rows: 0fr");
    // 收着的那条内容还在树上，不关掉命中与朗读的话，看不见的按钮照样能被 Tab 摸到
    expect(shut).toContain("visibility: hidden");
    // 两条 transition 必须写在一起：它是简写，只留 visibility 会把高度那条过渡顶掉
    expect(shut).toMatch(/transition: grid-template-rows var\(--dur-2\)[^;]*visibility var\(--dur-2\)/);
    // 这一块里不许出现字面毫秒（全应用的规矩，motion.test 也在全局拦）
    const block = overlaysCss
      .split("\n")
      .filter((l) => l.includes(".cl-old"))
      .join("\n");
    expect(block).not.toMatch(/\d+ms/);
  });
});

// ---------- ③ 任务卡：本来就是一次只摊开一张，钉住别被改坏 ----------

describe("任务卡一次只摊开一张", () => {
  it("点开第二张，第一张自己收起", () => {
    expandTask("t1");
    expect(appStore.getState().ui.expandedId).toBe("t1");
    expandTask("t2");
    expect(appStore.getState().ui.expandedId).toBe("t2");
    expandTask(null);
    expect(appStore.getState().ui.expandedId).toBeNull();
  });

  it("expandedId 是单值，谁也别悄悄改成数组", () => {
    // 改成 string[] 的那天，「点开一个自动收缩另一个」就不成立了
    expect(storeSource).toMatch(/expandedId: string \| null;/);
    expect(storeSource).not.toMatch(/expandedId:\s*string\[\]/);
    expect(storeSource).toContain("export function expandTask(id: string | null)");
  });

  it("手机上是抽屉，最上面永远只有一张", () => {
    closeAllSheets();
    openSheet({ kind: "task", taskId: "t1" });
    openSheet({ kind: "task", taskId: "t2" });
    const top = topSheet(sheetStore.getState().stack);
    expect(top).toEqual({ kind: "task", taskId: "t2" });
    // 界面只认最上面那张，所以天然不存在「同时摊开两张详情」
    expect(taskSheetSource).toContain("topSheet(s.stack)");
    closeAllSheets();
  });
});
