// 设置页的「云账号」一节。
//
// v1.11.0 起这里**只剩两屏**：
//   · 没登录 → 一句说明 + 一颗「登录 / 注册」，按了把登录页顶出来
//     （手机整页 / 桌面居中弹窗，components/LoginPage.tsx）。注册、验证码、忘记密码
//     那一整套表单连同状态机搬去了 core/useAuthFlow —— 塞在折叠节里的一个窄框子，
//     不该是第一次用橡果的人看见的登录长相。
//   · 已登录 → 邮箱、同步状态、立即同步、从云端覆盖、两条退出登录的路、注销。这一半一个字没动。
//
// 写这块时守的两条照旧：
// ① 任何一步失败都只是一行红字，不弹窗、不打断，本地照常用；
// ② 每个按钮下面都写清「按了会发生什么」，不让人猜。

import { useEffect, useState } from "react";
import * as cloud from "../core/cloud";
import { signOut, syncNow, useSync } from "../core/syncCtl";
import { errText } from "../core/useAuthFlow";
import { openLogin } from "../mobile/sheetStore";
import { appStore, showToast } from "../core/store";
import { checkWipeGate, restoreFromCloud, wipeLocalData } from "../core/wipe";
import { getDataDir, inTauri, purgeTargets, writeTextFile } from "../core/persist";
import { toJsonFile } from "../core/transfer";
import { APP_VERSION } from "../core/model";
import { todayYMD } from "../core/dates";
import { hasDesktopFeatures } from "../core/platform";

/** 两屏而已。留着这个 step 是因为下面每一处「已登录」的判断都跟它成对写着，
 *  换成裸 session 判断会让那一大段的分支条件各写各的 */
type Step = "signedIn" | "out";

/** 确认框。手机上的 WebView 不保证有 window.confirm，走 Tauri 的对话框插件 */
async function ask(message: string, title: string): Promise<boolean> {
  if (!inTauri) return window.confirm(message);
  const dlg = await import("@tauri-apps/plugin-dialog");
  return dlg.ask(message, { title, kind: "warning" });
}

