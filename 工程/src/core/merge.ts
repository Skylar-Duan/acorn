// 两台设备各改各的，合到一起怎么算——云同步的心脏。
//
// 口径（用户能理解的话）：
//   · 同一件事两边都改过 → **谁改得晚听谁的**（整条替换，不逐字段拼，免得拼出一条谁都没写过的事）
//   · 只有一边有 → 留着（除非另一边留了「已彻底删除」的墓碑，且删得比这次改动晚）
//   · 专注记录只增不减 → 两边合并去重
//   · 设置（主题、快捷键这些）**不同步**，各机器各的
//
// 文件末尾还住着三件相关但**不在每轮同步里跑**的事，全都只在登录那一刻用一次（见 loginCtl.ts）：
//   · dedupeListsByName —— 同名清单并一条。合并只认 id 不认名字，
//     两台设备各自的默认清单「工作」会并排站着；
//   · dedupeSameTasks   —— 两边各存了一份的同一件事只留一条（用户 2026-09-03 要的「交集不要重复」）；
//   · keepLocalOverCloud —— 用户选「用这台设备上的那份」时，给云端独有的东西立墓碑。
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

// ---------- 同名清单去重 ----------

export interface ListDedupe {
  data: AppData;
  /** 折掉了几条重名清单 */
  folded: number;
  /** 有几条任务被改挂到留下的那条清单上 */
  moved: number;
}

/** 同名清单里留哪一条。**只看数据本身，不看它是本机的还是云端的**——
 *  几台设备各自算一遍必须算出同一个答案，否则你删我的、我删你的，永远收敛不了。
 *
 *  排序口径（依次）：
 *  ① 挂着的任务多的留下 —— 重名的这一对里，一条是真在用的，另一条多半是
 *     新设备刚装出来的空默认清单。留空的那条等于让所有任务集体搬家，纯属折腾
 *  ② 一样多就留**老**的 —— 老的那条是先有的，颜色、位置都是用户排过的
 *  ③ 还一样就比 id —— 纯粹为了「两台设备算出同一个答案」，没有别的含义 */
function keeperRank(a: List, b: List, count: Map<string, number>): number {
  const ca = count.get(a.id) ?? 0;
  const cb = count.get(b.id) ?? 0;
  if (ca !== cb) return cb - ca;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

/**
 * 把名字一样的清单并成一条。
 *
 * 为什么要有这件事：新装的橡果自带「工作 / 生活」两条默认清单，每次都是新的 id。
 * 用户一登录，合并只认 id 不认名字，云端那条「工作」和本机这条「工作」就并排站着，
 * 侧栏上出现两个一模一样的「工作」，谁也分不清哪个是哪个（用户 2026-09-02 报的就是这个）。
 *
 * 做法：同名的一组里留一条（口径见 keeperRank），其余的
 * ① 把挂在它们名下的任务改挂到留下的那条上，并**重新盖改动时刻戳**
 *    —— 不盖的话别的设备手里那份「更新」的任务会赢，listId 又指回一条已经不存在的清单；
 * ② 给被折掉的那条立墓碑，别的设备同步过来才不会把它又拉回来。
 *
 * **没有重名时原样返回同一个对象**：同步那边靠对象身份判断「这份动没动过」，
 * 每次都返回一个新对象会白白多推一轮。
 *
 * 只在登录那一刻调（见 loginCtl），不挂进每一轮 mergeData：
 * 这件事会改任务的归属，是一次性的收拾，不该在每次同步里反复搅动。
 */
export function dedupeListsByName(data: AppData, at = new Date().toISOString()): ListDedupe {
  const groups = new Map<string, List[]>();
  for (const l of data.lists) {
    const key = l.name.trim();
    const g = groups.get(key);
    if (g) g.push(l);
    else groups.set(key, [l]);
  }

  const count = new Map<string, number>();
  for (const t of data.tasks) {
    if (t.listId) count.set(t.listId, (count.get(t.listId) ?? 0) + 1);
  }

  /** 被折掉的清单 id → 留下的那条的 id */
  const remap = new Map<string, string>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const keep = [...g].sort((a, b) => keeperRank(a, b, count))[0];
    for (const l of g) if (l.id !== keep.id) remap.set(l.id, keep.id);
  }
  if (remap.size === 0) return { data, folded: 0, moved: 0 };

  let moved = 0;
  const tasks = data.tasks.map((t) => {
    const to = t.listId === null ? undefined : remap.get(t.listId);
    if (to === undefined) return t;
    moved++;
    return { ...t, listId: to, updatedAt: at };
  });
  // filter 保序：留下来的清单彼此的先后一个字都没动，用户看见的侧栏只是少了重复那条
  const lists = data.lists.filter((l) => !remap.has(l.id));
  return {
    data: { ...data, lists, tasks, graveyard: bury(data.graveyard ?? [], [...remap.keys()], at) },
    folded: remap.size,
    moved,
  };
}

