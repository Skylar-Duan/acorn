import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ apply: vi.fn(), suspend: vi.fn(), resume: vi.fn(), update: vi.fn() }));
vi.mock("../src/core/shortcutCtl", () => ({ applyQuickAddShortcut: native.apply, suspendQuickAddShortcut: native.suspend, resumeQuickAddShortcut: native.resume }));
vi.mock("../src/core/store", () => ({ updateSettings: native.update }));
import ShortcutRecorder from "../src/components/ShortcutRecorder";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label || b.getAttribute("aria-label") === label);
  if (!button) throw new Error(`找不到按钮 ${label}`);
  await act(async () => { button.click(); });
}
async function keys(code: string, key: string, modifiers: KeyboardEventInit = {}) {
  await act(async () => {
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", { code, key, bubbles: true, cancelable: true, ...modifiers }));
    target.dispatchEvent(new KeyboardEvent("keyup", { code, key, bubbles: true, cancelable: true, ...modifiers }));
  });
}
beforeEach(async () => {
  vi.clearAllMocks();
  native.apply.mockResolvedValue(true); native.suspend.mockResolvedValue(undefined); native.resume.mockResolvedValue(true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(createElement(ShortcutRecorder, { value: "Alt+Space" })); });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("快捷键录制弹窗", () => {
  it("点击才开始录制，按键不触发外层导航，保存前不改设置", async () => {
    expect(document.querySelector("input")).toBeNull(); expect(native.suspend).not.toHaveBeenCalled();
    await click("Alt+Space");
    const navigation = vi.fn(); document.addEventListener("keydown", navigation);
    await keys("KeyK", "k", { ctrlKey: true });
    expect(navigation).not.toHaveBeenCalled();
    expect(document.querySelector('[role="status"]')?.textContent).toContain("橡果");
    expect(native.update).not.toHaveBeenCalled();
    await keys("KeyA", "a", { ctrlKey: true, shiftKey: true });
    expect([...document.querySelectorAll("kbd")].map((e) => e.textContent)).toEqual(["Ctrl", "Shift", "A"]);
    expect(native.apply).not.toHaveBeenCalled();
    await click("保存");
    expect(native.apply).toHaveBeenCalledWith("Ctrl+Shift+A");
    expect(native.update).toHaveBeenCalledWith({ quickAddShortcut: "Ctrl+Shift+A" });
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(native.resume).toHaveBeenCalledOnce();
    document.removeEventListener("keydown", navigation);
  });
  it("重置只改弹窗草稿，取消和 Escape 保留原设置", async () => {
    await click("Alt+Space"); await keys("KeyA", "a", { ctrlKey: true });
    await click("重置为默认");
    expect([...document.querySelectorAll("kbd")].map((e) => e.textContent)).toEqual(["Alt", "Space"]);
    expect(native.update).not.toHaveBeenCalled();
    await click("取消"); expect(native.apply).not.toHaveBeenCalled(); expect(native.resume).toHaveBeenCalledOnce();
    await click("Alt+Space"); await keys("Escape", "Escape");
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(native.update).not.toHaveBeenCalled();
  });
  it("窗口和录制区失焦都不提交或收起，回来仍可显式保存草稿", async () => {
    await click("Alt+Space"); await keys("KeyA", "a", { ctrlKey: true, shiftKey: true });
    await act(async () => {
      (document.activeElement as HTMLElement).blur();
      window.dispatchEvent(new Event("blur"));
    });
    expect(native.apply).not.toHaveBeenCalled(); expect(native.update).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect([...document.querySelectorAll("kbd")].map((e) => e.textContent)).toEqual(["Ctrl", "Shift", "A"]);
    await click("保存"); expect(native.update).toHaveBeenCalledWith({ quickAddShortcut: "Ctrl+Shift+A" });
  });
  it("系统注册失败保留弹窗与原设置，可重新录制保存", async () => {
    native.apply.mockResolvedValueOnce(false);
    await click("Alt+Space"); await keys("KeyA", "a", { ctrlKey: true, shiftKey: true }); await click("保存");
    expect(document.querySelector('[role="status"]')?.textContent).toContain("占用"); expect(native.update).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await keys("KeyB", "b", { ctrlKey: true, shiftKey: true }); await click("保存");
    expect(native.update).toHaveBeenCalledWith({ quickAddShortcut: "Ctrl+Shift+B" });
  });
  it("超出三个键时只显示三个，禁用保存；窗口失焦后可重新录制", async () => {
    await click("Alt+Space");
    await keys("KeyA", "a", { ctrlKey: true, altKey: true, shiftKey: true });
    expect(document.querySelectorAll("kbd")).toHaveLength(3);
    expect([...document.querySelectorAll("button")].find((b) => b.textContent === "保存")?.disabled).toBe(true);
    await act(async () => { window.dispatchEvent(new Event("blur")); });
    await keys("KeyA", "a", { ctrlKey: true, shiftKey: true });
    expect([...document.querySelectorAll("button")].find((b) => b.textContent === "保存")?.disabled).toBe(false);
  });
});
