import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TaskCard from "../src/components/TaskCard";
import TaskRow from "../src/components/TaskRow";
import { finishCategoryDraft, useCategoryCreation } from "../src/core/categoryCreation";
import { defaultData, newTask } from "../src/core/model";
import { appStore, deleteTasks, flushSave, toggleSubtask, undo, useApp } from "../src/core/store";
import { rememberTaskSubtasksFolded } from "../src/core/subtaskFold";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const getTask = () => appStore.getState().data.tasks.find((t) => t.id === "parent")!;

function Harness() {
  const task = useApp((s) => s.data.tasks.find((t) => t.id === "parent")!);
  return createElement(TaskCard, { task });
}
function title() { return document.querySelector<HTMLTextAreaElement>('.task-card .row1 textarea')!; }
function subTitle() { return document.querySelector<HTMLTextAreaElement>('.task-card .subs .sub-row textarea')!; }
function type(el: HTMLTextAreaElement, text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function enter(el: HTMLTextAreaElement) {
  const choosing = !!document.querySelector(".si-drop button");
  await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  if (choosing) await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
}

beforeEach(async () => {
  await flushSave();
  while (appStore.getState().undoDepth > 0) undo();
  await flushSave();
  finishCategoryDraft(null);
  localStorage.clear();
  const data = defaultData();
  data.lists = [
    { id: "work", name: "工作", color: "clay", order: 1, updatedAt: "2026-10-16T00:00:00Z" },
    { id: "life", name: "生活", color: "moss", order: 2, updatedAt: "2026-10-16T00:00:00Z" },
  ];
  data.tasks = [newTask({ id: "parent", title: "原任务", listId: "work", who: ["李哥"], due: "2026-10-20", dueTime: "18:00", priority: 3, tags: ["旧标签"], subtasks: [
    { id: "step", title: "子任务", done: false, due: "2026-10-21", dueTime: "09:00", who: ["原协作人"], listIds: ["work"] },
  ] }), newTask({ id: "person-source", title: "候选来源", who: ["张总"] })];
  appStore.setState({ data, loaded: true, loadError: null, wiped: false, undoDepth: 0, ui: { ...appStore.getState().ui, expandedId: "parent" } });
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 16, 12));
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(Harness)));
});

afterEach(async () => {
  act(() => { root.unmount(); finishCategoryDraft(null); });
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
  await flushSave();
});

