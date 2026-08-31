import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/themes.css";
import "./styles/base.css";
import "./styles/app.css";
import { addList, addTask, appStore, initStore, showToast } from "./core/store";
import { LIST_COLORS } from "./core/model";
import { startThemeSync } from "./core/themeCtl";
import { windowContext } from "./core/windowCtx";
import { startReminderLoop } from "./core/reminders";
import { wireFocusCommands } from "./core/focusCtl";
import { applyQuickAddShortcut } from "./core/shortcutCtl";
import { inTauri } from "./core/persist";
import { hasDesktopFeatures, isMobile } from "./core/platform";
import { maybeRunSmoke } from "./core/smoke";
import { dailySyncIfNeeded, flushSync, initSync } from "./core/syncCtl";
import { checkUpdateOnBoot } from "./core/updateCtl";
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

  // 每次打开都查一次版本。放在 maybeRunSmoke 之后：冒烟验收不该多打一次网络请求。
  // **void 不 await**：查更新挡不得启动，断网时那 12 秒超时也不能让人干等。
  // 只放这儿——quickadd.html / focus.html 是各自独立的入口，写进共享模块就变成开机查三遍
  void checkUpdateOnBoot();

  void initSync(); // 有登录态就恢复出来顺手同步一轮；没有就什么都不做，绝不阻塞启动

  // 每天至少同步一次。同步一直是「本地改了东西才传」，一台设备光看不改就永远拉不到
  // 另一台的更新；桌面版常驻托盘还可能好几天不重启，光靠启动那一轮不够。
  // 「没打开过就不算」——不做后台任务也不定时唤醒，只在应用重新回到眼前时补一轮。
  // 一律 void 不 await：这是后台行为，挡不得任何操作；没网就静默跳过，不打扰。
  //
  // 这两个事件来得很密：alt-tab 一次、关掉说明窗回主窗一次、从托盘恢复一次。
  // dailySyncIfNeeded 自己那道「今天试过就早退」只按日期算，所以这儿再加一道最短间隔，
  // 免得一分钟内被触发十几次（真要同步，改了东西那条防抖路照样会发）
  const FOCUS_SYNC_GAP_MS = 10 * 60 * 1000;
  let lastFocusSync = 0;
  const onBackToApp = () => {
    const now = Date.now();
    if (now - lastFocusSync < FOCUS_SYNC_GAP_MS) return;
    lastFocusSync = now;
    void dailySyncIfNeeded();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") onBackToApp();
  });
  // 托盘恢复窗口时 visibilitychange 不一定会来（窗口只是隐藏不是标签页切走），focus 兜一道
  window.addEventListener("focus", onBackToApp);

  // 专注浮窗和全局快捷键都要「第二个窗口 / 系统级热键」，手机上都没有，
  // 硬调会在启动最早期抛错，把整个 App 卡在白屏
  if (hasDesktopFeatures) {
    await wireFocusCommands();
    await applyQuickAddShortcut();
  }

  // 手机上没有「退出」这个动作——系统随时可能在后台把 App 干掉。
  // 所以一切进后台就立刻落盘 + 尽力同步，不能等下次启动
  if (isMobile) {
    const onHide = () => {
      if (document.visibilityState === "hidden") void flushSync();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", () => void flushSync());
  }

  if (inTauri && hasDesktopFeatures) {
    const { listen, emitTo } = await import("@tauri-apps/api/event");

    // 托盘「退出」：先冲掉未落盘数据再真正退出
    await listen("app:quit", async () => {
      await flushSync(); // 落盘 + 尽力推一把（最多等 3 秒，推不上去也照常退出）
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("exit_app");
    });

    // 独立窗口一律不碰数据文件：补全候选和主题都由主窗下发（windowContext 在
    // core/windowCtx.ts，themeCtl 换主题时也用同一份往说明窗补发），写入也一律经主窗

    // 快速添加小窗的数据桥
    await listen("quickadd:pull", async () => {
      await emitTo("quickadd", "quickadd:context", windowContext());
    });
    // 说明窗只显示，不写任何东西
    await listen("guide:pull", async () => {
      await emitTo("guide", "guide:context", windowContext());
    });
    await listen<AddTaskInput & { listName?: string | null }>("quickadd:submit", (e) => {
      const s = appStore.getState();
      // 数据没加载成功时不接收——此时任何写入都会拿空库覆盖磁盘真数据。
      // 磁盘上那份比本机新时同样不收（收了也存不下去，见 store.doSave）。
      // wiped：用户刚清空了本机，正等着 reload，这会儿收下也只会石沉大海
      if (!s.loaded || s.loadError || s.dataTooNew || s.wiped) {
        showToast("数据尚未就绪（数据文件夹不可用），这一条没有保存", false);
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
      showToast("已记录", false);
    });
  }
})();
