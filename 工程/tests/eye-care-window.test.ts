import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EYE_CARE_INTERVAL } from "../src/core/eyeCareClock";

const env = vi.hoisted(() => ({
  settings: { theme: "forest", mode: "light", eyeCareEnabled: false, eyeCareMode: "small" },
  callbacks: new Map<string, (e: { payload: string }) => void>(),
  subscriber: null as null | ((s: unknown, prev: unknown) => void),
  emitTo: vi.fn(async () => {}),
  show: vi.fn(async () => {}), hide: vi.fn(async () => {}),
  setSize: vi.fn(async (_v: unknown) => {}), setPosition: vi.fn(async (_v: unknown) => {}),
}));
vi.mock("../src/core/platform", () => ({ isDesktopShell: true }));
vi.mock("../src/core/store", () => ({
  appStore: {
    getState: () => ({ data: { settings: env.settings } }),
    subscribe: (cb: typeof env.subscriber) => { env.subscriber = cb; },
  },
  showToast: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: string }) => void) => { env.callbacks.set(name, cb); return () => {}; },
  emitTo: env.emitTo,
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: { getByLabel: async () => env } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (_cmd: string, args: { visible: boolean }) => args.visible ? env.show() : env.hide() }));
vi.mock("@tauri-apps/api/window", () => ({
  cursorPosition: async () => ({ x: -600, y: 100 }),
  monitorFromPoint: async () => ({ position: { x: -1920, y: 0 }, size: { width: 1920, height: 1080 }, scaleFactor: 1.5 }),
  currentMonitor: async () => null,
}));
vi.mock("@tauri-apps/api/dpi", () => {
  class Position { constructor(public x: number, public y: number) {} }
  class Size { constructor(public width: number, public height: number) {} }
  return { PhysicalPosition: Position, PhysicalSize: Size };
});

async function settle() { await vi.dynamicImportSettled(); for (let i = 0; i < 40; i++) await Promise.resolve(); }
function cmd(payload: string) { env.callbacks.get("eye-care:cmd")!({ payload }); }
function tick(seconds: number) {
  for (let i = 0; i < seconds; i++) {
    vi.setSystemTime(Date.now() + 1000);
    env.callbacks.get("eye-care:tick")!({ payload: "" });
  }
}
function configure(patch: Partial<typeof env.settings>) {
  const old = env.settings;
  env.settings = { ...old, ...patch };
  env.subscriber!({ data: { settings: env.settings } }, { data: { settings: old } });
}
function lastState() { return env.emitTo.mock.calls[env.emitTo.mock.calls.length - 1] as unknown as [string, string, { phase: string; remain: number }]; }

describe("护眼主窗与独立窗口桥接", () => {
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(0);
    env.settings = { theme: "forest", mode: "light", eyeCareEnabled: false, eyeCareMode: "small" };
    env.callbacks.clear();
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {} }));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("关闭不显示；托盘没有JS timer仍按Rust tick满20分钟显示，skip关闭", async () => {
    const { startEyeCareLoop } = await import("../src/core/eyeCare");
    await startEyeCareLoop();
    tick(EYE_CARE_INTERVAL / 1000);
    await settle();
    expect(env.show).not.toHaveBeenCalled();
    configure({ eyeCareEnabled: true });
    tick(EYE_CARE_INTERVAL / 1000);
    await settle();
    expect(env.show).toHaveBeenCalledTimes(1);
    expect(lastState()[2]).toMatchObject({ phase: "prepare", remain: 10 });
    cmd("skip"); await settle();
    expect(env.hide).toHaveBeenCalled();
    expect(lastState()[2].phase).toBe("waiting");
  });

  it("晚ready只补剩余3秒，禁用立即关闭且不会复活", async () => {
    const { startEyeCareLoop, previewEyeCare } = await import("../src/core/eyeCare");
    env.settings.eyeCareEnabled = true;
    await startEyeCareLoop(); await previewEyeCare(); await settle();
    tick(7); await settle(); cmd("ready"); await settle();
    expect(lastState()[2]).toMatchObject({ phase: "prepare", remain: 3 });
    configure({ eyeCareEnabled: false }); await settle();
    expect(env.hide).toHaveBeenCalled();
    expect(lastState()[2].phase).toBe("off");
    const count = env.show.mock.calls.length;
    tick(60); await settle();
    expect(env.show).toHaveBeenCalledTimes(count);
  });

  it("全屏精确覆盖当前副屏，小窗按DPI居中；不需要setFocus接口", async () => {
    const { startEyeCareLoop, previewEyeCare } = await import("../src/core/eyeCare");
    await startEyeCareLoop();
    configure({ eyeCareMode: "full" });
    await previewEyeCare(); await settle();
    expect(env.setSize).toHaveBeenLastCalledWith({ width: 1920, height: 1080 });
    expect(env.setPosition).toHaveBeenLastCalledWith({ x: -1920, y: 0 });
    expect(env.show).toHaveBeenCalled();
    configure({ eyeCareMode: "small" }); await settle();
    expect(env.setSize).toHaveBeenLastCalledWith({ width: 600, height: 420 });
    expect(env.setPosition).toHaveBeenLastCalledWith({ x: -1260, y: 330 });
  });

  it("窗口已显示时切模式失败也会隐藏，下一次预览可重新打开", async () => {
    const { startEyeCareLoop, previewEyeCare } = await import("../src/core/eyeCare");
    await startEyeCareLoop(); await previewEyeCare(); await settle();
    expect(env.show).toHaveBeenCalledTimes(1);
    env.setSize.mockRejectedValueOnce(new Error("native resize failed"));
    configure({ eyeCareMode: "full" }); await settle();
    expect(env.hide).toHaveBeenCalled();
    const hides = env.hide.mock.calls.length;
    tick(10); await settle();
    expect(env.show).toHaveBeenCalledTimes(1);
    expect(env.hide.mock.calls.length).toBe(hides);
    await previewEyeCare(); await settle();
    expect(env.show).toHaveBeenCalledTimes(2);
  });

  it("显示请求还在途中时禁用，不会留下置顶窗口", async () => {
    const { startEyeCareLoop, previewEyeCare } = await import("../src/core/eyeCare");
    env.settings.eyeCareEnabled = true;
    await startEyeCareLoop();
    let release!: () => void;
    env.setSize.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    await previewEyeCare(); await settle();
    configure({ eyeCareEnabled: false });
    release(); await settle();
    expect(env.show).not.toHaveBeenCalled();
    expect(env.hide).toHaveBeenCalled();
  });
});
