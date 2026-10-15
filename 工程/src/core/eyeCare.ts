// 只有主窗拥有计时；独立提醒窗只接收状态、回传按钮，不读写账本。
import { appStore, showToast } from "./store";
import { isDesktopShell } from "./platform";
import { EyeCareClock } from "./eyeCareClock";
import type { EyeCarePhase } from "./eyeCareClock";

export interface EyeCareState {
  phase: EyeCarePhase;
  remain: number;
  theme: string;
  mode: "light" | "dark";
  display: "small" | "full";
}

let clock: EyeCareClock | null = null;
let startPromise: Promise<void> | null = null;
let queue = Promise.resolve();
let revision = 0;
let shownKey = "";

async function setVisible(visible: boolean): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("eye_care_visibility", { visible });
}

function snapshot(): EyeCareState {
  const s = appStore.getState().data.settings;
  return {
    phase: clock?.phase ?? "off",
    remain: clock?.remaining(Date.now()) ?? 0,
    theme: s.theme,
    mode: s.mode === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : s.mode,
    display: s.eyeCareMode === "full" ? "full" : "small",
  };
}

function publish(): void {
  const state = snapshot();
  const key = clock?.active ? state.display : "";
  const changed = key !== shownKey;
  if (!key && !changed) return;
  if (changed) revision++;
  const rev = revision;
  shownKey = key;
  queue = queue.then(async () => {
    const { emitTo } = await import("@tauri-apps/api/event");
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const w = await WebviewWindow.getByLabel("eye-care");
    if (!w) throw new Error("护眼窗口不存在");
    if (rev !== revision) return;
    await emitTo("eye-care", "eye-care:state", state);
    if (!key) { await setVisible(false); return; }
    if (!changed) return;
    const { cursorPosition, monitorFromPoint, currentMonitor } = await import("@tauri-apps/api/window");
    const { PhysicalPosition, PhysicalSize } = await import("@tauri-apps/api/dpi");
    const cursor = await cursorPosition().catch(() => null);
    const mon = (cursor ? await monitorFromPoint(cursor.x, cursor.y).catch(() => null) : null)
      ?? await currentMonitor().catch(() => null);
    // 用无边框窗口铺满鼠标所在显示器，不进入会强切焦点/桌面的系统独占全屏。
    if (mon) {
      const scale = mon.scaleFactor;
      const width = key === "full" ? mon.size.width : Math.round(400 * scale);
      const height = key === "full" ? mon.size.height : Math.round(280 * scale);
      const x = key === "full" ? mon.position.x : mon.position.x + Math.max(0, (mon.size.width - width) / 2);
      const y = key === "full" ? mon.position.y : mon.position.y + Math.max(0, (mon.size.height - height) / 2);
      // 先跨到目标屏触发DPI切换，再写最终物理尺寸，避免WM_DPICHANGED二次缩放。
      await w.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));
      await w.setSize(new PhysicalSize(width, height));
      await w.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));
    }
    if (rev !== revision || !clock?.active) { await setVisible(false); return; }
    await setVisible(true); // Windows每次均SW_SHOWNOACTIVATE，不经过Tao重复show的激活分支。
    if (rev !== revision || !clock?.active) await setVisible(false);
  }).catch(async () => {
    if (rev !== revision) return;
    revision++;
    shownKey = "";
    // 窗口失败只反馈一次，下次周期仍可重试，不影响任务。
    if (clock?.active) { clock.reset(Date.now()); showToast("护眼提醒暂时打不开，请重新打开橡果后再试", false); }
    await setVisible(false).catch(() => {});
  });
}

export async function startEyeCareLoop(): Promise<void> {
  if (!isDesktopShell) return;
  if (startPromise) return startPromise;
  startPromise = (async () => {
    clock = new EyeCareClock(Date.now());
    clock.configure(appStore.getState().data.settings.eyeCareEnabled === true, Date.now());
    const { listen } = await import("@tauri-apps/api/event");
    // Rust 的桌面时钟不受托盘隐藏后的浏览器计时节流影响。
    await listen("eye-care:tick", () => { clock!.tick(Date.now()); publish(); });
    await listen<string>("eye-care:cmd", (e) => {
      if (e.payload === "skip") clock!.reset(Date.now());
      // ready 包括晚加载/重载的窗口，只补当前状态，绝不重新开启计时。
      if (e.payload === "ready") {
        void import("@tauri-apps/api/event").then(({ emitTo }) => emitTo("eye-care", "eye-care:state", snapshot())).catch(() => {});
        shownKey = "";
      }
      publish();
    });
    appStore.subscribe((s, prev) => {
      const a = s.data.settings, b = prev.data.settings;
      if (a.eyeCareEnabled !== b.eyeCareEnabled) clock!.configure(a.eyeCareEnabled === true, Date.now());
      if (a.eyeCareEnabled !== b.eyeCareEnabled || a.eyeCareMode !== b.eyeCareMode || a.theme !== b.theme || a.mode !== b.mode) publish();
    });
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", publish);
    publish();
  })();
  return startPromise;
}

export async function previewEyeCare(): Promise<void> {
  await startEyeCareLoop();
  if (!clock) return;
  clock.preview(Date.now());
  shownKey = "";
  publish();
}
