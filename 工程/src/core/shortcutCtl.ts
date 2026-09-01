// 全局快捷键：唤起「随手记一条」小窗。注册失败（被别的软件占了）不致命，提示即可。

import { appStore, showToast } from "./store";
import { inTauri } from "./persist";

let current: string | null = null;

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
export async function applyQuickAddShortcut(next?: string): Promise<boolean> {
  if (!inTauri) return true;
  const want = next ?? appStore.getState().data.settings.quickAddShortcut;
  if (current === want) return true;
  try {
    const gs = await import("@tauri-apps/plugin-global-shortcut");
    await gs.register(want, (e) => {
      if (e.state === "Pressed") void showQuickAdd();
    });
    if (current) await gs.unregister(current).catch(() => {});
    current = want;
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
