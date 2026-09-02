// 设置页的「云账号」一节：注册 / 邮箱验证码 / 登录 / 忘记密码 / 同步状态。
//
// 写这块时守的两条：
// ① 任何一步失败都只是一行红字，不弹窗、不打断，本地照常用；
// ② 每个按钮下面都写清「按了会发生什么」，不让人猜。

import { useEffect, useState } from "react";
import * as cloud from "../core/cloud";
import { flushSync, signOut, syncNow, useSync } from "../core/syncCtl";
import { askText, signInWithLocalData } from "../core/loginCtl";
import type { LoginAsk, LoginChoice, SignInOutcome } from "../core/loginCtl";
import { appStore, showToast } from "../core/store";
import { checkWipeGate, restoreFromCloud, wipeLocalData } from "../core/wipe";
import { getDataDir, inTauri, purgeTargets, writeTextFile } from "../core/persist";
import { toJsonFile } from "../core/transfer";
import { APP_VERSION } from "../core/model";
import { todayYMD } from "../core/dates";
import { hasDesktopFeatures } from "../core/platform";

type Step = "signedIn" | "choose" | "register" | "code" | "login" | "forgot" | "reset";

function errText(e: unknown): string {
  if (e instanceof cloud.ApiError) return e.message;
  // 这一块里抛出来的 Error 都是写给人看的中文，原样显示比「出了点问题」有用
  if (e instanceof Error && e.message) return e.message;
  return "操作失败，请稍后重试";
}

/** 确认框。手机上的 WebView 不保证有 window.confirm，走 Tauri 的对话框插件 */
async function ask(message: string, title: string): Promise<boolean> {
  if (!inTauri) return window.confirm(message);
  const dlg = await import("@tauri-apps/plugin-dialog");
  return dlg.ask(message, { title, kind: "warning" });
}

/** 「本机有内容、云端也有内容」时问一句：合并还是覆盖。
 *  **确定 = 覆盖、取消 = 合并**——确认框按回车走的是取消那条，默认落在不丢东西的一边。
 *  正经的登录弹窗另有人做，这里先用系统确认框把这条路接通，文案在 loginCtl.askText */
async function askLoginChoice(info: LoginAsk): Promise<LoginChoice> {
  return (await ask(askText(info), "云端已经有一份数据")) ? "replace" : "merge";
}

/** 登录完给用户的那句回执。三条路各说各的，别让人猜刚才到底发生了什么 */
function signInToast(out: SignInOutcome): string {
  const tail = out.folded > 0 ? `；顺手把 ${out.folded} 条重名的清单并成了一条` : "";
  if (out.action === "replace" && out.restored) {
    return (
      `已把云端第 ${out.restored.rev} 版取回这台设备（${out.restored.tasks} 条事）` +
      (out.restored.backup ? `，覆盖前那份存进了 backups/${out.restored.backup}` : "") +
      tail
    );
  }
  return `登录成功，正在合并两端数据${tail}`;
}

