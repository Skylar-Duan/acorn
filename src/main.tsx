import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/themes.css";
import "./styles/base.css";
import "./styles/app.css";
import { addList, addTask, allTags, allWho, appStore, initStore, showToast } from "./core/store";
import { LIST_COLORS } from "./core/model";
import { startThemeSync } from "./core/themeCtl";
import { startReminderLoop } from "./core/reminders";
import { wireFocusCommands } from "./core/focusCtl";
import { applyQuickAddShortcut } from "./core/shortcutCtl";
import { inTauri } from "./core/persist";
import { maybeRunSmoke } from "./core/smoke";
import { flushSync, initSync } from "./core/syncCtl";
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
  void initSync(); // 有登录态就恢复出来顺手同步一轮；没有就什么都不做，绝不阻塞启动

  if (inTauri) {
    const { listen, emitTo } = await import("@tauri-apps/api/event");

    // 托盘「退出」：先冲掉未落盘数据再真正退出
    await listen("app:quit", async () => {
      await flushSync(); // 落盘 + 尽力推一把（最多等 3 秒，推不上去也照常退出）
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("exit_app");
    });

    // 快速添加小窗的数据桥：小窗不碰数据文件，一切经主窗落库
    await listen("quickadd:pull", async () => {
      const d = appStore.getState().data;
      await emitTo("quickadd", "quickadd:context", {
        listNames: d.lists.map((l) => l.name),
        tagNames: allTags(d).map((t) => t.tag),
        whoNames: allWho(d).map((w) => w.who),
        theme: d.settings.theme,
        mode: d.settings.mode,
      });
    });
    await listen<AddTaskInput & { listName?: string | null }>("quickadd:submit", (e) => {
      const s = appStore.getState();
      // 数据没加载成功时不接收——此时任何写入都会拿空库覆盖磁盘真数据
      if (!s.loaded || s.loadError) {
        showToast("数据尚未就绪（数据文件夹不可用？），这条没有收下", false);
        return;
      }
      const { listName, ...input } = e.payload;
      let listId: string | null = null;
      if (listName) {
        const hit = s.data.lists.find((l) => l.name === listName);
        // /新清单 自动创建
        listId = hit ? hit.id : addList(listName, LIST_COLORS[s.data.lists.length % LIST_COLORS.length]);
      }
      addTask({ ...input, listId });
      showToast("已收下 🌰", false);
    });
  }
})();