export default function AccountPanel() {
  const session = useSync((s) => s.session);
  const phase = useSync((s) => s.phase);
  const message = useSync((s) => s.message);

  const [step, setStep] = useState<Step>("out");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [remote, setRemote] = useState<cloud.RemoteInfo | null>(null);
  /** 「退出并清空本机」的闸门没过：非空时把原因和几条出路摆出来 */
  const [wipeBlock, setWipeBlock] = useState<string | null>(null);

  useEffect(() => {
    setStep(session ? "signedIn" : "out");
    setErr(null);
    setWipeBlock(null);
    if (!session) setRemote(null);
  }, [session]);

  // 登录着的时候顺手问一下云端现状（多少版、上次是哪台设备推的）
  useEffect(() => {
    if (!session) return;
    let alive = true;
    cloud
      .whoAmI(session.token)
      .then((info) => alive && setRemote(info))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [session, phase]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  // ---------- 已登录：清空本机 / 从云端覆盖 ----------

  /** 闸门没过时的出口之一：先把这台机器上的东西导成一个 JSON 文件 */
  const doExportBeforeWipe = () =>
    run(async () => {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: `acorn-${todayYMD()}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      await writeTextFile(path, toJsonFile(appStore.getState().data, APP_VERSION));
      showToast("已导出。确认文件保存好之后再执行清空", false);
    });

  /** 退出登录 = 这台机器上不留本地。清之前必须当场同步成功，否则一条都不清 */
  const doSignOutAndWipe = () =>
    run(async () => {
      setWipeBlock(null);
      const gate = await checkWipeGate();
      if (!gate.ok) {
        setWipeBlock(gate.why);
        return;
      }
      // 清理范围要在按下确定之前逐条摆出来：数据文件夹是用户自己用文件夹选择器挑的，
      // 换过几次之后旧的那几个也在名单里，他得看得见 `D:\我的文档` 是不是也在其中
      const dirs = await purgeTargets().catch(() => [] as string[]);
      const ok = await ask(
        "退出登录会同时清空这台设备上的橡果数据。\n\n" +
          `· 刚刚已同步一轮，任务、清单、习惯都在云端第 ${gate.rev} 版，重新登录即可取回\n` +
          "· 每天自动保存的 30 份备份只存在本机，云端没有；清空后这 30 天的历史无法恢复\n" +
          "· 主题、快捷键、侧栏这些本机偏好也会一并清空\n" +
          "· 已导出到其他位置的文件不受影响\n\n" +
          (dirs.length > 0
            ? `会在这些文件夹里删掉橡果自己写下的文件（其余东西一律不碰）：\n${dirs
                .map((d) => `　${d}`)
                .join("\n")}\n\n`
            : "") +
          "确定退出登录并清空这台设备吗？",
        "退出登录并清空本机",
      );
      if (!ok) return;
      await wipeLocalData();
      location.reload();
    });

  /** 另一条常驻的出路：只断开登录态，本机那份原样留着。
   *  换账号、暂停同步、闸门没过时都走它——不能让「退出登录」只剩清空这一条路 */
  const doSignOutOnly = () =>
    run(async () => {
      await signOut();
      showToast("已退出登录。这台设备上的数据原样留着，一条都没清", false);
    });

  /** 从云端拉一份整份覆盖本机 */
  const doRestoreFromCloud = () =>
    run(async () => {
      const dir = await getDataDir().catch(() => "");
      const ok = await ask(
        "取回云端数据，整份覆盖这台设备上的数据。\n\n" +
          "这是单向覆盖，不是合并：本机有、云端没有的内容会消失，且无法撤销。\n" +
          (dir ? `覆盖前会先把当前这份存进数据文件夹的 backups（pre-restore-*.json）：\n${dir}\n` : "") +
          "\n确定覆盖吗？",
        "从云端覆盖本机",
      );
      if (!ok) return;
      const out = await restoreFromCloud();
      showToast(
        `已用云端第 ${out.rev} 版覆盖本机（${out.tasks} 条任务）` +
          (out.backup ? `；覆盖前那份存进了 backups/${out.backup}` : ""),
        false,
      );
      location.reload();
    });

  // ---------- 已登录 ----------

  if (session && step === "signedIn") {
    const dot = phase === "syncing" ? "…" : phase === "error" ? "！" : "✓";
    return (
      <div className="set-row col">
        <div className="acct-line">
          <span className={`acct-dot ${phase}`}>{dot}</span>
          <b>{session.email}</b>
          <span className="hint">{message}</span>
          <span className="spacer" />
          <button className="btn" disabled={phase === "syncing"} onClick={() => void syncNow()}>
            立即同步
          </button>
        </div>
        <p className="hint">
          这台机器上的事会自动传到云端，别的设备登同一个账号就能看到同一份。
          {remote?.device ? `上次同步来自「${remote.device}」。` : ""}
          {remote ? `云端已存 ${remote.rev} 版。` : ""}
        </p>
        <div className="set-row" style={{ gap: 8, padding: 0 }}>
          <button className="btn" disabled={busy} onClick={doRestoreFromCloud}>
            从云端覆盖到这台设备
          </button>
        </div>
        <p className="hint">
          换了新机器、这台上的数据被清过或者对不上时用它：把云端那份整份取回来。
          这是单向覆盖——这台机器上有、云端没有的事会消失；覆盖前会自动留一份备份。
        </p>
        <div className="set-row" style={{ gap: 8, padding: 0 }}>
          <button className="btn ghost" disabled={busy} onClick={doSignOutAndWipe}>
            {busy ? "处理中…" : "退出登录并清空本机"}
          </button>
          {/* 常驻第二条出路：换个账号登、暂时停掉同步、或者就是不想清本机时走它。
              不能只在闸门失败时才露出来——那等于「退出登录」只有清空一条路 */}
          <button className="btn ghost" disabled={busy} onClick={doSignOutOnly}>
            只退出登录，保留本机
          </button>
          <button
            className="btn danger"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const ok = await ask(
                  "注销账号会删除云端数据及其备份，无法恢复。\n\n" +
                    "这台设备上的数据不会改动。注销之后本机这一份就是唯一的副本，" +
                    "如需另存一份，先到「数据」一节导出。\n\n确定注销吗？",
                  "注销账号",
                );
                if (!ok) return;
                await cloud.deleteAccount(session.token);
                // 注销这条路**钉死不清本地**：先删云端再断登录态，
                // 顺手清了本地的话用户点一下就两边都没了、找都没处找
                await signOut();
                showToast("账号已注销。云端数据已删除，本机这一份是唯一副本", false);
              })
            }
          >
            注销账号
          </button>
        </div>
        <p className="hint">
          「退出登录并清空本机」会<b>同时清空这台设备上的数据</b>：数据保留在云端，重新登录（或用上面的「从云端覆盖」）即可取回。
          清空前会先同步一次，没有上传成功的内容不会被清空。
          只想停掉同步、或者换个账号登，用「只退出登录，保留本机」——那条不动这台设备上的任何东西。
        </p>
        {wipeBlock && (
          <div className="set-row col" style={{ padding: 0 }}>
            <p className="acct-err">未能确认本机数据都已上传云端，因此一条都没有清空：{wipeBlock}</p>
            <div className="acct-actions">
              {hasDesktopFeatures && (
                <button className="btn" disabled={busy} onClick={doExportBeforeWipe}>
                  先导出一份 JSON
                </button>
              )}
              <button className="btn ghost" disabled={busy} onClick={doSignOutAndWipe}>
                已联网，再试一次
              </button>
              {/* 「只退出登录，保留本机」上面常驻着，这里不再重复一个一模一样的按钮 */}
            </div>
          </div>
        )}
        {err && <p className="acct-err">{err}</p>}
      </div>
    );
  }

  // ---------- 没登录 ----------

  return (
    <div className="set-row col">
      <p className="hint">
        登录之后，手机和电脑上看到的就是同一份事，数据的家也就搬到了云端——
        以后在这台机器上「退出登录」会把本机这份一起清掉（清之前会先同步一次，没传上去的不会被清）。
        不登录也完全能用：数据就只待在这台机器上，橡果不会替你删任何东西。
      </p>
      <div className="acct-actions">
        {/* 注册和登录是同一扇门：登录页里两者互相切换，这儿不必摆两颗按钮。
            reason 传 manual——他是自己点进来的，跟首启自动弹的那次不是一回事 */}
        <button className="btn primary" onClick={() => openLogin("manual")}>
          登录 / 注册
        </button>
      </div>

      {err && <p className="acct-err">{err}</p>}
    </div>
  );
}
