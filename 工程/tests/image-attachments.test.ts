import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const flags = vi.hoisted(() => ({ ultra: true, mobile: false, compress: vi.fn() }));
vi.mock("../src/core/version", async (original) => ({ ...await original<typeof import("../src/core/version")>(), get IS_ULTRA() { return flags.ultra; } }));
vi.mock("../src/core/platform", async (original) => ({ ...await original<typeof import("../src/core/platform")>(), get isMobile() { return flags.mobile; } }));
vi.mock("../src/core/imageCompression", async (original) => ({ ...await original<typeof import("../src/core/imageCompression")>(), compressTaskImage: flags.compress }));
import ImageAttachments from "../src/components/ImageAttachments";
import TaskCard from "../src/components/TaskCard";
import QuickAddBar from "../src/components/QuickAddBar";
import { defaultData, newTask, type TaskImage } from "../src/core/model";
import { appStore, deleteTasks, flushSave, undo, updateTask, useApp } from "../src/core/store";
import { syncStore } from "../src/core/syncCtl";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const jpegHeader = [255, 216, 255, 192, 0, 17, 8, 0, 1, 0, 1, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 255, 217];
const image: TaskImage = { id: "new-photo", name: "合成图.jpg", dataUrl: `data:image/jpeg;base64,${btoa(String.fromCharCode(...jpegHeader))}`, width: 1, height: 1, bytes: jpegHeader.length };
let root: Root; let host: HTMLDivElement;
const getTask = () => appStore.getState().data.tasks.find((t) => t.id === "image-task")!;
function Existing() {
  const task = useApp((s) => s.data.tasks.find((t) => t.id === "image-task"));
  if (!task || task.deletedAt) return null;
  return createElement(ImageAttachments, { images: task.images, canEdit: () => !!appStore.getState().data.tasks.find((t) => t.id === task.id && !t.deletedAt), onChange: (images) => updateTask(task.id, { images }) });
}
async function selectFiles(files = [new File(["synthetic"], "合成图.png", { type: "image/png" })]) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}
function button(label: string) { return [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!; }

beforeEach(async () => {
  await flushSave(); while (appStore.getState().undoDepth > 0) undo(); await flushSave(); localStorage.clear();
  flags.ultra = true; flags.mobile = false; flags.compress.mockReset().mockResolvedValue(image);
  syncStore.setState({ session: null });
  appStore.setState({ data: { ...defaultData(), tasks: [newTask({ id: "image-task", title: "图片任务" })] }, loaded: true, loadError: null, wiped: false, undoDepth: 0 });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { act(() => root.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); await flushSave(); });

describe("Ultra图片入口", () => {
  it("普通版/手机没有图片、数量和入口，记录字段仍完整保留", () => {
    updateTask("image-task", { images: [image] });
    for (const [ultra, mobile] of [[false, false], [true, true]]) {
      flags.ultra = ultra; flags.mobile = mobile;
      act(() => root.render(createElement(TaskCard, { task: getTask() })));
      expect(document.querySelector("img")).toBeNull(); expect(document.querySelector('input[type="file"]')).toBeNull();
      expect(document.querySelector("[data-task-images]")).toBeNull();
      expect(getTask().images).toEqual([image]);
    }
  });
  it("Ultra离线可以添加，放大预览和删图，撤销恢复", async () => {
    act(() => root.render(createElement(Existing)));
    await selectFiles();
    expect(getTask().images).toEqual([image]);
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="放大图片 合成图.jpg"]')!.click());
    expect(document.querySelector('[aria-label="图片预览"]')).not.toBeNull();
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[aria-label="图片预览"]')).toBeNull();
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="删除图片 合成图.jpg"]')!.click());
    expect(getTask().images).toEqual([]); act(() => undo()); expect(getTask().images).toEqual([image]);
  });
  it("取消选择或处理失败不会写任务", async () => {
    act(() => root.render(createElement(Existing)));
    await selectFiles([]); expect(flags.compress).not.toHaveBeenCalled();
    flags.compress.mockRejectedValue(new Error("图片处理失败"));
    await selectFiles(); expect(getTask().images).toBeUndefined(); expect(document.querySelector('[role="alert"]')?.textContent).toBe("图片处理失败");
  });
  it.each(["取消", "换账号", "删目标"])("压缩未完成时%s，结果不会误写", async (action) => {
    let finish!: (value: TaskImage) => void;
    flags.compress.mockImplementation(() => new Promise<TaskImage>((resolve) => { finish = resolve; }));
    act(() => root.render(createElement(Existing)));
    await selectFiles();
    act(() => {
      if (action === "取消") button("取消").click();
      else if (action === "换账号") syncStore.setState({ session: { email: "synthetic@example.com", token: "synthetic", rev: 0, syncedAt: null } });
      else deleteTasks(["image-task"]);
    });
    await act(async () => finish(image));
    expect(getTask().images).toBeUndefined();
  });
  it("创建任务携带图片草稿，提交成功后清空图片", async () => {
    act(() => root.render(createElement(QuickAddBar)));
    await selectFiles();
    const input = document.querySelector<HTMLInputElement>('.si-input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "新图片任务");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(appStore.getState().data.tasks.find((t) => t.title === "新图片任务")?.images).toEqual([image]);
    expect(document.querySelector(".task-image-thumb")).toBeNull();
  });
  it("图片仍在处理时回车保留整句，处理完成后再保存不会把图片带到下一件事", async () => {
    let finish!: (value: TaskImage) => void;
    flags.compress.mockImplementation(() => new Promise<TaskImage>((resolve) => { finish = resolve; }));
    act(() => root.render(createElement(QuickAddBar)));
    await selectFiles();
    const input = document.querySelector<HTMLInputElement>('.si-input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "等待图片的任务");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(appStore.getState().data.tasks.some((t) => t.title === "等待图片的任务")).toBe(false);
    expect(input.value).toBe("等待图片的任务");
    await act(async () => finish(image));
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(appStore.getState().data.tasks.find((t) => t.title === "等待图片的任务")?.images).toEqual([image]);
    expect(document.querySelector(".task-image-thumb")).toBeNull();
  });
});
