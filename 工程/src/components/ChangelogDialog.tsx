// 更新日志弹窗：侧栏「橡果」旁边那个版本号点开就是它。
//
// 内容来自 core/changelog.ts（产品向，一版几条人话），**不是** CHANGELOG.md。
// 挂载点在 App.tsx——**不能塞进 Sidebar**：手机上侧栏带 transform，会成为 fixed 的包含块，
// 弹窗会被关在抽屉里。

import { useEffect } from "react";
import { CHANGELOG } from "../core/changelog";
import { APP_VERSION } from "../core/model";
import { setChangelogOpen } from "../core/store";

export default function ChangelogDialog() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setChangelogOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setChangelogOpen(false);
      }}
    >
      <div className="modal cl-modal" role="dialog" aria-labelledby="cl-title">
        <div className="cl-head">
          <h2 id="cl-title">更新日志</h2>
          <span className="cl-cur">当前 v{APP_VERSION}</span>
          <button className="btn ghost" onClick={() => setChangelogOpen(false)}>关闭</button>
        </div>
        <div className="cl-body">
          {CHANGELOG.map((e) => (
            <section key={e.version} className="cl-entry">
              <h3>
                {/^\d/.test(e.version) ? `v${e.version}` : e.version}
                <span className="cl-date">{e.date}</span>
              </h3>
              <ul>
                {e.lines.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