/** 记一笔墓碑（彻底删除时调用）。同一个 id 只留最晚那次 */
export function bury(graveyard: Tombstone[], ids: string[], at: string): Tombstone[] {
  if (ids.length === 0) return graveyard;
  return pruneGraveyard([...graveyard, ...ids.map((id) => ({ id, at }))]);
}

// ---------- 同一件事的跨档案去重 ----------

export interface TaskDedupe {
  data: AppData;
  /** 折掉了几件重复的事 */
  folded: number;
}

/** 「同一件事」的身份。四样全一样才算同一件：
 *  种类（事 / 习惯）、标题（前后空格不算）、在哪条清单、哪一天。
 *
 *  清单比的是**名字不是 id**：两台设备各自的「工作」本来就是两个 id，比 id 永远对不上。
 *  这也让这件事跟同名清单去重的先后无关——dedupeListsByName 会给搬过家的任务
 *  重新盖改动时刻戳，先跑它的话「留改得晚的那条」当场被那一下盖乱。
 *
 *  为什么把种类也算进去：一条叫「喝水」的习惯和一条叫「喝水」的事不是一回事，
 *  折掉一个用户就少了一个打卡记录。判据宁可严一点——严了最多留下一条重复，
 *  松了就是把用户的东西吃掉。 */
function taskIdentity(t: Task, listName: Map<string, string>): string {
  const where = t.listId === null ? "" : listName.get(t.listId) ?? t.listId;
  return JSON.stringify([t.kind, t.title.trim(), where, t.due ?? ""]);
}

/** 同一件事留哪条：改得晚的留下；一样晚就比 id。
 *  比 id 纯粹是为了「几台设备各自算一遍得出同一个答案」，没有别的含义 */
function taskKeeperRank(a: Task, b: Task): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

/**
 * 登录时选了「合并两份」之后，把**两边各存了一份的同一件事**并成一条。
 *
 * 为什么要有这件事（用户 2026-09-03 实测反馈）：两台设备各自记过同样的事，
 * 两条记录的 id 不一样，mergeData 只认 id，于是合完侧栏里同一件事并排站着两条。
 * 「合并」在用户嘴里的意思是「两边的东西都留着，**但交集不要重复**」。
 *
 * 只折**跨档案**的那种：一组里必须既有只属于本机的、又有只属于云端的，才动手。
 * 用户自己在一台设备上故意记了两条一模一样的（比如两趟一样的差事），
 * 那是他的事，一次登录不许替他做主删掉。
 *
 * 回收站里的（deletedAt 非空）一概不参与：它跟活着的那条不是「重复」，
 * 把活的那条折成删掉的那条，等于当场丢事。
 *
 * 被折掉的那条立墓碑——多设备收敛全靠它，不立的话别的设备下一轮同步又把它推回来。
 * 代价是那一条上的备注、子任务、专注时长跟着走，所以只留改得晚的那条。
 *
 * **没有重复时原样返回同一个对象**（口径同 dedupeListsByName）。
 */
