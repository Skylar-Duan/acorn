import { beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ register: vi.fn(), unregister: vi.fn(), show: vi.fn(), focus: vi.fn(), emit: vi.fn(), update: vi.fn(), toast: vi.fn() }));
vi.mock("../src/core/persist", () => ({ inTauri: true }));
vi.mock("../src/core/store", () => ({ appStore: { getState: () => ({ data: { settings: { quickAddShortcut: "Alt+Space" } } }) }, updateSettings: native.update, showToast: native.toast }));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({ register: native.register, unregister: native.unregister }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: { getByLabel: async () => ({ show: native.show, setFocus: native.focus }) } }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: native.emit }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); native.register.mockResolvedValue(undefined); native.unregister.mockResolvedValue(undefined);
});
describe("原生快捷键录制隔离", () => {
  it("先注销旧键、屏蔽已排队的原生回调；取消时恢复旧键", async () => {
    const ctl = await import("../src/core/shortcutCtl");
    await ctl.applyQuickAddShortcut();
    const callback = native.register.mock.calls[0][1];
    await ctl.suspendQuickAddShortcut();
    expect(native.unregister).toHaveBeenCalledWith("Alt+Space");
    callback({ state: "Pressed" }); await Promise.resolve(); expect(native.show).not.toHaveBeenCalled();
    await ctl.resumeQuickAddShortcut();
    expect(native.register.mock.calls.map((call) => call[0])).toEqual(["Alt+Space", "Alt+Space"]);
    callback({ state: "Pressed" });
    await vi.waitFor(() => expect(native.show).toHaveBeenCalledOnce());
  });
  it("新键注册失败时旧设置不丢失，取消仍恢复旧键", async () => {
    const ctl = await import("../src/core/shortcutCtl");
    await ctl.applyQuickAddShortcut(); await ctl.suspendQuickAddShortcut();
    native.register.mockRejectedValueOnce(new Error("occupied"));
    expect(await ctl.applyQuickAddShortcut("Ctrl+Shift+A")).toBe(false);
    await ctl.resumeQuickAddShortcut();
    expect(native.register.mock.calls.map((call) => call[0])).toEqual(["Alt+Space", "Ctrl+Shift+A", "Alt+Space"]);
  });
  it("快速取消也等待注销完成再恢复，不留下热键空档", async () => {
    const ctl = await import("../src/core/shortcutCtl"); await ctl.applyQuickAddShortcut();
    let release!: () => void;
    native.unregister.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const suspension = ctl.suspendQuickAddShortcut(); const restoration = ctl.resumeQuickAddShortcut();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(native.register).toHaveBeenCalledOnce(); release(); await suspension; await restoration;
    expect(native.register).toHaveBeenCalledTimes(2);
  });
});
