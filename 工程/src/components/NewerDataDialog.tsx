// 「这份数据是新版本的橡果写的」——弹一次窗，给两条路：现在更新 / 取消。
//
// 它取代的是 v1.9.0 那一整屏「版本过旧」的墙，以及 v1.9.1 初版那条常驻横幅。
// 用户 2026-09-01 定的口径：**改得更人性化**——「已有更新版橡果，支持更多功能，建议更新后再继续」，
// 下面「现在更新」「取消」两个键，**取消了也必须能正常用**（万一没网又急着用）。
//
// 数据那一侧一个字不变：不管点哪个，数据都已经照常读进来、照常改、照常存回去，
// 本机不认识的字段原样保留（见 core/model.migrate 与 merge.mergeData 的注释）。
// 这个框只负责「告诉你有更新、给你一条升级的路」，不是闸门。
//
// 每次冷启动弹一次；点了「取消」这次会话不再弹（状态在 App 里）。
// 不做「关掉就永远不提」——那样用户可能一直不知道有些东西没显示；
// 也不做常驻横幅——那会一直占着一行。

import { useEffect, useState } from "react";
import { DATA_VERSION } from "../core/model";
import { showToast } from "../core/store";
import { CHECK_FAILED_MSG, checkUpdateNow, type ManualCheck } from "../core/updateCtl";
import { updaterSupported } from "../core/updater";

export default function NewerDataDialog({
  schema,
  onClose,
}: {
  /** 数据文件自称的版本号（比本机 DATA_VERSION 大） */
  schema: number;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<"idle" | "checking" | ManualCheck>("idle");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function update() {
    setStage("checking");
    const r = await checkUpdateNow();
    setStage(r);
    // 查到了：UpdateDialog 会自己顶出来接手，这个框让位
    if (r === "found") onClose();
    // 服务器上还没有比本机新的包（数据是别的机器上更新的版本写的，包还没发到服务器）
    else if (r === "latest") {
      showToast("服务器上还没有更新的版本，请稍后再试。数据照常用。", false);
      onClose();
    }
    // failed：留在框里把原因写出来，「取消」照旧可点——没网也不能把人困住
  }

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal nd-modal" role="dialog" aria-labelledby="nd-title">
        <h2 id="nd-title">已有更新版橡果</h2>
        <p className="nd-body">
          新版本支持更多功能～这份日志是新版橡果写的（数据 v{schema}，这台上的橡果是 v{DATA_VERSION}），
          这台设备上有几项显示不出来——<b>一个字都不会丢</b>。建议更新之后再继续编辑。
        </p>
        {stage === "failed" && (
          <p className="nd-fail">{CHECK_FAILED_MSG}。先取消照常用也行，有网了再来设置里更新。</p>
        )}
        <div className="nd-acts">
          {/* 浏览器版没有更新通道，只留「取消」 */}
          {updaterSupported && (
            <button className="btn primary" disabled={stage === "checking"} onClick={() => void update()}>
              {stage === "checking" ? "检查中…" : "现在更新"}
            </button>
          )}
          <button className="btn" onClick={onClose}>取消</button>
        </div>
        <p className="nd-foot">取消也能照常用，只是新加的那些内容这台上看不到。</p>
      </div>
    </div>
  );
}
