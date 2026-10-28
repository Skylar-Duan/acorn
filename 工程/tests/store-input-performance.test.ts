import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appStore, clearUndo, flushSave, undo, updateTask } from "../src/core/store";
import { defaultData, newTask, type TaskImage } from "../src/core/model";

beforeEach(() => {
  clearUndo();
  appStore.setState({ data: defaultData(), loaded: false, saveError: null, wiped: false });
});
afterEach(async () => { await flushSave(); clearUndo(); vi.restoreAllMocks(); });

it("记录合成大账本中改字和撤销的主线程耗时", () => {
  const image: TaskImage = { id: "image", name: "synthetic.jpg", dataUrl: "data:image/jpeg;base64," + "A".repeat(128 * 1024), width: 640, height: 480, bytes: 98304 };
  const task = newTask({ id: "typing", title: "原名", images: Array.from({ length: 24 }, (_, i) => ({ ...image, id: "image-" + i })) });
  appStore.setState({ data: { ...defaultData(), tasks: [task, ...Array.from({ length: 69 }, (_, i) => newTask({ title: "其他任务" + i }))] } });
  const measurements: number[] = [];
  for (let i = 0; i < 30; i++) {
    let at = performance.now();
    updateTask(task.id, { title: "改字" + i });
    measurements.push(performance.now() - at);
    at = performance.now();
    undo();
    measurements.push(performance.now() - at);
  }
  expect(appStore.getState().data.tasks[0].title).toBe("原名");
  expect(appStore.getState().data.tasks[0].images).toBe(task.images);
  if (import.meta.env.ACORN_INPUT_BENCHMARK === "1") {
    measurements.sort((a, b) => a - b);
    console.log(JSON.stringify({ operations: measurements.length, totalMs: measurements.reduce((a, b) => a + b, 0), medianMs: measurements[30], p95Ms: measurements[57], maxMs: measurements[59] }));
  }
});

it("只改正文及撤销不读取未变图片的内容，未改字段仍保留原引用", () => {
  const readPayload = vi.fn(() => "data:image/jpeg;base64,/9j/2Q==");
  const image: TaskImage = { id: "shared", name: "synthetic.jpg", dataUrl: "", width: 1, height: 1, bytes: 4 };
  Object.defineProperty(image, "dataUrl", { enumerable: true, get: readPayload });
  const task = newTask({ id: "typing", title: "原名", images: [image], subtasks: [{ id: "sub", title: "子任务", done: false, images: [image] }] });
  Object.assign(task, { futureField: { nested: { keep: true } } });
  appStore.setState({ data: { ...defaultData(), tasks: [task] } });
  updateTask(task.id, { title: "新名" });
  undo();
  expect(readPayload).not.toHaveBeenCalled();
  expect(appStore.getState().data.tasks[0].images).toBe(task.images);
  expect(appStore.getState().data.tasks[0].subtasks).toBe(task.subtasks);
  expect(appStore.getState().data.tasks[0]).toHaveProperty("futureField.nested.keep", true);
});
