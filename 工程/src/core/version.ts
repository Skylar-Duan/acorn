// 版本号：网页版 / 安卓版 / 桌面版各排各的（用户 2026-09-18 定）。
//
// 以前全局只有一条号：每发一次 +1、不管发给谁，于是各端的号是跳着走的（桌面 1.14.1 → 1.14.3）。
// 现在每一端一条，只在自己那端有改动时才往上走，不再跳号；第一位三端共用（v1 → v2 一起跳）。
// 从 1.15.0 起切，之前的号维持原样——改了更新链会断。
// 号码真源是 工程/versions.json，构建时由 vite 写进产物（见 vite.config.ts）。
//
// **测试版**：发布前装给用户自己试的包，号码写成「下一个小修号 + -beta.N」
// （公开 1.15.0 → 测试版 1.15.1-beta.3）。按 semver 它比 1.15.0 新、比任何正式的 1.15.1 及以后都旧：
// 正式版出来时能正常盖掉它，它自己也不会被更新检查当成「落后」、被劝回去装 1.15.0。
// 正式号到发布时才定，所以界面上**不显示 1.15.1 这个占位号**，只说「测试版 3」。

import { isAndroid, isWebBuild } from "./platform";

export type Platform = "desktop" | "android" | "web";

export const PLATFORMS: readonly Platform[] = ["desktop", "android", "web"];

export const PLATFORM_LABEL: Record<Platform, string> = {
  desktop: "桌面版",
  android: "安卓版",
  web: "网页版",
};

/** 这份代码此刻算哪一端。网页版认构建（iPhone 上打开网页版也是网页版），
 *  装好的 App 里再用 UA 分安卓和电脑。`npm run dev` 那个浏览器预览算桌面版 */
export const APP_PLATFORM: Platform = isWebBuild ? "web" : isAndroid ? "android" : "desktop";

type Published = Partial<Record<Platform, string>>;
type BuildStamp = { platform?: string; version?: string };

/** 这一端现在是几号。打包脚本给某一端单独打包（尤其测试版）时会盖一个戳，
 *  戳对得上这一端就用戳上的号；否则用 versions.json 里这一端公开的号 */
export function pickVersion(platform: Platform, published?: Published, build?: BuildStamp): string {
  if (build?.version && build.platform === platform) return build.version;
  return published?.[platform] || "dev";
}

/** 应用版本号（测试环境没有构建宏时退到 dev） */
export const APP_VERSION: string = pickVersion(
  APP_PLATFORM,
  typeof __APP_VERSIONS__ === "object" ? __APP_VERSIONS__ : undefined,
  typeof __APP_BUILD__ === "object" ? __APP_BUILD__ : undefined,
);

const BETA_RE = /^(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/;

export function isBeta(v: string): boolean {
  return BETA_RE.test(v);
}

export const IS_BETA: boolean = isBeta(APP_VERSION);

/** 测试版的序号：1.15.1-beta.3 → 3；不是测试版 → null */
export function betaNumber(v: string): number | null {
  const m = BETA_RE.exec(v);
  return m ? Number(m[4]) : null;
}

/** 测试版是接在哪个正式版后面打的：1.15.1-beta.3 → 1.15.0。
 *  打包脚本永远拿「公开号的下一个小修号」当测试版的底，所以往回退一格就是它 */
export function betaBase(v: string): string | null {
  const m = BETA_RE.exec(v);
  if (!m) return null;
  const patch = Number(m[3]);
  return patch > 0 ? `${m[1]}.${m[2]}.${patch - 1}` : null;
}

/** 下一个测试版号：公开 1.15.0、第 3 次 → 1.15.1-beta.3 */
export function nextBetaVersion(publicVersion: string, n: number): string {
  const [a = 0, b = 0, c = 0] = publicVersion.split(".").map((x) => parseInt(x, 10) || 0);
  return `${a}.${b}.${c + 1}-beta.${n}`;
}

/** 短的，放侧栏那种小地方：「v1.15.0」/「测试版 3」 */
export function shortVersion(v: string = APP_VERSION): string {
  const n = betaNumber(v);
  return n === null ? `v${v}` : `测试版 ${n}`;
}

/** 带端名的，放「这台设备上是…」那种句子里：「桌面版 v1.15.0」/「桌面版 测试版 3（v1.15.0 之后）」 */
export function versionLabel(v: string = APP_VERSION, p: Platform = APP_PLATFORM): string {
  const n = betaNumber(v);
  if (n === null) return `${PLATFORM_LABEL[p]} v${v}`;
  const base = betaBase(v);
  return `${PLATFORM_LABEL[p]} 测试版 ${n}${base ? `（v${base} 之后）` : ""}`;
}

function splitPre(v: string): [string, string] {
  const i = v.indexOf("-");
  return i < 0 ? [v, ""] : [v.slice(0, i), v.slice(i + 1)];
}

/**
 * 比版本号。`1.10.0 > 1.9.0`（不能按字符串比，那样 1.10 会小于 1.9）。
 * 段数不一样时缺的位当 0：`1.7` 和 `1.7.0` 是同一个版本。
 * 带 `-beta.N` 的按 semver：同号的测试版比正式版旧（`1.15.1-beta.3 < 1.15.1`），
 * 测试版之间按序号比（`beta.10 > beta.9`，按数字不按字符串）。
 */
export function compareVersions(a: string, b: string): number {
  const [ca, pa] = splitPre(a);
  const [cb, pb] = splitPre(b);
  const na = ca.split(".").map((x) => parseInt(x, 10) || 0);
  const nb = cb.split(".").map((x) => parseInt(x, 10) || 0);
  const n = Math.max(na.length, nb.length);
  for (let i = 0; i < n; i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (pa === pb) return 0;
  if (!pa) return 1; // 正式版 > 同号的测试版
  if (!pb) return -1;
  const ia = pa.split(".");
  const ib = pb.split(".");
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i];
    const y = ib[i];
    if (x === undefined) return -1; // 段少的更旧（semver 规则）
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d > 0 ? 1 : -1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // 纯数字段比字母段旧
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}
