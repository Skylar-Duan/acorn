// 导入 / 导出的唯一口径。以后接服务器同步也走这里——本地文件、云端备份、
// 跨设备搬家用的必须是同一份信封与同一套校验，不能各写各的。
//
// 信封长这样：{ app:"acorn", schema:2, appVersion:"1.2.1", exportedAt:"…", data:{…} }
// 老版本导出的是**裸的 AppData**（没有信封），必须继续认——不然用户去年的备份就废了。

import type { AppData } from "./model";
import { DATA_VERSION, migrate } from "./model";

export const TRANSFER_APP = "acorn";

export interface Envelope {
  app: typeof TRANSFER_APP;
  /** 数据模型版本，与 AppData.version 同源 */
  schema: number;
  /** 产出这份文件的应用版本，仅供人看与排障 */
  appVersion: string;
  /** ISO 时刻 */
  exportedAt: string;
  data: AppData;
}

export function pack(data: AppData, appVersion: string, now: Date = new Date()): Envelope {
  return {
    app: TRANSFER_APP,
    schema: DATA_VERSION,
    appVersion,
    exportedAt: now.toISOString(),
    data,
  };
}

export interface UnpackOk {
  ok: true;
  data: AppData;
  /** 来源形态：信封 or 老式裸数据 */
  kind: "envelope" | "bare";
  /** 信封里带的应用版本（老式为 null） */
  appVersion: string | null;
}
export interface UnpackErr {
  ok: false;
  error: string;
}

function looksLikeData(v: unknown): v is AppData {
  return !!v && typeof v === "object" && Array.isArray((v as AppData).tasks);
}

/** 把任意来源（文件内容、以后的服务器响应）解成可用的 AppData；不合格就明确说为什么 */
export function unpack(raw: unknown): UnpackOk | UnpackErr {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "内容不是一份数据对象" };
  }
  const env = raw as Partial<Envelope>;
  if (env.app === TRANSFER_APP) {
    if (!looksLikeData(env.data)) {
      return { ok: false, error: "这份文件是橡果的信封，但里面没有任务列表" };
    }
    // schema 比本机新：仍然尝试迁移（migrate 只补不删），但要让调用方能提示用户
    return { ok: true, data: migrate(env.data), kind: "envelope", appVersion: env.appVersion ?? null };
  }
  if (looksLikeData(raw)) {
    return { ok: true, data: migrate(raw), kind: "bare", appVersion: null };
  }
  return { ok: false, error: "这个文件不是橡果的数据（缺少任务列表）" };
}

/** 导出成文本：带信封、缩进两格，人能读、diff 能看 */
export function toJsonFile(data: AppData, appVersion: string, now?: Date): string {
  return JSON.stringify(pack(data, appVersion, now), null, 2);
}
