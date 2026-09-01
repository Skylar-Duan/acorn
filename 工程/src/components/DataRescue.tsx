// 找回数据：当前数据文件夹是空的，但别处找到了有内容的。
// 规矩是「问，不是猜」——绝不自动切换，也绝不在用户拍板前写盘覆盖任何东西。
import { useState } from "react";
import type { DataCandidate } from "../core/persist";
import { resolveRescue, useApp } from "../core/store";

export default function DataRescue() {
  const found = useApp((s) => s.rescue);
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
            当前数据文件夹是空的，但在下面这些位置找到了有内容的数据。
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
          <button className="btn" disabled={busy} onClick={() => void pick(null)}>
            都不是，从空数据开始
          </button>
        </div>
      </div>
    </div>
  );
}
