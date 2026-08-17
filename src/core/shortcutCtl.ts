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

export async function applyQuickAddShortcut(next?: string): Promise<void> {
  if (!inTauri) return;
  const want = next ?? appStore.getState().data.settings.quickAddShortcut;
  try {
    const gs = await import("@tauri-apps/plugin-global-shortcut");
    if (current && current !== want) {
      await gs.unregister(current).catch(() => {});
      current = null;
    }
    if (current === want) return;
    await gs.register(want, (e) => {
      if (e.state === "Pressed") void showQuickAdd();
    });
    current = want;
  } catch (err) {
    showToast(`全局快捷键 ${want} 注册失败（可能被占用）`, false);
  }
}
