import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TaskCard from "../src/components/TaskCard";
import { defaultData, newTask } from "../src/core/model";
import { editedTitlePatch, parseEditedTitle } from "../src/core/editSyntax";
import { parseQuickAdd } from "../src/core/parse";
import { appStore, flushSave, undo, useApp } from "../src/core/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
const current = () => appStore.getState().data.tasks[0];
const sub = () => current().subtasks[0];
function Harness() { return createElement(TaskCard, { task: useApp((state) => state.data.tasks[0]) }); }
function setValue(input: HTMLTextAreaElement, value: string) {
  act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function enter(input: HTMLTextAreaElement, composing = false) {
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: composing })); await Promise.resolve(); });
}
beforeEach(async () => {
  await flushSave(); while (appStore.getState().undoDepth) undo(); await flushSave();
  localStorage.clear();
  const task = newTask({ id: "priority-parent", title: "母任务", due: "2026-10-30", dueTime: "11:00", priority: 3, notes: "保留备注", subtasks: [
    { id: "priority-sub", title: "原步骤", done: false, due: "2026-10-25", dueTime: "09:00", priority: 0, repeat: { kind: "weekly", days: [5] }, who: ["原需求方"], listIds: ["old-list"] },
  ] });
  appStore.setState({ data: { ...defaultData(), tasks: [task] }, loaded: true, wiped: false, loadError: null, undoDepth: 0, ui: { ...appStore.getState().ui, expandedId: task.id, ctxMenu: null } });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); act(() => root.render(createElement(Harness)));
});
afterEach(async () => { act(() => root.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); await flushSave(); });

describe("已有子任务输入优先级：真实TaskCard", () => {
  it.each(["原步骤!!!", "原步骤！！！", "!!!", "！！！", "!!!原步骤", "！！！原步骤", "！！原步骤", "! 原步骤", "！ 原步骤"])("%s覆盖原显式0，去掉标记且保留其他字段", async (raw) => {
    const before = { ...sub() }; const parentBefore = { ...current() };
    const input = host.querySelector<HTMLTextAreaElement>('[data-subtask-id="priority-sub"] textarea')!;
    setValue(input, raw); expect(sub()).toEqual(before); await enter(input);
    const expected = raw.startsWith("！！原") ? 2 : /^[!！] 原/.test(raw) ? 1 : 3;
    expect(sub()).toEqual({ ...before, priority: expected }); expect(input.value).toBe("原步骤");
    expect(current()).toEqual({ ...parentBefore, updatedAt: current().updatedAt, subtasks: [{ ...before, priority: expected }] });
  });

  it("IME回车只确认输入；普通提交只改标题，原显式0不变成继承", async () => {
    const input = host.querySelector<HTMLTextAreaElement>('[data-subtask-id="priority-sub"] textarea')!;
    setValue(input, "！！！下一步"); await enter(input, true);
    expect(sub().priority).toBe(0); expect(sub().title).toBe("原步骤");
    setValue(input, "改好的步骤"); await enter(input);
    expect(sub().title).toBe("改好的步骤"); expect(sub().priority).toBe(0); expect(current().priority).toBe(3);
  });

  it("母标题与新子任务共用同一解析规则，连续标记紧贴正文生效", async () => {
    const mother = host.querySelector<HTMLTextAreaElement>('.task-card > .row1 textarea')!;
    setValue(mother, "！！母任务"); await enter(mother); expect(current().priority).toBe(2); expect(current().title).toBe("母任务");
    const input = host.querySelector<HTMLTextAreaElement>('.new-sub-row textarea')!;
    setValue(input, "！！！新步骤"); await enter(input);
    expect(current().subtasks[1]).toMatchObject({ title: "新步骤", priority: 3 });
  });

  it("重要性弹层设无仍是显式0，之后仅改正文不重新继承母高", async () => {
    const click = (el: Element) => act(() => (el as HTMLElement).click());
    click(host.querySelector('[aria-label="子任务重要性：原步骤"]')!);
    click([...document.querySelectorAll('[data-task-popover] button')].find((el) => el.textContent?.trim() === "高")!);
    expect(sub().priority).toBe(3);
    click(host.querySelector('[aria-label="子任务重要性：原步骤"]')!);
    click([...document.querySelectorAll('[data-task-popover] button')].find((el) => el.textContent?.trim() === "无")!);
    expect(sub().priority).toBe(0);
    const input = host.querySelector<HTMLTextAreaElement>('[data-subtask-id="priority-sub"] textarea')!;
    setValue(input, "只改步骤正文"); await enter(input); expect(sub().priority).toBe(0); expect(current().priority).toBe(3);
  });
});

describe("优先级符号边界", () => {
  const opts = { now: new Date(2026, 9, 20, 12), listNames: [] };
  it.each(["!!!修复", "！！！修复", "！！修复", "修复 !!!", "修复！！！", "!！!修复"])("新建/编辑同源识别 %s", (text) => {
    const parsed = parseQuickAdd(text, opts); expect(parsed.title).toBe("修复"); expect(parsed.priority).toBe(text.startsWith("！！修") ? 2 : 3);
    expect(editedTitlePatch({ id: "sub", title: "修复", done: false, priority: 0 }, parseEditedTitle(text, opts))).toEqual({ priority: parsed.priority });
  });
  it.each(["真棒！！继续", "!棒 点子", "检查 https://example.com/!!!todo", "邮件 wow!!!@example.com"])("正文标点和URL保留：%s", (text) => {
    const parsed = parseEditedTitle(text, opts); expect(parsed.title).toBe(text); expect(parsed.chips).toEqual([]);
  });
});
