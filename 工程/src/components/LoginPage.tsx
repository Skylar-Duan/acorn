// 登录页（v1.11.0，画板 ⑦ 手机整页 / ⑦b 桌面居中弹窗）。
//
// 两端同一套文案、同一套入口，只有外壳不同：
//   · 手机（platform.isMobile）：盖住整个应用的一整页，自己的纸底，右上角 ×，底下「先看看，不登录」
//   · 电脑：遮罩 + 居中卡片，左边扉页右边表单
//   分叉按 isMobile 而不是窗口宽度——桌面把窗口拖窄了仍然是桌面，不该突然变成一整页。
//
// 三条得守住的：
// ① 请求全部走 core/useAuthFlow（它再走 core/cloud），这里一行网络代码都没有；
// ② 登录成功那一刻本机数据怎么办，走的是现成的 loginCtl.signInWithLocalData，
//    「合并还是覆盖」那一问由这一页自己画（不再是系统确认框），但**判断本身一个字没动**；
// ③ 首启自动弹的那一次，用户点「先看看，不登录」要记下 markLoginLater——
//    不记的话每次开机都被同一个框拦一道，云账号就从「可选的便利」变成「进门收费站」。
//
// 用 portal 挂到 body：手机壳子里有 transform（底部导航、滑动行），会把 fixed 定位
// 关进自己的盒子里（mobile/Sheet.tsx 头注释里那次已经踩过）。

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { closeLogin, useLogin } from "../mobile/sheetStore";
import type { LoginReason } from "../mobile/sheetStore";
import { markLoginLater } from "../core/fresh";
import { isMobile } from "../core/platform";
import { looksLikeEmail, useAuthFlow } from "../core/useAuthFlow";
import type { AuthStep } from "../core/useAuthFlow";
import type { LoginAsk, LoginChoice } from "../core/loginCtl";
import "../styles/login.css";

/** 关掉登录页。**首启自动弹的那一次**要顺手记下「以后别再自动弹」：
 *  「先看看，不登录」是一句承诺，下次开机再拦一道就是食言。
 *  设置页里自己点开的（manual）不记——那本来就是他主动来的 */
export function dismissLogin(reason: LoginReason): void {
  if (reason === "first-run") markLoginLater();
  closeLogin();
}

/** 主按钮上写什么：[平时, 忙着的时候] */
const GO_LABEL: Record<AuthStep, [string, string]> = {
  login: ["登录", "登录中…"],
  register: ["发验证码", "发送中…"],
  code: ["完成注册", "验证中…"],
  forgot: ["重设密码并登录", "处理中…"],
};

const mailIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 8l9 6 9-6" />
  </svg>
);

const lockIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
    <rect x="4" y="10" width="16" height="10" rx="2" />
    <path d="M8 10V7a4 4 0 018 0v3" />
  </svg>
);

/** 一格输入。icon + 输入框 +（可选）右边那颗小动作 */
function Field({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="lfield">
      {icon}
      {children}
    </div>
  );
}

export function LoginPageHost() {
  const open = useLogin((s) => s.open);
  // 关着的时候一个 hook 都不挂：整页里有计时器和 document 监听，没必要一直活着
  if (!open) return null;
  return <LoginPage />;
}

