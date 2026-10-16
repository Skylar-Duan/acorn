import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultData, newTask, type Task } from "../src/core/model";
import { appStore, flushSave, undo } from "../src/core/store";
import { TaskSheetHost } from "../src/mobile/TaskSheet";
import { closeAllSheets, openSheet } from "../src/mobile/sheetStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;

const mother = (patch: Partial<Task> = {}) => newTask({
  id: "parent", title: "整理项目", due: null,
  subtasks: [
    { id: "next", title: "今天这一步", done: false, due: "2026-10-15", dueTime: "09:00" },
    { id: "later", title: "下一步", done: false, due: "2026-10-20", dueTime: "15:00" },
    { id: "blank", title: "尚未安排", done: false, due: null },
  ], ...patch,
});

function renderTask(task = mother()) {
  appStore.setState({ data: { ...defaultData(), tasks: [task] } });
  act(() => {
    openSheet({ kind: "task", taskId: task.id });
    root.render(createElement(TaskSheetHost));
  });
}

function dateRow() {
  return [...document.querySelectorAll<HTMLButtonElement>("button.msh-prop")]
    .find((b) => b.querySelector(".msh-prop-k")?.textContent === "日期")!;
}

beforeEach(async () => {
  await flushSave();
  while (appStore.getState().undoDepth > 0) undo();
  await flushSave();
  localStorage.clear();
  closeAllSheets();
  appStore.setState({ data: defaultData(), loaded: true, undoDepth: 0 });
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 15, 12));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  act(() => root.unmount());
  closeAllSheets();
  document.body.innerHTML = "";
  vi.useRealTimers();
  await flushSave();
});

describe("手机任务详情的母任务显示日期", () => {
  it("长备注和133个子任务处于同一滚区，日期仍在其中、底部动作留在滚区外", () => {
    const notes = "长备注仍可完整阅读。\n".repeat(80);
    renderTask(mother({ notes, subtasks: Array.from({ length: 133 }, (_, i) => ({ id: `long-${i}`, title: `步骤 ${i + 1}`, done: false })) }));
    const scroll = document.querySelector<HTMLElement>(".msh-task .msh-scroll")!;
    expect(scroll).not.toBeNull();
    expect(scroll.contains(document.querySelector(".msh-head"))).toBe(true);
    expect(scroll.querySelector(".msh-notes")?.textContent).toBe(notes);
    expect(scroll.querySelectorAll(".msh-subwrap")).toHaveLength(133);
    expect(scroll.contains(dateRow())).toBe(true);
    const footer = document.querySelector<HTMLElement>(".msh-foot")!;
    expect(footer).not.toBeNull();
    expect(scroll.contains(footer)).toBe(false);
    expect(appStore.getState().data.tasks[0].notes).toBe(notes);
  });

  it("母任务没手排日期，日期行显示今天、钟点和最近子任务来源", () => {
    renderTask();
    const value = dateRow().querySelector(".msh-prop-v")!;
    expect(value.textContent).toBe("今天 09:00 · 最近子任务");
    expect(value.classList.contains("off")).toBe(false);
    expect(appStore.getState().data.tasks[0].due).toBeNull();
  });

  it("母任务手排日期和钟点优先，省略最近子任务来源", () => {
    renderTask(mother({ due: "2026-10-16", dueTime: "18:00" }));
    expect(dateRow().querySelector(".msh-prop-v")!.textContent).toBe("明天 18:00");
    act(() => dateRow().click());
    expect(document.querySelector<HTMLInputElement>('.msh-seg input[type="date"]')!.value).toBe("2026-10-16");
    expect(document.querySelector<HTMLInputElement>('.msh-seg input[type="time"]')!.value).toBe("18:00");
  });

  it("显示子任务安排时，母任务编辑字段和预设选择仍保持空白", () => {
    renderTask();
    act(() => dateRow().click());
    expect(document.querySelector<HTMLInputElement>('.msh-seg input[type="date"]')!.value).toBe("");
    expect(document.querySelector<HTMLInputElement>('.msh-seg input[type="time"]')!.value).toBe("");
    expect(document.querySelectorAll(".msh-dates .msh-opt.on")).toHaveLength(0);
    expect(appStore.getState().data.tasks[0].due).toBeNull();
    const blank = [...document.querySelectorAll(".msh-subwrap")]
      .find((row) => row.querySelector(".msh-subtitle")?.textContent === "尚未安排")!;
    expect(blank.querySelector(".msh-subdate")).toBeNull();
  });

  it("在详情勾完最近步骤，日期行即时更新到下一步；全部排期步骤完成后恢复未安排", () => {
    renderTask();
    const finish = (title: string) => {
      const row = [...document.querySelectorAll(".msh-subwrap")]
        .find((r) => r.querySelector(".msh-subtitle")?.textContent === title)!;
      act(() => row.querySelector<HTMLButtonElement>(".msh-sb")!.click());
    };
    finish("今天这一步");
    expect(dateRow().querySelector(".msh-prop-v")!.textContent).toBe("10月20日 15:00 · 最近子任务");
    expect(appStore.getState().data.tasks[0].due).toBeNull();
    finish("下一步");
    const value = dateRow().querySelector(".msh-prop-v")!;
    expect(value.textContent).toBe("没有日期");
    expect(value.classList.contains("off")).toBe(true);
    expect(appStore.getState().data.tasks[0].subtasks.find((s) => s.id === "blank")!.due).toBeNull();
  });
});
