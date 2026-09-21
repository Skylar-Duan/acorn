// 子任务可以写成几行（用户原话「子任务输入的时候也是自动换行（跟输入后的展示一样），
// 而不是不断地左移。子任务里面 shift+enter 可以换行」）。
// 钉住：
//   ① parse 的 keepNewlines 开关：开了换行留着、每行各自清理；**不开时一丝不变**
//      （记一条 / 整句改 / 快捷记浮窗 / 手机记一条都不开）
//   ② SyntaxInput 的 allowNewline：Shift+Enter 放给 textarea 插换行、Enter 还是提交、
//      补全下拉开着时 Enter 还是选候选、粘进来的换行留着
//   ③ 任务卡：新加栏开 allowNewline + keepNewlines；已有子任务标题 Shift+Enter 换行、Enter 不做事；
//      母任务标题和整句改原样
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseQuickAdd, parseSubtaskInput } from "../src/core/parse";
import SyntaxInput from "../src/components/SyntaxInput";
import type { SyntaxInputProps } from "../src/components/SyntaxInput";
import { keepLines, oneLine } from "../src/components/autogrow";
import { addSubtask, addTask, appStore, updateSubtask } from "../src/core/store";
import { defaultData } from "../src/core/model";
import taskCardSource from "../src/components/TaskCard.tsx?raw";
import quickAddBarSource from "../src/components/QuickAddBar.tsx?raw";
import quickAddWinSource from "../src/windows/quickadd.tsx?raw";
import taskSheetSource from "../src/mobile/TaskSheet.tsx?raw";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 8, 21, 9, 0); // 2026-09-21 周一 09:00

describe("① parse：keepNewlines 只让子任务那条路留换行", () => {
  it("开了：换行留着，每行各自压空白、去首尾空格，空行扔掉", () => {
    const r = parseSubtaskInput("  买菜   \n\n  鸡蛋  牛奶 \r\n 面包", NOW, [], "sun", { keepNewlines: true });
    expect(r.title).toBe("买菜\n鸡蛋 牛奶\n面包");
  });

  it("开了照样认日期 / 重要性，认出来的字从那一行里拿掉", () => {
    const r = parseSubtaskInput("~明天 !高 写周报\n附上数据", NOW, [], "sun", { keepNewlines: true });
    expect(r.due).toBe("2026-09-22");
    expect(r.priority).toBe(3);
    expect(r.title).toBe("写周报\n附上数据");
  });

  it("开了：「提醒我」「光杆的每」那两道清理按行做，不会把换行当词边界吃掉", () => {
    const r = parseSubtaskInput("~20点 提醒我\n交电费", NOW, [], "sun", { keepNewlines: true });
    expect(r.dueTime).toBe("20:00");
    expect(r.title).toBe("交电费");
    const w = parseSubtaskInput("每 交周报 ~明天\n带上表格", NOW, [], "sun", { keepNewlines: true });
    expect(w.title).toBe("交周报\n带上表格");
  });

  it("不开（默认）：跟以前一模一样，换行压成一个空格", () => {
    expect(parseSubtaskInput("买菜\n鸡蛋", NOW).title).toBe("买菜 鸡蛋");
    expect(parseSubtaskInput("~明天 写周报\n附上数据", NOW).title).toBe("写周报 附上数据");
  });

  it("记一条 / 整句改（parseQuickAdd 不传开关）照旧吃掉换行", () => {
    const r = parseQuickAdd("开会\n#工作  @李哥\n带电脑", { now: NOW, listNames: [] });
    expect(r.title).toBe("开会 带电脑");
    expect(r.tags).toEqual(["工作"]);
    expect(r.who).toEqual(["李哥"]);
  });

  it("只有一行时开不开结果一样", () => {
    const a = parseSubtaskInput("  ~明天 ~15点 !中  画趋势图  ", NOW, [], "sun");
    const b = parseSubtaskInput("  ~明天 ~15点 !中  画趋势图  ", NOW, [], "sun", { keepNewlines: true });
    expect(b).toEqual(a);
  });
});

