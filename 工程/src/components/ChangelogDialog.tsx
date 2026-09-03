// 更新日志弹窗：侧栏「橡果」旁边那个版本号点开就是它（设置页「关于」也有入口）。
//
// 内容来自 core/changelog.ts（产品向），**不是** CHANGELOG.md。
// 挂载点在 App.tsx——**不能塞进 Sidebar**：手机上侧栏带 transform，会成为 fixed 的包含块，
// 弹窗会被关在抽屉里。
//
// 版式（v1.10.0 重做，用户 09-02 的话：「不要弄成这种文本框风格，尤其在一个版本更新内容比较多的情况下」）：
//   · 最新一版是一块「主卡」：大号版本号 + 一句话 + 几张小卡（每张一个新能力）+ 一行「还有」
//   · 之前的版本收成一行一版，点开才展开——用户只关心现在这版，旧的留着查而不是摊着看
//   · 顶上一个「检查新版本」：今天查过且是最新就换成绿勾（用户点名），没查过给按钮

import { useEffect, useState } from "react";
import { CHANGELOG, type ChangelogEntry } from "../core/changelog";
import { APP_VERSION } from "../core/model";
import { setChangelogOpen } from "../core/store";
import { CHECK_FAILED_MSG, checkUpdateNow, checkedToday, useUpdate, type ManualCheck } from "../core/updateCtl";
import { updaterSupported } from "../core/updater";

function fmtDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}

/**
 * 顶上那个「检查新版本」。
 *
 * 状态从上一次查成功的记录（updateCtl 的 memo）推出来，不是弹窗自己记的：
 * 开机那次自动查过了，这里就该直接显示绿勾，不该让人再按一遍。
 * 查失败不进 memo，所以失败之后按钮还在，能重试。
 */
function CheckControl() {
  const memo = useUpdate((s) => s.memo);
  const today = checkedToday(memo);
  const [stage, setStage] = useState<"idle" | "checking" | ManualCheck>("idle");

  if (!updaterSupported) return null;

  async function go() {
    setStage("checking");
    const r = await checkUpdateNow();
    setStage(r);
    // 查到新版本：UpdateDialog 会顶出来（它在这个弹窗之上），这个弹窗让位
    if (r === "found") setChangelogOpen(false);
  }

  if (stage === "checking") return <span className="cl-check cl-check-wait">检查中…</span>;

  if (today?.result === "latest" && stage !== "failed") {
    return (
      // 用户 9/3 定的顺序与叫法：按钮叫「检查更新」，放在那句话前面
      <span className="cl-check cl-check-ok" title="今天已经查过一次">
        <button className="cl-again" onClick={() => void go()}>检查更新</button>
        <span className="cl-tick" aria-hidden>✓</span>
        你用的已经是最新版本
      </span>
    );
  }
  if (today?.result === "found" && stage !== "failed") {
    return (
      <button className="btn primary cl-check" onClick={() => void go()}>
        有新版本 v{today.version}，去更新
      </button>
    );
  }
  return (
    <span className="cl-check">
      {stage === "failed" && <span className="cl-check-fail">{CHECK_FAILED_MSG}</span>}
      <button className="btn" onClick={() => void go()}>
        {stage === "failed" ? "再试一次" : "检查新版本"}
      </button>
    </span>
  );
}

function Latest({ e }: { e: ChangelogEntry }) {
  return (
    <section className="cl-hero">
      <div className="cl-hero-top">
        <span className="cl-hero-ver">v{e.version}</span>
        <span className="cl-hero-date">{fmtDate(e.date)}</span>
        {e.version === APP_VERSION && <span className="cl-hero-now">这台设备上的版本</span>}
      </div>
      <p className="cl-hero-head">{e.headline}</p>
      <div className="cl-cards">
        {e.highlights.map((h) => (
          <article className="cl-card" key={h.title}>
            <h4>{h.title}</h4>
            <p>{h.body}</p>
          </article>
        ))}
      </div>
      {e.minor && (
        <p className="cl-minor">
          <span className="cl-minor-tag">还有</span>
          {e.minor}
        </p>
      )}
    </section>
  );
}

function Older({ e }: { e: ChangelogEntry }) {
  // 原生 details：不用管状态，键盘可达，收起时就是一行
  return (
    <details className="cl-old">
      <summary>
        <span className="cl-old-ver">v{e.version}</span>
        <span className="cl-old-head">{e.headline}</span>
        <span className="cl-old-date">{fmtDate(e.date)}</span>
        <span className="cl-old-caret" aria-hidden>▾</span>
      </summary>
      <ul className="cl-old-list">
        {e.highlights.map((h) => (
          <li key={h.title}>
            <b>{h.title}</b>
            <span>{h.body}</span>
          </li>
        ))}
      </ul>
      {e.minor && (
        <p className="cl-minor">
          <span className="cl-minor-tag">还有</span>
          {e.minor}
        </p>
      )}
    </details>
  );
}

export default function ChangelogDialog() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setChangelogOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const [latest, ...older] = CHANGELOG;

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setChangelogOpen(false);
      }}
    >
      <div className="modal cl-modal" role="dialog" aria-labelledby="cl-title">
        <header className="cl-head">
          <div className="cl-title">
            <h2 id="cl-title">更新日志</h2>
            <span className="cl-cur">这台设备上是 v{APP_VERSION}</span>
          </div>
          <CheckControl />
          <button className="cl-x" aria-label="关闭" title="关闭" onClick={() => setChangelogOpen(false)}>
            ×
          </button>
        </header>
        <div className="cl-body">
          {latest && <Latest e={latest} />}
          {older.length > 0 && (
            <section className="cl-past">
              <h3>之前的版本</h3>
              {older.map((e) => (
                <Older key={e.version} e={e} />
              ))}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
