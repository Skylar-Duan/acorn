import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const flags = vi.hoisted(() => ({ plus: true }));
vi.mock("../src/core/plus", async original => ({ ...await original<typeof import("../src/core/plus")>(), plusEnabled: () => flags.plus, usePlus: () => flags.plus, usePlusCanToggle: () => false }));
import ImageManager from "../src/components/ImageManager";
import Settings from "../src/views/Settings";
import { appStore, flushSave } from "../src/core/store";
import { defaultData, newTask, type TaskImage } from "../src/core/model";
import { syncStore } from "../src/core/syncCtl";
import { IMAGE_LEDGER_MAX_BYTES } from "../src/core/taskImages";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const bytes = [255, 216, 255, 192, 0, 17, 8, 0, 1, 0, 1, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 255, 217];
const image = (id: string): TaskImage => ({ id, name: id + ".jpg", dataUrl: "data:image/jpeg;base64," + btoa(String.fromCharCode(...bytes)), width: 1, height: 1, bytes: bytes.length });
let root: Root, host: HTMLDivElement;
const onClose = vi.fn();
const manager = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="管理图片"]')!;
const ledger = () => JSON.stringify(appStore.getState().data);
const button = (name: string) => [...manager().querySelectorAll<HTMLButtonElement>("button")].find(el => el.textContent?.trim() === name)!;
function click(el: HTMLElement) { act(() => el.click()); }
function renderManager() { act(() => root.render(createElement(ImageManager, { onClose }))); }

