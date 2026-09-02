// 设置页的「版本更新」一节。手机和桌面都有。
//
// 一条原则：这段路要在 App 里走完——查、下、装。让人跑去浏览器翻下载目录
// 是最容易半路走丢的做法，只在 App 内这条路真走不通时才给出来当备用。

import { useEffect, useState } from "react";
import { APP_VERSION } from "../core/model";
import { isAndroid } from "../core/platform";
import { CHECK_FAILED_MSG, HANDOFF_MSG, useUpdateRun } from "../core/updateCtl";
import {
  fetchUpdate, isRequiredForSync, openFallback, shouldOffer, updaterSupported,
  type UpdateCheck, type UpdateInfo,
} from "../core/updater";

/** 只管「查」这一段；「下」和「装」在 useUpdateRun 里，跟开机弹窗共用一份 */
type Stage = "idle" | "checking" | "found" | "latest" | "check-failed";

function mb(n: number): string {
  return `${(n / 1048576).toFixed(1)} MB`;
}

export default function UpdatePanel() {
  const [stage, setStage] = useState<Stage>("idle");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const run = useUpdateRun();

  // **查不到和已是最新是两回事**：断网时绝不能显示「已经是最新版了」，那是骗人
  function apply(res: UpdateCheck) {
    if (!res.ok) {
      setInfo(null);
      setStage("check-failed");
      return;
    }
    setInfo(res.info);
    setStage(shouldOffer(res.info) ? "found" : "latest");
  }

  // 开设置页时静默查一次：有就提示，没有就当无事发生
  useEffect(() => {
    if (!updaterSupported) return;
    let alive = true;
    void fetchUpdate().then((res) => {
      if (alive) apply(res);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!updaterSupported) return null;

  async function check() {
    setStage("checking");
    apply(await fetchUpdate());
  }

  const required = isRequiredForSync(info);
  const working =
    run.phase === "downloading" || run.phase === "installing" || run.phase === "launching";
  const busy = stage === "checking" || working;

  return (
    <div className="set-row col">
      <div className="acct-line">
        <b>当前版本 {APP_VERSION}</b>
        <span className="spacer" />
        <button className="btn" disabled={busy} onClick={() => void check()}>
          {stage === "checking" ? "检查中…" : "检查更新"}
        </button>
      </div>

      {stage === "latest" && <p className="hint">当前已是最新版本。</p>}
      {stage === "check-failed" && <p className="hint">{CHECK_FAILED_MSG}。</p>}

      {stage === "found" && info && (
        <>
          <p className="hint">
            <b style={{ color: "var(--accent)" }}>有新版本 {info.version}</b>
            {info.size > 0 && ` · ${mb(info.size)}`}
            {required && (
              <>
                <br />
                <b style={{ color: "var(--warn)" }}>这一版带了新的数据格式</b>
                ：新版本才有的内容在这台设备上看不见也编辑不了（数据照常读、照常同步，
                一条都不会丢），升级完就能看到。
              </>
            )}
          </p>
          {info.notes && <pre className="up-notes">{info.notes}</pre>}

          {run.phase === "downloading" && (
            <div className="up-progress">
              <div className="up-bar">
                <span style={{ width: `${run.pct}%` }} />
              </div>
              <span className="hint">
                下载中 {run.pct}%{info.size > 0 ? ` · ${mb(run.got)} / ${mb(info.size)}` : ""}
              </span>
            </div>
          )}
          {(run.phase === "installing" || run.phase === "launching") && (
            <p className="hint">
              {isAndroid
                ? "正在交给系统安装，按提示点「安装」。"
                : "正在启动安装程序。橡果会先退出，安装完成后重新打开。"}
            </p>
          )}
          {run.phase === "handed-off" && <p className="hint">{HANDOFF_MSG}</p>}

          <div className="acct-actions">
            {!working && (
              <button className="btn primary" onClick={() => void run.start(info)}>
                {run.phase === "failed" || run.phase === "handed-off"
                  ? "重试下载并安装"
                  : "下载并安装"}
              </button>
            )}
            {/* 下载 27MB 得走一会儿，中途一定得能停下来（这里不锁屏，但同一个 run 顺手也用上） */}
            {run.phase === "downloading" && (
              <button className="btn" onClick={run.cancel}>
                取消下载
              </button>
            )}
            {run.manual && (
              <button className="btn" onClick={() => void openFallback(info)}>
                改用浏览器下载
              </button>
            )}
          </div>
          <p className="hint">
            {isAndroid
              ? "首次安装可能需要在系统弹窗里允许「安装未知来源应用」。数据保存在本机，升级不会改动。"
              : "点击后橡果会先把未保存的内容落盘、再退出，把位置让给安装程序（不退出则新版本装不进来）。数据保存在本机，升级不会改动。"}
          </p>
        </>
      )}

      {run.err && <p className="acct-err">{run.err}</p>}
    </div>
  );
}
