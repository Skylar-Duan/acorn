// 09-21 · 手机上所有选日子 / 选循环的入口对齐成同一套（用户原话：「各个地方的循环可选项要对齐一致，
// 包括延期选项也要对齐，现在不同的地方点进去可以选择的方案不一样」）。
//
// 钉住四件事：
//   ① 「顺延到哪天」那张小纸（mobile/PostponeSheet）：选项跟桌面「顺延 ▾」同一套，不晚于现有日期的藏掉；
//      今天到期的事第一项就是「明天」（原来一键推明天的快捷还在）；点一下 = postponeRowsTo 落一次库、纸收掉；
//   ② 要推的是哪几行按 id 现找：删掉 / 做完 / 放弃了的不推（纸开着时别处了结了）；
//   ③ 手机的循环那一段（mobile/RepeatOptions）：选项顺序跟 repeatMenu 一致，「每隔几天…」是数字输入，
//      「自定义…」叠一张底部纸装 RepeatPicker；
//   ④ 叠着两张纸时 Esc 只收最上面那张。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultData, newTask } from "../src/core/model";
import type { RepeatRule } from "../src/core/model";
import { addDays, todayYMD } from "../src/core/dates";
import { appStore, undo } from "../src/core/store";
import { PostponeSheetHost, resolvePostponeRows } from "../src/mobile/PostponeSheet";
import RepeatOptions from "../src/mobile/RepeatOptions";
import Sheet from "../src/mobile/Sheet";
import { closeAllSheets, openSheet, sheetStore } from "../src/mobile/sheetStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function reset(tasks: ReturnType<typeof newTask>[] = []) {
  localStorage.clear();
  const data = defaultData();
  data.tasks = tasks;
  appStore.setState({ data, loaded: true, loadError: null, undoDepth: 0 });
  for (let i = 0; i < 60; i++) undo();
  appStore.setState({ data, loaded: true, loadError: null });
}

function render(el: ReturnType<typeof createElement>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
}

/** 纸是 portal 挂在 body 上的，按钮要在整个 body 里找 */
function buttons(scope = ""): HTMLButtonElement[] {
  return [...document.body.querySelectorAll<HTMLButtonElement>(`${scope} button`)];
}
function click(text: string, scope = "") {
  const b = buttons(scope).find((x) => x.textContent?.trim().startsWith(text));
  if (!b) throw new Error(`找不到按钮「${text}」`);
  act(() => b.click());
}

beforeEach(() => closeAllSheets());
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  act(() => closeAllSheets());
  document.body.innerHTML = "";
});

const task = (id: string) => appStore.getState().data.tasks.find((t) => t.id === id)!;

describe("② 要推的行按 id 现找：没了的、了结了的都不推", () => {
  it("删掉 / 做完 / 放弃了的任务和子任务都跳过，其余原样交出", () => {
    const today = todayYMD();
    const a = newTask({ title: "a", due: today });
    const done = newTask({ title: "done", due: today });
    done.done = true;
    const gone = newTask({ title: "gone", due: today });
    gone.deletedAt = "2026-09-20T10:00:00";
    const withSubs = newTask({ title: "母", due: today });
    withSubs.subtasks = [
      { id: "s1", title: "活的", done: false },
      { id: "s2", title: "做完了", done: true },
      { id: "s3", title: "删了", done: false, deletedAt: "2026-09-20T10:00:00" },
    ] as typeof withSubs.subtasks;
    const rows = resolvePostponeRows(
      [
        { taskId: a.id }, { taskId: done.id }, { taskId: gone.id }, { taskId: "nope" },
        { taskId: withSubs.id, subId: "s1" }, { taskId: withSubs.id, subId: "s2" }, { taskId: withSubs.id, subId: "s3" },
      ],
      [a, done, gone, withSubs],
    );
    expect(rows.map((r) => (r.sub ? `${r.task.title}›${r.sub.title}` : r.task.title))).toEqual(["a", "母›活的"]);
  });
});

