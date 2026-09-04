// 登录成功那一刻，本机这份数据怎么办。
//
// 以前只有一条路：登录 → 立刻跟云端合并。新装的橡果自带「工作 / 生活」两条默认清单，
// 合并只认 id 不认名字，于是用户第一次在手机上登录，侧栏就出现了两个「工作」
// （2026-09-02 用户反馈原文：「登录后，已经有的东西应该全部删除，这里两个『工作』的分类肯定不行」）。
//
// 现在分三条路（判据在 fresh.ts，全是纯函数）：
//   · 本机什么都还没有 + 云端有内容 → **用云端整份覆盖本机**，默认清单直接丢
//   · 两边都有内容                   → 停下来把**两份档案**摆给用户看，他挑一份或者合并
//   · 云端是空的                     → 照常合并（等于把本机这份推上去，第一台设备就该这样）
//
// 「两边都有内容」那一问长什么样见 components/LoginPage.tsx：两张卡（云端的那份 /
// 这台设备上的那份），各写「N 件事 · M 个清单」和「最近更新 X月X日 HH:mm」，
// 选一张点「用这份」，或者点下面那行「合并两份（重复的只留一份）」。三条路各自走：
//   · 用云端的 → wipe.restoreFromCloud（整份覆盖，保留本机的主题快捷键）
//   · 用这台设备上的 → merge.keepLocalOverCloud 给云端独有的立墓碑，再推上去
//   · 合并     → mergeData + 同一件事去重 + 同名清单去重，**算完只落一次 state**
//
// 三条底线：
// ① 覆盖走的是现成那条路（wipe.restoreFromCloud），不另写一套：
//    它自带「先落盘 → 先备份 → 云端空了就一个字不动」这一整套闸门，重写一遍必然漏掉某一道。
//    推送同理，一律走 syncNow / syncOnce（自带 base_rev、409 重试、服务端 schema 闸门）。
// ② 云端有没有内容问不出来时（断网、服务器抽风）一律当「没有」→ 走合并。
//    合并只会多不会少，**绝不在不确定的时候覆盖本机**。
// ③ **算完只落一次 state**。以前是「先落合并结果、再落去重结果」，中间那一拍侧栏
//    把两份都数了一遍，用户看见的就是数字先翻倍再恢复（2026-09-03 实测反馈）。

import { applyRemoteData, appStore } from "./store";
import * as cloud from "./cloud";
import type { Session } from "./cloud";
import type { AppData } from "./model";
import { adoptSession, syncNow, syncStore } from "./syncCtl";
import { restoreFromCloud } from "./wipe";
import type { CloudRestore } from "./wipe";
import { dedupeListsByName, dedupeSameTasks, keepLocalOverCloud, mergeData, sameContent } from "./merge";
import { isPristineLocal, planLoginData } from "./fresh";
import type { LoginDataAction } from "./fresh";

/** 用户在「两份档案」那一屏上的选择：
 *  · cloud = 用云端的那份
 *  · local = 用这台设备上的那份（云端换成本机这份）
 *  · merge = 合并两份，重复的只留一份 */
export type LoginChoice = "cloud" | "local" | "merge";

/** 一份档案的门面：给用户看的三个数，两边各算一份，摆在一起他才判得了该留哪份 */
export interface ProfileSummary {
  /** 还活着的事有几件（回收站里的不算——用户数不到它们） */
  tasks: number;
  /** 有几个清单 */
  lists: number;
  /** 这份档案最近一次改动：所有事和清单的 updatedAt 取最大。一条内容都没有时是 null */
  updatedAt: string | null;
}

export interface LoginAsk {
  /** 云端那份 */
  cloud: ProfileSummary;
  /** 这台设备上这份 */
  local: ProfileSummary;
  /** 云端那份的版本号。界面上不画（用户不认识「第几版」），留给排查和回执 */
  rev: number;
}

/** 一份数据的门面数。纯函数，**只数看得见的东西**：
 *  回收站里的事用户在界面上数不到，摆进卡片里只会让两边的数字对不上他看见的 */
export function summarizeProfile(data: AppData): ProfileSummary {
  let latest: string | null = null;
  const seen = (at: string) => {
    if (latest === null || at > latest) latest = at;
  };
  for (const t of data.tasks) seen(t.updatedAt);
  for (const l of data.lists) seen(l.updatedAt);
  return {
    tasks: data.tasks.filter((t) => !t.deletedAt).length,
    lists: data.lists.length,
    updatedAt: latest,
  };
}

