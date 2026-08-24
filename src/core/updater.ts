// 手机端自动更新：App 自己问「有没有新版」，有就自己下、自己拉起安装。
//
// 为什么不让用户去网页找：手机上让人去浏览器点来点去、再从下载目录里翻安装包，
// 是最容易半路走丢的一段路。网页只当**备用**——App 内这条路走不通时才给出来。
//
// 桌面端不用这套（有 NSIS 安装包，而且桌面版更新更勤，见 README 的发布节奏）。

import { APP_VERSION, DATA_VERSION } from "./model";
import { API_BASE } from "./cloud";
import { isAndroid } from "./platform";

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

export async function fetchUpdate(): Promise<UpdateInfo | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(`${API_BASE}/api/android/latest`, { signal: ctrl.signal });
    if (!res.ok) return null;
    return parseManifest(await res.json());
  } catch {
    return null; // 查更新失败绝不打扰用户，下次再说
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

/**
 * 把安装包下下来存到应用私有目录，返回文件路径。
 * 边下边报进度——32MB 在移动网络上要走一会儿，没进度条的等待最难熬。
 */
export async function downloadApk(
  info: UpdateInfo,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(info.url, { signal });
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
  const total = Number(res.headers.get("content-length")) || info.size || 0;

  const reader = res.body?.getReader();
  if (!reader) throw new Error("这台设备的浏览器内核不支持边下边存");

  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress({ received, total });
  }

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
      throw new Error("下下来的安装包校验不过（可能下到一半断了），没有安装，请重试");
    }
  }

  return inv<string>("save_download", {
    name: `Acorn_${info.version}.apk`,
    bytes: Array.from(bytes),
  });
}

/**
 * 把包交给系统安装器。用官方 opener 插件（安卓上它会走 FileProvider 出 content:// URI，
 * 这是 API 24 起唯一能把文件递给别的应用的方式；Tauri 生成的安卓工程里已经声明好了 provider）。
 *
 * 返回 true = 安装界面已拉起；false = 这条路走不通，得走备用。
 * **不抛异常**：装不上只是少条捷径，不能把界面搞崩。
 */
export async function installApk(path: string): Promise<boolean> {
  try {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(path);
    return true;
  } catch {
    return false;
  }
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

/** 这台设备需要这套东西吗（只有安卓） */
export const updaterSupported = isAndroid;
