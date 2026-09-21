// 设置页「反馈」那一节的判据、说法和那一个外链（2026-09-21）。
//
// 用户原话：「三端：反馈入口做出来（放到设置里面）」。三端同一份 Settings.tsx，
// 这里只放纯函数和一个开外链的小工具，界面在 components/FeedbackPanel.tsx。
//
// 发出去的时候自动带上三样，用户不用自己写「我用的是哪个版本」：
//   · 端（APP_PLATFORM：desktop / android / web，正好就是服务端白名单那三个字）
//   · 版本（APP_VERSION，测试版会是 1.15.1-beta.N 这种完整的号——界面上只写 beta，这里要真号）
//   · 设备（cloud.deviceName()，跟「上次同步来自哪台设备」同一个说法）
//
// 网络请求照旧只在 core/cloud 里（submitFeedback），这个文件里没有 fetch。

import * as cloud from "./cloud";
import { API_BASE, deviceName } from "./cloud";
import { APP_PLATFORM, APP_VERSION } from "./version";
import { inTauri } from "./platform";

/** 一条反馈最多几个字。服务端 FEEDBACK_MAX_CHARS 也是 2000，两处得对得上 */
export const FEEDBACK_MAX = 2000;

/** 剩下不到这么多字时才显示「还能写几个字」——平时一直挂个数字是噪音 */
export const FEEDBACK_WARN_LEFT = 200;

/** 管理员看大家反馈的地方：介绍页（管理员登录后那里有「反馈」面板） */
export const FEEDBACK_ADMIN_URL = `${API_BASE}/intro/`;

/** 按服务端的数法数字数：换行统一、首尾空白不算，一个表情算一个字（不是两个） */
export function feedbackLength(text: string): number {
  return [...text.replace(/\r\n?/g, "\n").trim()].length;
}

/** 还能写几个字（写超了是负数） */
export function feedbackLeft(text: string): number {
  return FEEDBACK_MAX - feedbackLength(text);
}

/** 「发送」此刻能不能按：写了东西、没超长 */
export function canSendFeedback(text: string): boolean {
  const n = feedbackLength(text);
  return n > 0 && n <= FEEDBACK_MAX;
}

/** 字数提示那一行写什么；不该显示时是 null */
export function feedbackCountText(text: string): string | null {
  const left = feedbackLeft(text);
  if (left < 0) return `超出 ${-left} 字，删掉一些再发`;
  if (left <= FEEDBACK_WARN_LEFT) return `还能写 ${left} 字`;
  return null;
}

/** 真发出去的那一份 */
export function feedbackPayload(text: string): cloud.FeedbackIn {
  return {
    text: text.replace(/\r\n?/g, "\n").trim(),
    platform: APP_PLATFORM,
    version: APP_VERSION,
    device: deviceName(),
  };
}

/** 这个账号**此刻**能不能看大家的反馈：只认 feedbackAdmin——跟服务端反馈后台放行的条件一模一样。
 *  isAdmin 比它宽（cdpandas 给的管理员身份不看新不新鲜），拿它开入口会出现「点开了是空的」。
 *  老服务器两项都不给，一律当不是 */
export function isFeedbackAdmin(info: cloud.RemoteInfo | null | undefined): boolean {
  return !!info?.feedbackAdmin;
}

/** 是管理员、但隔了一阵没登录，服务端这会儿不放他进反馈后台（isAdmin 真、feedbackAdmin 假）。
 *  这种不给入口，只说一句怎么才能看——重新登录一次，服务端就会重新确认他的管理员身份 */
export function feedbackAdminStale(info: cloud.RemoteInfo | null | undefined): boolean {
  return !!info?.isAdmin && !info?.feedbackAdmin;
}

/** 上面那种情况底下那句话 */
export const FEEDBACK_ADMIN_STALE_TEXT = "要看大家的反馈，先退出再登录一次";

/** 发送失败时那句话。login = 要不要顺手给一颗「去登录」 */
export function feedbackErr(e: unknown): { text: string; login: boolean } {
  if (e instanceof cloud.ApiError) {
    if (e.needsLogin) return { text: "登录已经过期，重新登录后再发", login: true };
    if (e.slug === "unverified") return { text: "邮箱还没验证，重新登录一下再发", login: true };
    if (e.slug === "feedback_too_long") return { text: `太长了，一条最多 ${FEEDBACK_MAX} 字，拆成几条发`, login: false };
    if (e.slug === "empty_feedback") return { text: "写点什么再发", login: false };
    if (e.status === 429) return { text: "发得太勤了，过一会儿再发", login: false };
    if (e.status === 0) return { text: "网络不通，没发出去。写的字还在，连上网再发", login: false };
    // 服务器还没有反馈这项（老服务器）：别让人对着一句「服务器出错（404）」发愣
    if (e.status === 404) return { text: "现在还发不了反馈，过几天再试", login: false };
    // 服务端的 account_unavailable，或者前面网关只回了个 503 页面：都是过一会儿再试
    if (e.status === 503) return { text: "暂时发不出去，过一会儿再试", login: false };
  }
  const msg = e instanceof Error && e.message ? e.message : "";
  return { text: msg ? `没发出去：${msg}` : "没发出去，过一会儿再试", login: false };
}

/** 在系统浏览器里打开一个网址。
 *  装好的橡果（电脑 / 安卓）走 opener 插件——webview 里的 window.open 是静默无效的
 *  （updater.openFallback 头注释里那次踩过）；浏览器里就是开一个新标签页。
 *  返回开没开成，开不成由界面说一句 */
export async function openExternal(url: string): Promise<boolean> {
  try {
    if (inTauri) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return true;
    }
    // 带 noopener 时浏览器返回 null，那不代表没开，所以不看返回值
    window.open(url, "_blank", "noopener,noreferrer");
    return true;
  } catch {
    return false;
  }
}
