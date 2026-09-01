// 专注控制：主窗是唯一状态源（常驻内存，即使隐藏也在跑）；
// 迷你浮窗只负责显示与回传按钮命令。

import { appStore, logFocus, setFocusState, showToast } from "./store";
import { inTauri } from "./persist";

let tick: ReturnType<typeof setInterval> | null = null;
let pausedRemainMs: number | null = null;
/** 当前连续运行段的起点（暂停会结束一段，继续开新一段） */
let segStartMs = 0;
/** 已结束的运行段累计毫秒（真实专注时间 = accumulated + 当前段） */
let accumulatedMs = 0;

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
    // 多显示器：必须叠加显示器自身的原点偏移，否则副屏上会定位到主屏甚至屏外
    const ox = mon.position.x / mon.scaleFactor;
    const oy = mon.position.y / mon.scaleFactor;
    const sw = mon.size.width / mon.scaleFactor;
    const sh = mon.size.height / mon.scaleFactor;
    const { LogicalPosition } = await import("@tauri-apps/api/dpi");
    await w.setPosition(new LogicalPosition(Math.round(ox + sw - 320), Math.round(oy + sh - 170)));
  }
  await w.show();
}

async function hideFocusWindow() {
  if (!inTauri) return;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const w = await WebviewWindow.getByLabel("focus");
  await w?.hide();
}

/** 真实已专注毫秒：不含暂停；当前段封顶到 endsAt（合盖睡过头不算专注） */
function earnedMs(): number {
  const s = appStore.getState().focus;
  let ms = accumulatedMs;
  if (s.running && s.endsAt) {
    ms += Math.max(0, Math.min(Date.now(), s.endsAt) - segStartMs);
  }
  return ms;
}

export async function startFocus(taskId: string | null, minutes?: number) {
  // 已有一轮在跑/暂停：先按「手动停止」结算掉，已专注的分钟不丢
  const prev = appStore.getState().focus;
  if (prev.running || prev.totalMinutes > 0) await stopFocus(true);

  const s = appStore.getState();
  const min = minutes ?? s.data.settings.focusMinutesDefault;
  segStartMs = Date.now();
  accumulatedMs = 0;
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
  accumulatedMs += Math.max(0, Math.min(Date.now(), s.endsAt) - segStartMs);
  setFocusState({ running: false, endsAt: null });
  await broadcast();
}

export async function resumeFocus() {
  if (pausedRemainMs == null) return;
  segStartMs = Date.now();
  setFocusState({ running: true, endsAt: Date.now() + pausedRemainMs });
  pausedRemainMs = null;
  await broadcast();
}

/** 手动停止：真实专注的分钟数照记（≥1 分钟才记；暂停与睡眠时间不算） */
export async function stopFocus(log = true) {
  const s = appStore.getState().focus;
  if (tick) { clearInterval(tick); tick = null; }
  const elapsedMin = Math.floor(earnedMs() / 60000);
  if (log && elapsedMin >= 1) {
    logFocus(s.taskId, Math.min(elapsedMin, s.totalMinutes));
  }
  pausedRemainMs = null;
  accumulatedMs = 0;
  setFocusState({ taskId: null, running: false, endsAt: null, totalMinutes: 0 });
  await hideFocusWindow();
}

async function onTick() {
  const s = appStore.getState().focus;
  if (!s.running || !s.endsAt) return;
  if (Date.now() >= s.endsAt) {
    if (tick) { clearInterval(tick); tick = null; }
    // 按真实运行时间记（正常跑完 = totalMinutes；中途睡过去的只记睡前部分）
    const earned = Math.min(Math.round(earnedMs() / 60000), s.totalMinutes);
    if (earned >= 1) logFocus(s.taskId, earned);
    showToast(`已记录专注 ${earned} 分钟`, false);
    void notifyDone(earned);
    pausedRemainMs = null;
    accumulatedMs = 0;
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
    if (granted) sendNotification({ title: "专注完成", body: `本轮 ${minutes} 分钟已记录。` });
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
