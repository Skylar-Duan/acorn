// 云账号与同步。UI 只跟这里打交道，不直接碰网络。
//
// 同步一次干三件事：拉云端那份 → 跟本机合（merge.ts）→ 把合完的推回去。
// 推的时候要报「我是基于第几版改的」，对不上说明另一台设备先推过了——
// 服务器把最新那版退回来，这里再合一次重推，最多试三轮。
//
// 什么时候会同步：登录后、应用启动时、数据改完静置几秒、退出前。
// 离线、服务器挂了、令牌过期 —— 一律不影响本地使用，本地数据永远是权威。

import type { AppData } from "./model";
import { APP_VERSION, DATA_VERSION } from "./model";
import { mergeData } from "./merge";
import { pack, unpack } from "./transfer";
import { inTauri } from "./persist";

/** 服务器地址。构建时可用 VITE_ACORN_API 覆盖（自建服务器 / 本地联调） */
export const API_BASE: string =
  (import.meta.env?.VITE_ACORN_API as string | undefined)?.replace(/\/+$/, "") ||
  "https://acorn.cdpandas.com";

/** 这台设备认得的数据版本。比它新的数据**照常收下**（v1.9.1）——
 *  本机看不见的字段原样保留、原样推回去，这个数字只用来在界面上说清「你看到的可能不全」 */
export const CLIENT_SCHEMA = DATA_VERSION;

const AUTH_LS_KEY = "acorn-auth";
const SYNC_TIMEOUT_MS = 20000;

export interface Session {
  token: string;
  email: string;
  /** 上次成功同步时，云端那份的版本号 */
  rev: number;
  /** 上次成功同步的时刻 ISO */
  syncedAt: string | null;
}

export type SyncPhase = "off" | "idle" | "syncing" | "error";

export interface SyncState {
  session: Session | null;
  phase: SyncPhase;
  /** 给用户看的一句话 */
  message: string;
  lastError: string | null;
}

// ---------- 凭据存取（永远不进 data.json，不参与同步与导出） ----------

async function inv<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export async function loadSession(): Promise<Session | null> {
  try {
    const raw = inTauri
      ? await inv<string | null>("load_auth")
      : localStorage.getItem(AUTH_LS_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    return typeof s?.token === "string" && s.token ? s : null;
  } catch {
    return null;
  }
}

export async function saveSession(s: Session | null): Promise<void> {
  const text = s ? JSON.stringify(s) : null;
  if (inTauri) {
    await inv("save_auth", { json: text });
    return;
  }
  if (text) localStorage.setItem(AUTH_LS_KEY, text);
  else localStorage.removeItem(AUTH_LS_KEY);
}

// ---------- HTTP ----------

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly slug: string,
    message: string,
  ) {
    super(message);
  }
  /** 令牌不认了：要用户重新登录 */
  get needsLogin(): boolean {
    return this.status === 401;
  }
}

async function call<T>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SYNC_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new ApiError(0, "offline", "连不上服务器，这次没有同步");
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const b = (body ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, b.error ?? "error", b.message ?? `服务器出错（${res.status}）`);
  }
  return body as T;
}

// ---------- 账号 ----------

interface TokenOut {
  token: string;
  email: string;
  rev: number;
}

function toSession(t: TokenOut): Session {
  return { token: t.token, email: t.email, rev: t.rev, syncedAt: null };
}

export async function register(email: string, password: string): Promise<void> {
  await call("/api/auth/register", { method: "POST", body: { email, password } });
}

export async function resendCode(email: string): Promise<void> {
  await call("/api/auth/resend", { method: "POST", body: { email } });
}

export async function verify(email: string, code: string): Promise<Session> {
  return toSession(await call<TokenOut>("/api/auth/verify", { method: "POST", body: { email, code } }));
}

export async function login(email: string, password: string): Promise<Session> {
  return toSession(await call<TokenOut>("/api/auth/login", { method: "POST", body: { email, password } }));
}

export async function forgot(email: string): Promise<void> {
  await call("/api/auth/forgot", { method: "POST", body: { email } });
}

export async function resetPassword(email: string, code: string, password: string): Promise<Session> {
  return toSession(
    await call<TokenOut>("/api/auth/reset", { method: "POST", body: { email, code, password } }),
  );
}

export async function deleteAccount(token: string): Promise<void> {
  await call("/api/account", { method: "DELETE", token });
}

export interface RemoteInfo {
  email: string;
  rev: number;
  updatedAt: string | null;
  device: string;
  hasData: boolean;
}

export async function whoAmI(token: string): Promise<RemoteInfo> {
  return call<RemoteInfo>("/api/me", { token });
}

// ---------- 同步 ----------

