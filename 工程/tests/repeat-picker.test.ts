// 循环的「自定义…」面板（v1.15，桌面）。用户原话：
// 「循环~每个月末识别不了，循环界面的可选也不对，应该可以点开弹出日历有更多的选择之类的」。
//
// 钉住三件事：
//   · 面板本身：天 / 周 / 月三个页签，周可多选，月是 1–31 + 「最后一天」，点「好」才交出去，「取消」什么都不交；
//   · 两个桌面入口（任务卡 ↻ 循环、快速添加条 🔁 重复）都保留常用项、末尾挂「自定义…」，
//     现在的规则不在常用项里时常用项那排也看得到它；
//   · 顺手修的那个时区 bug：任务卡菜单的星期几改走本地日期（dayOfWeek），不再 new Date(ymd).getDay()。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import RepeatPicker, { sameRepeat } from "../src/components/RepeatPicker";
import type { RepeatRule } from "../src/core/model";
import taskCardSource from "../src/components/TaskCard.tsx?raw";
import quickAddBarSource from "../src/components/QuickAddBar.tsx?raw";
import quickAddSheetSource from "../src/mobile/QuickAddSheet.tsx?raw";
import taskSheetSource from "../src/mobile/TaskSheet.tsx?raw";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** 渲染面板，返回拿按钮 / 点按钮 / 看预览的几只手，以及交出去的结果 */
function mount(value: RepeatRule | null, anchor = "2026-09-21") {
  const out: { done: RepeatRule[]; cancelled: number } = { done: [], cancelled: 0 };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      createElement(RepeatPicker, {
        value,
        anchor,
        onDone: (r: RepeatRule) => out.done.push(r),
        onCancel: () => { out.cancelled += 1; },
      }),
    );
  });
  const buttons = () => [...host!.querySelectorAll("button")];
  const btn = (text: string, scope = "") => {
    const b = [...host!.querySelectorAll<HTMLButtonElement>(`${scope} button`)].find((x) => x.textContent === text);
    if (!b) throw new Error(`找不到按钮「${text}」`);
    return b;
  };
  const click = (text: string, scope = "") => act(() => { btn(text, scope).click(); });
  const preview = () => host!.querySelector(".rp-preview")!.childNodes[0].textContent;
  const onTab = () => host!.querySelector(".rp-tab.on")!.textContent;
  return { out, buttons, btn, click, preview, onTab };
}

describe("面板：三个页签，点「好」才交出去", () => {
  it("没有规则时停在「周」，默认选中那天是星期几（9-21 是周一），预览跟着写", () => {
    const m = mount(null);
    expect(m.onTab()).toBe("周");
    expect(m.preview()).toBe("每周一");
  });

  it("周可以多选：再点三、五 → 每周一、三、五；点「好」交出排好序的 days", () => {
    const m = mount(null);
    m.click("五", ".rp-week");
    m.click("三", ".rp-week");
    expect(m.preview()).toBe("每周一、三、五");
    expect(m.out.done).toEqual([]); // 点格子只改草稿
    m.click("好");
    expect(m.out.done).toEqual([{ kind: "weekly", days: [1, 3, 5] }]);
  });

  it("周一天都不选：预览提示「至少选一天」，「好」按不动", () => {
    const m = mount(null);
    m.click("一", ".rp-week");
    expect(m.preview()).toBe("至少选一天");
    expect(m.btn("好").disabled).toBe(true);
  });

  it("月：1–31 号格子加「最后一天」；点「最后一天」存 day 31，预览写「每月最后一天」", () => {
    const m = mount(null);
    m.click("月");
    const cells = [...host!.querySelectorAll(".rp-month button")].map((b) => b.textContent);
    expect(cells).toEqual([...Array.from({ length: 31 }, (_, i) => String(i + 1)), "最后一天"]);
    expect(m.preview()).toBe("每月21号"); // 默认按那天几号
    m.click("最后一天");
    expect(m.preview()).toBe("每月最后一天");
    m.click("好");
    expect(m.out.done).toEqual([{ kind: "monthly", day: 31 }]);
  });

  it("月：选 30 号，提示小月落在月末", () => {
    const m = mount(null);
    m.click("月");
    m.click("30", ".rp-month");
    expect(m.preview()).toBe("每月30号");
    expect(host!.querySelector(".rp-note")?.textContent).toBe("没有这一天的月份落在月末");
  });

  it("天：每隔 N 天，加减按钮改天数", () => {
    const m = mount(null);
    m.click("天");
    expect(m.preview()).toBe("每天");
    m.click("＋");
    m.click("＋");
    expect(m.preview()).toBe("每3天");
    m.click("好");
    expect(m.out.done).toEqual([{ kind: "daily", every: 3 }]);
  });

  it("「取消」什么都不交", () => {
    const m = mount(null);
    m.click("三", ".rp-week");
    m.click("取消");
    expect(m.out.done).toEqual([]);
    expect(m.out.cancelled).toBe(1);
  });

  it("打开时停在现有规则那一页，格子照现有规则亮", () => {
    expect(mount({ kind: "daily", every: 4 }).preview()).toBe("每4天");
    act(() => root?.unmount());
    const w = mount({ kind: "weekly", days: [1, 3, 5] });
    expect(w.onTab()).toBe("周");
    expect(w.preview()).toBe("每周一、三、五");
    act(() => root?.unmount());
    const mo = mount({ kind: "monthly", day: 31 });
    expect(mo.onTab()).toBe("月");
    const lit = [...host!.querySelectorAll(".rp-month .on")].map((b) => b.textContent);
    expect(lit).toEqual(["31", "最后一天"]); // 31 号跟最后一天是一回事，两格一起亮
  });

  it("只用现有 4 种规则：没有每年 / 隔周 / 隔月的选项", () => {
    const m = mount(null);
    const tabs = [...host!.querySelectorAll(".rp-tab")].map((b) => b.textContent);
    expect(tabs).toEqual(["天", "周", "月"]);
    expect(m.buttons().some((b) => /年|隔周|隔月/.test(b.textContent ?? ""))).toBe(false);
  });
});

