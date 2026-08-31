// 自动更新：App 自己问「有没有新版」，有就自己下、自己拉起安装。手机和桌面共用这一套。
//
// 为什么不让用户去网页找：让人去浏览器点来点去、再从下载目录里翻安装包，
// 是最容易半路走丢的一段路。网页只当**备用**——App 内这条路走不通时才给出来。
//
// 两端的差别只有三处：查哪个清单（android / desktop）、包叫什么（.apk / .exe）、
// 装的时候要不要先把自己退掉（桌面要，见 installPackage）。

import { APP_VERSION, DATA_VERSION } from "./model";
import { API_BASE } from "./cloud";
import { hasDesktopFeatures, isAndroid } from "./platform";
import { inTauri } from "./persist";

export interface UpdateInfo {
  version: string;
  /** 这个新版认的数据模型版本；用来解释「为什么必须升」 */
  schema: number;
  url: string;
  size: number;
  sha256: string;
  notes: string;
  publishedAt: string;
  /** 备用：App 内装不上时让用户自己去下 */
  pageUrl: string;
}

/**
 * 比版本号。`1.10.0 > 1.9.0`（不能按字符串比，那样 1.10 会小于 1.9）。
 * 段数不一样时缺的位当 0：`1.7` 和 `1.7.0` 是同一个版本。
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function isNewer(remote: string, local: string = APP_VERSION): boolean {
  return compareVersions(remote, local) > 0;
}

/** 把服务器返回的清单校成 UpdateInfo；缺斤少两就当没有更新（宁可不提示，也不给个下不动的按钮） */
export function parseManifest(raw: unknown): UpdateInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (m.available !== true) return null;
  const version = typeof m.version === "string" ? m.version : "";
  const url = typeof m.url === "string" ? m.url : "";
  if (!version || !url) return null;
  // 只认自家服务器的下载地址：清单要是被人改过，也不能把用户引到别处去装东西
  if (!url.startsWith(`${API_BASE}/`) && !url.startsWith("https://acorn.cdpandas.com/")) return null;
  return {
    version,
    schema: typeof m.schema === "number" ? m.schema : 0,
    url,
    size: typeof m.size === "number" ? m.size : 0,
    sha256: typeof m.sha256 === "string" ? m.sha256 : "",
    notes: typeof m.notes === "string" ? m.notes : "",
    publishedAt: typeof m.publishedAt === "string" ? m.publishedAt : "",
    pageUrl: typeof m.pageUrl === "string" ? m.pageUrl : "",
  };
}

/** 值得提示用户升级吗 */
export function shouldOffer(info: UpdateInfo | null, local: string = APP_VERSION): boolean {
  if (info === null) return false;
  // dev 环境（版本号不是数字）不提示，免得开发时天天弹
  if (!/^\d/.test(local)) return false;
  return isNewer(info.version, local);
}

/** 这次更新是不是「非升不可」——新版数据模型比本机高，不升就同步不了 */
export function isRequiredForSync(info: UpdateInfo | null): boolean {
  return info !== null && info.schema > DATA_VERSION;
}

// ---------- 网络 ----------

/** 这台设备该查哪个通道的清单 */
export const UPDATE_CHANNEL: "android" | "desktop" = isAndroid ? "android" : "desktop";

/**
 * 查一次的结果。
 *
 * **「没查到」和「已经是最新」必须分开**：以前两种情况都返回 null，界面一律显示
 * 「已经是最新版了」——断网时这是骗人，而且用户要的「检测失败请检查网络」根本做不出来。
 */
export type UpdateCheck =
  | { ok: true; info: UpdateInfo | null }
  | { ok: false; reason: "offline" | "timeout" | "http" };

const CHECK_TIMEOUT_MS = 12000;