describe("数据：多行标题原样存、原样改", () => {
  beforeEach(() => {
    localStorage.clear();
    appStore.setState({ data: defaultData(), loaded: true, loadError: null });
  });

  it("加子任务、改子任务标题都把换行存进去", () => {
    const id = addTask({ title: "搬家" });
    addSubtask(id, "打包\n书和衣服");
    const t = () => appStore.getState().data.tasks.find((x) => x.id === id)!;
    const sub = t().subtasks[0];
    expect(sub.title).toBe("打包\n书和衣服");
    updateSubtask(id, sub.id, { title: keepLines("打包\r\n书、衣服\r厨具") });
    expect(t().subtasks[0].title).toBe("打包\n书、衣服\n厨具");
  });

  it("keepLines 只统一换行符；oneLine 照旧压成空格", () => {
    expect(keepLines("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
    expect(oneLine("a\r\nb\nc")).toBe("a b c");
  });
});

describe("② SyntaxInput allowNewline", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  function mount(props: Partial<SyntaxInputProps>) {
    const calls = { submit: [] as string[], shift: 0, change: [] as string[] };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const render = (value: string) =>
      act(() =>
        root!.render(
          createElement(SyntaxInput, {
            value,
            onChange: (v: string) => {
              calls.change.push(v);
              render(v);
            },
            onSubmit: (p) => {
              calls.submit.push(p.title);
            },
            onShiftEnter: () => {
              calls.shift++;
            },
            lists: [],
            tags: [],
            whos: [],
            ...props,
          }),
        ),
      );
    render(props.value ?? "");
    return { calls, el: () => host!.querySelector<HTMLTextAreaElement | HTMLInputElement>(".si-input")!, render };
  }

  const key = (el: HTMLElement, k: string, shift = false) => {
    const ev = new KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true, cancelable: true });
    act(() => {
      el.dispatchEvent(ev);
    });
    return ev;
  };

  /** 模拟用户在框里敲 / 粘贴成这个值（React 认的是原生 value setter + input 事件） */
  const typeInto = (el: HTMLTextAreaElement, v: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setter.call(el, v);
      el.selectionStart = el.selectionEnd = v.length;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("开了就是 textarea（长句子折行、框跟着长高，不再单行往左推）", () => {
    const { el } = mount({ allowNewline: true, value: "abc" });
    expect(el().tagName).toBe("TEXTAREA");
  });

  it("Shift+Enter 不拦（textarea 自己插换行），也不去叫 onShiftEnter", () => {
    const { el, calls } = mount({ allowNewline: true, value: "买菜" });
    const ev = key(el(), "Enter", true);
    expect(ev.defaultPrevented).toBe(false);
    expect(calls.shift).toBe(0);
    expect(calls.submit).toEqual([]);
  });

  it("Enter 还是提交，不插换行", () => {
    const { el, calls } = mount({ allowNewline: true, value: "买菜" });
    const ev = key(el(), "Enter");
    expect(ev.defaultPrevented).toBe(true);
    expect(calls.submit).toEqual(["买菜"]);
  });

  it("补全下拉开着时 Enter 是选候选，不提交不换行", () => {
    const { el, calls } = mount({ allowNewline: true, tags: ["工作"] });
    typeInto(el() as HTMLTextAreaElement, "开会 #工");
    const ev = key(el(), "Enter");
    expect(ev.defaultPrevented).toBe(true);
    expect(calls.submit).toEqual([]);
    expect(calls.change[calls.change.length - 1]).toBe("开会 #工作 ");
  });

  it("敲 / 粘进来的换行留着（\\r\\n 统一成 \\n）", () => {
    const { el, calls } = mount({ allowNewline: true });
    typeInto(el() as HTMLTextAreaElement, "打包\r\n书");
    expect(calls.change[calls.change.length - 1]).toBe("打包\n书");
  });

  it("不开的时候老样子：multiline 吃换行、Shift+Enter 走 onShiftEnter", () => {
    const { el, calls } = mount({ multiline: true, value: "开会" });
    typeInto(el() as HTMLTextAreaElement, "开会\n带电脑");
    expect(calls.change[calls.change.length - 1]).toBe("开会 带电脑");
    const ev = key(el(), "Enter", true);
    expect(ev.defaultPrevented).toBe(true);
    expect(calls.shift).toBe(1);
  });

  it("什么都不开还是 input", () => {
    const { el } = mount({});
    expect(el().tagName).toBe("INPUT");
  });
});

describe("③ 任务卡与其他入口", () => {
  /** 新加子任务那一栏的 <SyntaxInput …/> 整段 */
  const addBar = (() => {
    const at = taskCardSource.indexOf("value={newSub}");
    return taskCardSource.slice(at, taskCardSource.indexOf("/>", at));
  })();

  it("新加栏开 allowNewline，不再接 onShiftEnter（子任务里收卡按 Esc 或点卡外）", () => {
    expect(addBar).toMatch(/^\s*allowNewline\s*$/m);
    expect(addBar).not.toContain("onShiftEnter=");
    // Esc 那条路还在：有字先擦，第二下冒泡去收卡
    expect(addBar).toContain("onEscape");
  });

  it("加子任务时解析开 keepNewlines（换行一路留进标题）", () => {
    expect(taskCardSource).toContain(
      "parseSubtaskInput(newSub, new Date(), [], settings.weekendDay, { keepNewlines: true })",
    );
  });

  it("已有子任务标题：Shift+Enter 放行（换行），Enter 拦掉不做事；改标题走 keepLines", () => {
    const at = taskCardSource.indexOf("value={s.title}");
    const body = taskCardSource.slice(at, taskCardSource.indexOf("<CommitMark", at));
    expect(body).toContain("keepLines(e.target.value)");
    expect(body).not.toContain("oneLine(");
    expect(body).toContain("if (e.shiftKey) return;");
    expect(body).not.toContain("expandTask(null)");
    expect(body).toContain("e.preventDefault();");
  });

  it("母任务标题一个字没动：oneLine + Shift+Enter 收卡 + Enter 跳备注", () => {
    const at = taskCardSource.indexOf("ref={titleRef}");
    const body = taskCardSource.slice(at, taskCardSource.indexOf("<CommitMark", at));
    expect(body).toContain("oneLine(e.target.value)");
    expect(body).toContain("if (e.shiftKey) expandTask(null);");
    expect(body).toContain("else notesRef.current?.focus();");
  });

  it("记一条横条、快捷记浮窗、手机子任务都没开允许换行", () => {
    for (const src of [quickAddBarSource, quickAddWinSource]) {
      expect(src).not.toContain("allowNewline");
      expect(src).not.toContain("keepNewlines");
    }
    // 手机改子任务标题这次不动（照旧压成一行，已记进手机跟随清单）
    expect(taskSheetSource).not.toContain("keepNewlines");
    expect(taskSheetSource).toContain("const t = oneLine(v).trim();");
  });

  it("整句改那个框没开 allowNewline（一句话就是一句话）", () => {
    // 新加栏之外，任务卡里再没有别的 allowNewline
    expect(taskCardSource.split(/^\s*allowNewline\s*$/m).length - 1).toBe(1);
  });
});
