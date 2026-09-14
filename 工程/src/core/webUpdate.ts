// 网页版的「有新版了」。
//
// 桌面和安卓靠 updater.ts：自己下包、自己拉起安装。网页版没有包可下——**刷新一下就是新版**，
// 所以 updater.ts 里那条路在浏览器里天然走不通（updaterSupported 恒为 false），这边不去碰它。
//
// 那为什么还需要这么个东西：iPhone 上「添加到主屏幕」之后，那个窗口用起来跟一个 App 一样，
// 按 Home 键收起来、隔天再点开，中间**不会重新加载**。服务器上早换了新版，它还跑着上礼拜那份代码，
// 时间一长可能跟服务端对不上账。
//
// 这个模块只干一件事：隔一阵去问一句「服务器现在是哪一版」，比手里这份新就喊一声。
// 怎么提示（借现成的 toast 说一句「有新版了，点这里刷新」）、在哪儿挂，都不归这里管——
// 这里不碰 store、不碰界面，只回调。
//
// version.json 是发布时由 server/deploy/publish-web.sh 写在网页版根目录下的，
// 内容就是 {"version": "1.15.0", "publishedAt": "..."}。没有这个文件（还没发过）就当查不到，
// 安安静静什么都不做——宁可不提示，也不能给人弹一句莫名其妙的话。

import { APP_VERSION } from "./model";
import { compareVersions } from "./updater";

/**
 * 这份代码是不是网页版打出来的（vite.config.ts 在 `--mode web` 下把它写死成 "1"）。
 *
 * v1.15.0 第六波把它并进了 platform.ts —— 那儿还有 isWeb / isDesktopShell 一族，
 * 「我是谁」这类判断全放一处。这里只转手再导出一次，同一件事不留两套。
 */
export { isWebBuild } from "./platform";

/** 版本清单的地址。BASE_URL 网页版是 "/app/"，所以查的是 /app/version.json；
 *  跟着 base 走而不是写死，本地 `vite --mode web` 预览时也对得上 */
export const WEB_VERSION_URL = `${import.meta.env.BASE_URL || "/"}version.json`;

/** 多久问一次。四小时：加到主屏幕的窗口一开就是好几天，一天问六次足够早发现，
 *  又不至于在用户流量上多花什么（一次不到 100 字节） */
export const WEB_POLL_MS = 4 * 60 * 60 * 1000;

/** 从服务器那份清单里取版本号。取不到就返回 null——缺斤少两一律当「没查到」 */
export function parseWebVersion(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const v = (raw as Record<string, unknown>).version;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  // 至少得像个版本号（1.15.0 / 1.15），否则八成是拿到了一张 404 页面
  return /^\d+(\.\d+)*$/.test(trimmed) ? trimmed : null;
}

export interface FetchWebVersionOpts {
  url?: string;
  fetchImpl?: typeof fetch;
  /** 给 URL 后面挂的那个随机数，测试里要固定住 */
  stamp?: () => number;
}

/**
 * 去服务器问一句现在是哪一版。任何异常都吞掉返回 null：
 * 断网、服务器抽风都不该在界面上留下痕迹，下一轮再问就是了。
 */
export async function fetchWebVersion(opts: FetchWebVersionOpts = {}): Promise<string | null> {
  const f = opts.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);
  if (!f) return null;
  const base = opts.url ?? WEB_VERSION_URL;
  // 挂个时间戳：cache: "no-store" 中间隔着 CDN / 运营商缓存时不一定管用，
  // 而查到的要是一份旧清单，这个模块就完全白做了
  const stamp = (opts.stamp ?? Date.now)();
  const url = `${base}${base.includes("?") ? "&" : "?"}t=${stamp}`;
  try {
    const res = await f(url, { cache: "no-store", credentials: "omit" });
    if (!res.ok) return null;
    return parseWebVersion(await res.json());
  } catch {
    return null;
  }
}

export interface WebUpdateWatchOpts {
  /** 查到更新时叫一声，参数是服务器上那个版本号。只会叫一次，不反复烦人 */
  onNewVersion: (version: string) => void;
  /** 手里这份是哪一版，默认就是本次打包的版本 */
  current?: string;
  intervalMs?: number;
  url?: string;
  fetchImpl?: typeof fetch;
}

/**
 * 开始盯着服务器上的版本。返回一个「别盯了」的函数。
 *
 * 两个时机会去问：① 每隔 intervalMs；② 页面重新回到前台，且距上次问已经超过一轮。
 * 第二条才是加到主屏幕那个场景的主力——窗口在后台挂着的时候定时器可能被系统冻住，
 * 用户重新点开它的那一下，恰好是最该去问一句的时候。
 */
export function startWebUpdateWatch(opts: WebUpdateWatchOpts): () => void {
  const current = opts.current ?? APP_VERSION;
  const intervalMs = opts.intervalMs ?? WEB_POLL_MS;
  let stopped = false;
  let announced = false;
  let lastCheck = 0;

  const check = async (): Promise<void> => {
    if (stopped || announced) return;
    lastCheck = Date.now();
    const remote = await fetchWebVersion({ url: opts.url, fetchImpl: opts.fetchImpl });
    if (stopped || announced || !remote) return;
    if (compareVersions(remote, current) > 0) {
      announced = true;
      opts.onNewVersion(remote);
    }
  };

  void check();
  const timer = setInterval(() => void check(), intervalMs);

  const onVisible = (): void => {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - lastCheck < intervalMs) return;
    void check();
  };
  const hasDoc = typeof document !== "undefined";
  if (hasDoc) document.addEventListener("visibilitychange", onVisible);

  return () => {
    stopped = true;
    clearInterval(timer);
    if (hasDoc) document.removeEventListener("visibilitychange", onVisible);
  };
}

/**
 * 换上新版：就是重新加载一次。
 * index.html 在服务器上是 no-cache 的（见 nginx-acorn.conf），刷一下拿到的就是新的那份。
 */
export function reloadForUpdate(): void {
  if (typeof location !== "undefined") location.reload();
}