interface PullOut {
  rev: number;
  data: unknown | null;
  updatedAt: string | null;
  /** 云端那份的模型版本（服务端 GET /api/sync 一并给）。
   *  暂不往上抛：合并后 data.version 已经取了两边的 max，落盘后下次启动
   *  persist.loadData 自然会报 tooNew，提示条照样出得来 */
  schema?: number;
}

interface ConflictBody {
  rev: number;
  data: unknown | null;
}

/** 这台机器叫什么——纯粹是给「上次是哪台设备同步的」看的，不参与任何判断 */
export function deviceName(): string {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua)
    ? "Android"
    : /Windows/i.test(ua)
      ? "Windows"
      : /Mac/i.test(ua)
        ? "Mac"
        : /Linux/i.test(ua)
          ? "Linux"
          : "其他";
  return `${os} · 橡果 ${APP_VERSION}`;
}

/** 把服务器上那份解开成 AppData。
 *  · 解不开 → 当云端还没有数据（绝不拿坏数据去合并）
 *  · **比本机新 → 照常收下**（v1.9.1 拆墙）。以前这里抛 `client_too_old`，同步整个停摆，
 *    用户在这台设备上再也看不到另一台记的东西。现在合并不丢未知字段（merge.ts 赢家整条走、
 *    顶层两边都铺、墓碑不重建），推回去时信封上盖的是 max 后的 schema（transfer.pack），
 *    所以既不会把云端降级，也不会撞服务端那道 409。
 *  · `client_too_old` 这个 slug **仍要认得**：服务端对付的是已经发出去的 v1.9.0 及更老客户端，
 *    它还会返回，syncCtl 那边照旧要处理。 */
function unpackRemote(raw: unknown): AppData | null {
  if (raw == null) return null;
  const r = unpack(raw);
  if (!r.ok) return null;
  return r.data;
}

/** 只拉不合也不推：把云端那份原样解出来。
 *  「从云端覆盖本机」那条恢复路径专用——它要的就是**云端原样**，
 *  走 syncOnce 会先跟本机合一遍，本机多出来的东西反而会被推上云，那不是覆盖。
 *  云端还没有数据时 data 是 null，调用方必须据此中止，绝不能拿空的去覆盖本机。 */
export async function pullOnly(
  session: Session,
): Promise<{ rev: number; data: AppData | null; updatedAt: string | null }> {
  const pulled = await call<PullOut>("/api/sync", { token: session.token });
  return { rev: pulled.rev, data: unpackRemote(pulled.data), updatedAt: pulled.updatedAt };
}

export interface SyncOutcome {
  rev: number;
  data: AppData;
  /** 本机数据有没有被这次同步改动过（没改就不用重新落盘） */
  changed: boolean;
  summary: { added: number; updated: number; removed: number };
}

/**
 * 同步一轮。传进来本机当前数据，返回合并后的数据与新版本号。
 * 调用方负责把返回的数据写回 store 与磁盘。
 */
export async function syncOnce(session: Session, local: AppData): Promise<SyncOutcome> {
  let mergedLocal = local;
  let summary = { added: 0, updated: 0, removed: 0 };
  let changed = false;
  let baseRev: number;

  const pulled = await call<PullOut>("/api/sync", { token: session.token });
  const remote = unpackRemote(pulled.data);
  baseRev = pulled.rev;

  if (remote !== null) {
    const m = mergeData(mergedLocal, remote);
    mergedLocal = m.data;
    summary = m.summary;
    changed = m.summary.added + m.summary.updated + m.summary.removed > 0;
  }

  // 最多试三轮：每轮之间只可能插进来别的设备的一次推送
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = await call<{ rev: number }>("/api/sync", {
        method: "PUT",
        token: session.token,
        body: {
          base_rev: baseRev,
          data: pack(mergedLocal, APP_VERSION),
          device: deviceName(),
        },
      });
      return { rev: out.rev, data: mergedLocal, changed, summary };
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 409) throw e;
      // 有人先我一步：把它那版合进来，用它的版本号再推
      const latest = await call<PullOut>("/api/sync", { token: session.token });
      const fresher = unpackRemote(latest.data);
      baseRev = latest.rev;
      if (fresher !== null) {
        const m = mergeData(mergedLocal, fresher);
        mergedLocal = m.data;
        summary = {
          added: summary.added + m.summary.added,
          updated: summary.updated + m.summary.updated,
          removed: summary.removed + m.summary.removed,
        };
        changed = changed || m.summary.added + m.summary.updated + m.summary.removed > 0;
      }
    }
  }
  throw new ApiError(409, "busy", "另一台设备正在频繁同步，稍后再试");
}

