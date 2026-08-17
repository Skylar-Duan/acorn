import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/themes.css";
import "./styles/base.css";
import "./styles/app.css";
import { initStore, addTask, appStore, flushSave, showToast } from "./core/store";
import { startThemeSync } from "./core/themeCtl";
import { startReminderLoop } from "./core/reminders";
import { wireFocusCommands } from "./core/focusCtl";
import { applyQuickAddShortcut } from "./core/shortcutCtl";
import { inTauri } from "./core/persist";
import { maybeRunSmoke } from "./core/smoke";
import type { AddTaskInput } from "./core/store";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

void (async () => {
  await initStore();
  startThemeSync();

  if (await maybeRunSmoke()) return; // 冒烟模式：跑完自检直接退出

  startReminderLoop();
  await wireFocusCommands();
  await applyQuickAddShortcut();

  if (inTauri) {
    const { listen, emitTo } = await import("@tauri-apps/api/event");

    // 托盘「退出」：先冲掉未落盘数据再真正退出
    await listen("app:quit", async () => {
      await flushSave();
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("exit_app");
    });

    // 快速添加小窗的数据桥：小窗不碰数据文件，一切经主窗落库
    await listen("quickadd:pull", async () => {
      const d = appStore.getState().data;
      await emitTo("quickadd", "quickadd:context", {
        listNames: d.lists.map((l) => l.name),
        theme: d.settings.theme,
        mode: d.settings.mode,
      });
    });
    await listen<AddTaskInput & { listName?: string | null }>("quickadd:submit", (e) => {
      const { listName, ...input } = e.payload;
      const listId = listName ? appStore.getState().data.lists.find((l) => l.name === listName)?.id ?? null : null;
      addTask({ ...input, listId });
      showToast("已收下 🌰", false);
    });
  }
})();