/** 默认问法。**界面另有人做**（components/LoginPage.tsx 里那两张档案卡），
 *  这里只保证「不接界面也能问得出口」，文案以界面那份为准 */
export function askText(info: LoginAsk): string {
  const line = (p: ProfileSummary) =>
    `${p.tasks} 件事 · ${p.lists} 个清单${p.updatedAt ? ` · 最近更新 ${p.updatedAt.slice(0, 10)}` : ""}`;
  return (
    "云端和这台设备上各有一份。\n\n" +
    `· 云端的那份：${line(info.cloud)}\n` +
    `· 这台设备上的那份：${line(info.local)}\n\n` +
    "留一份，或者把两份合并（重复的只留一份）。"
  );
}

export interface SignInOutcome {
  /** 最后真正走的是哪条路 */
  action: LoginChoice;
  /** 有没有停下来问过用户 */
  asked: boolean;
  /** 走「用云端的」时云端那份的情况；另外两条是 null */
  restored: CloudRestore | null;
  /** 顺手折掉了几条重名清单 */
  folded: number;
  /** 顺手折掉了几件两边都有的重复的事 */
  foldedTasks: number;
  /** 本来打算走哪条（ask 表示问过用户）。排查用，界面不必管 */
  plan: LoginDataAction;
  /** 两边内容一模一样，所以没问、也没真合出什么（v1.12.1）。只有本来要问的那条路上才会为 true；
   *  回执得据此换一句话——「正在合并两端数据」在这儿是假话，什么都没合 */
  same?: boolean;
}

/**
 * 登录 / 注册验证 / 改密码之后统一走这里，替掉直接调 adoptSession。
 *
 * `ask` 是界面给的问法：只有「本机有内容 + 云端也有内容」、并且**云端那份真拉下来了**
 * 时才会被调用（拉不下来就没有第二份档案可挑，退回合并）。
 * 不传就当用户选了合并——**默认永远是不丢东西的那条**。
 */