export async function fetchUpdate(): Promise<UpdateCheck> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/api/${UPDATE_CHANNEL}/latest`, { signal: ctrl.signal });
    if (!res.ok) return { ok: false, reason: "http" };
    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      return { ok: false, reason: "http" }; // 清单读不成 JSON：服务端出的事，别栽给网络
    }
    return { ok: true, info: parseManifest(raw) };
  } catch {
    // 超时和「压根连不上」分开报：前者多半是网慢，后者才是真断网
    return { ok: false, reason: timedOut ? "timeout" : "offline" };
  } finally {
    clearTimeout(timer);
  }
}

async function inv<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export interface DownloadProgress {
  received: number;
  total: number;
}

/** 下下来的包叫什么。安卓是 APK，桌面是 NSIS 安装器 */
export function packageName(version: string): string {
  return `Acorn_${version}.${isAndroid ? "apk" : "exe"}`;
}

/**
 * 把下好的字节交给 Rust 落盘。
 *
 * 桌面走原始 IPC（save_download_raw）：安装包接近 30MB，按 JSON 数字数组传会膨胀成
 * 80-100MB 的字符串，WebView2 上光拼这个串就能把内存顶爆。
 * 安卓走不了原始 IPC（安卓 webview 读不了自定义协议的请求体，Tauri 自己就是这么判的），
 * 只能继续走 JSON 那条——APK 33MB 实测能过。
 */
async function savePackage(name: string, bytes: Uint8Array): Promise<string> {
  if (isAndroid) return inv<string>("save_download", { name, bytes: Array.from(bytes) });
  const { invoke } = await import("@tauri-apps/api/core");
  // 整个 payload 就是这段字节，文件名只能另走请求头
  return invoke<string>("save_download_raw", bytes, { headers: { "acorn-file-name": name } });
}

/**
 * 下载看门狗：这么久没收到新字节，就当这条连接已经死了，主动断掉。
 *
 * 为什么非有不可：连接**挂住**跟连接断开是两回事——合盖、切到没网的热点、
 * 公司门户劫持、服务端 hang 住，这些情况下 TCP 上一个字节都不来、也不报错，
 * `reader.read()` 会永远不返回。而这条请求走的时候界面上盖着一整块遮罩，
 * 卡住就等于把整个应用锁死，只能去任务管理器杀进程。
 */
export const DOWNLOAD_STALL_MS = 30000;

/** 用户自己点了「取消」时抛的这一条。调用方靠它把状态打回 idle，而不是报一条红字错误 */
export const DOWNLOAD_CANCELLED = "acorn:download-cancelled";

/** 这次失败是不是用户自己叫停的 */
export function isCancelled(e: unknown): boolean {
  return e instanceof Error && e.message === DOWNLOAD_CANCELLED;
}

/**
 * 把安装包下下来存到应用私有目录，返回文件路径。
 * 边下边报进度——30MB 上下的包要走一会儿，没进度条的等待最难熬。
 *
 * **这条路必须能中断**，而且有两个来源：外面传进来的 signal 是「用户点了取消」，
 * 内部的看门狗是「连接挂住了但没人来点取消」。两条都接到同一个 controller 上，
 * 哪条先到都能把 fetch 断掉。全仓库最长的一次请求，不能是唯一裸奔的那条。
 */
export async function downloadPackage(
  info: UpdateInfo,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  const ctrl = new AbortController();
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const relay = () => ctrl.abort();
  const disarm = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    signal?.removeEventListener("abort", relay);
  };
  // 每收到一批新字节就把看门狗重置一次：慢但活着的连接不该被误杀
  const bump = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      ctrl.abort();
    }, DOWNLOAD_STALL_MS);
  };
  if (signal?.aborted) ctrl.abort();
  else signal?.addEventListener("abort", relay);

  try {
    bump(); // 连响应头都没回来的那一段同样算「卡住」，所以看门狗从 fetch 之前就开始走
    const res = await fetch(info.url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
    const total = Number(res.headers.get("content-length")) || info.size || 0;

    const reader = res.body?.getReader();
    if (!reader) throw new Error("这台设备的浏览器内核不支持边下边存");

    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bump();
      chunks.push(value);
      received += value.length;
      onProgress({ received, total });
    }
    disarm(); // 字节收齐了；后面校验和落盘慢一点是正常的，别再让看门狗掺和

    const bytes = new Uint8Array(received);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }

    // 校验完整性：半截包装上去只会得到一个「解析包时出现问题」
    if (info.sha256) {
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      if (hex !== info.sha256.toLowerCase()) {
        throw new Error("安装包校验不通过（可能下载中断），已中止安装，请重试");
      }
    }

    return await savePackage(packageName(info.version), bytes);
  } catch (e) {
    // 三种断法要分开报：用户点的取消根本不是错误，看门狗踢掉的得说清是网络卡住了
    if (signal?.aborted) throw new Error(DOWNLOAD_CANCELLED);
    if (stalled) {
      throw new Error(
        `下载卡住了：${Math.round(DOWNLOAD_STALL_MS / 1000)} 秒没有收到新数据，已中止。请检查网络后重试`,
      );
    }
    throw e;
  } finally {
    disarm();
  }
}

/**
 * 交接结果。
 *
 * - `"failed"`：安装界面压根没拉起来，得走备用（浏览器下载页）。
 * - `"handed-off"`：安装器已经起来了，**但橡果还在跑**。
 * - `"cancelled"`：用户在交接之前点了「稍后再说」，什么都没发生。
 *
 * 没有「装好了」这一种，因为装好了这个进程早就不在了，没人接得到返回值。
 * 换句话说：只要这个函数返回了，界面就必须把出口还给用户——
 * 安卓上系统那一步随时可能被取消（首次安装必经的「允许未知来源」就是一次取消机会），
 * 桌面上 exit_app 也可能没生效。以前这里返回 true 就让界面停在「安装中」，
 * 用户回到橡果看到的是一个一个按钮都没有的全屏遮罩，只能强杀进程。
 */
export type InstallOutcome = "failed" | "handed-off" | "cancelled";

/** 桌面上等自己退出的宽限期。到点还活着，就说明 exit_app 没退成，得把界面还给用户 */
export const EXIT_GRACE_MS = 4000;

/**
 * 把包交给系统安装器。
 *
 * 安卓走官方 opener 插件：它会走 FileProvider 出 content:// URI，
 * 这是 API 24 起唯一能把文件递给别的应用的方式（Tauri 生成的安卓工程里已经声明好 provider）。
 *
 * **桌面走 Rust 的 run_installer，不用 openPath**：安装器必须带上 `/UPDATE` 才行。
 * openPath 只是让系统「打开」这个文件，递不进命令行参数，于是新安装器 $UpdateMode = 0、
 * 照常去调旧版 uninstaller，卸载钩子把 auth.json 删掉——**每次 App 内升级都静默登出**，
 * 云同步从此停摆，而用户在界面上看不到任何异样。
 *
 * **不抛异常**：装不上只是少条捷径，不能把界面搞崩。
 *
 * **桌面上拉起之后必须把自己退掉**，顺序还不能错：先让安装器起来，
 * 再 flushSync 把没落盘的写下去，最后 exit_app。理由是 NSIS 装完会拉起新的 acorn.exe，
 * 旧进程要是还没退干净，新进程会被单实例挡回去、只把旧窗口 show 出来——
 * 用户看到的是「更新了但还是老版本」。而且 exe 在跑时文件被占，安装器也复制不进去。
 *
 * `stillOn`：这一轮还算不算数（用户没点过「稍后再说」）。整段交接要走好几秒，
 * 中间用户改主意是常事，所以**拉起安装器之前、退掉自己之前各查一次**——
 * 光靠调用方那道 runId 闸门拦不住已经跑起来的这个函数。
 * `onLaunched`：安装器真的起来了，从这一刻起停不下来了，界面据此把「稍后再说」收掉。
 */
export async function installPackage(
  path: string,
  stillOn: () => boolean = () => true,
  onLaunched?: () => void,
): Promise<InstallOutcome> {
  if (!stillOn()) return "cancelled"; // 还没动手，说停就停
  try {
    if (isAndroid) {
      const { openPath } = await import("@tauri-apps/plugin-opener");
      await openPath(path);
    } else {
      await inv("run_installer", { path });
    }
  } catch {
    return "failed";
  }
  onLaunched?.();
  // 安卓：安装界面已经拉起，装没装成它根本不知道，也退不掉自己
  if (isAndroid) return "handed-off";
  try {
    const { flushSync } = await import("./syncCtl");
    await flushSync();
  } catch {
    // 没落盘的那点东西不该挡住安装；同步失败下一次开机还会补
  }
  // 安装器已经在跑了，这时候「取消」也只能是「不把橡果关掉」——不假装什么都没发生
  if (!stillOn()) return "handed-off";
  // exit_app 正常情况下不会 resolve——进程在 IPC 回话之前就没了。所以这里不是「等它成功」，
  // 而是等一个宽限期：能执行到下一行，就说明橡果还活着。
  await Promise.race([
    inv("exit_app").catch(() => undefined),
    new Promise<void>((r) => setTimeout(r, EXIT_GRACE_MS)),
  ]);
  return "handed-off";
}

/** 备用方案：拿系统浏览器打开下载页，让用户自己下自己装 */
export async function openFallback(info: UpdateInfo): Promise<void> {
  const url = info.pageUrl || info.url;
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    window.open(url, "_blank");
  }
}

/** 这台设备走不走这套。
 *
 *  必须在 Tauri 里：下载落盘和拉起安装器都是 Rust 命令，浏览器里（vite:dev、测试）没有。
 *  iOS 不发包也没有安装器可拉，所以要 isAndroid 或桌面二者之一。 */
export const updaterSupported: boolean = inTauri && (isAndroid || hasDesktopFeatures);
