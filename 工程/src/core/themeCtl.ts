// 主题应用：把 settings 的 theme/mode 落到 <html> 属性上；system 模式跟随系统。

import { inTauri } from "./persist";
import { hasDesktopFeatures } from "./platform";
import { appStore } from "./store";
import { windowContext } from "./windowCtx";

let media: MediaQueryList | null = null;

function resolveMode(mode: "light" | "dark" | "system"): "light" | "dark" {
  if (mode !== "system") return mode;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme() {
  const { theme, mode } = appStore.getState().data.settings;
  const el = document.documentElement;
  el.dataset.theme = theme;
  el.dataset.mode = resolveMode(mode);
}

/** 说明窗是独立 webview，改不了自己的主题——它只在打开那一刻发一次 guide:pull。
 *  所以主窗每次换主题/深浅色都得主动补发一次，否则开着的说明窗停在旧配色，
 *  两块屏幕对不上，只能关掉重开。
 *  窗口没开着（或压根没有第二个 webview）时 emitTo 什么也不做，不必先问它在不在；
 *  真出错也只吞掉——换主题不该因为一个说明窗而失败。 */
function pushGuideContext() {
  if (!inTauri || !hasDesktopFeatures) return;
  void (async () => {
    try {
      const { emitTo } = await import("@tauri-apps/api/event");
      await emitTo("guide", "guide:context", windowContext());
    } catch {
      /* 说明窗不在 / 事件通道没起来，都不影响主窗自己换主题 */
    }
  })();
}

export function startThemeSync() {
  applyTheme();
  appStore.subscribe((s, prev) => {
    if (s.data.settings.theme !== prev.data.settings.theme || s.data.settings.mode !== prev.data.settings.mode) {
      applyTheme();
      pushGuideContext();
    }
  });
  media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", () => {
    if (appStore.getState().data.settings.mode === "system") {
      applyTheme();
      pushGuideContext();
    }
  });
}
