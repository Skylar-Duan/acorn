import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultData, newTask, type TaskImage } from "../src/core/model";
import { fitJpeg, imageHeaderSize } from "../src/core/imageCompression";
import { renderableTaskImages } from "../src/core/imageDisplay";
import { IMAGE_LEDGER_MAX_BYTES, IMAGE_MAX_BYTES, imageListUpdateError, imageSourceError, imageTargetSize, ledgerImageBytes } from "../src/core/taskImages";
import { addSubtask, addTask, appStore, completeTask, deleteTasks, flushSave, removeSubtask, restoreSubtask, restoreTask, toggleSubtask, undo, updateSubtask, updateTask } from "../src/core/store";

const jpeg = (id = "image", bytes = 4): TaskImage => ({ id, name: "合成图片.jpg", dataUrl: `data:image/jpeg;base64,${"A".repeat(Math.ceil(bytes / 3) * 4).slice(0, Math.ceil(bytes / 3) * 4 - (bytes % 3 ? 3 - bytes % 3 : 0))}${bytes % 3 ? "=".repeat(3 - bytes % 3) : ""}`, width: 800, height: 600, bytes });
beforeEach(async () => {
  await flushSave(); while (appStore.getState().undoDepth > 0) undo(); await flushSave(); localStorage.clear();
  appStore.setState({ data: defaultData(), loaded: true, loadError: null, wiped: false, undoDepth: 0 });
});
afterEach(async () => { await flushSave(); });