describe("sameRepeat：判「现在选的是不是这个」", () => {
  it("每周那几天不看顺序", () => {
    expect(sameRepeat({ kind: "weekly", days: [5, 1] }, { kind: "weekly", days: [1, 5] })).toBe(true);
    expect(sameRepeat({ kind: "weekly", days: [1] }, { kind: "weekly", days: [1, 5] })).toBe(false);
    expect(sameRepeat({ kind: "monthly", day: 31 }, { kind: "monthly", day: 31 })).toBe(true);
    expect(sameRepeat(null, null)).toBe(true);
    expect(sameRepeat({ kind: "workday" }, null)).toBe(false);
  });
});

describe("两个桌面入口：常用项 + 「自定义…」，现值不在常用项里也看得到", () => {
  it("任务卡 ↻ 循环", () => {
    expect(taskCardSource).toContain('<button className="item" onClick={() => setRepeatCustom(true)}>自定义…</button>');
    expect(taskCardSource).toContain("<RepeatPicker");
    expect(taskCardSource).toContain("onDone={(r) => setRepeat(r)}");
    // 现值不在常用项里：单独挂在最上面
    expect(taskCardSource).toContain("const repeatOffList = !!task.repeat && !repeatCommon.some((r) => sameRepeat(r, task.repeat ?? null));");
    // 常用项的名字统一走 describeRepeat（月末那项写「每月最后一天」，不再手写「每月{dom}号」）
    expect(taskCardSource).not.toContain("每月{dom}号");
  });

  it("任务卡菜单的星期几按本地日期取，不再按 UTC 解析", () => {
    expect(taskCardSource).not.toContain("new Date(task.due).getDay()");
    expect(taskCardSource).toContain("const wd = dayOfWeek(repeatAnchor);");
  });

  it("快速添加条 🔁 重复：常用项写成「每周一」「每月21号」，末尾「自定义…」，显示文字走 describeRepeat", () => {
    expect(quickAddBarSource).toContain('<button className="item" onClick={() => setRepeatCustom(true)}>自定义…</button>');
    expect(quickAddBarSource).toContain("<RepeatPicker");
    expect(quickAddBarSource).toContain('pick.repeat ? describeRepeat(pick.repeat) : "重复"');
    expect(quickAddBarSource).not.toContain("function repeatLabel");
    expect(quickAddBarSource).not.toContain("每周（按今天是周几）");
  });

  it("手机这次只改显示文字，选项排里不加自定义（要先出稿）", () => {
    expect(quickAddSheetSource).toContain('eff.repeat ? describeRepeat(eff.repeat) : "重复"');
    expect(quickAddSheetSource).not.toContain("RepeatPicker");
    expect(taskSheetSource).not.toContain("RepeatPicker");
  });
});