describe("任务卡直接编辑标题", () => {
  it("只在提交时以~今天覆盖原日期，保留未提及的钟点/需求方/清单", async () => {
    const before = JSON.stringify(appStore.getState().data);
    type(title(), "改好的任务 ~今天");
    expect(JSON.stringify(appStore.getState().data)).toBe(before);
    await enter(title());
    expect(getTask()).toMatchObject({ title: "改好的任务", due: "2026-10-16", dueTime: "18:00", who: ["李哥"], listId: "work", priority: 3, tags: ["旧标签"] });
    expect(document.querySelector(".tc-sentence")).toBeNull();
  });

  it("主标题@和/替换归类，普通改名不清空原字段", async () => {
    type(title(), "改名 @张总 /生活");
    await enter(title());
    expect(getTask()).toMatchObject({ title: "改名", who: ["张总"], listId: "life", due: "2026-10-20" });
    type(title(), "普通改名");
    await enter(title());
    expect(getTask()).toMatchObject({ title: "普通改名", who: ["张总"], listId: "life", dueTime: "18:00" });
  });

  it("Esc丢弃主子标题草稿，一个真实字段都不改", () => {
    const before = JSON.stringify(appStore.getState().data);
    type(title(), "未完成改名 ~今天");
    type(subTitle(), "未完成子改名 ~明天");
    act(() => subTitle().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(JSON.stringify(appStore.getState().data)).toBe(before);
  });

  it("确认了新清单、再取消新人时整笔编辑和新分类都不落库", async () => {
    const before = JSON.stringify(appStore.getState().data);
    type(title(), "新任务 /新清单 @新人 ~今天");
    await enter(title());
    const first = useCategoryCreation.getState().pending!;
    expect(first.draft.kind).toBe("list");
    await act(async () => finishCategoryDraft(first.draft));
    expect(useCategoryCreation.getState().pending?.draft.kind).toBe("who");
    await act(async () => finishCategoryDraft(null));
    expect(JSON.stringify(appStore.getState().data)).toBe(before);
  });

  it("弹窗期间任务被删除，之后确认也不会产生孤立新分类", async () => {
    type(title(), "新任务 /新清单");
    await enter(title());
    const first = useCategoryCreation.getState().pending!;
    act(() => deleteTasks(["parent"]));
    const afterDelete = JSON.stringify(appStore.getState().data);
    await act(async () => finishCategoryDraft(first.draft));
    expect(JSON.stringify(appStore.getState().data)).toBe(afterDelete);
  });

  it("子标题日期替换、归类去重追加在末尾，×仅去掉该子任务追加项", async () => {
    type(subTitle(), "子任务 ~今天 @张总 /生活");
    await enter(subTitle());
    expect(getTask()).toMatchObject({ who: ["李哥"], listId: "work", due: "2026-10-20" });
    expect(getTask().subtasks[0]).toMatchObject({ title: "子任务", due: "2026-10-16", dueTime: "09:00", who: ["原协作人", "张总"], listIds: ["work", "life"] });
    type(subTitle(), "子任务 @张总 /生活");
    await enter(subTitle());
    expect(getTask().subtasks[0].who).toEqual(["原协作人", "张总"]);
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="移除子任务需求方 张总"]')!.click());
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="移除子任务清单 生活"]')!.click());
    expect(getTask().subtasks[0]).toMatchObject({ who: ["原协作人"], listIds: ["work"] });
    expect(getTask().who).toEqual(["李哥"]);
  });

  it("新增子任务沿用同一解析和创建确认，中途取消不产生半份子任务", async () => {
    const input = document.querySelector<HTMLTextAreaElement>('.subs .si-input')!;
    type(input, "新步骤 ~今天 @张总 /生活 #正文");
    await enter(input);
    expect(getTask().subtasks).toHaveLength(2);
    expect(getTask().subtasks[1]).toMatchObject({ title: "新步骤 #正文", due: "2026-10-16", who: ["张总"], listIds: ["life"] });
    type(input, "未确认步骤 /新清单 @新人");
    await enter(input);
    await act(async () => finishCategoryDraft(useCategoryCreation.getState().pending!.draft));
    await act(async () => finishCategoryDraft(null));
    expect(getTask().subtasks).toHaveLength(2);
    expect(appStore.getState().data.lists.map((l) => l.name)).toEqual(["工作", "生活"]);
  });

  it("折叠子行仅显示自己追加的只读小签，父行及已完成日期行不显示归类", () => {
    const task = getTask();
    act(() => root.render(createElement(TaskRow, { task, sub: task.subtasks[0], orderedIds: [task.id] })));
    const badges = document.querySelector(".sub-row-categories")!;
    expect(badges.textContent).toBe("@原协作人/工作");
    expect(badges.querySelector("button")).toBeNull();
    expect(document.querySelector(".who-badge")).toBeNull();
    act(() => root.render(createElement(TaskRow, { task, orderedIds: [task.id] })));
    expect(document.querySelector(".sub-row-categories")).toBeNull();
    act(() => root.render(createElement(TaskRow, { task, sub: task.subtasks[0], tail: "date", orderedIds: [task.id] })));
    expect(document.querySelector(".sub-row-categories")).toBeNull();
  });

  it("133条真实待办子任务可折叠且记忆每任务偏好，收起仍可新增并正确更新完成计数", async () => {
    act(() => {
      const task = getTask();
      appStore.setState({ data: { ...appStore.getState().data, tasks: [{ ...task, subtasks: Array.from({ length: 133 }, (_, i) => ({ id: `many-${i}`, title: `第${i + 1}步`, done: false })) }] } });
    });
    const toggle = () => document.querySelector<HTMLButtonElement>(".tc-openfold")!;
    const count = () => toggle().querySelector(".tc-openfold-count")!.textContent;
    const panel = () => document.getElementById("pending-subs-parent")!;
    expect(panel().querySelectorAll("textarea")).toHaveLength(133);
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    act(() => toggle().click());
    expect(panel().querySelectorAll("textarea")).toHaveLength(3);
    expect(toggle().textContent).toContain("展开其余 130 条");
    const input = document.querySelector<HTMLTextAreaElement>('.subs .si-input')!;
    type(input, "收起时也能添加下一步"); await enter(input);
    expect(count()).toBe("134"); expect(panel().querySelectorAll("textarea")).toHaveLength(3);
    act(() => toggleSubtask("parent", "many-0")); expect(count()).toBe("133");
    expect([...panel().querySelectorAll("textarea")].map((el) => el.value)).toEqual(["第2步", "第3步", "第4步"]);
    act(() => root.render(createElement(Harness, { key: "reopen-card" })));
    expect(toggle().getAttribute("aria-expanded")).toBe("false"); expect(panel().querySelectorAll("textarea")).toHaveLength(3);
    act(() => toggle().click()); expect(panel().querySelectorAll("textarea")).toHaveLength(133);
    expect(getTask().subtasks).toHaveLength(134);
  });
  it.each([0, 1, 2, 3, 4, 133])("%i条待办：少于四条全部可见，收起也保留前三条", (size) => {
    rememberTaskSubtasksFolded("parent", true);
    act(() => { const task = getTask(); appStore.setState({ data: { ...appStore.getState().data, tasks: [{ ...task, subtasks: Array.from({ length: size }, (_, i) => ({ id: `size-${i}`, title: `预览${i + 1}`, done: false })) }] } }); });
    act(() => root.render(createElement(Harness, { key: `remembered-${size}` })));
    const panel = document.getElementById("pending-subs-parent")!;
    const toggle = document.querySelector<HTMLButtonElement>('button.tc-openfold');
    if (size > 3) {
      expect(toggle).not.toBeNull();
      expect(panel.querySelectorAll("textarea")).toHaveLength(3);
      expect(toggle!.textContent).toContain(`展开其余 ${size - 3} 条`);
      act(() => toggle!.click()); expect(panel.querySelectorAll("textarea")).toHaveLength(size);
    } else {
      expect(toggle).toBeNull(); expect(panel.querySelectorAll("textarea")).toHaveLength(size);
    }
    expect(document.querySelector('.new-sub-row textarea')).not.toBeNull();
  });
});
