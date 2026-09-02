// 「这份数据是新版本的橡果写的」那条提示条。
//
// 它取代的是 v1.9.0 那一整屏「这台设备上的橡果版本过旧」——那一屏把用户自己的日志
// 整个挡在外面，是产品原则上的错（2026-09-01 用户裁定：**一定不能拒绝读取客户之前的日志**）。
// 现在数据照常读进来、照常改、照常存回去，本机不认识的字段一个不丢，
// 这条横幅只负责把「你看到的可能不全」这件事说清楚，并且**可以关掉**。
//
// 关掉的状态存 localStorage，**key 里带 schema 号**：7 → 8 会重新弹一次，
// 因为那是新的一批看不见的东西。前缀必须是 `acorn-`，
// 否则退出登录清空本机时 persist.clearLocalPrefs() 扫不到它。

import { DATA_VERSION } from "../core/model";
import { UpdateNudge } from "./UpdateDialog";

export function schemaNoticeKey(schema: number): string {
  return `acorn-schema-notice-${schema}`;
}

/** 这个版本号的提示条被关过了吗。存储不可用就当没关过——宁可多说一次，不可少说一次 */
export function schemaNoticeDismissed(schema: number): boolean {
  try {
    return localStorage.getItem(schemaNoticeKey(schema)) === "1";
  } catch {
    return false;
  }
}

export function dismissSchemaNotice(schema: number): void {
  try {
    localStorage.setItem(schemaNoticeKey(schema), "1");
  } catch {
    /* 存不下就只这次会话记得，不影响用 */
  }
}

export default function SchemaBanner({
  schema,
  onClose,
}: {
  schema: number;
  onClose: () => void;
}) {
  return (
    <div className="schema-banner" role="status">
      {/* 文案短一点：手机上多一行就多吃掉一条任务的位置（看图看出来的） */}
      <span className="sb-text">
        这份数据是新版本的橡果写的（v{schema}，本机 v{DATA_VERSION}）。
        有些内容在这台设备上显示不出来，<b>不会弄丢</b>，升级后就能看到。
      </span>
      <span className="sb-acts">
        {/* 应用内唯一一条升级的路，从那一屏墙里原样搬过来 */}
        <UpdateNudge />
        <button className="btn ghost" onClick={onClose}>知道了</button>
      </span>
    </div>
  );
}