export function dedupeSameTasks(
  data: AppData,
  sides: { local: ReadonlySet<string>; remote: ReadonlySet<string> },
  at = new Date().toISOString(),
): TaskDedupe {
  const listName = new Map(data.lists.map((l) => [l.id, l.name.trim()]));
  const groups = new Map<string, Task[]>();
  for (const t of data.tasks) {
    if (t.deletedAt) continue;
    const key = taskIdentity(t, listName);
    const g = groups.get(key);
    if (g) g.push(t);
    else groups.set(key, [t]);
  }

  const drop = new Set<string>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    // 「只属于这一边」才算数：两边都有的那个 id（以前同步过的同一条）既不算本机独有、
    // 也不算云端独有，否则一条同步过的事加上一条本机的手误重复，也会被当成跨档案重复折掉
    const fromLocal = g.some((t) => sides.local.has(t.id) && !sides.remote.has(t.id));
    const fromRemote = g.some((t) => sides.remote.has(t.id) && !sides.local.has(t.id));
    if (!fromLocal || !fromRemote) continue;
    const keep = [...g].sort(taskKeeperRank)[0];
    for (const t of g) if (t.id !== keep.id) drop.add(t.id);
  }
  if (drop.size === 0) return { data, folded: 0 };

  return {
    data: {
      ...data,
      tasks: data.tasks.filter((t) => !drop.has(t.id)),
      graveyard: bury(data.graveyard ?? [], [...drop], at),
    },
    folded: drop.size,
  };
}

// ---------- 「用这台设备上的那份」 ----------

/**
 * 登录时选了「用这台设备上的那份」：本机内容一个字不动，**把云端换成本机这份**。
 *
 * 两件事一起做，少一件都不成：
 * ① 云端有、本机没有的事和清单**立墓碑**——不立的话，随后那一轮同步会把它们
 *    原样合回本机（合并只会多不会少），用户选的「用这份」当场落空；
 *    别的设备下次同步也会把它们再推回来。
 * ② 两边都有、云端却改得更晚的那几条，**重新盖上本机的时刻戳**——不盖的话
 *    同步那一轮里「谁改得晚听谁的」会让云端那条赢，用户选的这份又被翻案。
 *    只盖有冲突的那几条，不盖整库：整库盖戳等于把这台设备标成「刚全改过」。
 *
 * 专注记录没有墓碑机制（它只增不减、也没有 id），云端那些会在下一轮同步里并进来。
 * 那是统计数字，不是「事」，不在这次选择的范围内。
 *
 * 返回一份新的数据，调用方**落一次 state 就够**，随后照常推一轮上去。
 */
export function keepLocalOverCloud(local: AppData, remote: AppData, at = new Date().toISOString()): AppData {
  const localTaskIds = new Set(local.tasks.map((t) => t.id));
  const localListIds = new Set(local.lists.map((l) => l.id));
  const doomed = [
    ...remote.tasks.filter((t) => !localTaskIds.has(t.id)).map((t) => t.id),
    ...remote.lists.filter((l) => !localListIds.has(l.id)).map((l) => l.id),
  ];

  const remoteTasks = new Map(remote.tasks.map((t) => [t.id, t]));
  const remoteLists = new Map(remote.lists.map((l) => [l.id, l]));
  const restamp = <T extends Stamped>(x: T, other: T | undefined): T =>
    other !== undefined && other.updatedAt > x.updatedAt ? { ...x, updatedAt: at } : x;

  return {
    ...local,
    // 版本号取三者最大，口径同 mergeData：本机是老版本时不许把云端的 schema 棘轮拉回去
    version: Math.max(local.version || 0, remote.version || 0, DATA_VERSION),
    tasks: local.tasks.map((t) => restamp(t, remoteTasks.get(t.id))),
    lists: local.lists.map((l) => restamp(l, remoteLists.get(l.id))),
    graveyard: bury(local.graveyard ?? [], doomed, at),
  };
}
