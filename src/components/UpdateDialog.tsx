// 开机查到新版本时弹的那个框。
//
// 让位规矩：**「找回数据」排在它前面**——数据可能丢了是要当场拍板的事，
// 更新等下一次开机也不迟。
// 「这台设备上的橡果太老了」那一屏**不再让位**：那一屏的正事就是让人升级，
// 挡掉这个框等于把唯一的升级入口也挡了（见 App.tsx 里的 dataTooNew 分支）。
//
// 兜底纪律：这是一块全屏遮罩，没有 Esc、点背景也关不掉。所以**任何阶段都必须
// 至少留一个出得去的按钮**——以前下载和安装中三个按钮全靠 !working 条件渲染，
// 连接一挂住就只能去任务管理器杀进程。

import { useState } from "react";
import { APP_VERSION } from "../core/model";
import { isAndroid } from "../core/platform";
import { useApp } from "../core/store";
import {
  CHECK_FAILED_MSG, checkUpdateNow, dismissUpdate, HANDOFF_MSG, skipVersion,
  useUpdate, useUpdateRun, type ManualCheck,
} from "../core/updateCtl";
import { isRequiredForSync, openFallback, updaterSupported } from "../core/updater";
import "../styles/overlays.css";

function mb(n: number): string {
  return `${(n / 1048576).toFixed(1)} MB`;
}

export default function UpdateDialog() {
  const info = useUpdate((s) => s.pending);
  const rescue = useApp((s) => s.rescue);
  const run = useUpdateRun();

  if (!info) return null;
  if (rescue && rescue.length > 0) return null;

  const required = isRequiredForSync(info);
  const working =
    run.phase === "downloading" || run.phase === "installing" || run.phase === "launching";

  /** 关掉这个框之前先把在飞的下载停掉——不然框没了下载还在跑，
   *  下完还会自己拉起安装器把橡果退掉，用户完全不知道发生了什么。
   *  交接那几秒同样算数：useUpdateRun 会把「还算不算数」一路带进 installPackage */
  function later() {
    run.cancel();
    dismissUpdate();
  }

  return (
    <div className="overlay">
      <div className="modal update-modal">
        <div className="update-head">
          <h2 className="serif">有新版本 {info.version}</h2>
          <p>
            这台设备上是 v{APP_VERSION}
            {info.size > 0 && ` · 安装包 ${mb(info.size)}`}
          </p>
        </div>

        {required && (
          <p className="update-required">
            <b>这一版必须升级</b>
            ：云端的数据已经是新版格式了，不升级这台设备同步不了。
            同步会一直停着，但本地照常用、一条都不会动。
          </p>
        )}

        {info.notes && <pre className="up-notes update-notes">{info.notes}</pre>}

        {run.phase === "downloading" && (
          <div className="up-progress update-progress">
            <div className="up-bar">
              <span style={{ width: `${run.pct}%` }} />
            </div>
            <span className="update-hint">
              下载中 {run.pct}%{info.size > 0 ? ` · ${mb(run.got)} / ${mb(info.size)}` : ""}
            </span>
          </div>
        )}
        {(run.phase === "installing" || run.phase === "launching") && (
          <p className="update-note">
            {isAndroid
              ? "正在交给系统安装，按提示点「安装」。"
              : "正在启动安装程序。橡果会先退出，安装完成后重新打开。"}
          </p>
        )}
        {run.phase === "handed-off" && <p className="update-note">{HANDOFF_MSG}</p>}
        {run.err && <p className="update-err">{run.err}</p>}

        <div className="update-foot">
          {!working && (
            <button className="btn ghost" onClick={() => skipVersion(info.version)}>
              这一版不再提醒
            </button>
          )}
          <span className="spacer" />
          {/* 交接之前的每个阶段都渲染：这是全屏遮罩，必须留一条出得去的路。
              安装器一旦起来就换成一句说明——那之后按了也不算数，不给假按钮 */}
          {run.phase === "launching" ? (
            <span className="update-hint">安装程序正在启动，已经停不下来了</span>
          ) : (
            <button className="btn" onClick={later}>
              稍后再说
            </button>
          )}
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
          {!working && (
            <button className="btn primary" onClick={() => void run.start(info)}>
              {run.phase === "failed" || run.phase === "handed-off" ? "重试" : "下载并安装"}
            </button>
          )}
        </div>

        {!working && (
          <p className="update-tail">
            {isAndroid
              ? "数据保存在本机，升级不会改动。"
              : "点「下载并安装」后橡果会先把未保存的内容落盘、再退出，把位置让给安装程序。数据保存在本机，升级不会改动。"}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * 一个光秃秃的「检查更新」按钮，给那些**没有设置页可用**的屏用。
 *
 * 现在只有一个去处：App.tsx 的「这台设备上的橡果版本过旧」那一屏。那一屏替换掉了
 * 整个界面，设置里的 UpdatePanel 渲染不到，于是它一边写着「升级到同一版本即可」、
 * 一边一条升级的路都不给——共用盘场景（本项目自己就这么用）天天会撞上这一屏。
 * 查到了就把 UpdateDialog 顶出来，下载安装还是走那一套。
 */
export function UpdateNudge() {
  const [stage, setStage] = useState<"idle" | "checking" | ManualCheck>("idle");

  if (!updaterSupported) return null;

  async function go() {
    setStage("checking");
    setStage(await checkUpdateNow());
  }

  return (
    <>
      <button className="btn" disabled={stage === "checking"} onClick={() => void go()}>
        {stage === "checking" ? "检查中…" : "检查更新"}
      </button>
      {/* 查不到跟已是最新是两回事，断网时不能骗人说「已经是最新版了」 */}
      {stage === "failed" && <span>{CHECK_FAILED_MSG}。</span>}
      {stage === "latest" && <span>服务器上还没有更新的版本，请稍后再试。</span>}
    </>
  );
}
