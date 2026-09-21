// 同步的调度层：什么时候同步、同步失败了怎么办、界面上显示成什么样。
//
// 一条底线：**本地永远能用**。断网、服务器挂了、令牌过期，统统只影响那行小字，
// 不拦任何操作、不弹窗打断、不阻塞退出。

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import type { AppData, Settings } from "./model";
import { appStore, applyRemoteData, flushSave, setProfiles, updateSettings } from "./store";
import { mergeData, sideDataChanged } from "./merge";
import * as cloud from "./cloud";
import type { Session, SyncPhase } from "./cloud";
import { todayYMD, toYMD } from "./dates";
import { isMobile } from "./platform";
import { adoptLegacyProfile } from "./profile";

interface SyncStore {
  session: Session | null;
  phase: SyncPhase;
  message: string;
  /** 有没有攒着还没同步上去的改动 */
  dirty: boolean;
  /** **服务端**说这台设备太老，把这一次推送挡回来了（409 client_too_old）。
   *
   *  客户端自己不再判这件事（v1.9.1：比本机新的数据照读照推，见 cloud.unpackRemote）——
   *  这个标记只可能来自服务端，而服务端守的是那些已经发出去、改不了的老客户端。
   *  **它是软状态，不是终态**：置上之后只暂停 UPGRADE_RETRY_MS，到点自己再试一次，
   *  重开橡果也清零。原来只有重新登录/退出登录才解得开，重启都不行，那才叫「永久停摆」 */
  needsUpgrade: boolean;
  /** needsUpgrade 的解除时刻（epoch ms）。null = 没被挡过 */
  upgradeRetryAt: number | null;
  /** 最近一次「每天补一轮」真发出去的时刻（**成功失败都记**）。只活在进程内。
   *  失败时 session.syncedAt 一动不动，光看它的话离线时每次切回窗口都会重跑一整轮 */
  lastAttemptAt: string | null;
  /** 开机自动从云端取回之后要给用户的那句回执（null = 没这回事）。只活在进程内：
   *  它是「刚刚发生了什么」，不是一个长期状态，重开橡果不该再说一遍。
   *  界面在侧栏底下摆一行可点的字（Sidebar 的 .foot），点了去设置的云账号那一节 */
  restored: { tasks: number; backup: string | null } | null;
  /** 开机这一轮正在问云端 / 拉云端那份（true 时界面摆一块「正在取回」的占位）。
   *
   *  为什么要它：initStore 一返回界面就能用了，而这条路还在等网络往返——
   *  用户看见的是一本**假的**空账本，第一反应就是开始重新记。等这边整份盖下去，
   *  刚敲的那几条当着面消失。占位是第一道（别让人对着假账本干活），
   *  wipe.restoreFromCloud 的 abortIfTasksExceed 是第二道（真记了就不覆盖）。 */
  restoring: boolean;
}

export const syncStore = createStore<SyncStore>(() => ({
  session: null,
  phase: "off",
  message: "未登录，数据只保存在这台设备上",
  dirty: false,
  needsUpgrade: false,
  upgradeRetryAt: null,
  lastAttemptAt: null,
  restored: null,
  restoring: false,
}));

export function useSync<T>(selector: (s: SyncStore) => T): T {
  return useStore(syncStore, selector);
}

/** 被服务端挡回来之后歇多久再试。**不是「永不再试」**：
 *  桌面版常驻托盘好几天不重启，永不再试等于用户升级完了同步也不会自己回来。
 *  退避的理由跟 dailySyncIfNeeded 里 lastAttemptAt 那段一样——
 *  不退避的话侧栏那行会一直闪「正在同步…」→「同步失败」 */
export const UPGRADE_RETRY_MS = 6 * 60 * 60 * 1000;

/** 这会儿还在「被服务端挡着」的窗口里吗。到点了就当没挡过，让它再试一次 */
export function upgradeBlocked(
  s: Pick<SyncStore, "needsUpgrade" | "upgradeRetryAt">,
  now = Date.now(),
): boolean {
  if (!s.needsUpgrade) return false;
  return s.upgradeRetryAt === null || now < s.upgradeRetryAt;
}

/** 改完东西静置多久才同步。太短会把每个字都发上去，太长又怕关机前没传上 */
const QUIET_MS = 4000;

