// 设置页的「版本更新」一节，只在安卓上出现。
//
// 一条原则：这段路要在 App 里走完——查、下、装。让人跑去浏览器翻下载目录
// 是最容易半路走丢的做法，只在 App 内这条路真走不通时才给出来当备用。

import { useEffect, useState } from "react";
import { APP_VERSION } from "../core/model";
import {
  downloadApk, fetchUpdate, installApk, isRequiredForSync, openFallback,
  shouldOffer, updaterSupported, type UpdateInfo,
} from "../core/updater";

type Stage = "idle" | "checking" | "found" | "downloading" | "installing" | "latest" | "failed";

function mb(n: number): string {
  return `${(n / 1048576).toFixed(1)} MB`;
}

export default function UpdatePanel() {
  const [stage, setStage] = useState<Stage>("idle");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [pct, setPct] = useState(0);
  const [got, setGot] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [manual, setManual] = useState(false);

  // 开设置页时静默查一次：有就提示，没有就当无事发生
  useEffect(() => {
    if (!updaterSupported) return;
    let alive = true;
    void fetchUpdate().then((u) => {
      if (!alive) return;
      setInfo(u);
      setStage(shouldOffer(u) ? "found" : "latest");
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!updaterSupported) return null;

  async function check() {
    setStage("checking");
    setErr(null);
    const u = await fetchUpdate();
    setInfo(u);
    setStage(shouldOffer(u) ? "found" : "latest");
  }

  async function run() {
    if (!info) return;
    setStage("downloading");
    setErr(null);
    setPct(0);
    setGot(0);
    try {
      const path = await downloadApk(info, ({ received, total }) => {
        setGot(received);
        setPct(total > 0 ? Math.round((received / total) * 100) : 0);
      });
      setStage("installing");
      const ok = await installApk(path);
      if (!ok) {
        // App 内交给系统安装器这条路没走通 → 亮出备用方案，别把人晾在这儿
        setManual(true);
        setErr("这台手机没能直接拉起安装界面。下面那个按钮可以用浏览器打开下载页，手动装一次。");
        setStage("failed");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "下载失败，过会儿再试");
      setManual(true);
      setStage("failed");
    }
  }

  const required = isRequiredForSync(info);

  return (
    <div className="set-row col">
      <div className="acct-line">
        <b>当前版本 {APP_VERSION}</b>
        <span className="spacer" />
        <button className="btn" disabled={stage === "checking" || stage === "downloading"} onClick={() => void check()}>
          {stage === "checking" ? "检查中…" : "检查更新"}
        </button>
      </div>

      {stage === "latest" && <p className="hint">已经是最新版了。</p>}

      {(stage === "found" || stage === "downloading" || stage === "installing" || stage === "failed") && info && (
        <>
          <p className="hint">
            <b style={{ color: "var(--accent)" }}>有新版本 {info.version}</b>
            {info.size > 0 && ` · ${mb(info.size)}`}
            {required && (
              <>
                <br />
                <b style={{ color: "var(--warn)" }}>这一版必须升</b>
                ：云端的数据已经是新版格式了，不升级这台手机同步不了（同步会一直停着，
                但本地照常用、一条都不会动）。
              </>
            )}
          </p>
          {info.notes && <pre className="up-notes">{info.notes}</pre>}

          {stage === "downloading" && (
            <div className="up-progress">
              <div className="up-bar">
                <span style={{ width: `${pct}%` }} />
              </div>
              <span className="hint">
                下载中 {pct}%{info.size > 0 ? ` · ${mb(got)} / ${mb(info.size)}` : ""}
              </span>
            </div>
          )}
          {stage === "installing" && <p className="hint">正在交给系统安装，按提示点「安装」就行。</p>}

          <div className="acct-actions">
            {stage !== "downloading" && stage !== "installing" && (
              <button className="btn primary" onClick={() => void run()}>
                {stage === "failed" ? "重试下载并安装" : "下载并安装"}
              </button>
            )}
            {manual && (
              <button className="btn" onClick={() => void openFallback(info)}>
                改用浏览器下载
              </button>
            )}
          </div>
          <p className="hint">
            首次安装可能要在系统弹窗里允许「安装未知来源应用」。装完数据不会丢——它在本机，
            升级不动它。
          </p>
        </>
      )}

      {err && <p className="acct-err">{err}</p>}
    </div>
  );
}
