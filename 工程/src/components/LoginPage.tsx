// 登录弹窗（v1.11.2）。
//
// 两端同一套文案、同一套入口，只有外壳不同：
//   · 手机（platform.isMobile）：遮罩 + 居中的悬浮卡（min(92vw, 380px)），右上角 ×
//   · 电脑：遮罩 + 居中卡片，登录表单是左扉页右表单的双栏，选档案那一步收成单栏窄卡
//   分叉按 isMobile 而不是窗口宽度——桌面把窗口拖窄了仍然是桌面，不该突然换一套外壳。
//
// 手机为什么不再是「盖住整个应用的一整页」（用户 2026-09-03）：
//   「不要一整页的登录，只要中间正常放下我删剪之后的这些内容宽度的悬浮弹窗就好」。
//   一整页把登录做成了一道门；弹窗才是「顺手做一件事，做完接着用」。
//
// 三条得守住的：
// ① 请求全部走 core/useAuthFlow（它再走 core/cloud），这里一行网络代码都没有；
// ② 登录成功那一刻本机数据怎么办，走的是现成的 loginCtl.signInWithLocalData，
//    「两份档案」那一问由这一页自己画（不再是系统确认框），但**判断本身一个字没动**；
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
import type { LoginAsk, LoginChoice, ProfileSummary } from "../core/loginCtl";
// 桌面上那只橡果，登录页左上角摆的就该是同一只（用户 2026-09-03：「这个标志也要换成橡果的」）。
// 用的是 src-tauri/icons/icon.svg 的一份副本（矢量，放大不糊），跟字体一样归 src 自己管；
// 换图标时两处一起换
import appIconUrl from "../assets/app-icon.svg";
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

/** 档案卡上那两行：「12 件事 · 3 个清单」/「更新于 9月2日 14:30」。
 *  两张卡同一个写法，用户才好一眼比出哪份新、哪份大。
 *
 *  为什么拆成两行而不是一整句：卡片只有半张卡宽，一整句会断在半路，
 *  行尾还挂着一个孤零零的间隔点。
 *  写「更新于」不写「最近更新」（用户 2026-09-03：「不要最近两个字」）——
 *  卡上写的是那一份自己的时刻，不是「最近一次」的排名，多两个字反而绕。
 *  时刻一律带月日、按本机时区：两份档案本来就是拿来比先后的，只写钟点比不出来 */
export function profileLines(p: ProfileSummary): string[] {
  const lines = [`${p.tasks} 件事 · ${p.lists} 个清单`];
  const d = p.updatedAt ? new Date(p.updatedAt) : null;
  if (d && !Number.isNaN(d.getTime())) {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    lines.push(`更新于 ${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`);
  }
  return lines;
}

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
  /** 两张档案卡上选中的是哪张。**默认云端**：会走到这一问的多半是换了新设备的人，
   *  云端那份才是他这些年记下来的账本 */
  const [pick, setPick] = useState<"cloud" | "local">("cloud");

  const flow = useAuthFlow({
    ask: (info) =>
      new Promise<LoginChoice>((resolve) => {
        setPick("cloud"); // 上一次登录没成功留下的选择不带到这一次
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
        <img src={appIconUrl} alt="" />
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

  /** 「两份档案，留一份还是合并」那一步。手机和电脑同一段，两边一个字都一样。
   *  文案是用户 2026-09-03 一句一句点过的：标题「欢迎回到橡果~」、那一句
   *  「目前检测到您的本地档案和云端不一致：」、两张卡就叫「云端 / 本设备」，
   *  第二颗按钮说清合并是怎么合的——「差异化合并（保留不同之处）」 */
  const askPane = ask && (
    <div className="login-ask">
      <div className="login-ask-title serif">欢迎回到橡果~</div>
      <p className="login-ask-line">目前检测到您的本地档案和云端不一致：</p>
      <div className="login-picks">
        {(["cloud", "local"] as const).map((side) => (
          <button
            key={side}
            className={`login-pick${pick === side ? " on" : ""}`}
            aria-pressed={pick === side}
            onClick={() => setPick(side)}
          >
            <span className="login-pick-name">{side === "cloud" ? "云端" : "本设备"}</span>
            {profileLines(side === "cloud" ? ask.info.cloud : ask.info.local).map((line) => (
              <span key={line} className="login-pick-meta">{line}</span>
            ))}
          </button>
        ))}
      </div>
      <button className="login-go" onClick={() => ask.decide(pick)}>用这份</button>
      <button className="login-second" onClick={() => ask.decide("merge")}>差异化合并（保留不同之处）</button>
    </div>
  );

  const closeX = (
    <button className="login-x" aria-label="关闭" onClick={leave}>
      ×
    </button>
  );

  const label = asking ? "选一份档案" : "登录橡果";

  if (isMobile) {
    // 遮罩 + 居中悬浮卡。点遮罩关掉；正等着「合并还是覆盖」时 leave() 本来就不放行，
    // 所以那一步点遮罩、按 Esc 都关不掉——必须先做完那个选择
    return createPortal(
      <div className="login-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) leave(); }}>
        <div className="login-sheet" role="dialog" aria-modal="true" aria-label={label}>
          {/* 正等着「合并还是覆盖」时把出口收起来：留着一颗按不动的按钮比没有更糟 */}
          <div className="login-topbar">{!asking && closeX}</div>
          {asking ? (
            askPane
          ) : (
            <>
              <div className="login-brand">{brand}</div>
              <div className="login-form">
                {head}
                {rest}
                {!onEntry && registerTip}
              </div>
              <div className="login-foot">
                <button className="login-later" onClick={leave}>先看看，不登录</button>
              </div>
            </>
          )}
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div className="overlay login-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) leave(); }}>
      {asking ? (
        // 选档案这一步收成单栏窄卡：要看的就是标题、那一句、两张卡、两颗按钮，
        // 摊成双栏只会让左半边空着（用户 2026-09-03：「正常放下这些内容宽度」）
        <div className="login-modal solo" role="dialog" aria-modal="true" aria-label={label}>
          <div className="login-main">{askPane}</div>
        </div>
      ) : (
        <div className="login-modal" role="dialog" aria-modal="true" aria-label={label}>
          <div className="login-aside">
            {brand}
            <div className="login-spacer" />
            <button className="login-later" onClick={leave}>先看看，不登录</button>
          </div>
          <div className="login-main">
            <div className="login-head">
              {head}
              {closeX}
            </div>
            {rest}
            <div className="login-spacer" />
            {registerTip}
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
