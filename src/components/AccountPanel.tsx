// 设置页的「云账号」一节：注册 / 邮箱验证码 / 登录 / 忘记密码 / 同步状态。
//
// 写这块时守的两条：
// ① 任何一步失败都只是一行红字，不弹窗、不打断，本地照常用；
// ② 每个按钮下面都写清「按了会发生什么」，不让人猜。

import { useEffect, useState } from "react";
import * as cloud from "../core/cloud";
import { adoptSession, signOut, syncNow, useSync } from "../core/syncCtl";
import { showToast } from "../core/store";

type Step = "signedIn" | "choose" | "register" | "code" | "login" | "forgot" | "reset";

function errText(e: unknown): string {
  if (e instanceof cloud.ApiError) return e.message;
  return "出了点问题，过会儿再试";
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

  useEffect(() => {
    setStep(session ? "signedIn" : "choose");
    setErr(null);
    setNote(null);
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

  const doVerify = () =>
    run(async () => {
      const s = await cloud.verify(email.trim(), code.trim());
      await adoptSession(s);
      showToast("账号开好了，正在把这台机器上的事传上去", false);
    });

  const doLogin = () =>
    run(async () => {
      const s = await cloud.login(email.trim(), password);
      await adoptSession(s);
      showToast("登录成功，正在合并两边的事", false);
    });

  const doForgot = () =>
    run(async () => {
      await cloud.forgot(email.trim());
      setNote(`如果 ${email.trim()} 注册过，验证码已经发过去了`);
      setCode("");
      setPassword("");
      setStep("reset");
    });

  const doReset = () =>
    run(async () => {
      const s = await cloud.resetPassword(email.trim(), code.trim(), password);
      await adoptSession(s);
      showToast("密码改好了，已经登录", false);
    });

  const doResend = () =>
    run(async () => {
      await cloud.resendCode(email.trim());
      setNote("又发了一封，去邮箱看看");
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
          <button
            className="btn ghost"
            onClick={() => {
              void signOut();
              showToast("已退出登录，这台机器上的事一条没动", false);
            }}
          >
            退出登录
          </button>
          <button
            className="btn danger"
            onClick={() =>
              void run(async () => {
                const ok = window.confirm(
                  "注销账号会把云端那份**连同备份一起删干净**，无法找回。\n" +
                    "这台电脑上的任务不会动，还留着。\n\n确定要注销吗？",
                );
                if (!ok) return;
                await cloud.deleteAccount(session.token);
                await signOut();
                showToast("账号已注销，本机数据没有动", false);
              })
            }
          >
            注销账号
          </button>
        </div>
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
            登录之后，手机和电脑上看到的就是同一份事。不登录也完全能用——数据就只待在这台机器上。
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
          <p className="hint">登录之后，这台机器上已有的事会和云端那份**合起来**，不会互相覆盖。</p>
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
