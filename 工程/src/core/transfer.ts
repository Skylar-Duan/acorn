// 导入 / 导出的唯一口径。以后接服务器同步也走这里——本地文件、云端备份、
// 跨设备搬家用的必须是同一份信封与同一套校验，不能各写各的。
//
// 信封长这样：{ app:"acorn", schema:2, appVersion:"1.2.1", exportedAt:"…", data:{…} }
// 老版本导出的是**裸的 AppData**（没有信封），必须继续认——不然用户去年的备份就废了。
//
// 反过来那一头同样要认真，但**认真不等于拒收**（v1.9.1 起的产品原则）：
// 比本机新的数据一律照常读进来——多出来的字段空着、原样留着，等用户升级了自然看得见。
// **绝不许因为「这份比我新」就不给用户看他自己的日志。**
// 不丢是靠 migrate 那边保的（顶层先铺开、墓碑不重建、version 取 max），
// unpack 这里只负责把「这份比我新」这个事实报上来（tooNew），供调用方提示，**不得据此拒绝加载**。

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

/** 信封上盖的 schema 是 `max(本机 DATA_VERSION, 这份数据自称的版本)`。
 *
 *  为什么不是写死 DATA_VERSION：一台 v6 的设备读进了 schema 7 的数据（内容一个字没丢），
 *  推上云时若报 6，服务端那道「schema < stored」当场 409，而云端的 `MAX(schema, ?)` 棘轮
 *  又保证报 7 不会把云端降级——报 max 是让棘轮和无损读取共存的唯一取值。
 *  版本号跟着数据本身走，不需要额外的持久化状态：重启、导出导入、云同步一路带着。 */
export function pack(data: AppData, appVersion: string, now: Date = new Date()): Envelope {
  return {
    app: TRANSFER_APP,
    schema: Math.max(DATA_VERSION, typeof data?.version === "number" ? data.version : 0),
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
  /** 这份数据的模型版本（老式裸数据按 1 算） */
  schema: number;
  /** **这份数据比本机新**：里面有本机这个版本还不认识的东西。
   *  调用方据此**提示**用户（顶上一条可关的横幅、导入前的确认框里加一句），
   *  **不得据此拒绝加载**——拒绝读取客户之前的日志是产品原则上的错。
   *  数据本身不会因为读进来就损坏：未知字段由 migrate/mergeData 原样保留。 */
  tooNew: boolean;
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
    // 信封上的 schema 是权威；没写就看数据里的 version，再没有就当最老的
    const schema =
      typeof env.schema === "number"
        ? env.schema
        : typeof (env.data as { version?: unknown }).version === "number"
          ? (env.data as { version: number }).version
          : 1;
    return {
      ok: true,
      data: migrate(env.data),
      kind: "envelope",
      appVersion: env.appVersion ?? null,
      schema,
      tooNew: schema > DATA_VERSION,
    };
  }
  if (looksLikeData(raw)) {
    const schema = typeof (raw as { version?: unknown }).version === "number"
      ? (raw as { version: number }).version
      : 1;
    return {
      ok: true,
      data: migrate(raw),
      kind: "bare",
      appVersion: null,
      schema,
      tooNew: schema > DATA_VERSION,
    };
  }
  return { ok: false, error: "这个文件不是橡果的数据（缺少任务列表）" };
}

/** 导出成文本：带信封、缩进两格，人能读、diff 能看 */
export function toJsonFile(data: AppData, appVersion: string, now?: Date): string {
  return JSON.stringify(pack(data, appVersion, now), null, 2);
}
