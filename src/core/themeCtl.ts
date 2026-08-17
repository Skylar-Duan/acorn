// 主题应用：把 settings 的 theme/mode 落到 <html> 属性上；system 模式跟随系统。

import { appStore } from "./store";

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

export function startThemeSync() {
  applyTheme();
  appStore.subscribe((s, prev) => {
    if (s.data.settings.theme !== prev.data.settings.theme || s.data.settings.mode !== prev.data.settings.mode) {
      applyTheme();
    }
  });
  media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", () => {
    if (appStore.getState().data.settings.mode === "system") applyTheme();
  });
}