function LoginPage() {
  const reason = useLogin((s) => s.reason);
  /** 「这台设备上有内容、云端也有内容」那一问。开着的时候表单让位给它——
   *  在他拍板之前登录流程停在原地（signInWithLocalData 正 await 这个 Promise） */
  const [ask, setAsk] = useState<{ info: LoginAsk; decide: (c: LoginChoice) => void } | null>(null);

  const flow = useAuthFlow({
    ask: (info) =>
      new Promise<LoginChoice>((resolve) => {
        setAsk({ info, decide: (c) => { setAsk(null); resolve(c); } });
      }),
    onSignedIn: () => closeLogin(),
  });

  const asking = ask !== null;

  /** ×、遮罩、Esc、「先看看，不登录」四个出口共用这一个 */
  function leave(): void {
    // 正等着「合并还是覆盖」的时候不许半路退出：这会儿退出等于把一次已经成功的登录
    // 停在半空（那个 Promise 永远不 resolve）。两个按钮就在眼前，让他点一下
    if (asking) return;
    dismissLogin(reason);
  }

  // Esc 关掉。走捕获阶段并且拦住冒泡：App 上那条全局 Escape 会顺手清选中、收任务卡，
  // 登录页盖在最上面时那些都不该发生
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      leave();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [asking, reason]);

  const brand = (
    <>
      <div className="login-mark" aria-hidden>
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 9c0-3 2.2-5 5-5s5 2 5 5" />
          <path d="M5 9h14" />
          <path d="M6.5 9c0 6 2.5 9 5.5 11 3-2 5.5-5 5.5-11" />
        </svg>
      </div>
      <div className="login-title serif">你好，这里是橡果。</div>
      <p className="login-sub">电脑上记的，手机上接着做。登录一次，两边就是同一本。</p>
    </>
  );

  const onEntry = flow.step === "login" || flow.step === "forgot";

  // 两个 tab 是「密码登录 / 忘记密码」，不是画板上画的那个「用验证码直接登录」：
  // 现有服务端的验证码只有两种用途——注册时验证邮箱（/verify，已验证的账号再也发不出这种码，
  // /resend 对它什么都不发），和忘记密码（/forgot → /reset）。拿后者去顶那一条，
  // 必然要求当场设一个新密码：写着「登录」却把人密码换掉，是误导，还多一步。
  // 要真做，得服务端先开一种「登录用的验证码」，那是另一件事，不为了凑画板去改服务端。
  const tabs = (
    <div className="login-tabs" role="tablist">
      <button
        role="tab" aria-selected={flow.step === "login"}
        className={`login-tab${flow.step === "login" ? " on" : ""}`}
        onClick={() => flow.go("login")}
      >
        密码登录
      </button>
      <button
        role="tab" aria-selected={flow.step === "forgot"}
        className={`login-tab${flow.step === "forgot" ? " on" : ""}`}
        onClick={() => flow.go("forgot")}
      >
        忘记密码
      </button>
    </div>
  );

  const head = onEntry ? tabs : <div className="login-step">注册新账号</div>;

  const codeAction = flow.step === "code" ? flow.resend : flow.sendResetCode;
  const fields = (
    <>
      {flow.step !== "code" && (
        <Field icon={mailIcon}>
          <input
            type="email" autoComplete="email" placeholder="邮箱" value={flow.email}
            onChange={(e) => flow.setEmail(e.target.value)}
          />
        </Field>
      )}
      {(flow.step === "login" || flow.step === "register") && (
        <Field icon={lockIcon}>
          <input
            type="password"
            autoComplete={flow.step === "login" ? "current-password" : "new-password"}
            placeholder={flow.step === "login" ? "密码" : "密码，至少 8 位"}
            value={flow.password}
            onChange={(e) => flow.setPassword(e.target.value)}
          />
        </Field>
      )}
      {flow.step === "register" && (
        <Field icon={lockIcon}>
          <input
            type="password" autoComplete="new-password" placeholder="再输一次密码" value={flow.password2}
            onChange={(e) => flow.setPassword2(e.target.value)}
          />
        </Field>
      )}
      {(flow.step === "forgot" || flow.step === "code") && (
        <Field icon={lockIcon}>
          <input
            inputMode="numeric" maxLength={6} placeholder="6 位验证码" value={flow.code}
            onChange={(e) => flow.setCode(e.target.value)}
          />
          <button
            className="lfield-act"
            disabled={flow.busy || flow.cooldown > 0 || !looksLikeEmail(flow.email)}
            onClick={() => void codeAction()}
          >
            {flow.cooldown > 0 ? `${flow.cooldown} 秒` : "发送"}
          </button>
        </Field>
      )}
      {flow.step === "forgot" && (
        <Field icon={lockIcon}>
          <input
            type="password" autoComplete="new-password" placeholder="新密码，至少 8 位" value={flow.password}
            onChange={(e) => flow.setPassword(e.target.value)}
          />
        </Field>
      )}
    </>
  );

  const rest = (
    <>
      {fields}
      <button className="login-go" disabled={flow.busy || !flow.ready} onClick={() => void flow.submit()}>
        {GO_LABEL[flow.step][flow.busy ? 1 : 0]}
      </button>
      {flow.err && <p className="login-err">{flow.err}</p>}
      {flow.note && !flow.err && <p className="login-note">{flow.note}</p>}
      <div className="login-links">
        {onEntry ? (
          <button onClick={() => flow.go("register")}>还没有账号？注册</button>
        ) : (
          <button onClick={() => flow.go("login")}>返回</button>
        )}
        {flow.step === "login" && (
          <button className="muted" onClick={() => flow.go("forgot")}>忘记密码</button>
        )}
        {flow.step === "code" && (
          <button className="muted" disabled={flow.busy || flow.cooldown > 0} onClick={() => void flow.resend()}>
            {flow.cooldown > 0 ? `没收到，${flow.cooldown} 秒后可重发` : "没收到，重发"}
          </button>
        )}
      </div>
    </>
  );

  /** 注册那两屏才画这一句：它回答的正是此刻手里的问题（我设的这个密码以后怎么用）。
   *  桌面那边照画板常驻在表单最底下 */
  const registerTip = (
    <div className="login-tip">注册时会设一个密码，之后用密码登录；忘了就用邮箱收一个验证码，重设一个新的。</div>
  );

  const askPane = ask && (
    <div className="login-ask">
      <div className="login-ask-title">这台设备上已经记了 {ask.info.localTasks} 件事。</div>
      <p className="login-ask-line">
        云端也存着一份（第 {ask.info.rev} 版
        {ask.info.updatedAt ? `，${ask.info.updatedAt.slice(0, 10)} 更新` : ""}）。
      </p>
      <button className="login-go" onClick={() => ask.decide("merge")}>合起来（推荐，什么都不丢）</button>
      <button className="login-second" onClick={() => ask.decide("replace")}>用云端那份覆盖这台</button>
    </div>
  );

  const closeX = (
    <button className="login-x" aria-label="关闭" onClick={leave}>
      ×
    </button>
  );

  if (isMobile) {
    return createPortal(
      <div className="login-page" role="dialog" aria-modal="true" aria-label="登录橡果">
        {/* 正等着「合并还是覆盖」时把这两个出口收起来：leave() 那会儿本来就不放行，
            留着一颗按不动的按钮比没有更糟 */}
        <div className="login-topbar">{!asking && closeX}</div>
        <div className="login-brand">{brand}</div>
        <div className="login-form">
          {asking ? (
            askPane
          ) : (
            <>
              {head}
              {rest}
              {!onEntry && registerTip}
            </>
          )}
        </div>
        <div className="login-spacer" />
        <div className="login-foot">
          {!asking && <button className="login-later" onClick={leave}>先看看，不登录</button>}
          <span className="login-tip">不登录的话，事情只存在这台手机上。</span>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div className="overlay login-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) leave(); }}>
      <div className="login-modal" role="dialog" aria-modal="true" aria-label="登录橡果">
        <div className="login-aside">
          {brand}
          <div className="login-spacer" />
          {/* 正等着「合并还是覆盖」时收起两个出口：那会儿 leave() 本来就不放行 */}
          {!asking && <button className="login-later" onClick={leave}>先看看，不登录</button>}
          <span className="login-tip">不登录的话，事情只存在这台电脑上。</span>
        </div>
        <div className="login-main">
          <div className="login-head">
            {asking ? <span /> : head}
            {!asking && closeX}
          </div>
          {asking ? askPane : rest}
          <div className="login-spacer" />
          {!asking && registerTip}
        </div>
      </div>
    </div>,
    document.body,
  );
}
