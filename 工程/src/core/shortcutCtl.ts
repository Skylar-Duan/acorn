// 全局快捷键：唤起「随手记一条」小窗。注册失败（被别的软件占了）不致命，提示即可。

import { appStore, showToast } from "./store";
import { inTauri } from "./persist";

let current: string | null = null;
let registered = false;
let captureCount = 0;
// 弹窗打开、保存和关闭可能连续发生，按顺序处理原生注册，避免旧请求盖掉新键。
let pending: Promise<unknown> = Promise.resolve();
function ordered<T>(action: () => Promise<T>): Promise<T> {
  const next = pending.then(action, action);
  pending = next.catch(() => {});
  return next;
}

/** 录制时先停掉旧系统热键，让原来的组合也能被键盘采集。 */
export function suspendQuickAddShortcut(): Promise<void> {
  captureCount += 1;
  return ordered(async () => {
    if (!inTauri || !current || !registered) return;
    const gs = await import("@tauri-apps/plugin-global-shortcut");
    await gs.unregister(current);
    registered = false;
  });
}

export async function resumeQuickAddShortcut(): Promise<boolean> {
  try { return await applyQuickAddShortcut(); }
  finally { captureCount = Math.max(0, captureCount - 1); }
}

async function showQuickAdd() {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const w = await WebviewWindow.getByLabel("quickadd");
  if (!w) return;
  await w.show();
  await w.setFocus();
  const { emitTo } = await import("@tauri-apps/api/event");
  await emitTo("quickadd", "quickadd:show", {});
}

/** 注册/更换全局快捷键。先注册新键、成功才注销旧键——失败时旧键保持可用并把设置回滚 */
export function applyQuickAddShortcut(next?: string): Promise<boolean> {
  return ordered(() => registerQuickAddShortcut(next));
}

async function registerQuickAddShortcut(next?: string): Promise<boolean> {
  if (!inTauri) return true;
  const want = next ?? appStore.getState().data.settings.quickAddShortcut;
  if (current === want && registered) return true;
  try {
    const gs = await import("@tauri-apps/plugin-global-shortcut");
    await gs.register(want, (e) => {
      if (e.state === "Pressed" && captureCount === 0) void showQuickAdd();
    });
    if (current && registered) await gs.unregister(current).catch(() => {});
    current = want;
    registered = true;
    return true;
  } catch {
    showToast(`快捷键 ${want} 注册失败（可能被占用），保持原设置`, false);
    if (current) {
      const { updateSettings } = await import("./store");
      updateSettings({ quickAddShortcut: current });
    }
    return false;
  }
}
