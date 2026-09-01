// 本机这份数据的两条「整份换掉」路径：清空、以及从云端拉一份覆盖下来。
//
// 两条都会让本机现有数据消失，所以都写在这里、都带同一套闸门，
// 免得哪天有人在界面上又拼一遍、少拼一道。
//
// 一条底线：**云端有没有那份东西，只认当场同步成功这一个证据**。
// syncStore.dirty 只活在进程内，重启就归零——离线改过的东西会被它谎报成「干净」。

import { appStore, clearUndo, flushSave, haltPersistence } from "./store";
import * as persist from "./persist";
import * as cloud from "./cloud";
import { signOut, syncNowChecked, syncStore } from "./syncCtl";
import type { SyncGate } from "./syncCtl";

/** 闸门没过。跟一般的报错分开，界面据此显示「先导出再清」那条出口 */
export class WipeBlocked extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WipeBlocked";
  }
}

/** 本机这份是不是已经全在云端了。ok 时带上云端版本号，给确认文案用 */
export function checkWipeGate(): Promise<SyncGate> {
  return syncNowChecked();
}

/**
 * 清空这台设备上的橡果数据，并退出登录。
 *
 * 顺序本身就是正确性，一步都不能挪：
 * ① 闸门——当场同步一轮，成功了才往下走（确认框弹着的那几秒用户可能又改了东西，
 *    所以这里再跑一遍，不是重复劳动）
 * ② 停掉一切会写盘的东西并清撤销栈（haltPersistence）
 * ③ 删盘（Rust 侧还会自己判一次「有没有登录过」）
 * ④ 断开登录态
 * ⑤ 清 localStorage 那几个 acorn- 开头的 key
 *
 * 界面负责在这之后 reload。
 */
export async function wipeLocalData(): Promise<{ rev: number }> {
  if (!syncStore.getState().session) {
    // 没登录过账号的人，这条路根本不该可达：他们的数据从来没上过云，删了就是没了
    throw new WipeBlocked("这台设备没有登录云账号，数据从来没上过云，不能清空");
  }
  const gate = await checkWipeGate();
  if (!gate.ok) throw new WipeBlocked(gate.why);

  await haltPersistence();
  try {
    await persist.purgeLocalFiles();
  } catch (e) {
    // 没删成就得把闸门放开，否则用户接着用却一个字都存不下去
    appStore.setState({ wiped: false });
    throw e;
  }
  await signOut();
  persist.clearLocalPrefs();
  return { rev: gate.rev };
}

export interface CloudRestore {
  /** 覆盖下来的是云端第几版 */
  rev: number;
  /** 云端那份里还活着的任务条数 */
  tasks: number;
  /** 覆盖前留的退路文件名（浏览器环境没有文件，是 null） */
  backup: string | null;
}

/**
 * 从云端拉一份，**整份覆盖**本机。版本错位、本机被清空、换了新机器之后的统一恢复路径。
 *
 * 跟同步不是一回事：同步是把两边合起来（本机多出来的会被推上云），
 * 这里要的是云端原样——本机上云端没有的东西**会消失**。所以走 pullOnly 不走 syncOnce。
 *
 * 云端是空的、或者拉取失败时**一个字都不动本机**：先拉到手，再备份，最后才写。
 */
export async function restoreFromCloud(): Promise<CloudRestore> {
  const session = syncStore.getState().session;
  if (!session) throw new Error("先登录云账号，才能把云端那份取回来");

  const pulled = await cloud.pullOnly(session);
  if (!pulled.data) {
    throw new Error("云端还没有数据，没有东西可以覆盖下来（这台设备上的事一条没动）");
  }

  // 先把攒着的写完，留出来的退路才是「覆盖前那一刻」的样子
  await flushSave();

  // 备份是这条单向覆盖路上**唯一**的退路，确认框也白纸黑字承诺过会先备份，
  // 所以它是硬前置：写不成（磁盘满、备份目录被网盘/杀软锁着、移动硬盘掉线、目录只读）
  // 就一个字节都不写。吞掉失败照样覆盖，等于把「本机有、云端没有」的内容直接抹掉。
  //
  // **「没什么可备份的」不算写失败**：snapshotBackup 返回 null 只说明本机还没有数据文件
  // （刚清空过、换了新机器、或者登录后那一轮同步没成），没有旧数据就没有退路可言，
  // 硬前置在这里没有保护对象。把它一并当成失败，会把「清空之后从云端拿回来」
  // 这条唯一的恢复路径堵死，报的原因还是错的（用户的盘既没满也没只读）。
  // 只有真正抛出来的写失败才中止。
  let backup: string | null = null;
  let backupErr: unknown = null;
  try {
    backup = await persist.snapshotBackup("pre-restore");
  } catch (e) {
    backupErr = e;
  }
  if (persist.inTauri && backupErr) {
    const why = backupErr instanceof Error ? backupErr.message : String(backupErr);
    throw new Error(
      `覆盖前的备份没能写成，本机数据一条未动。请确认数据文件夹能写、磁盘还有空间，再试一次。${
        why ? `（原因：${why}）` : ""
      }`,
    );
  }

  await persist.saveData(pulled.data);
  // 不清的话 Ctrl+Z 一按就把覆盖前那份整份写回盘，等于白覆盖
  clearUndo();
  appStore.setState({ data: pulled.data, loaded: true, loadError: null, dataTooNew: null, rescue: null });
  // 版本号跟着走：下一轮同步要报「我是基于第几版改的」，报错了会白白撞一次 409
  const next = { ...session, rev: pulled.rev, syncedAt: new Date().toISOString() };
  await cloud.saveSession(next);
  syncStore.setState({ ...syncStore.getState(), session: next });

  return {
    rev: pulled.rev,
    tasks: pulled.data.tasks.filter((t) => !t.deletedAt).length,
    backup,
  };
}