beforeEach(async () => {
  await flushSave(); localStorage.clear(); flags.plus = true; onClose.mockReset();
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("External requests blocked"))));
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  const data = defaultData(), a = image("shared"), b = image("other");
  data.tasks = [newTask({ id: "active", title: "母任务", images: [a, b], subtasks: [{ id: "child", title: "子任务", done: false, images: [a] }] }), newTask({ id: "history", title: "已完成历史", done: true, doneAt: "2026-10-20T00:00:00Z", images: [a] })];
  appStore.setState({ data, loaded: true, loadError: null, wiped: false }); syncStore.setState({ session: null });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; await flushSave(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("图片管理真实组件", () => {
  it("单删先确认，取消零写，确认后相同id的母/子/历史引用全部移除", () => {
    renderManager(); expect(manager().querySelectorAll(".image-manager-item")).toHaveLength(2);
    expect(manager().querySelector(".image-manager-owner")?.textContent).toContain("3处");
    const before = ledger(); click(manager().querySelector<HTMLButtonElement>('[aria-label="删除图片 shared.jpg"]')!);
    expect(manager().querySelector('[role="alertdialog"]')).not.toBeNull(); expect(ledger()).toBe(before);
    click(button("取消")); expect(ledger()).toBe(before);
    click(manager().querySelector<HTMLButtonElement>('[aria-label="删除图片 shared.jpg"]')!); click(button("删除图片"));
    expect(manager().querySelectorAll(".image-manager-item")).toHaveLength(1);
    for (const task of appStore.getState().data.tasks) for (const owner of [task, ...task.subtasks]) expect(owner.images?.some(img => img.id === "shared")).not.toBe(true);
    expect(appStore.getState().data.tasks[0].images?.map(img => img.id)).toEqual(["other"]);
    expect(appStore.getState().data.imageSync?.shared.deletedAt).toBeTruthy();
  });

  it("批删数量及确认正确，取消不改数据，确认去掉选中的全部引用", () => {
    renderManager(); click(manager().querySelector<HTMLInputElement>('[aria-label="选择当前全部图片"]')!);
    const before = ledger(); click(button("删除")); expect(manager().querySelector("[role=alertdialog] h3")?.textContent).toBe("删除 2 张图片？");
    click(button("取消")); expect(ledger()).toBe(before);
    click(button("删除")); click(button("删除图片"));
    expect(manager().querySelectorAll(".image-manager-item")).toHaveLength(0);
    expect(appStore.getState().data.tasks.every(task => !task.images?.length && task.subtasks.every(sub => !sub.images?.length))).toBe(true);
  });

  it("批量改为仅本机保留所有bytes，筛选和重新开启同步均正常", () => {
    renderManager(); const original = appStore.getState().data.tasks.map(task => [task.images?.map(img => img.dataUrl), task.subtasks.map(sub => sub.images?.map(img => img.dataUrl))]);
    click(manager().querySelector<HTMLInputElement>('[aria-label="选择当前全部图片"]')!); click(button("仅存本机"));
    expect([...manager().querySelectorAll<HTMLInputElement>(".image-manager-sync input")].every(el => !el.checked)).toBe(true);
    expect(appStore.getState().data.tasks.map(task => [task.images?.map(img => img.dataUrl), task.subtasks.map(sub => sub.images?.map(img => img.dataUrl))])).toEqual(original);
    click(button("云端")); expect(manager().querySelectorAll(".image-manager-item")).toHaveLength(0);
    click(button("本地")); expect(manager().querySelectorAll(".image-manager-item")).toHaveLength(2);
    click(button("云端")); click(button("本地"));
    click(manager().querySelector<HTMLInputElement>('[aria-label="选择当前全部图片"]')!); click(button("同步到云端"));
    expect([...manager().querySelectorAll<HTMLInputElement>(".image-manager-sync input")].every(el => el.checked)).toBe(true);
  });

  it("切换分类清空选择，批量删除只涉及当前可见且重新选择的图片", () => {
    const data = appStore.getState().data;
    data.tasks[1].images = [image("done")]; appStore.setState({ data }); renderManager();
    click(manager().querySelector<HTMLInputElement>('[aria-label="选择当前全部图片"]')!);
    click(button("已完成"));
    expect(manager().querySelectorAll('.image-manager-item.selected')).toHaveLength(0);
    expect(button("删除").disabled).toBe(true);
    click(manager().querySelector<HTMLInputElement>('[aria-label="选择当前全部图片"]')!); click(button("删除"));
    expect(document.querySelector('[role="alertdialog"] h3')?.textContent).toBe("删除 1 张图片？");
    click(button("删除图片"));
    expect(appStore.getState().data.tasks[0].images).toHaveLength(2);
    expect(appStore.getState().data.tasks[1].images).toHaveLength(0);
  });

  it("四分类独立多选，来源内取并集、来源与完成状态组合，重复点可清除", () => {
    const data = appStore.getState().data;
    data.tasks[1].images = [image("done")];
    data.tasks[0].images![1] = { ...data.tasks[0].images![1], sync: false };
    appStore.setState({ data }); renderManager();
    expect(manager().querySelectorAll(".image-manager-filters button")).toHaveLength(4);
    expect(manager().querySelectorAll(".image-manager-item")).toHaveLength(3);
    click(button("已完成")); expect(manager().querySelectorAll(".image-manager-item")).toHaveLength(1);
    expect(manager().querySelector(".image-manager-owner")?.textContent).toContain("已完成历史");
    click(button("本地")); expect(manager().querySelectorAll(".image-manager-item")).toHaveLength(0);
    click(button("未完成")); expect(manager().querySelectorAll(".image-manager-item")).toHaveLength(1);
    click(button("云端")); expect(manager().querySelectorAll(".image-manager-item")).toHaveLength(3);
    for (const name of ["本地", "云端", "已完成", "未完成"]) expect(button(name).getAttribute("aria-pressed")).toBe("true");
    for (const name of ["本地", "云端", "已完成", "未完成"]) click(button(name));
    expect(manager().querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
    expect(manager().querySelectorAll(".image-manager-item")).toHaveLength(3);
  });

  it("云额度不足时开启同步整笔拒绝，本地图和选择状态保留", () => {
    const data = appStore.getState().data, task = data.tasks[0];
    task.images = [{ ...image("huge-cloud"), dataUrl: "data:image/jpeg;base64," + "A".repeat(IMAGE_LEDGER_MAX_BYTES) }, { ...image("only-local"), sync: false }];
    task.subtasks = []; data.tasks = [task]; appStore.setState({ data }); renderManager();
    const before = appStore.getState().data;
    click(manager().querySelector<HTMLInputElement>('[aria-label="云端同步图片 only-local.jpg"]')!);
    expect(manager().querySelector('[role="alert"]')?.textContent).toContain("空间不足");
    expect(appStore.getState().data).toBe(before);
    expect(manager().querySelector<HTMLInputElement>('[aria-label="云端同步图片 only-local.jpg"]')!.checked).toBe(false);
    expect(appStore.getState().data.tasks[0].images).toHaveLength(2);
  });

  it("未知远程或SVG图片不插入img，不发起加载；有效图仍能预览", () => {
    const data = appStore.getState().data;
    data.tasks = [newTask({ title: "带坏图的导入账本", images: [{ ...image("remote"), dataUrl: "https://never-load.invalid/private.jpg" }, { ...image("svg"), dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" }, image("safe")] })];
    appStore.setState({ data }); renderManager();
    expect(manager().querySelectorAll("img")).toHaveLength(1);
    expect(manager().querySelector('img[src^="https:"]')).toBeNull();
    expect(manager().querySelector<HTMLButtonElement>('[aria-label="预览图片 remote.jpg"]')!.disabled).toBe(true);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    click(manager().querySelector<HTMLButtonElement>('[aria-label="预览图片 safe.jpg"]')!);
    expect(document.querySelector(".image-lightbox img")?.getAttribute("src")).toBe(image("safe").dataUrl);
  });

  it("普通或Plus关闭不暴露图片管理入口，原图片仍保留", async () => {
    flags.plus = false; const before = ledger(); await act(async () => root.render(createElement(Settings)));
    expect(document.querySelector(".image-manage-entry")).toBeNull(); expect(document.querySelector('[aria-label="管理图片"]')).toBeNull(); expect(document.querySelector('[aria-label="已完成自动移除云端数据"]')).toBeNull(); expect(ledger()).toBe(before);
  });

  it("图片下方清理开关默认关，开启保留本地图，换号不继承且返回原账号记住偏好", async () => {
    act(() => syncStore.setState({ session: { email: "cleanup-a@example.test", token: "synthetic-a", rev: 1, syncedAt: null } }));
    await act(async () => root.render(createElement(Settings)));
    const toggle = () => document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="已完成自动移除云端数据"]')!;
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    const before = appStore.getState().data.tasks[1].images?.[0].dataUrl;
    click(toggle()); expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(appStore.getState().data.settings.completedImageCleanup).toEqual({ "cleanup-a@example.test": true });
    expect(appStore.getState().data.tasks[1].images?.[0].dataUrl).toBe(before);
    act(() => syncStore.setState({ session: { email: "cleanup-b@example.test", token: "synthetic-b", rev: 1, syncedAt: null } }));
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    act(() => syncStore.setState({ session: { email: "cleanup-a@example.test", token: "synthetic-a2", rev: 1, syncedAt: null } }));
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });

  it("打开管理器后切换账号即时请求关闭，不延用旧账号选择", () => {
    renderManager(); act(() => syncStore.setState({ session: { email: "other@example.test", token: "synthetic-new", rev: 1, syncedAt: null } }));
    expect(onClose).toHaveBeenCalled();
  });
});
