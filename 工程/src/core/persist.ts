// 存取层：Tauri 环境走 Rust 命令（原子写 + 备份）；纯浏览器（vite dev / 测试）退回 localStorage。

import type { AppData } from "./model";
import { DATA_VERSION, migrate } from "./model";
import { unpack } from "./transfer";

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function inv<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export interface DataStatus {
  dir: string;
  dirOk: boolean; // 目录存在且可写
  hasFile: boolean;
}

const LS_KEY = "acorn-data";

export async function dataStatus(): Promise<DataStatus> {
  if (!inTauri) return { dir: "(浏览器 localStorage)", dirOk: true, hasFile: localStorage.getItem(LS_KEY) != null };
  return inv<DataStatus>("data_status");
}

export interface LoadResult {
  /** 文件不存在时是 null（首次运行） */
  data: AppData | null;
  /** 磁盘上那份数据的模型版本（认不出来时按 DATA_VERSION 算，等于「不当回事」） */
  schema: number;
  /** **磁盘上那份比本机新**：只是一个事实，供界面提示。**不是拒绝加载的理由** */
  tooNew: boolean;
}

/** 载入数据。
 *
 *  走 unpack 而不是直接 migrate：本地文件同样可能比本机新——降级安装、恢复一份新版本做的备份、
 *  或者数据目录放在两台机器共用的移动硬盘上（这个项目就是这么用的）。
 *  这种文件**照读**（v1.9.1 起）：不认识的字段原样留着，界面顶上给一条可关的提示条。
 *  能这么读是有前提的——migrate 顶层先铺开、墓碑不重建、version 取 max，三条缺一不可，
 *  缺了任何一条，读一次存一次就吃掉一层新数据。
 *
 *  unpack 解不出来的（文件损坏、根本不是橡果的数据）维持原样走 migrate：那条路通向
 *  「空账本 + 找回数据屏」，是现成的兜底，不要顺手改成报错。 */
export async function loadData(): Promise<LoadResult> {
  const raw = inTauri ? await inv<string | null>("load_data") : localStorage.getItem(LS_KEY);
  if (!raw) return { data: null, schema: DATA_VERSION, tooNew: false };
  const parsed = JSON.parse(raw) as unknown;
  const res = unpack(parsed);
  if (!res.ok) return { data: migrate(parsed), schema: DATA_VERSION, tooNew: false };
  return { data: res.data, schema: res.schema, tooNew: res.tooNew };
}

export async function saveData(data: AppData): Promise<void> {
  const json = JSON.stringify(data);
  if (!inTauri) {
    localStorage.setItem(LS_KEY, json);
    return;
  }
  await inv("save_data", { json });
}

/** 当天首存前调用：滚动每日备份（保留 30 份），返回是否新建了备份 */
export async function ensureDailyBackup(): Promise<boolean> {
  if (!inTauri) return false;
  return inv<boolean>("ensure_daily_backup");
}

export interface BackupInfo { name: string; size: number }

export async function listBackups(): Promise<BackupInfo[]> {
  if (!inTauri) return [];
  return inv<BackupInfo[]>("list_backups");
}

/** 恢复前会先把当前数据另存一份 pre-restore 备份 */
export async function restoreBackup(name: string): Promise<void> {
  await inv("restore_backup", { name });
}

/** 覆盖类操作之前先把当前数据留一份备份，返回备份文件名。
 *  **返回 null 有两种，都不是失败**：浏览器环境没有文件系统；本机压根还没有 data.json
 *  （刚清空过、新机器、登录后那一轮同步没成）。真正写不进去时 Rust 侧抛错。
 *  前缀只收 Rust 侧登记过的那几个（BACKUP_PREFIXES）——它要拼进文件名，
 *  而清空本机时是照着这一组前缀删的 */
export async function snapshotBackup(prefix: string): Promise<string | null> {
  if (!inTauri) return null;
  return inv<string | null>("snapshot_backup", { prefix });
}

/** 把这台设备上的橡果数据删干净：data.json 与它的中间态、backups/ 里橡果自己写的那些、
 *  冒烟报告、登录令牌，并清空 config.json 的 recentDirs。返回真正清过的目录。
 *  **Rust 侧自己会拒绝没登录过账号的调用**，这里不是唯一的闸门。 */
export async function purgeLocalFiles(): Promise<string[]> {
  if (!inTauri) {
    localStorage.removeItem(LS_KEY);
    return [];
  }
  return inv<string[]>("purge_local_data");
}

/** 清空本机会动到哪些目录。确认框在弹之前调一次，把路径逐条列给用户看——
 *  数据文件夹是用户拿文件夹选择器随便挑的，换过几次之后旧目录也在名单里，
 *  他得在按下确定之前看见 `D:\我的文档` 这种自己的通用文件夹也在其中 */
export async function purgeTargets(): Promise<string[]> {
  if (!inTauri) return [];
  return inv<string[]>("list_purge_targets");
}

/** 清空本机之后那一次启动的一次性标记：读到就清掉，只生效一次。
 *
 *  用途：那一次启动**不许建默认账本**。defaultData() 带两条每次都换新 id 的清单
 *  「工作」「生活」，落了盘用户一登录就把它们推上云，云端和另一台设备各多出一对。
 *
 *  标记存在 Rust 侧的 config.json 里，**不能放 localStorage**——清空的最后一步
 *  clearLocalPrefs() 会把 `acorn-` 开头的 key 全扫掉，放那儿等于没放。 */
export async function takeFreshStart(): Promise<boolean> {
  if (!inTauri) return false;
  return inv<boolean>("take_fresh_start");
}

/** 界面偏好那几个 localStorage key（折叠状态、侧栏展开、计划页页签、日历筛选、令牌回退位）。
 *  一律按 `acorn-` 前缀扫——列白名单迟早漏掉新加的那个 */
export function clearLocalPrefs(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("acorn-")) doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
  } catch {
    /* 存储不可用就算了，本来也没存下什么 */
  }
}

export interface DataCandidate {
  dir: string;
  tasks: number;
  lists: number;
  modified: string;
}

/** 扫一遍数据可能待着的地方（指针丢了、换了机器、装机工具把指针写歪了都靠它兜底） */
export async function findDataCandidates(): Promise<DataCandidate[]> {
  if (!inTauri) return [];
  return inv<DataCandidate[]>("find_data_candidates");
}

export async function getDataDir(): Promise<string> {
  if (!inTauri) return "(浏览器)";
  return inv<string>("get_data_dir");
}

export async function setDataDir(dir: string): Promise<void> {
  await inv("set_data_dir", { dir });
}

export async function writeSmokeReport(json: string): Promise<void> {
  await inv("write_smoke_report", { json });
}

/** 导出：path 必须来自系统保存对话框 */
export async function writeTextFile(path: string, content: string): Promise<void> {
  await inv("write_text_file", { path, content });
}

/** 导入：path 必须来自系统打开对话框 */
export async function readTextFile(path: string): Promise<string> {
  return inv<string>("read_text_file", { path });
}