export default function AccountPanel() {
  const session = useSync((s) => s.session);
  const phase = useSync((s) => s.phase);
  const message = useSync((s) => s.message);

  const [step, setStep] = useState<Step>("choose");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [remote, setRemote] = useState<cloud.RemoteInfo | null>(null);
  /** 「退出并清空本机」的闸门没过：非空时把原因和几条出路摆出来 */
  const [wipeBlock, setWipeBlock] = useState<string | null>(null);

  useEffect(() => {
    setStep(session ? "signedIn" : "choose");
    setErr(null);
    setNote(null);
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

  const doRegister = () =>
    run(async () => {
      await cloud.register(email.trim(), password);
      setNote(`验证码发到 ${email.trim()} 了，去邮箱找一下（可能在垃圾箱）`);
      setCode("");
      setStep("code");
    });

  /** 登录 / 验证 / 改密码之后统一走这条：本机是全新的就用云端整份覆盖，
   *  两边都有内容就停下来问一句，其余照常合并。判据全在 core/fresh.ts */
  async function settleSignIn(s: cloud.Session, fallbackMsg: string) {
    const out = await signInWithLocalData(s, askLoginChoice);
    showToast(out.action === "merge" && out.folded === 0 ? fallbackMsg : signInToast(out), false);
    // 覆盖过就得刷一遍界面：ui 里记着的当前清单可能已经被云端那份换掉，
    // 留在原地会是一屏空白。刷之前先把攒着的写完、推完，否则刚清好的那份云端还不知道
    if (out.action === "replace") {
      await flushSync();
      location.reload();
    }
  }

  const doVerify = () =>
    run(async () => {
      const s = await cloud.verify(email.trim(), code.trim());
      await settleSignIn(s, "账号开好了，正在把这台机器上的事传上去");
    });

  const doLogin = () =>
    run(async () => {
      const s = await cloud.login(email.trim(), password);
      await settleSignIn(s, "登录成功，正在合并两端数据");
    });

  const doForgot = () =>
    run(async () => {
      await cloud.forgot(email.trim());
      setNote(`如果 ${email.trim()} 已注册，验证码已发送`);
      setCode("");
      setPassword("");
      setStep("reset");
    });

  const doReset = () =>
    run(async () => {
      const s = await cloud.resetPassword(email.trim(), code.trim(), password);
      await settleSignIn(s, "密码改好了，已经登录");
    });

  const doResend = () =>
    run(async () => {
      await cloud.resendCode(email.trim());
      setNote("又发了一封，去邮箱看看");
    });

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

  const emailInput = (
    <input
      className="input"
      type="email"
      autoComplete="email"
      placeholder="邮箱"
      value={email}
      onChange={(e) => setEmail(e.target.value)}
    />
  );
  const passwordInput = (placeholder: string) => (
    <input
      className="input"
      type="password"
      autoComplete="new-password"
      placeholder={placeholder}
      value={password}
      onChange={(e) => setPassword(e.target.value)}
    />
  );
  const codeInput = (
    <input
      className="input"
      inputMode="numeric"
      maxLength={6}
      placeholder="6 位验证码"
      value={code}
      onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
    />
  );

  return (
    <div className="set-row col">
      {step === "choose" && (
        <>
          <p className="hint">
            登录之后，手机和电脑上看到的就是同一份事，数据的家也就搬到了云端——
            以后在这台机器上「退出登录」会把本机这份一起清掉（清之前会先同步一次，没传上去的不会被清）。
            不登录也完全能用：数据就只待在这台机器上，橡果不会替你删任何东西。
          </p>
          <div className="acct-actions">
            <button className="btn primary" onClick={() => setStep("register")}>
              注册新账号
            </button>
            <button className="btn" onClick={() => setStep("login")}>
              我已经有账号
            </button>
          </div>
        </>
      )}

      {step === "register" && (
        <>
          <p className="hint">填个邮箱设个密码，我们会发一封验证码过去确认是你本人。</p>
          <div className="acct-form">
            {emailInput}
            {passwordInput("密码，至少 8 位")}
          </div>
          <div className="acct-actions">
            <button className="btn primary" disabled={busy} onClick={doRegister}>
              {busy ? "发送中…" : "发验证码"}
            </button>
            <button className="btn ghost" onClick={() => setStep("choose")}>
              返回
            </button>
          </div>
        </>
      )}

      {step === "code" && (
        <>
          <p className="hint">{note ?? "输入邮箱里收到的 6 位验证码。"}</p>
          <div className="acct-form">{codeInput}</div>
          <div className="acct-actions">
            <button className="btn primary" disabled={busy || code.length < 6} onClick={doVerify}>
              {busy ? "验证中…" : "确认"}
            </button>
            <button className="btn ghost" disabled={busy} onClick={doResend}>
              没收到，重发
            </button>
            <button className="btn ghost" onClick={() => setStep("choose")}>
              返回
            </button>
          </div>
        </>
      )}

      {step === "login" && (
        <>
          <p className="hint">
            登录之后，这台设备上已有的内容会与云端<b>合并</b>，不会互相覆盖。
            这台设备要是还什么都没记过（刚装好的样子），会直接把云端那份取回来，不留下多余的默认清单。
          </p>
          <div className="acct-form">
            {emailInput}
            {passwordInput("密码")}
          </div>
          <div className="acct-actions">
            <button className="btn primary" disabled={busy} onClick={doLogin}>
              {busy ? "登录中…" : "登录"}
            </button>
            <button className="btn ghost" onClick={() => setStep("forgot")}>
              忘记密码
            </button>
            <button className="btn ghost" onClick={() => setStep("choose")}>
              返回
            </button>
          </div>
        </>
      )}

      {step === "forgot" && (
        <>
          <p className="hint">填注册用的邮箱，我们发一封验证码过去，用它重设密码。</p>
          <div className="acct-form">{emailInput}</div>
          <div className="acct-actions">
            <button className="btn primary" disabled={busy} onClick={doForgot}>
              {busy ? "发送中…" : "发验证码"}
            </button>
            <button className="btn ghost" onClick={() => setStep("login")}>
              返回
            </button>
          </div>
        </>
      )}

      {step === "reset" && (
        <>
          <p className="hint">{note ?? "输入验证码和新密码。"}</p>
          <div className="acct-form">
            {codeInput}
            {passwordInput("新密码，至少 8 位")}
          </div>
          <div className="acct-actions">
            <button className="btn primary" disabled={busy || code.length < 6} onClick={doReset}>
              {busy ? "处理中…" : "改密码并登录"}
            </button>
            <button className="btn ghost" onClick={() => setStep("login")}>
              返回
            </button>
          </div>
        </>
      )}

      {err && <p className="acct-err">{err}</p>}
      {note && step !== "code" && step !== "reset" && <p className="hint">{note}</p>}
    </div>
  );
}
