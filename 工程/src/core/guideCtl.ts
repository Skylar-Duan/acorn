// 「一句话记事」说明窗：桌面上是一个独立窗口，静态声明在 tauri.conf.json 里，
// 跟 quickadd / focus 一样常驻隐藏、只 show/hide 不 close。
//
// 手机上没有第二个 webview（tauri.android.conf.json 只声明 main），
// 硬调 getByLabel 会抛错，所以先过 hasDesktopFeatures，返回 false 让调用方改开应用内弹层。
import { inTauri } from "./persist";
import { hasDesktopFeatures } from "./platform";

/** 打开说明窗。返回 false = 这里开不了独立窗口，调用方应该退化成应用内弹层 */
export async function openGuide(): Promise<boolean> {
  if (!inTauri || !hasDesktopFeatures) return false;
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const w = await WebviewWindow.getByLabel("guide");
    if (!w) return false;
    await w.show();
    await w.setFocus();
    // 让窗口重新拉一次清单/标签/需求方/主题，并把卡片的「今天」重算
    const { emitTo } = await import("@tauri-apps/api/event");
    await emitTo("guide", "guide:show", {});
    return true;
  } catch {
    return false;
  }
}
