// 冒烟自检：设 ACORN_SMOKE=1 启动时运行——真实走一遍「建任务→完成→落盘→重读校验」，
// 把结果写进数据目录 smoke-report.json 后自动退出。用于安装包验收。

import { addDays, todayYMD } from "./dates";
import { parseQuickAdd } from "./parse";
import { nextOccurrence } from "./recur";
import * as persist from "./persist";
import { addTask, appStore, completeTask, flushSave } from "./store";

interface Step { name: string; pass: boolean; detail?: string }

export async function maybeRunSmoke(): Promise<boolean> {
  if (!persist.inTauri) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  const smoke = await invoke<boolean>("is_smoke").catch(() => false);
  if (!smoke) return false;

  const steps: Step[] = [];
  const check = (name: string, pass: boolean, detail?: string) => steps.push({ name, pass, detail });

  try {
    const today = todayYMD();
    const s0 = appStore.getState();
    check("数据加载", s0.loaded && !s0.loadError, s0.loadError ?? undefined);

    const stamp = `冒烟-${Date.now()}`;
    const id1 = addTask({ title: `${stamp}-待办`, due: today });
    const id2 = addTask({ title: `${stamp}-要完成`, due: today });
    completeTask(id2);
    const after = appStore.getState().data;
    check("建任务", after.tasks.some((t) => t.id === id1));
    check("完成任务", after.tasks.find((t) => t.id === id2)?.done === true);

    await flushSave();
    const reread = await persist.loadData();
    check("落盘后重读", !!reread && reread.tasks.some((t) => t.id === id1) && reread.tasks.find((t) => t.id === id2)?.done === true);

    const p = parseQuickAdd("明天下午3点 交周报 #工作 @李哥 !高", {
      now: new Date(),
      listNames: ["工作"],
    });
    check(
      "中文解析",
      p.due === addDays(today, 1) && p.dueTime === "15:00" && p.listName === "工作" && p.who === "李哥" && p.priority === 3,
      JSON.stringify(p),
    );

    const n = nextOccurrence({ kind: "monthly", day: 31 }, "2026-01-31");
    check("循环引擎", n === "2026-02-28", n);

    const backups = await persist.listBackups();
    check("每日备份", backups.length >= 1, `${backups.length} 份`);
  } catch (e) {
    check("异常", false, String(e));
  }

  const ok = steps.every((s) => s.pass);
  await persist.writeSmokeReport(JSON.stringify({ ok, at: new Date().toISOString(), steps }, null, 2)).catch(() => {});
  const { invoke: inv2 } = await import("@tauri-apps/api/core");
  await inv2("exit_app").catch(() => {});
  return true;
}
