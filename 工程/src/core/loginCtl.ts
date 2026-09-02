// 登录成功那一刻，本机这份数据怎么办。
//
// 以前只有一条路：登录 → 立刻跟云端合并。新装的橡果自带「工作 / 生活」两条默认清单，
// 合并只认 id 不认名字，于是用户第一次在手机上登录，侧栏就出现了两个「工作」
// （2026-09-02 用户反馈原文：「登录后，已经有的东西应该全部删除，这里两个『工作』的分类肯定不行」）。
//
// 现在分三条路（判据在 fresh.ts，全是纯函数）：
//   · 本机什么都还没有 + 云端有内容 → **用云端整份覆盖本机**，默认清单直接丢
//   · 两边都有内容                   → 停下来问用户：合并，还是用云端覆盖
//   · 云端是空的                     → 照常合并（等于把本机这份推上去，第一台设备就该这样）
//
// 三条路走完，最后统一收拾一遍同名清单（merge.dedupeListsByName）——
// 用户账号里**现在就已经躺着**两条「工作」，光靠上面三条路是清不掉的。
//
// 两条底线：
// ① 覆盖走的是现成那条路（wipe.restoreFromCloud），不另写一套：
//    它自带「先落盘 → 先备份 → 云端空了就一个字不动」这一整套闸门，重写一遍必然漏掉某一道。
// ② 云端有没有内容问不出来时（断网、服务器抽风）一律当「没有」→ 走合并。
//    合并只会多不会少，**绝不在不确定的时候覆盖本机**。

import { applyRemoteData, appStore } from "./store";
import * as cloud from "./cloud";
import type { Session } from "./cloud";
import { adoptSession, syncNow, syncStore } from "./syncCtl";
import { restoreFromCloud } from "./wipe";
import type { CloudRestore } from "./wipe";
import { dedupeListsByName } from "./merge";
import { isPristineLocal, planLoginData } from "./fresh";
import type { LoginDataAction } from "./fresh";

/** 用户在「两边都有内容」那个框上的选择 */
export type LoginChoice = "merge" | "replace";

export interface LoginAsk {
  /** 云端上次更新的时刻（拿不到是 null），给文案用 */
  updatedAt: string | null;
  /** 云端那份的版本号 */
  rev: number;
  /** 本机现在有几条活着的事 */
  localTasks: number;
}

/** 默认问法。**界面另有人做**，这里只保证「不接界面也能问得出口」——
 *  AccountPanel 现在拿它去喂系统确认框，将来换成正经弹窗时文案再由界面那边定 */
export function askText(info: LoginAsk): string {
  return (
    "云端已经存着一份数据，这台设备上也有记过的事。\n\n" +
    `· 这台设备：${info.localTasks} 条事\n` +
    `· 云端：第 ${info.rev} 版${info.updatedAt ? `，上次更新 ${info.updatedAt.slice(0, 10)}` : ""}\n\n` +
    "点「确定」= 用云端那份**覆盖**这台设备，本机现在有、云端没有的会消失（覆盖前会自动留一份备份）。\n" +
    "点「取消」= 把两边**合并**，两边的东西都留着（推荐）。"
  );
}

export interface SignInOutcome {
  /** 最后真正走的是哪条路 */
  action: LoginChoice;
  /** 有没有停下来问过用户 */
  asked: boolean;
  /** 走覆盖时云端那份的情况；走合并是 null */
  restored: CloudRestore | null;
  /** 顺手折掉了几条重名清单 */
  folded: number;
  /** 本来打算走哪条（ask 表示问过用户）。排查用，界面不必管 */
  plan: LoginDataAction;
}

/**
 * 登录 / 注册验证 / 改密码之后统一走这里，替掉直接调 adoptSession。
 *
 * `ask` 是界面给的问法：只有「本机有内容 + 云端也有内容」时才会被调用。
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
  let rev = 0;
  let updatedAt: string | null = null;
  try {
    const info = await cloud.whoAmI(session.token);
    cloudHasData = !!info.hasData;
    rev = info.rev;
    updatedAt = info.updatedAt;
  } catch {
    cloudHasData = false;
  }

  const plan = planLoginData({ pristine, cloudHasData });
  let action: LoginChoice = plan === "replace" ? "replace" : "merge";
  let asked = false;
  if (plan === "ask") {
    asked = true;
    const localTasks = before.data.tasks.filter((t) => !t.deletedAt).length;
    action = ask ? await ask({ rev, updatedAt, localTasks }) : "merge";
  }

  // 登录态先落下来（覆盖那条路要它才能拉云端），但**先别同步**：
  // 默认那一下 syncNow 正是「合并」，而我们可能要的是覆盖
  await adoptSession(session, { sync: false });

  let restored: CloudRestore | null = null;
  if (action === "replace") {
    try {
      restored = await restoreFromCloud();
    } catch {
      // 覆盖没成（断网、备份写不下去）：本机一个字都没动，退回合并这条稳的路。
      // 不把错误抛出去——用户已经登录成功了，为一次没成的覆盖把登录也报成失败没道理
      action = "merge";
    }
  }
  if (action === "merge") await syncNow();

  // 最后统一收拾同名清单。三条路都要走这一遭：
  // · 合并那条会当场造出「两个工作」，正是要清的；
  // · 覆盖那条清的是**云端已经有的**那一对重复（用户账号里现在就躺着），
  //   清完随下一轮同步推回云端，等于顺手替他把云端也修了
  const folded = await tidyDuplicateLists();

  return { action, asked, restored, folded, plan };
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