describe("① 顺延到哪天：跟桌面同一套选项，点一下落一次库", () => {
  it("今天到期的事：第一项就是「明天」，「今天」藏掉；点了日期落到明天、顺延记一次、纸收掉", () => {
    const today = todayYMD();
    const t = newTask({ title: "写周报", due: today });
    reset([t]);
    render(createElement(PostponeSheetHost));
    act(() => openSheet({ kind: "postpone", rows: [{ taskId: t.id }] }));
    const labels = buttons(".mpp-list").map((b) => b.firstElementChild?.textContent);
    expect(labels[0]).toBe("明天");
    expect(labels).not.toContain("今天");
    expect(labels[labels.length - 1]).toBe("选日期…");
    click("明天", ".mpp-list");
    expect(task(t.id).due).toBe(addDays(today, 1));
    expect(task(t.id).postponeCount).toBe(1);
    expect(sheetStore.getState().stack).toEqual([]);
  });

  it("逾期的事：「今天」也在，排第一（跟桌面逾期组「全部顺延」一样）", () => {
    const today = todayYMD();
    const t = newTask({ title: "回邮件", due: addDays(today, -2) });
    reset([t]);
    render(createElement(PostponeSheetHost));
    act(() => openSheet({ kind: "postpone", rows: [{ taskId: t.id }] }));
    const labels = buttons(".mpp-list").map((b) => b.firstElementChild?.textContent);
    expect(labels[0]).toBe("今天");
    expect(labels[1]).toBe("明天");
    click("今天", ".mpp-list");
    expect(task(t.id).due).toBe(today);
  });

  it("好几行一起（今天页「全部顺延」）：一次落库，几行都挪到选的那天", () => {
    const today = todayYMD();
    const a = newTask({ title: "a", due: addDays(today, -1) });
    const b = newTask({ title: "b", due: addDays(today, -3) });
    reset([a, b]);
    render(createElement(PostponeSheetHost));
    act(() => openSheet({ kind: "postpone", rows: [{ taskId: a.id }, { taskId: b.id }] }));
    expect(document.body.querySelector(".msheet-title")?.textContent).toBe("2 件");
    click("明天", ".mpp-list");
    expect(task(a.id).due).toBe(addDays(today, 1));
    expect(task(b.id).due).toBe(addDays(today, 1));
  });

  it("「选日期…」点开是日期框 + 确定，不点确定一个字都不落库", () => {
    const today = todayYMD();
    const t = newTask({ title: "x", due: today });
    reset([t]);
    render(createElement(PostponeSheetHost));
    act(() => openSheet({ kind: "postpone", rows: [{ taskId: t.id }] }));
    click("选日期…", ".mpp-list");
    expect(document.body.querySelector(".mpp-pick")).not.toBeNull();
    click("确定", ".mpp-pick"); // 还没选日子：什么都不做
    expect(task(t.id).due).toBe(today);
    expect(sheetStore.getState().stack).toHaveLength(1);
  });

  it("要推的那几行全没了：纸自己收掉", () => {
    const t = newTask({ title: "x", due: todayYMD() });
    reset([t]);
    render(createElement(PostponeSheetHost));
    act(() => openSheet({ kind: "postpone", rows: [{ taskId: "早就没了" }] }));
    expect(sheetStore.getState().stack).toEqual([]);
  });
});

describe("③ 手机的循环那一段：同一套选项，自定义叠一张纸", () => {
  function mountRepeat(value: RepeatRule | null, anchor = "2026-09-21") {
    const picked: (RepeatRule | null)[] = [];
    render(createElement(RepeatOptions, { anchor, value, onPick: (r: RepeatRule | null) => picked.push(r) }));
    return picked;
  }

  it("没循环时：每天 / 每个工作日 / 每周一 / 每月21号 / 每隔几天… / 自定义…，没有「不重复」", () => {
    mountRepeat(null);
    expect(buttons(".msh-chips").map((b) => b.textContent)).toEqual([
      "每天", "每个工作日", "每周一", "每月21号", "每隔几天…", "自定义…",
    ]);
  });

  it("现值不在常用项里：挂在最前面亮着；有循环时末尾多一个「不重复」", () => {
    const picked = mountRepeat({ kind: "weekly", days: [1, 3, 5] });
    const labels = buttons(".msh-chips").map((b) => b.textContent);
    expect(labels[0]).toBe("✓ 每周一、三、五");
    expect(labels[labels.length - 1]).toBe("不重复");
    click("不重复", ".msh-chips");
    expect(picked).toEqual([null]);
  });

  it("「每隔几天…」是数字键盘的输入：填 3 点「好」→ 每 3 天；填 0 或 400 「好」是灰的", () => {
    const picked = mountRepeat(null);
    click("每隔几天…", ".msh-chips");
    const input = document.body.querySelector<HTMLInputElement>(".msh-everyn input")!;
    expect(input.getAttribute("inputmode")).toBe("numeric");
    const setVal = (v: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const ok = () => buttons(".msh-everyn").find((b) => b.textContent === "好")!;
    setVal("0");
    expect(ok().disabled).toBe(true);
    setVal("400");
    expect(ok().disabled).toBe(true);
    setVal("3");
    act(() => ok().click());
    expect(picked).toEqual([{ kind: "daily", every: 3 }]);
  });

  it("「自定义…」叠一张底部纸，里面是天 / 周 / 月面板；点「好」交出去、纸收掉", () => {
    const picked = mountRepeat(null);
    click("自定义…", ".msh-chips");
    expect(document.body.querySelector(".msh-rp .rp")).not.toBeNull();
    click("三", ".msh-rp .rp-week");
    click("好", ".msh-rp .rp-foot");
    expect(picked).toEqual([{ kind: "weekly", days: [1, 3] }]);
  });
});

describe("④ 两张纸叠着时，Esc 只收最上面那张", () => {
  it("底下一张、上面一张：按一下 Esc 只有上面那张的 onClose 被叫到", () => {
    const closed: string[] = [];
    render(
      createElement("div", null,
        createElement(Sheet, { open: true, onClose: () => closed.push("底下"), children: "a" }),
        createElement(Sheet, { open: true, onClose: () => closed.push("上面"), children: "b" }),
      ),
    );
    expect(document.body.querySelectorAll(".msheet-back")).toHaveLength(2);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(closed).toEqual(["上面"]);
  });
});
