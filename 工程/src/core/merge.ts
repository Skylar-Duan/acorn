// 两台设备各改各的，合到一起怎么算——云同步的心脏。
//
// 口径（用户能理解的话）：
//   · 同一件事两边都改过 → **谁改得晚听谁的**（整条替换，不逐字段拼，免得拼出一条谁都没写过的事）
//   · 只有一边有 → 留着（除非另一边留了「已彻底删除」的墓碑，且删得比这次改动晚）
//   · 专注记录只增不减 → 两边合并去重
//   · 设置（主题、快捷键这些）**不同步**，各机器各的
//
// 为什么不逐字段合并：任务是一个整体（改了日期往往连带改了提醒和顺延计数），
// 逐字段拼会产出「日期是 A 机的、提醒是 B 机的」这种自相矛盾的记录。
// 整条替换最多丢掉「晚的那次改动之前、早的那次改动之后」的一点内容，代价可预期。
//
// **未知字段随赢家整条走**（v1.9.1）：赢的那条记录是原对象直接放进结果，不重建，
// 所以更新版本的橡果写进去的字段老客户端合一遍也一个不少。顶层同理——
// 返回值先铺 remote 再铺 local 再覆盖已知键，两边任何一边的顶层未知集合都留得住
// （同名时听本机的，跟「设置不同步」一个口径）。

import type { AppData, FocusSession, List, Task, Tombstone } from "./model";
import { DATA_VERSION, pruneGraveyard } from "./model";

/** 有 id 和 updatedAt 的东西（任务和清单都算） */
interface Stamped {
  id: string;
  updatedAt: string;
}

/** 谁改得晚听谁的；一样晚就听本机的（免得两台机器来回打架永远收敛不了） */
function pickNewer<T extends Stamped>(local: T | undefined, remote: T | undefined): T | undefined {
  if (local === undefined) return remote;
  if (remote === undefined) return local;
  return remote.updatedAt > local.updatedAt ? remote : local;
}

function mergeStamped<T extends Stamped>(
  localList: T[],
  remoteList: T[],
  graves: Map<string, string>,
): T[] {
  const localById = new Map(localList.map((x) => [x.id, x]));
  const remoteById = new Map(remoteList.map((x) => [x.id, x]));
  const out: T[] = [];
  const ids = new Set([...localById.keys(), ...remoteById.keys()]);
  for (const id of ids) {
    const winner = pickNewer(localById.get(id), remoteById.get(id));
    if (winner === undefined) continue;
    const buried = graves.get(id);
    // 墓碑只有在「删得比这次改动还晚」时才算数——否则等于把一条改回来的事又杀掉
    if (buried !== undefined && buried >= winner.updatedAt) continue;
    out.push(winner);
  }
  return out;
}

/** 专注记录的身份：同一个任务同一次开始，就是同一条 */
function sessionKey(s: FocusSession): string {
  return `${s.taskId ?? ""}|${s.startedAt}`;
}

function mergeSessions(local: FocusSession[], remote: FocusSession[]): FocusSession[] {
  const byKey = new Map<string, FocusSession>();
  for (const s of [...local, ...remote]) {
    const k = sessionKey(s);
    const prev = byKey.get(k);
    // 同一条两边分钟数不同（一边中途关机没记全）取大的，专注时长只多不少
    if (prev === undefined || s.minutes > prev.minutes) byKey.set(k, s);
  }
  return [...byKey.values()].sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
}

export interface MergeResult {
  data: AppData;
  /** 给用户看的一句话：这次同步实际发生了什么 */
  summary: { added: number; updated: number; removed: number };
}

/**
 * 把云端那份并进本机这份。
 * 返回的是新的一整份数据 —— 设置永远取本机的，云端的设置不覆盖你这台机器。
 */
export function mergeData(local: AppData, remote: AppData, now = Date.now()): MergeResult {
  const graveList = pruneGraveyard([...(local.graveyard ?? []), ...(remote.graveyard ?? [])], now);
  const graves = new Map(graveList.map((g) => [g.id, g.at]));

  const tasks = mergeStamped<Task>(local.tasks, remote.tasks, graves);
  const lists = mergeStamped<List>(local.lists, remote.lists, graves);

  const localIds = new Set(local.tasks.map((t) => t.id));
  const localById = new Map(local.tasks.map((t) => [t.id, t]));
  const finalIds = new Set(tasks.map((t) => t.id));
  let added = 0;
  let updated = 0;
  for (const t of tasks) {
    if (!localIds.has(t.id)) added++;
    else if (localById.get(t.id) !== t) updated++;
  }
  const removed = local.tasks.filter((t) => !finalIds.has(t.id)).length;

  return {
    data: {
      // 先 remote 后 local：两边的顶层未知集合都带走，同名时本机那份赢
      ...remote,
      ...local,
      // 版本号取三者最大。写死 DATA_VERSION 的那些年，本机每同步一次就把
      // 「这份是第 7 版」降回 6，云端的 schema 棘轮也跟着被这台老设备拉回去
      version: Math.max(local.version || 0, remote.version || 0, DATA_VERSION),
      lists,
      tasks,
      sessions: mergeSessions(local.sessions ?? [], remote.sessions ?? []),
      settings: local.settings, // 设置不同步：主题/快捷键是这台机器的事
      graveyard: graveList,
    },
    summary: { added, updated, removed },
  };
}

/** 记一笔墓碑（彻底删除时调用）。同一个 id 只留最晚那次 */
export function bury(graveyard: Tombstone[], ids: string[], at: string): Tombstone[] {
  if (ids.length === 0) return graveyard;
  return pruneGraveyard([...graveyard, ...ids.map((id) => ({ id, at }))]);
}
