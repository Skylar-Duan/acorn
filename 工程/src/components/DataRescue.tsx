// 找回数据：当前数据文件夹是空的，但别处找到了有内容的。
// 规矩是「问，不是猜」——绝不自动切换，也绝不在用户拍板前写盘覆盖任何东西。
import { useState } from "react";
import type { DataCandidate } from "../core/persist";
import { resolveRescue, useApp } from "../core/store";

export default function DataRescue() {
  const found = useApp((s) => s.rescue);
  /** 这张卡有两处出身：正常开机发现「当前文件夹是空的」，
   *  以及「数据打不开」那一屏上用户自己点了「去别处找找我的数据」（v1.15.0）。
   *  两处文案不一样——在出错屏上说「当前数据文件夹是空的」是假话，它不是空的，是读不到 */
  const failed = useApp((s) => !!s.loadError);
  const [busy, setBusy] = useState(false);
  if (!found || found.length === 0) return null;

  async function pick(dir: string | null) {
    setBusy(true);
    try {
      await resolveRescue(dir);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay">
      <div className="modal rescue">
        <div className="rescue-head">
          <h2 className="serif">找到了以前的数据</h2>
          <p>
            {failed
              ? "橡果现在用的那个文件夹读不到，不过在下面这些位置找到了有内容的数据。"
              : "当前数据文件夹是空的，但在下面这些位置找到了有内容的数据。"}
            <b>这些文件都没有被改动</b>，选中哪份就使用哪份。
          </p>
        </div>
        <div className="rescue-list">
          {found.map((c: DataCandidate) => (
            <button key={c.dir} className="rescue-item" disabled={busy} onClick={() => void pick(c.dir)}>
              <span className="rescue-n">{c.tasks}</span>
              <span className="rescue-meta">
                <b>{c.tasks} 条任务 · {c.lists} 个清单</b>
                <span className="rescue-path">{c.dir}</span>
                <span className="rescue-time">最后改动 {c.modified}</span>
              </span>
              <span className="rescue-go">用这份 →</span>
            </button>
          ))}
        </div>
        <div className="rescue-foot">
          <span className="set-hint">选错了可以改：设置 → 数据 → 更换文件夹。</span>
          {/* 出错屏上这颗只是「关掉这张卡」：那儿内存里这份不是用户的账本，
              「从空数据开始」会把它写到盘上去，一个字都不许写（见 store.resolveRescue） */}
          <button className="btn" disabled={busy} onClick={() => void pick(null)}>
            {failed ? "都不是，关掉" : "都不是，从空数据开始"}
          </button>
        </div>
      </div>
    </div>
  );
}