export async function signInWithLocalData(
  session: Session,
  ask?: (info: LoginAsk) => Promise<LoginChoice>,
): Promise<SignInOutcome> {
  const before = appStore.getState();
  // 「从没同步过」看的是**登录之前**那个登录态：新拿到的这个 session 的 syncedAt
  // 永远是 null（cloud.toSession 就是这么造的），拿它判等于永远为真
  const prev = syncStore.getState().session;
  const pristine = isPristineLocal({ data: before.data, everSynced: !!prev?.syncedAt });

  // 云端有没有东西：问一句 /api/me 就够，不用把整份数据拉下来。
  // 问不出来（断网 / 服务器抽风）一律当「没有」，那一路走合并，不会动本机一个字
  let cloudHasData = false;
  try {
    const info = await cloud.whoAmI(session.token);
    cloudHasData = !!info.hasData;
  } catch {
    cloudHasData = false;
  }

  const plan = planLoginData({ pristine, cloudHasData });
  let action: LoginChoice = plan === "replace" ? "cloud" : "merge";
  let asked = false;
  let same = false;
  /** 要摆给用户看的那份云端档案。**只拉不落**：这会儿一个字都还没写进本机 */
  let remote: AppData | null = null;

  if (plan === "ask") {
    // 要让用户在两份档案之间挑，光有「第几版」不够——他得看见两边各有多少事、
    // 多少清单、最近什么时候动过。这些只有把云端那份真拉下来才算得出，
    // 所以这里走 pullOnly：**只拉，不合也不落**，用户没拍板之前本机一个字不动
    let pulled: { rev: number; data: AppData | null; updatedAt: string | null } | null = null;
    try {
      pulled = await cloud.pullOnly(session);
    } catch {
      pulled = null;
    }
    remote = pulled?.data ?? null;
    if (remote && pulled && sameContent(before.data, remote)) {
      // 两边内容一模一样（多半是同一个账号在这台设备上退出过又登回来）：摆两张一模一样的卡
      // 让人挑是折腾人（用户 2026-09-03：「如果云端和本地没有差异就不用差异化合并或者选用什么档」）。
      // 不问，走合并——把一份跟自己一样的东西合进来等于什么都没发生，而且照样只落一次
      // state、推一轮，这台设备的版本号也就跟云端接上了。判据见 merge.sameContent
      same = true;
      action = "merge";
    } else if (remote && pulled) {
      asked = true;
      const cloudSum = summarizeProfile(remote);
      action = ask
        ? await ask({
            rev: pulled.rev,
            // 云端那份一条内容都没有时（理论上 hasData 就该是 false）退回服务器记的推送时刻
            cloud: { ...cloudSum, updatedAt: cloudSum.updatedAt ?? pulled.updatedAt },
            local: summarizeProfile(before.data),
          })
        : "merge";
    } else {
      // 拉不下来（断网 / 服务器抽风 / 那份解不开）：退回现有行为——合并。
      // 合并只会多不会少，登录本身照样成功
      action = "merge";
    }
  }

  // 登录态先落下来（「用云端的」那条要它才能拉云端、三条路都要它才能推），
  // 但**先别同步**：默认那一下 syncNow 正是「合并」，而用户可能选的是另外两条
  await adoptSession(session, { sync: false });

  let restored: CloudRestore | null = null;
  if (action === "cloud") {
    try {
      restored = await restoreFromCloud();
    } catch {
      // 覆盖没成（断网、备份写不下去）：本机一个字都没动，退回合并这条稳的路。
      // 不把错误抛出去——用户已经登录成功了，为一次没成的覆盖把登录也报成失败没道理
      action = "merge";
      remote = null; // 云端那份这会儿已经不可信（多半是网断了），走下面那条老路
    }
  }

  let folded = 0;
  let foldedTasks = 0;

  if (action === "cloud" && restored) {
    // 覆盖下来的是**云端已经有的**那一对重复（用户账号里现在就躺着），
    // 清完随下一轮同步推回云端，等于顺手替他把云端也修了
    folded = await tidyDuplicateLists();
  } else if (action === "local" && remote) {
    // 「用这台设备上的那份」：本机内容一个字不动，把云端多出来的立墓碑，
    // 再推上去——推送走的是现成的 syncNow / syncOnce（它自带 base_rev 与 409 重试，
    // 也自带服务端那道 schema 闸门），这里不另写一套推送
    applyRemoteData(keepLocalOverCloud(appStore.getState().data, remote));
    await syncNow();
  } else if (action === "merge" && remote) {
    // 「合并两份」：整套算完**只落一次 state**。
    // 以前是先把合并结果落一次、再把去重结果落第二次，中间那一拍侧栏两份都数进去了，
    // 用户看见的就是「先 double counting、随后才恢复」（2026-09-03 实测反馈）。
    const local = appStore.getState().data;
    const localIds = new Set(local.tasks.map((t) => t.id));
    const remoteIds = new Set(remote.tasks.map((t) => t.id));
    // 顺序：先并同一件事，再并同名清单。反过来的话，同名清单去重会给搬过家的任务
    // 重新盖改动时刻戳，「同一件事留改得晚的那条」就被那一下盖乱了
    // （「在同一条清单」这个判据比的是清单**名字**，所以不必等清单先并完）
    const tidy = dedupeSameTasks(mergeData(local, remote).data, { local: localIds, remote: remoteIds });
    const listed = dedupeListsByName(tidy.data);
    folded = listed.folded;
    foldedTasks = tidy.folded;
    applyRemoteData(listed.data);
    await syncNow();
  } else {
    // 老路：云端是空的（第一台设备开账号）、拉不下来、或者「用云端的」半路失败退回来的。
    // 手里没有云端那份，只能照旧先同步一轮，再收拾同名清单
    await syncNow();
    folded = await tidyDuplicateLists();
  }

  return { action, asked, restored, folded, foldedTasks, plan, same };
}

/** 把内存里这份的同名清单并一并，动过就装回 store 并立刻推一轮。返回折掉的条数。
 *
 *  走 applyRemoteData 而不是 mutate：改动时刻戳 dedupeListsByName 自己盖好了，
 *  再盖一次会把整库标成「本机刚改过」，下一轮同步就拿本机盖掉别的设备；
 *  撤销栈也该清——「撤销一次登录」没有意义，撤回去只会把重复的清单又变出来。
 *
 *  这里 await 而不是 void：调用方登录完往往要 reload 界面，
 *  推之前就把页面刷掉的话，清干净的这份云端一直不知道。 */
async function tidyDuplicateLists(): Promise<number> {
  const cleaned = dedupeListsByName(appStore.getState().data);
  if (cleaned.folded === 0) return 0;
  applyRemoteData(cleaned.data);
  await syncNow();
  return cleaned.folded;
}
