// 专注控制：主窗是唯一状态源（常驻内存，即使隐藏也在跑）；
// 迷你浮窗只负责显示与回传按钮命令。

import { appStore, logFocus, setFocusState, showToast } from "./store";
import { inTauri } from "./persist";

let tick: ReturnType<typeof setInterval> | null = null;
let pausedRemainMs: number | null = null;
let startedAtMs = 0;

interface FocusBroadcast {
  title: string;
  endsAt: number | null;
  paused: boolean;
  remainMs: number;
}

async function broadcast() {
  const s = appStore.getState();
  const t = s.focus.taskId ? s.data.tasks.find((x) => x.id === s.focus.taskId) : null;
  const payload: FocusBroadcast = {
    title: t?.title ?? "专注",
    endsAt: s.focus.endsAt,
    paused: !s.focus.running,
    remainMs: pausedRemainMs ?? Math.max(0, (s.focus.endsAt ?? 0) - Date.now()),
  };
  if (inTauri) {
    const { emitTo } = await import("@tauri-apps/api/event");
    await emitTo("focus", "focus:state", payload).catch(() => {});
  }
}

async function showFocusWindow() {
  if (!inTauri) return;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const { currentMonitor } = await import("@tauri-apps/api/window");
  const w = await WebviewWindow.getByLabel("focus");
  if (!w) return;
  const mon = await currentMonitor().catch(() => null);
  if (mon) {
    const sw = mon.size.width / mon.scaleFactor;
    const sh = mon.size.height / mon.scaleFactor;
    const { LogicalPosition } = await import("@tauri-apps/api/dpi");
    await w.setPosition(new LogicalPosition(Math.round(sw - 320), Math.round(sh - 170)));
  }
  await w.show();
}

async function hideFocusWindow() {
  if (!inTauri) return;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const w = await WebviewWindow.getByLabel("focus");
  await w?.hide();
}

export async function startFocus(taskId: string | null, minutes?: number) {
  const s = appStore.getState();
  const min = minutes ?? s.data.settings.focusMinutesDefault;
  startedAtMs = Date.now();
  pausedRemainMs = null;
  setFocusState({ taskId, running: true, endsAt: Date.now() + min * 60000, totalMinutes: min });
  if (tick) clearInterval(tick);
  tick = setInterval(onTick, 1000);
  await showFocusWindow();
  await broadcast();
}

export async function pauseFocus() {
  const s = appStore.getState().focus;
  if (!s.running || !s.endsAt) return;
  pausedRemainMs = Math.max(0, s.endsAt - Date.now());
  setFocusState({ running: false, endsAt: null });
  await broadcast();
}

export async function resumeFocus() {
  if (pausedRemainMs == null) return;
  setFocusState({ running: true, endsAt: Date.now() + pausedRemainMs });
  pausedRemainMs = null;
  await broadcast();
}

/** 手动停止：已专注的分钟数照记（≥1 分钟才记） */
export async function stopFocus(log = true) {
  const s = appStore.getState().focus;
  if (tick) { clearInterval(tick); tick = null; }
  const elapsedMin = Math.floor((Date.now() - startedAtMs) / 60000);
  if (log && s.taskId !== undefined && elapsedMin >= 1) {
    logFocus(s.taskId, Math.min(elapsedMin, s.totalMinutes));
  }
  pausedRemainMs = null;
  setFocusState({ taskId: null, running: false, endsAt: null, totalMinutes: 0 });
  await hideFocusWindow();
}

async function onTick() {
  const s = appStore.getState().focus;
  if (!s.running || !s.endsAt) return;
  if (Date.now() >= s.endsAt) {
    if (tick) { clearInterval(tick); tick = null; }
    logFocus(s.taskId, s.totalMinutes);
    showToast(`🍅 专注 ${s.totalMinutes} 分钟完成`, false);
    void notifyDone(s.totalMinutes);
    pausedRemainMs = null;
    setFocusState({ taskId: null, running: false, endsAt: null, totalMinutes: 0 });
    await hideFocusWindow();
    return;
  }
  await broadcast();
}

async function notifyDone(minutes: number) {
  if (!inTauri) return;
  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import(
      "@tauri-apps/plugin-notification"
    );
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title: "专注完成", body: `这一轮 ${minutes} 分钟收进口袋了，歇口气。` });
  } catch {
    // 通知失败不影响主流程
  }
}

/** 主窗监听浮窗按钮命令 */
export async function wireFocusCommands() {
  if (!inTauri) return;
  const { listen } = await import("@tauri-apps/api/event");
  await listen<string>("focus:cmd", (e) => {
    if (e.payload === "pause") void pauseFocus();
    else if (e.payload === "resume") void resumeFocus();
    else if (e.payload === "stop") void stopFocus();
  });
}