describe("图片压缩与额度", () => {
  it("保持比例、不放大小图，1920是最长边", () => {
    expect(imageTargetSize(6000, 4000)).toEqual({ width: 1920, height: 1280 });
    expect(imageTargetSize(400, 800)).toEqual({ width: 400, height: 800 });
    expect(imageTargetSize(3000, 6000)).toEqual({ width: 960, height: 1920 });
  });
  it("拒绝超大原图、像素炸弹与未知文件头", () => {
    expect(imageSourceError(21 * 1024 * 1024)).toContain("20 MB");
    expect(imageSourceError(1000, 9000, 9000)).toContain("4000 万");
    expect(imageSourceError(1000, 18000, 10)).toContain("4000 万");
    expect(imageHeaderSize(new Uint8Array([1, 2, 3]))).toBeNull();
    const png = new Uint8Array(24); png.set([137, 80, 78, 71]); const view = new DataView(png.buffer); view.setUint32(16, 1920); view.setUint32(20, 1280);
    expect(imageHeaderSize(png)).toEqual({ width: 1920, height: 1280 });
  });
  it("先降质量再缩图，最终体积不超过256KiB，处理串行", async () => {
    let active = 0; let max = 0; const calls: number[][] = [];
    const result = await fitJpeg(5000, 4000, async (width, height, quality) => {
      active++; max = Math.max(max, active); calls.push([width, height, quality]); await Promise.resolve(); active--;
      return jpeg("x", width > 1500 ? IMAGE_MAX_BYTES + 1 : IMAGE_MAX_BYTES).dataUrl;
    });
    expect(max).toBe(1); expect(result.bytes).toBe(IMAGE_MAX_BYTES); expect(result.width).toBe(1440);
    expect(calls.slice(0, 4).map((c) => c[2])).toEqual([0.86, 0.72, 0.58, 0.44]);
  });
  it("取消后不继续编码", async () => {
    let valid = true; let calls = 0;
    await expect(fitJpeg(5000, 4000, async () => { calls++; valid = false; return jpeg("x", IMAGE_MAX_BYTES + 1).dataUrl; }, () => valid)).rejects.toThrow("取消");
    expect(calls).toBe(1);
  });
  it("每件数量和本机总量不限，单张256KiB，总量计历史和回收站的dataURL", () => {
    const data = defaultData();
    expect(imageListUpdateError(data, [], Array.from({ length: 9 }, (_, i) => jpeg(String(i))))).toBeNull();
    expect(imageListUpdateError(data, [], [jpeg("x", IMAGE_MAX_BYTES + 1)])).toContain("大小");
    expect(imageListUpdateError(data, [], [jpeg()], IMAGE_LEDGER_MAX_BYTES)).toBeNull();
    data.tasks = [newTask({ title: "历史", done: true, deletedAt: "2026-10-16T00:00:00Z", images: [jpeg()], subtasks: [{ id: "s", title: "步骤", done: true, images: [jpeg("s")] }] })];
    expect(ledgerImageBytes(data)).toBe(jpeg().dataUrl.length * 2);
  });
  it("已超云额度仍允许本机新增图片、删图与纯文字更新", () => {
    const data = defaultData(); const current = [jpeg("a"), jpeg("b")];
    expect(imageListUpdateError(data, current, [current[0]], IMAGE_LEDGER_MAX_BYTES + 100)).toBeNull();
    expect(imageListUpdateError(data, current, [...current, jpeg("c")], IMAGE_LEDGER_MAX_BYTES)).toBeNull();
  });
  it("显示过滤拒绝远程URL和伪造尺寸的解码炸弹，原数组不动", () => {
    const png = new Uint8Array(24); png.set([137, 80, 78, 71]);
    const view = new DataView(png.buffer); view.setUint32(16, 50000); view.setUint32(20, 50000);
    const malicious = [
      { ...jpeg(), dataUrl: "https://outside.invalid/private.png" },
      { ...jpeg(), dataUrl: `data:image/png;base64,${btoa(String.fromCharCode(...png))}`, width: 1, height: 1 },
      { ...jpeg(), dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" },
      { futureImageFormat: true }, null,
    ] as unknown as TaskImage[];
    const original = JSON.stringify(malicious);
    expect(renderableTaskImages(malicious)).toEqual([]);
    expect(JSON.stringify(malicious)).toBe(original);
    view.setUint32(16, 640); view.setUint32(20, 480);
    const safe = { ...jpeg(), dataUrl: `data:image/png;base64,${btoa(String.fromCharCode(...png))}` };
    expect(renderableTaskImages([safe])).toEqual([safe]);
  });
});

describe("内联图片沿用任务生命周期", () => {
  it("新增任务/子任务图片可撤销，删除恢复图片不丢", () => {
    const id = addTask({ title: "图片任务", images: [jpeg()] });
    addSubtask(id, "图片步骤", { images: [jpeg("sub")] });
    const subId = appStore.getState().data.tasks.find((t) => t.id === id)!.subtasks[0].id;
    removeSubtask(id, subId); restoreSubtask(id, subId);
    expect(appStore.getState().data.tasks.find((t) => t.id === id)!.subtasks[0].images).toEqual([jpeg("sub")]);
    deleteTasks([id]); restoreTask(id);
    expect(appStore.getState().data.tasks.find((t) => t.id === id)!.images).toEqual([jpeg()]);
    updateSubtask(id, subId, { images: [] }); undo();
    expect(appStore.getState().data.tasks.find((t) => t.id === id)!.subtasks[0].images).toEqual([jpeg("sub")]);
  });
  it("循环历史与本体都保留任务和子图片，子循环推进也保留", () => {
    const id = addTask({ title: "循环图片任务", due: "2026-10-16", repeat: { kind: "daily", every: 1 }, images: [jpeg()] });
    addSubtask(id, "循环步骤", { due: "2026-10-16", repeat: { kind: "daily", every: 1 }, images: [jpeg("sub")] });
    const subId = appStore.getState().data.tasks.find((t) => t.id === id)!.subtasks[0].id;
    toggleSubtask(id, subId); completeTask(id);
    for (const task of appStore.getState().data.tasks.filter((t) => t.title === "循环图片任务")) {
      expect(task.images).toEqual([jpeg()]); expect(task.subtasks[0].images).toEqual([jpeg("sub")]);
    }
  });
  it("存量图片超限不阻止普通版改字/完成，也允许删除旧图片", () => {
    const images = Array.from({ length: 9 }, (_, i) => jpeg(String(i)));
    const task = newTask({ id: "legacy", title: "老图片", images });
    appStore.setState({ data: { ...defaultData(), tasks: [task] } });
    updateTask(task.id, { title: "只改文字" }); completeTask(task.id);
    expect(appStore.getState().data.tasks[0]).toMatchObject({ title: "只改文字", done: true, images });
    updateTask(task.id, { images: images.slice(0, 8) });
    expect(appStore.getState().data.tasks[0].images).toHaveLength(8);
  });
});
