// 存取层：Tauri 环境走 Rust 命令（原子写 + 备份）；纯浏览器（vite dev / 测试）退回 localStorage。

import type { AppData } from "./model";
import { migrate } from "./model";

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

/** 载入数据；文件不存在返回 null（首次运行） */
export async function loadData(): Promise<AppData | null> {
  if (!inTauri) {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? migrate(JSON.parse(raw)) : null;
  }
  const raw = await inv<string | null>("load_data");
  return raw ? migrate(JSON.parse(raw)) : null;
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
