// 给使用者看的更新日志（打进包里，侧栏版本号点开就是它）。每一端一份，只写这一端的。
//
// **内容在 changelog-data.json**，这里只管类型和取法。验收页（交付验收/橡果 v1 怎么验.html）的
// 历史版本也从那份 JSON 生成，两边说法一致。
//
// **这不是 CHANGELOG.md。** 那份是仓库里的工程记录，可以细。这份怎么写，规矩在
// `_work/约定.md` 第五节（用户 2026-09-18 狠批过一次之后定的），最要紧的几条：
//   · 只写使用者用得上的；内部机制、工程、更新日志自己怎么显示，一律不写
//   · 新功能直接点名，再说怎么用、配日常例子（「子任务支持循环：……例如「每周大扫除」」）；不用比喻、不自造说法
//   · 界面和交互的小调整合成最后一张「体验优化」小卡，一小句带过，不逐条解释
//   · 测试版那段（beta）是给开发者 / 管理员看的：累计的每处改动都单独列一张，仍然是产品角度
//   · 分端：某一版对这一端没有看得见的变化，这一端就不列这一版
//   · beta（未发布）那段同一处改几次只写最后结果，不留过程
// tests/changelog.test.ts 会拦住「发了版忘了写」「混进了工程词」「又写回了被骂过的说法」。
//
// **发布时**：beta 那段是写给开发者 / 管理员的，要按第五节改写成给使用者看的（去掉只跟开发者有关的，
// 比如「测试版显示 beta」「管理员可更新到测试版」，细节并进「体验优化」），填上号和日期放到这一端列表最上面；
// beta 那段清空，下一轮重新攒。

import data from "./changelog-data.json";
import { APP_PLATFORM, APP_VERSION, IS_BETA, compareVersions, type Platform } from "./version";

export type Highlight = {
  /** 功能名，短 */
  title: string;
  /** 一两句：能做什么、怎么用，最好带个日常例子 */
  body: string;
};

export type ChangelogEntry = {
  version: string;
  /** YYYY-MM-DD */
  date: string;
  /** 这一版最主要的新功能，直接点名；没有新功能就写「体验优化与问题修复」 */
  headline: string;
  /** 每条一张小卡：新功能各一张；细节合成最后一张「体验优化」（工程上的写「工程优化」），一小句带过。
   *  没有「还有」那一行了（用户 2026-09-18）。测试版那段是给开发者 / 管理员看的，每处改动都要单独列 */
  highlights: Highlight[];
};

/** 还没发布、装在测试版里的那一段：没有号，号就是这台设备上那个测试版号 */
export type BetaNotes = Omit<ChangelogEntry, "version">;

/** 三端各自已经发布的版本，新的在前 */
export const CHANGELOG: Record<Platform, ChangelogEntry[]> = {
  desktop: data.desktop,
  android: data.android,
  web: data.web,
};

/** 三端各自攒着、还没发布的那一段 */
export const BETA_NOTES: Partial<Record<Platform, BetaNotes>> = data.beta;

/**
 * 某一端的更新日志。装的是测试版时，最上面多一块「这个测试版比上一个正式版多了什么」，
 * 号就用这台设备上的测试版号（界面上显示成 beta），上一个正式版挪进「之前的版本」。
 */
export function changelogFor(
  platform: Platform = APP_PLATFORM,
  opts: { beta?: boolean; betaVersion?: string } = {},
): ChangelogEntry[] {
  const released = [...CHANGELOG[platform]].sort((a, b) => compareVersions(b.version, a.version));
  const beta = opts.beta ?? IS_BETA;
  const notes = BETA_NOTES[platform];
  if (!beta || !notes) return released;
  return [{ ...notes, version: opts.betaVersion ?? APP_VERSION }, ...released];
}
