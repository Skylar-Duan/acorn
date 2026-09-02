// 「这台设备是不是全新的」——登录时怎么处置本机数据、首次启动要不要请人登录，都问这里。
//
// 为什么单独一个文件、为什么全是纯函数：这几条判断的下游动作是**整份覆盖本机数据**，
// 属于数据安全级别。掺进 store / cloud 里就没法单独测，而这里每一个分支都必须有用例钉着。
//
// 背景（用户 2026-09-02 在手机上第一次装 v1.10.1 之后的反馈）：
// 新装的橡果自带「工作 / 生活」两条默认清单，登录同一个账号之后跟云端一合，
// 就出现了两个「工作」。用户的原话是「登录后，已经有的东西应该全部删除」——
// 一台什么都还没记过的新设备，登录时本机那份没有任何值得保留的东西，
// 该做的是**把云端整份取回来**，而不是跟一本空账本做合并。
//
// 一条底线贯穿全篇：**宁可判严不判松**。判成「全新」会让本机那份被覆盖掉，
// 所以但凡有一点点用户自己的痕迹（哪怕是回收站里一条、一次专注记录、一个改过的清单名），
// 就一律不算全新，老老实实走合并——合并只会多不会少。

import type { AppData } from "./model";
import { defaultData } from "./model";

/** 默认账本自带的清单名（现在是「工作」「生活」），已排序。
 *  不写死字面量：从 defaultData() 取，将来改了默认清单这里自动跟上，
 *  否则改完默认清单，这条判据会永远判「不是全新」，谁都不会注意到 */
export const DEFAULT_LIST_NAMES: readonly string[] = defaultData()
  .lists.map((l) => l.name)
  .sort();

export interface PristineInput {
  /** 本机内存里这份账本 */
  data: AppData;
  /** 这台设备**成功同步过**（session.syncedAt 非空）。没登录过就是 false。
   *  同步过说明这台设备上的东西已经跟某个账号发生过关系，不能再当白纸看待 */
  everSynced: boolean;
}

/**
 * 本机这份是不是「什么都还没有」的全新状态。
 *
 * 全部条件（缺一不可，任何一条不满足都当「有用户内容」）：
 * · 一条任务都没有——回收站里的、习惯，全都在 tasks 里，这一条就把三样一起管了
 * · 一次专注记录都没有
 * · 墓碑是空的（彻底删过东西 = 用过这个软件）
 * · 需求方排序是空的（whoOrder 一有内容，说明用户排过人名）
 * · 清单要么一条没有（刚清空过本机的那种），要么**正好**是默认那两条、名字一个字没改
 * · 从没成功同步过
 *
 * 注意「清单一条没有」也算全新：那是「退出登录并清空本机」之后那一次启动的样子
 * （store.initStore 的 freshStart 分支），盘上一个字都没有，更没有什么可保留的。
 */
export function isPristineLocal({ data, everSynced }: PristineInput): boolean {
  if (everSynced) return false;
  if (data.tasks.length > 0) return false;
  if ((data.sessions ?? []).length > 0) return false;
  if ((data.graveyard ?? []).length > 0) return false;
  if ((data.settings?.whoOrder ?? []).length > 0) return false;
  const names = data.lists.map((l) => l.name.trim()).sort();
  if (names.length === 0) return true;
  if (names.length !== DEFAULT_LIST_NAMES.length) return false;
  return names.every((n, i) => n === DEFAULT_LIST_NAMES[i]);
}

/** 登录成功那一刻，本机这份该怎么处置。
 *  · replace = 用云端整份覆盖本机（本机是全新的，没什么可丢的）
 *  · merge   = 走现有的合并（两边都留着）
 *  · ask     = 两边都有内容，得让用户自己拍板，界面弹框问 */
export type LoginDataAction = "replace" | "merge" | "ask";

/**
 * 决策表。只有两个输入，摊开就四种：
 *
 * | 本机 \ 云端 | 云端有内容 | 云端是空的 |
 * |---|---|---|
 * | 本机全新   | replace | merge |
 * | 本机有内容 | ask     | merge |
 *
 * 云端是空的时候永远走 merge：没有东西可以拿来覆盖，问用户也没意义，
 * 合并的效果就是把本机这份推上去——这正是「第一台设备开账号」该有的样子。
 *
 * **云端有没有内容判断不了时（断网、服务器抽风）传 false**：那一路走 merge，
 * 只会多不会少。绝不能在不确定的时候去覆盖本机。
 */
export function planLoginData(o: { pristine: boolean; cloudHasData: boolean }): LoginDataAction {
  if (!o.cloudHasData) return "merge";
  return o.pristine ? "replace" : "ask";
}

// ---------- 首次启动要不要请人登录 ----------

/** 用户在首启登录框上点过「以后再说」。
 *  按 `acorn-` 前缀存 localStorage，清空本机时会被 persist.clearLocalPrefs 一并扫掉——
 *  那正好：本机都清干净了，下次开起来本来就该重新问一次 */
export const LOGIN_LATER_KEY = "acorn-login-later";

export function isLoginLater(): boolean {
  try {
    return localStorage.getItem(LOGIN_LATER_KEY) === "1";
  } catch {
    return false; // 存储不可用只是这台设备每次都会被问一遍，不值得为它出错
  }
}

/** 记下「以后再说」。只记「别再自动弹」，**不关掉设置页里的登录入口**——
 *  用户随时可以自己去登，这个标记只管首启那个框 */
export function markLoginLater(): void {
  try {
    localStorage.setItem(LOGIN_LATER_KEY, "1");
  } catch {
    /* 记不住就下次开机再问一遍，比问不出来强 */
  }
}

export interface LoginOfferState {
  /** 当前有登录态 */
  signedIn: boolean;
  /** isPristineLocal 的结果：这台设备什么都还没有 */
  pristine: boolean;
  /** 点过「以后再说」 */
  later: boolean;
}

/**
 * 首次启动该不该把登录框顶出来。
 *
 * 只在**三件事同时成立**时才弹：没登录、本机是全新的、没点过「以后再说」。
 * 「本机是全新的」这一条是关键——已经记了一堆事的老用户不该被一个登录框拦在门口，
 * 那是把云账号从「可选的便利」变成「进门收费站」。
 *
 * 这里只出判据，弹不弹、长什么样由界面决定（界面另有人做）。
 */
export function shouldOfferLogin(s: LoginOfferState): boolean {
  return !s.signedIn && s.pristine && !s.later;
}