let debounce: ReturnType<typeof setTimeout> | null = null;

/** 独占闸门（9-21 复核）：「从云端覆盖本机」、登录时挑档案那一段里，**后台自己发的同步一律不发**。
 *  原生确认框一关、窗口重新拿到焦点就会触发自动取；那一轮拿「本机这份」跟云端合并推上去，
 *  用户明确要丢的本机内容就混进了云端，覆盖白做。这段时间里只有流程自己显式调的 syncNow 照走。
 *  计数而不是布尔：覆盖可能套在登录流程里面 */
let exclusive = 0;

/** 挡住后台同步（自动取、每天补一轮、改动防抖），并等在途的那一轮落地。返回放行函数（多调只算一次）。
 *  放行时这段里攒下的改动（dirty）照常排一次防抖同步 */
export async function holdAutoSync(): Promise<() => void> {
  exclusive++;
  if (debounce) {
    clearTimeout(debounce);
    debounce = null;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    exclusive = Math.max(0, exclusive - 1);
    if (exclusive === 0 && syncStore.getState().dirty) requestSync();
  };
  if (running) await running.catch(() => {});
  return release;
}

/** 闸门关着没有（测试和调用方自查用） */
export function autoSyncHeld(): boolean {
  return exclusive > 0;
}
let running: Promise<void> | null = null;
let unsubscribe: (() => void) | null = null;
let lastSeenData: AppData | null = null;
/** 最近一轮同步**确实推上去了的那个对象身份**。往返期间数据又变过就置回 null。
 *  闸门（syncNowChecked）靠它区分「内存里这份就是刚上传的那份」和
 *  「上传之后又变了」——只看 dirty 不够，applyRemoteData 换掉引用也是常事 */
let syncedRef: AppData | null = null;

function set(patch: Partial<SyncStore>) {
  syncStore.setState({ ...syncStore.getState(), ...patch });
}

function humanTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return sameDay ? hhmm : `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
}

function idleMessage(session: Session | null): string {
  if (!session) return "未登录，数据只保存在这台设备上";
  return session.syncedAt ? `已同步 · ${humanTime(session.syncedAt)}` : "已登录，尚未同步";
}

/** 多久没同步过就算「久了」。桌面版常驻托盘，好几天不重启是常事，
 *  停摆了不说一声，用户要等到某天点开设置才发现 */
export const STALE_SYNC_MS = 24 * 60 * 60 * 1000;

/** 侧栏底下那行同步指示。**同步状态不能只在设置→云账号里有**：
 *  升级、令牌过期、断网都会让它停摆，而那一页用户一个月也未必点开一次。
 *
 *  没登录返回 null（那是常态，不是故障，不值得占地方）；
 *  正常时一句克制的「已同步 · 14:30」，出问题时才 bad，界面据此标红。 */
export type SyncFoot = { bad: boolean; text: string } | null;

export function syncFootState(
  s: Pick<SyncStore, "session" | "phase" | "needsUpgrade">,
  now = Date.now(),
): SyncFoot {
  if (!s.session) return null;
  // 「暂停」不是「已停」：升级完（或退避到点）它自己会回来，用户不用做别的
  if (s.needsUpgrade) return { bad: true, text: "同步暂停，升级后恢复" };
  if (s.phase === "error") return { bad: true, text: "同步失败" };
  if (s.phase === "syncing") return { bad: false, text: "正在同步…" };
  const at = s.session.syncedAt;
  // 登录了却一次都没成功过：云端还什么都没有，这台设备等于没在同步
  if (!at) return { bad: true, text: "尚未同步" };
  if (now - new Date(at).getTime() > STALE_SYNC_MS) {
    return { bad: true, text: `上次同步 ${humanTime(at)}` };
  }
  return { bad: false, text: `已同步 ${humanTime(at)}` };
}

// ---------- 开机自动取回 ----------

export interface AutoRestoreInput {
  /** 盘上**连账本文件都没有**（store.noDataFile）。不是「读出来是 0 件事」 */
  noDataFile: boolean;
  /** 这台设备有登录态 */
  signedIn: boolean;
  /** 云端确实有内容（cloud.whoAmI().hasData）。问不出来一律传 false */
  cloudHasData: boolean;
}

/**
 * 开机该不该**自己**把云端那份取回来（用户 2026-09-14 拍板：做，但要三道硬闸门）。
 *
 * 三条同时成立才取，缺一不可：
 * ① 盘上连账本文件都没有；② 已经登录；③ 云端确实有内容。
 *
 * **为什么不能直接用 fresh.isPristineLocal**：那条判据第一行就是
 * `if (everSynced) return false`——同步过的设备一律不算全新。它服务的是「登录那一刻
 * 要不要拿云端盖掉本机」，在那个场合判严是对的。而这里的场景恰恰相反：本体这台机器
 * 同步过好多回，数据文件却不见了（指针指歪、文件夹没挂上、刚清空过），
 * 拿那条判据来问永远得到 false，自动取回就永远不会发生。
 *
 * 这一条为什么敢更窄地放行：它要的不是「本机看起来是空的」，而是**本机那份压根不存在**。
 * 「读出来是 0 件事」不算——那可能是用户自己把事全做完删光了，那份空账本是他的真实意愿，
 * 拿云端去盖它就是擅自改用户的数据。文件不存在就没有任何东西会被盖掉，
 * 加上取回之前照旧先留一份备份（wipe.restoreFromCloud 自带），这条路没有损失面。
 */
export function shouldAutoRestore(i: AutoRestoreInput): boolean {
  return i.noDataFile && i.signedIn && i.cloudHasData;
}

/** 把回执收掉（用户点过那行字了） */
export function dismissRestored(): void {
  if (syncStore.getState().restored) set({ restored: null });
}

/** 开机这一轮：够条件就自己把云端那份取回来。取到了返回 true（这一轮就不用再合并了）。
 *
 *  为什么不走开机那一轮「合并」：本机是个空壳的时候，合并等于把空壳推上云——
 *  云端那份一条不少地还在，但这台设备永远停在「什么都没有」，用户得自己找到
 *  设置 → 云账号 → 从云端覆盖到这台设备 才救得回来。这正是账本里那条最高优先级的死循环。
 *
 *  restoreFromCloud 走**动态 import**：wipe.ts 反过来要用这里的 signOut / syncNowChecked，
 *  静态互引就成了环。它只在这一条路上用一次，进函数再取最省事也最稳。 */
async function autoRestoreOnBoot(session: Session): Promise<boolean> {
  const s = appStore.getState();
  // 闸门①：盘上得真没有账本文件。顺带把「读都没读成」「正等着用户在找回数据屏上拍板」
  // 这两种状态挡在外面——那两种情况下本机这份不代表用户的账本，别在上面再动手
  if (!s.loaded || s.loadError || s.rescue || !s.noDataFile) return false;
  // 进这条路那一刻本机有几条事（正常是 0，这条路的前提就是盘上连账本文件都没有）。
  // 拉云端那份要等一个甚至几十秒的网络往返，这个数是稍后「还能不能覆盖」的判据
  const tasksAtStart = s.data.tasks.length;
  // 从这里开始界面换成「正在从云端取回…」的占位：往下每一步都要等网络，
  // 而这段时间里界面早就能用了，不挡住的话用户就在对着一本假的空账本干活
  set({ restoring: true });
  try {
    // 闸门③：云端确实有内容。问一句 /api/me 就够，不用把整份拉下来；
    // 问不出来（断网、服务器抽风）一律当「没有」，那就什么都不做，照旧走合并那条老路
    let cloudHasData = false;
    try {
      cloudHasData = !!(await cloud.whoAmI(session.token)).hasData;
    } catch {
      return false;
    }
    // 闸门②由调用点保证（有 session 才进得来），仍然显式摆进判据里，省得哪天挪了地方漏掉
    if (!shouldAutoRestore({ noDataFile: s.noDataFile, signedIn: true, cloudHasData })) return false;
    try {
      const { restoreFromCloud } = await import("./wipe");
      // 自带「先落盘 → 先备份 → 云端空了就一个字不动」；
      // abortIfTasksExceed 再加一道：这中间用户真记了东西就不覆盖了，退回合并
      const out = await restoreFromCloud({ abortIfTasksExceed: tasksAtStart });
      appStore.setState({ noDataFile: false });
      set({ restored: { tasks: out.tasks, backup: out.backup } });
      return true;
    } catch {
      // 取不回来（断网、备份写不下去、云端那份解不开），或者这中间用户已经动手记了东西
      //（RestoreAborted）：本机一个字都没动，退回开机那一轮合并——
      // 合并会把刚记的那几条跟云端那份并起来，两边都留住，还顺手推上云
      return false;
    }
  } finally {
    // 无论走哪条岔路都得把占位收掉，否则用户对着「正在取回…」再也回不来
    set({ restoring: false });
  }
}

// ---------- 自动登录（v1.15.0） ----------

/**
 * 这台设备「下次打开还认不认登录态」。缺这个字段一律当开着——
 * 老数据、一直以来的桌面端都是打开就登录着的，升上来不能把人踢出去。
 */
export function autoLoginOn(s?: Pick<Settings, "autoLogin">): boolean {
  const v = (s ?? appStore.getState().data.settings).autoLogin;
  return v !== false;
}

/**
 * 开关翻动时调一次。
 *
 * 关掉 = **当场把本机那份令牌删掉**，但内存里的登录态一个字不动：
 * 这次照常同步照常用，下次打开才需要重新输密码。用户要的是「别替我记住密码」，
 * 不是「立刻把我踢下线」——顺手 signOut 会让他刚记的几条停在本机，还以为传上去了。
 *
 * 重新打开 = 把现在这份登录态再写回去，否则开关拨回来了、下次打开还是得重输。
 */
export async function applyAutoLogin(on: boolean): Promise<void> {
  if (!on) {
    await cloud.saveSession(null);
    return;
  }
  const s = syncStore.getState().session;
  if (s) await cloud.saveSession(s);
}

// ---------- 对外 ----------

/** 应用启动时调一次：有登录态就恢复出来，并立刻同步一轮 */
export async function initSync(): Promise<void> {
  const session = await cloud.loadSession();
  if (!session) {
    set({ session: null, phase: "off", message: idleMessage(null) });
    return;
  }
  // 自动登录关着却还留着令牌：多半是上一次关开关时那一下写盘没落地（进程被杀、盘满）。
  // 以**用户拨过的那个开关**为准，顺手把令牌再删一次，别让它下次又把人自动登进去
  if (!autoLoginOn()) {
    await cloud.saveSession(null);
    set({ session: null, phase: "off", message: idleMessage(null) });
    return;
  }
  // 重开一次橡果就该重新试一次：升级往往正是「关掉 → 装新版 → 打开」，
  // 不在这里清零的话，装完新版同步照旧不动，用户只能靠重新登录去撞开
  set({
    session, phase: "idle", message: idleMessage(session),
    needsUpgrade: false, upgradeRetryAt: null,
  });
  // 这台设备是个空壳、而这个账号云端有东西：自己取回来，别摆一张只有一个选项的卡去问。
  // **排在 watchData 之前**：取回会整份换掉内存那份数据，监听已经挂上的话，
  // 这一下会被当成「用户改了东西」排一轮推送，侧栏那行先亮「有改动没传」再自己消下去
  const restored = await autoRestoreOnBoot(session);
  // 排在 watchData 之前、syncNow 之前：迁进来的那一条直接搭这一轮一起上云，不另排一轮
  adoptLegacyProfileNow(session);
  watchData();
  startAutoPull();
  // 取回那条路自己就把版本号跟云端对齐了，这一轮不用再同步一次
  if (restored) return;
  void syncNow();
}

/** 旧字段（settings.profileName / profileAvatar）迁进这个账号名下，只迁一次（口径见 profile.adoptLegacyProfile）。
 *  账本没正常读进来时不动手——那时内存里那份不是用户的账本 */
function adoptLegacyProfileNow(session: Session): void {
  const a = appStore.getState();
  if (!a.loaded || a.loadError || a.rescue) return;
  const next = adoptLegacyProfile(a.data, session.email);
  if (next === a.data) return;
  if (next.profiles && next.profiles !== a.data.profiles) setProfiles(next.profiles);
  // 「这个账号迁过了」记在设置里（设置不同步），下次打开不再迁
  if (next.settings.legacyProfileDone !== a.data.settings.legacyProfileDone) {
    updateSettings({ legacyProfileDone: next.settings.legacyProfileDone });
  }
}

/** 登录 / 注册验证成功后调：存下登录态，立刻把两边并起来。
 *
 *  `sync: false` = **只落登录态，先别合**。给登录时那条「本机是全新的 → 用云端整份覆盖」
 *  的路用（loginCtl.signInWithLocalData）：那条路要的正是不合并，
 *  默认这一下 syncNow 恰恰是它要避免的动作。调用方自己负责随后走覆盖或走合并。 */
export async function adoptSession(session: Session, opts?: { sync?: boolean }): Promise<void> {
  await cloud.saveSession(session);
  set({
    session, phase: "idle", message: idleMessage(session),
    dirty: false, needsUpgrade: false, upgradeRetryAt: null, lastAttemptAt: null,
  });
  adoptLegacyProfileNow(session);
  watchData();
  startAutoPull();
  if (opts?.sync === false) return;
  await syncNow();
}

/** 断开登录态：清防抖、停监听、删令牌、把同步状态归零。**只管登录态，不碰任何本机数据**。
 *
 *  清空本机数据是另一件事，走 wipe.ts 的 wipeLocalData()——绝不能做成「session 变 null」
 *  的副作用：401 令牌过期是**非自愿登出**，那一刻恰恰同步不上去，
 *  一次过期就无声抹掉全部本地数据，用户找都没处找。 */
export async function signOut(): Promise<void> {
  if (debounce) {
    clearTimeout(debounce);
    debounce = null;
  }
  stopWatching();
  stopAutoPull();
  await cloud.saveSession(null);
  set({
    session: null, phase: "off", message: idleMessage(null),
    dirty: false, needsUpgrade: false, upgradeRetryAt: null, lastAttemptAt: null,
  });
}

/** 令牌不认了（服务端回 401：过期，或别处改过密码）：断开登录态，但**本机数据一个字都不动**。
 *  同步和设置页发反馈撞上 401 都走这一条，两处的样子得一致——
 *  不然反馈那边红字说「登录已经过期」，账号卡却还显示登录着 */
export async function expireSession(): Promise<void> {
  await cloud.saveSession(null);
  stopWatching();
  stopAutoPull();
  set({
    session: null,
    phase: "error",
    message: "登录状态已过期，重新登录后继续同步",
  });
}

/** 「本地已经全部在云端」的唯一可靠证据：当场同步一轮并且成功。
 *
 *  **绝不许拿 syncStore.dirty 当证据**——它只活在进程内，重启就归零，
 *  离线改过的东西会被它谎报成「干净」，照着删就是真丢数据。 */
export type SyncGate = { ok: true; rev: number } | { ok: false; why: string };

export async function syncNowChecked(): Promise<SyncGate> {
  const before = syncStore.getState();
  if (!before.session) return { ok: false, why: "这台设备没有登录账号，数据从来没上过云" };
  if (upgradeBlocked(before)) return { ok: false, why: before.message };
  const a = appStore.getState();
  // **dataFromNewer 不在这里**：那份数据是真读进来的账本，推得上去也判得了
  if (!a.loaded || a.loadError || a.rescue) {
    return { ok: false, why: "数据还没正常读进来，这会儿判断不了云端是不是全了" };
  }
  // 闸门要的是「**当前这份**上去了」，所以走 force：不许搭一轮早就在飞的旧同步，
  // 那一轮的快照是起飞那一刻的数据，之后记的东西一个字都不在里面
  const beforeData = appStore.getState().data;
  await syncNow({ force: true });
  const after = syncStore.getState();
  if (!after.session) return { ok: false, why: "登录状态过期了，重新登录再试一次" };
  if (after.phase === "error") return { ok: false, why: after.message };
  // 同步过程中又改了东西：那部分还没上去，这次不算数
  if (after.dirty) return { ok: false, why: "还有改动没有上传，等这一轮同步完成后再试" };
  // 不依赖 dirty 的第二重证据：内存里这份必须还是刚刚推上去的那份。
  // 引用变了但等于 syncedRef 是正常的——那是 applyRemoteData 把合并结果装了回来，
  // 而合并结果本身就是这一轮 PUT 上去的内容
  const afterData = appStore.getState().data;
  if (afterData !== beforeData && afterData !== syncedRef) {
    return { ok: false, why: "同步过程中数据又变了，再点一次把这次改动也传上去" };
  }
  return { ok: true, rev: after.session.rev };
}

/** 每天至少同步一次：当天（本地日期）还没成功同步过就补一轮。
 *
 *  为什么需要：同步的触发条件一直是「本地改了东西才传」，一台设备光看不改就永远
 *  拉不到另一台的更新；桌面版常驻托盘还可能好几天不重启。
 *  「没打开过就不算」——软件没启动当然不会同步，不为此做后台任务或定时唤醒。
 *
 *  上次成功同步的时刻直接读 session.syncedAt（存在 auth.json 里，跟登录态同生共死、
 *  跟着这台设备走不跟着数据走），不另开一个 key。
 *  **调用方一律 void 不 await**：这是后台行为，挡不得启动；没网就静默跳过，不打扰。 */
export async function dailySyncIfNeeded(today = todayYMD()): Promise<boolean> {
  const st = syncStore.getState();
  if (!st.session || upgradeBlocked(st) || st.phase === "syncing" || exclusive > 0) return false;
  const last = st.session.syncedAt;
  if (last && toYMD(new Date(last)) === today) return false;
  // **失败也算「今天试过了」**：syncedAt 只在成功时前进，只看它的话，
  // 断网或服务端故障期间每一次 alt-tab 回来、每一次从托盘恢复窗口都会重跑一整轮，
  // 状态行反复闪「正在同步…」→「同步失败」，手机端还在计费流量上反复重试。
  // 记在进程内就够：重开一次橡果本来也该重新试一次
  const tried = st.lastAttemptAt;
  if (tried && toYMD(new Date(tried)) === today) return false;
  set({ lastAttemptAt: new Date().toISOString() }); // 先记再发，免得两个事件同时进来发两轮
  await syncNow();
  const after = syncStore.getState();
  return !!after.session && after.phase !== "error";
}

// ---------- 电脑上自动去云端取最新（v1.15.1） ----------

/** 距上次成功同步不到这么久，窗口回到眼前也不再取：alt-tab 一次、关个小窗回主窗一次，
 *  一分钟里能来十几下，每下都跑一轮是白耗 */
export const AUTO_PULL_GAP_MS = 60 * 1000;
/** 登录着、开着橡果，每隔这么久自己取一次 */
export const AUTO_PULL_EVERY_MS = 5 * 60 * 1000;

/** 上一次「自动取」真发出去的时刻（**成败都记**）。只活在进程内。
 *  失败时 syncedAt 一动不动，光看它的话服务器挂着的那段时间每次切回窗口都会重撞一次 */
let lastAutoPullAt = 0;
let autoPullOff: (() => void) | null = null;

/**
 * 该取就取一轮：用户 2026-09-21 定的「电脑版自动去云端取最新数据」。
 *
 * 原来桌面只在开机和本机有改动时同步，手机上刚记的事，电脑上光看不改就永远等不来。
 * 走的就是 syncNow（自带 base_rev、409 重试、合并），不另写一套：
 * 取回来的并进本机，本机没传的顺手推上去。
 *
 * 不发的情况：没登录、离线、被服务端挡着等升级、正在同步、距上次成功（或上次自动取）不到一分钟。
 * **出错安静处理**：不弹窗不打扰，侧栏那行字照实说，下一次到点再试。返回这一轮发没发出去。
 */
export async function autoPullIfDue(now = Date.now()): Promise<boolean> {
  const st = syncStore.getState();
  if (!st.session || upgradeBlocked(st, now) || st.phase === "syncing" || running || exclusive > 0) return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  const last = st.session.syncedAt ? Date.parse(st.session.syncedAt) : NaN;
  if (Number.isFinite(last) && now - last < AUTO_PULL_GAP_MS) return false;
  if (now - lastAutoPullAt < AUTO_PULL_GAP_MS) return false;
  lastAutoPullAt = now; // 先记再发：focus 和 visibilitychange 常常前后脚一起来
  await syncNow();
  return true;
}

/**
 * 挂上「窗口回到眼前就取一次 + 每 5 分钟取一次」。登录态落定时调（initSync / adoptSession），
 * 重复调只挂一份；登出、令牌过期时 stopAutoPull 摘掉。
 *
 * **只在电脑上**（isMobile 为假，电脑浏览器上的网页版也算）：手机进后台就落盘推一把、
 * 回来有每天补一轮，再加定时拉会在计费流量上一直跑。
 */
export function startAutoPull(mobile = isMobile): void {
  if (mobile || autoPullOff || typeof window === "undefined") return;
  const onFocus = () => void autoPullIfDue();
  const onVisible = () => {
    if (document.visibilityState === "visible") void autoPullIfDue();
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisible);
  const timer = setInterval(() => void autoPullIfDue(), AUTO_PULL_EVERY_MS);
  autoPullOff = () => {
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisible);
    clearInterval(timer);
  };
}

/** 摘掉自动取。换个账号登录时间隔从头算 */
export function stopAutoPull(): void {
  if (autoPullOff) {
    autoPullOff();
    autoPullOff = null;
  }
  lastAutoPullAt = 0;
}

/** 立刻同步一轮。同一时间只会有一轮在跑，重复调用等同一个 promise。
 *
 *  `force`：**不许复用在途的那一轮**，排队等它落地再跑一轮全新的。
 *  给闸门（syncNowChecked）用——在途那轮的快照是它起飞那一刻的数据，
 *  搭上去等于拿「几秒前那份传上去了」当「现在这份传上去了」的证据。
 *
 *  `chained`：这一轮是上一轮漂移之后自动补的。**补最多只补一轮**——
 *  每一轮往返都有几秒，用户手快的话可以一直漂下去，无限接力会把自己转死。
 *  再漂就交回给防抖那条路（数据变了本来就会排一次），dirty 也照旧是 true。 */
export function syncNow(opts?: { force?: boolean; chained?: boolean }): Promise<void> {
  if (running) {
    if (!opts?.force) return running;
    // 等在途那轮落地（成败都不管），再从当前数据重新起一轮
    return running.catch(() => {}).then(() => syncNow(opts));
  }
  const st = syncStore.getState();
  // 服务端刚把我们挡回来，退避窗口内不再撞（到点了 upgradeBlocked 自己放行）
  if (upgradeBlocked(st)) return Promise.resolve();
  const session = st.session;
  if (!session) return Promise.resolve();
  const state = appStore.getState();
  // 数据没真正读进来之前，内存里那份不代表用户的账本——既不许写盘，也不许推云。
  // 理由同 store.doSave：loadError（读不出来）、rescue（疑似指错文件夹，等用户拍板）
  // 这两种状态下 loaded 都是 true，光看 loaded 拦不住，会把一本空账本合并进云端再 PUT 回去。
  // **dataFromNewer 已从这里去掉**（v1.9.1）：更新版本写的那份是真账本，
  // 未知字段合并不丢、推上去信封盖的是 max 后的 schema，拦着它反而是把用户的两台设备切断
  if (!state.loaded || state.loadError || state.rescue) return Promise.resolve();

  set({ phase: "syncing", message: "正在同步…" });
  /** 这一轮结束后要不要立刻再跑一轮：往返期间用户又改了东西，那部分还没上云 */
  let followUp = false;
  running = (async () => {
    try {
      // 快照：这一轮**推上去的就是这一份**，往返期间的改动一个字都不在里面
      const snap = appStore.getState().data;
      const outcome = await cloud.syncOnce(session, snap);
      // 必须在 applyRemoteData 之前判：它会拿旧快照的合并结果整份替换内存那份，
      // 把往返期间用户刚记的那条盖掉，判在后面就看不见「又改过」了
      let drifted = appStore.getState().data !== snap;
      // changed 只数「事」的增改删（那是给用户看的那句「收到几条」）。名字头像从云端带回新的，
      // 事一条没变也得装回来，否则手机刚换的头像电脑这边永远只推不收。
      // mergeProfiles 在「跟本机一模一样」时原样返回本机那个对象，所以这里比身份就够
      // 清单（改名 / 换色 / 排顺序 / 删掉）、墓碑、专注记录同理（9-21 复核）：
      // 只推不装的话本机旧那条下次一改就盖新戳赢回去，别处的改动在所有设备上被撤销
      const adopt = outcome.changed || outcome.data.profiles !== snap.profiles
        || sideDataChanged(outcome.data, snap);
      if (adopt) {
        // outcome.data 是拿**起飞那一刻**那份算出来的合并结果。漂移了还直接 apply，
        // 等于把这几秒里记的东西当场抹掉（小窗随手记的一条、勾掉的一件事都算）——
        // 云端没有、内存没了、scheduleSave 一写盘上也没了，用户找都没处找。
        // 所以先拿它跟**当前**内存这份再合一遍，两边都留住
        applyRemoteData(drifted ? mergeData(appStore.getState().data, outcome.data).data : outcome.data);
      }
      // 确知已经在云端的那一份：合并过就是合并结果（那才是 PUT 上去的内容），否则就是快照
      const settled = adopt ? outcome.data : snap;
      lastSeenData = appStore.getState().data;
      const next: Session = {
        ...session,
        rev: outcome.rev,
        syncedAt: new Date().toISOString(),
      };
      await cloud.saveSession(next);
      // saveSession 也是一次 await，这段窗口里同样可能改过
      if (appStore.getState().data !== settled) drifted = true;
      syncedRef = drifted ? null : settled;
      // 合进来的那部分只在内存里，云端还没有：立刻再排一轮，快照就是现在这份。
      // 少了这一步，闸门那句「再点一次把这次改动也传上去」得等防抖那 4 秒才成真
      followUp = drifted && !opts?.chained;
      const { added, updated, removed } = outcome.summary;
      const detail =
        added + updated + removed > 0
          ? `（收到 ${added} 条新的、${updated} 条改动${removed ? `、清掉 ${removed} 条` : ""}）`
          : "";
      set({
        session: next,
        phase: "idle",
        // **只有「上传的就是当前这份」才敢说干净**。无条件写 false 会把往返期间
        // 产生的改动一笔勾销，而「清空本机」正是拿这个标记当删数据的依据
        dirty: drifted,
        message: `${idleMessage(next)}${detail}`,
      });
    } catch (e) {
      // 这一轮没成，什么都没确知在云端
      syncedRef = null;
      const err = e as cloud.ApiError;
      if (err?.slug === "client_too_old") {
        // 这一条只可能来自**服务端**（客户端自己不再判，见 cloud.unpackRemote）。
        // 不是网络抖动，立刻重试没意义，所以歇 UPGRADE_RETRY_MS——但**只是歇着**：
        // 到点自己再试一次，重开橡果也清零。本地数据一个字不动，用户照常用。
        set({
          phase: "error",
          needsUpgrade: true,
          upgradeRetryAt: Date.now() + UPGRADE_RETRY_MS,
          message: err.message,
        });
        return;
      }
      if (err?.needsLogin) {
        await expireSession();
        return;
      }
      set({
        phase: "error",
        message: err?.message ? `同步失败：${err.message}` : "同步失败，请稍后重试",
      });
    } finally {
      running = null;
      // 必须排在 running 清空之后：否则会被当成「搭在飞的那一轮」原地返回
      if (followUp) void syncNow({ chained: true });
    }
  })();
  return running;
}

/** 数据变过就排一次同步（静置 QUIET_MS 后真发） */
export function requestSync(): void {
  const st = syncStore.getState();
  if (!st.session || upgradeBlocked(st)) return;
  set({ dirty: true });
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    // 闸门关着：dirty 留着，放行时再排（见 holdAutoSync）
    if (exclusive > 0) return;
    void syncNow();
  }, QUIET_MS);
}

/** 退出前最后一次：先把盘落了，再尽力推一把。**推不上去也不能拦着退出** */
export async function flushSync(): Promise<void> {
  if (debounce) {
    clearTimeout(debounce);
    debounce = null;
  }
  await flushSave();
  if (!syncStore.getState().session || !syncStore.getState().dirty) return;
  try {
    await Promise.race([
      syncNow(),
      new Promise((resolve) => setTimeout(resolve, 3000)), // 最多等 3 秒，不能让人关不掉窗口
    ]);
  } catch {
    /* 退出路径上不打扰用户 */
  }
}

// ---------- 数据变动监听 ----------

function watchData(): void {
  if (unsubscribe) return;
  lastSeenData = appStore.getState().data;
  unsubscribe = appStore.subscribe(() => {
    const d = appStore.getState().data;
    if (d === lastSeenData) return;
    lastSeenData = d;
    requestSync();
  });
}

function stopWatching(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  lastSeenData = null;
  syncedRef = null;
}
