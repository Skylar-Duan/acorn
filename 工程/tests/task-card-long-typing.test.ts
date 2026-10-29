import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const flags = vi.hoisted(() => ({ plus: true }));
vi.mock("../src/core/plus", async original => ({ ...await original<typeof import("../src/core/plus")>(), plusEnabled: () => flags.plus, usePlus: () => flags.plus }));
import TaskCard from "../src/components/TaskCard";
import { appStore, flushSave, useApp } from "../src/core/store";
import { defaultData, newTask, type Subtask, type TaskImage } from "../src/core/model";

// 长子任务打字卡顿（10-28）：一百多条子任务、已完成与图片较多的卡片里，每敲一键不能把所有子框都重新量一遍。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const jpeg = [255, 216, 255, 192, 0, 17, 8, 0, 1, 0, 1, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 255, 217];
const picture: TaskImage = { id: "a", name: "配色.jpg", dataUrl: "data:image/jpeg;base64," + btoa(String.fromCharCode(...jpeg)), width: 1, height: 1, bytes: jpeg.length };
let root: Root, host: HTMLDivElement, measured = 0;
function Card() { return createElement(TaskCard, { task: useApp(state => state.data.tasks[0]) }); }
function type(el: HTMLTextAreaElement, value: string) {
  act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
}
beforeEach(async () => {
  await flushSave(); localStorage.clear(); flags.plus = true;
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockImplementation(() => { measured++; return 24; });
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 28, 12));
  const subtasks: Subtask[] = Array.from({ length: 130 }, (_, i) => ({
    id: `s${i}`, title: `第${i}步 核对材料，写清楚结论再交`, done: i >= 40, due: "2026-11-02", priority: 1,
    ...(i % 3 === 0 ? { images: [{ ...picture, id: `p${i}` }, { ...picture, id: `q${i}` }] } : {}),
  }));
  const data = defaultData();
  data.tasks = [newTask({ id: "parent", title: "长任务", due: "2026-11-05", subtasks })];
  appStore.setState({ data, loaded: true, loadError: null, wiped: false, ui: { ...appStore.getState().ui, expandedId: "parent" } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(createElement(Card)));
});
afterEach(async () => { act(() => root.unmount()); document.body.innerHTML = ""; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await flushSave(); });

describe("长子任务卡片打字", () => {
  it("在一条子任务里连敲几个字，只重新量这一条", () => {
    const boxes = host.querySelectorAll(".subs textarea");
    expect(boxes.length).toBeGreaterThan(40);
    // 用户逐条点开过的子任务会保持展开，展开的才需要真量高
    for (let i = 0; i < 30; i++) act(() => host.querySelector<HTMLButtonElement>(`[data-subtask-id="s${i}"] .sub-disclosure`)!.click());
    const box = host.querySelector<HTMLTextAreaElement>('[data-subtask-id="s1"] textarea')!;
    act(() => box.focus());
    measured = 0;
    const base = box.value;
    for (const ch of "补充一句") type(box, box.value + ch);
    expect(box.value).toBe(`${base}补充一句`);
    // 每键只量正在打的这一条（几次之内）；以前是每键把全部展开的子框都量一遍（30条展开时连敲4字132次）
    console.info(`连敲4个字共量高 ${measured} 次`);
    expect(measured).toBeLessThanOrEqual(4 * 3);
  });

  it("撤销式外部改写仍会让对应子框重新量高", () => {
    const box = host.querySelector<HTMLTextAreaElement>('[data-subtask-id="s2"] textarea')!;
    measured = 0;
    act(() => {
      const task = appStore.getState().data.tasks[0];
      appStore.setState({ data: { ...appStore.getState().data, tasks: [{ ...task, subtasks: task.subtasks.map((s) => s.id === "s2" ? { ...s, title: "外面改过的标题\n第二行" } : s) }] } });
    });
    expect(box.value).toBe("外面改过的标题\n第二行");
    expect(measured).toBeGreaterThanOrEqual(1);
  });
});
