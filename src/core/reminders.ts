// 提醒调度：常驻主窗，每 20 秒扫一遍。到点 → 系统通知 + 应用内 toast，
// 然后清掉 reminder（循环任务完成时会随新落点重新带上提醒）。

import { appStore, requestSave, showToast } from "./store";
import { nowLocalDT, todayYMD } from "./dates";
import { ensureDailyBackup, inTauri } from "./persist";

let timer: ReturnType<typeof setInterval> | null = null;
let lastBackupDay = "";

async function fire(title: string, body: string) {
  if (inTauri) {
    try {
      const { isPermissionGranted, requestPermission, sendNotification } = await import(
        "@tauri-apps/plugin-notification"
      );
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      if (granted) sendNotification({ title, body });
    } catch {
      // 系统通知失败退回应用内提示
    }
  }
  showToast(`⏰ ${body}`, false);
}

function sweep() {
  const s = appStore.getState();
  if (!s.loaded) return;
  // 托盘常驻可能几十天不重启：跨天时在这里补每日备份
  const today = todayYMD();
  if (today !== lastBackupDay) {
    lastBackupDay = today;
    void ensureDailyBackup().catch(() => {});
  }
  const now = nowLocalDT();
  // 放弃的跟做完的、删掉的一样不再提醒：都说了不做了还弹一下，那是纯打扰。
  // 注意提醒本身**不清空**——取消放弃之后它得原样回来（真到点了会在下一轮 sweep 里补响）
  const dueOnes = s.data.tasks.filter(
    (t) => !t.done && !t.droppedAt && !t.deletedAt && t.reminder && t.reminder <= now,
  );
  if (!dueOnes.length) return;
  for (const t of dueOnes) {
    void fire("橡果 · 提醒", t.title || "有一条任务到时间了");
  }
  // 直接改 store（不进撤销栈——提醒消费不是用户动作）
  appStore.setState({
    data: {
      ...s.data,
      tasks: s.data.tasks.map((t) =>
        dueOnes.some((d) => d.id === t.id) ? { ...t, reminder: null } : t,
      ),
    },
  });
  requestSave();
}

export function startReminderLoop() {
  if (timer) clearInterval(timer);
  timer = setInterval(sweep, 20000);
  sweep();
}
