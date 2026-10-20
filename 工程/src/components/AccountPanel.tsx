// 设置账号：状态与动作。影响范围放进确认框，页面保留简洁的按钮。
import { useRef, useState } from "react";
import { clearLocalAccountData, eraseAcornAccount } from "../core/accountActions";
import { holdAutoSync, signOut, syncNow, syncStore, useSync } from "../core/syncCtl";
import { errText } from "../core/useAuthFlow";
import { openLogin } from "../mobile/sheetStore";
import { showToast } from "../core/store";
import { restoreFromCloud } from "../core/wipe";
import { inTauri, purgeTargets } from "../core/persist";
import type { Session } from "../core/cloud";

async function ask(message: string, title: string): Promise<boolean> {
  if (!inTauri) return window.confirm(message);
  return (await import("@tauri-apps/plugin-dialog")).ask(message, { title, kind: "warning" });
}

function sameAccount(session: Session): boolean {
  const current = syncStore.getState().session;
  return current?.email === session.email && current.token === session.token;
}

async function localScope(): Promise<string> {
  const directories = await purgeTargets().catch(() => [] as string[]);
  return directories.length ? "\n\n仅清理下列文件夹中橡果自己的文件，其他文件保留：\n" + directories.join("\n") : "";
}

export default function AccountPanel() {
  const session = useSync(state => state.session);
  const phase = useSync(state => state.phase);
  const message = useSync(state => state.message);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (caught) { setError(errText(caught)); }
    finally { running.current = false; setBusy(false); }
  }

  const doSignOutOnly = () => run(async () => {
    if (!session || !await ask("将退出当前账号并停止同步，本机数据保留。\n\n确定退出登录吗？", "退出登录")) return;
    if (!sameAccount(session)) return;
    await signOut();
    showToast("已退出登录", false);
  });

  const doClearLocal = () => run(async () => {
    if (!session) return;
    const scope = await localScope();
    const confirmed = await ask(
      "将退出登录，删除本机账本、备份、偏好及仅保存在本机的图片。\n\n" +
      "已同步到云端的内容保留，未同步内容无法从云端找回。此操作不会上传未选择同步的图片。" +
      scope + "\n\n确定删除本地数据吗？", "删除本地数据",
    );
    if (!confirmed || !sameAccount(session)) return;
    await clearLocalAccountData();
    location.reload();
  });

  const doEraseAccount = () => run(async () => {
    if (!session) return;
    const scope = await localScope();
    const confirmed = await ask(
      "将注销橡果账号并退出登录，删除橡果云端的账号资料、账本、反馈、Plus授权及可关联的申请、下载和账号记录。\n\n" +
      "本机账本、备份、偏好及仅保存在本机的图片也会删除，无法恢复。\n\n" +
      "cdpandas统一账号保留，不影响其他产品。服务器访问日志及应用外独立备份不在本次清理范围。" +
      scope + "\n\n确定注销橡果账号吗？", "注销橡果账号",
    );
    if (!confirmed || !sameAccount(session)) return;
    await eraseAcornAccount();
    location.reload();
  });

  const doRestoreFromCloud = () => run(async () => {
    if (!session) return;
    // 确认及下载期间不让后台合并把准备替换的本机内容又推回云端。
    const release = await holdAutoSync();
    try {
      if (!sameAccount(session)) return;
      const confirmed = await ask(
        "将下载云端账本并替换本机账本；本机有、云端没有的任务会被替换。\n\n下载前会保留一份本机备份。\n\n确定从云端下载吗？",
        "云端下载",
      );
      if (!confirmed || !sameAccount(session)) return;
      const out = await restoreFromCloud();
      showToast("云端下载完成" + (out.backup ? `；下载前的本机备份：backups/${out.backup}` : ""), false);
      location.reload();
    } finally { release(); }
  });

  if (session) {
    const dot = phase === "syncing" ? "…" : phase === "error" ? "！" : "✓";
    return <div className="set-row col acct-panel" aria-busy={busy}>
      <div className="acct-line">
        <span className={`acct-dot ${phase}`}>{dot}</span>
        <b>{session.email}</b>
        <span className="hint">{message}</span>
        <span className="spacer" />
        <div className="acct-sync-actions">
          <button type="button" className="btn" disabled={busy || phase === "syncing"} onClick={doRestoreFromCloud}>云端下载</button>
          <button type="button" className="btn" disabled={busy || phase === "syncing"} onClick={() => void syncNow()}>立即同步</button>
        </div>
      </div>
      <div className="acct-account-actions" role="group" aria-label="账号操作">
        <button type="button" className="btn acct-account-action" disabled={busy} onClick={doSignOutOnly}>退出登录</button>
        <button type="button" className="btn acct-account-action acct-remove-local" disabled={busy} onClick={doClearLocal}>删除本地数据</button>
        <button type="button" className="btn acct-account-action acct-delete-account" disabled={busy} onClick={doEraseAccount}>注销橡果账号</button>
      </div>
      {error && <p className="acct-err" role="alert">{error}</p>}
    </div>;
  }

  return <div className="set-row col acct-panel">
    <div className="acct-actions"><button type="button" className="btn primary" onClick={() => openLogin("manual")}>登录 / 注册</button></div>
    {error && <p className="acct-err" role="alert">{error}</p>}
  </div>;
}
