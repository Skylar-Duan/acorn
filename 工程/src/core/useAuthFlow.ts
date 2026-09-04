// 账号表单的那套状态机：注册 → 收验证码 → 完成即登录；密码登录；忘记密码 → 验证码 + 新密码 → 登录。
//
// 为什么从 AccountPanel 里抽出来（v1.11.0）：登录这件事有了自己的一页
// （手机整页 / 桌面居中弹窗，components/LoginPage.tsx），设置页里那块只剩一个入口。
// 两处要是各写一份请求与错误处理，改一处必漏一处；更要紧的是「登录成功那一刻本机数据怎么办」——
// 那一段是数据安全级别的分叉（core/loginCtl.signInWithLocalData：本机全新就用云端覆盖、
// 两边都有内容就把两份档案摆出来让他挑、其余合并），**全应用只许有一份实现**——
// 谁都不许绕过它自己去把登录态装上（绕过去 = 跳过那道判断 = 侧栏又冒出两个「工作」）。
//
// 这里只管三件事：表单状态、调哪个接口、出错说什么。长什么样、问法怎么问由界面决定——
// `ask` 是「本机有内容、云端也有内容」时的问法，`onSignedIn` 是登录成功之后的收尾（关掉登录页）。
//
// 网络请求一律走 core/cloud 那几个函数，这个文件里**没有也不许有 fetch**。

import { useEffect, useRef, useState } from "react";
import * as cloud from "./cloud";
import { flushSync } from "./syncCtl";
import { signInWithLocalData } from "./loginCtl";
import type { LoginAsk, LoginChoice, SignInOutcome } from "./loginCtl";
import { showToast } from "./store";

/** 表单停在哪一屏。
 *  · login    密码登录（默认）
 *  · forgot   忘记密码：邮箱收验证码 → 设个新密码 → 直接就是登录态
 *  · register 注册：邮箱 + 密码（+ 确认）
 *  · code     注册发出去的验证码填这儿，填对就算开好账号了 */
export type AuthStep = "login" | "forgot" | "register" | "code";

export interface AuthFields {
  email: string;
  password: string;
  password2: string;
  code: string;
}

/** 密码下限。服务端 check_password 也是 8（server/app/main.py），两处得对得上；
 *  本地先拦一道纯粹是别让人白等一趟网络再看见红字 */
export const MIN_PASSWORD = 8;

/** 验证码重发的冷却秒数。服务端自己也限流，这个数只是别让人一秒点五下 */
export const RESEND_SECONDS = 60;

/** 验证码长度（服务端发的就是 6 位） */
export const CODE_LEN = 6;

/** 长得像不像个邮箱。只挡明显没填完的，真正的判定在服务端——
 *  本地正则写严了只会把带加号、带子域名的正经邮箱拦在门外 */
export function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export function errText(e: unknown): string {
  if (e instanceof cloud.ApiError) return e.message;
  // 这一块里抛出来的 Error 都是写给人看的中文，原样显示比「出了点问题」有用
  if (e instanceof Error && e.message) return e.message;
  return "操作失败，请稍后重试";
}

/** 登录完给用户的那句回执。三条路各说各的，别让人猜刚才到底发生了什么 */
export function signInToast(out: SignInOutcome): string {
  const tail =
    (out.folded > 0 ? `；顺手把 ${out.folded} 条重名的清单并成了一条` : "") +
    (out.foldedTasks > 0 ? `；${out.foldedTasks} 件两边都有的事只留了一份` : "");
  // 两边本来就是同一份（v1.12.1）：没问、也没真合出什么，就别说「正在合并」——那是假话
  if (out.same) {
    return `登录成功，云端和这台设备上的是同一份，直接用了${tail}`;
  }
  if (out.action === "cloud" && out.restored) {
    return (
      `已把云端第 ${out.restored.rev} 版取回这台设备（${out.restored.tasks} 条事）` +
      (out.restored.backup ? `，覆盖前那份存进了 backups/${out.restored.backup}` : "") +
      tail
    );
  }
  if (out.action === "local") {
    return `已经把云端那份换成这台设备上的这一份${tail}`;
  }
  return `登录成功，正在合并两端数据${tail}`;
}

/** 主按钮此刻能不能按。纯函数，界面只负责把它接到 disabled 上 */
export function canSubmit(step: AuthStep, f: AuthFields): boolean {
  const email = looksLikeEmail(f.email);
  switch (step) {
    case "login":
      return email && f.password.length > 0;
    case "register":
      return email && f.password.length >= MIN_PASSWORD && f.password2.length > 0;
    case "code":
      return f.code.length === CODE_LEN;
    case "forgot":
      return email && f.code.length === CODE_LEN && f.password.length >= MIN_PASSWORD;
  }
}

export interface AuthFlowOptions {
  /** 「本机有内容、云端也有内容」时的问法：两份档案摆出来，留一份还是合并。
   *  界面自己画（components/LoginPage.tsx），别用系统确认框 */
  ask: (info: LoginAsk) => Promise<LoginChoice>;
  /** 登录成功且**没有走「用云端的」**时的收尾（那条会整页刷新，收尾没有意义） */
  onSignedIn?: () => void;
}

export interface AuthFlow extends AuthFields {
  step: AuthStep;
  /** 换一屏。错误和提示不跨屏留着 */
  go: (next: AuthStep) => void;
  setEmail: (v: string) => void;
  setPassword: (v: string) => void;
  setPassword2: (v: string) => void;
  setCode: (v: string) => void;
  /** 有请求在路上：所有按钮该灰着 */
  busy: boolean;
  /** 红字 */
  err: string | null;
  /** 灰字（「验证码发到 xxx 了」这类） */
  note: string | null;
  /** 还有几秒才能再发一次验证码，0 = 现在就能发 */
  cooldown: number;
  /** canSubmit 的结果 */
  ready: boolean;
  /** 按主按钮：按当前这一屏该干什么就干什么 */
  submit: () => Promise<void>;
  /** 注册那一屏「没收到，重发」 */
  resend: () => Promise<void>;
  /** 忘记密码那一屏的「发送」 */
  sendResetCode: () => Promise<void>;
}

export function useAuthFlow({ ask, onSignedIn }: AuthFlowOptions): AuthFlow {
  const [step, setStep] = useState<AuthStep>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [code, setCodeRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  // 两个回调在界面那边基本都写成内联箭头，每次渲染都是新的。存进 ref：
  // 下面那几个动作是被按钮直接调用的，不必跟着回调重建，也不必包 useCallback
  const cb = useRef({ ask, onSignedIn });
  cb.current = { ask, onSignedIn };

  // 重发倒计时：一秒一跳，跳到 0 自己停。用 setTimeout 而不是 setInterval——
  // 每次只安排下一跳，组件卸载时不会留下还在跑的计时器
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((n) => Math.max(0, n - 1)), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  /** 验证码只收数字、只收 6 位：粘贴进来的整段短信也能自己挑出号码 */
  function setCode(v: string): void {
    setCodeRaw(v.replace(/\D/g, "").slice(0, CODE_LEN));
  }

  function go(next: AuthStep): void {
    setStep(next);
    setErr(null);
    setNote(null);
    setCodeRaw(""); // 上一屏的验证码不许带到下一屏：两条路的验证码用途不同（verify / reset）
  }

  async function run(fn: () => Promise<void>): Promise<void> {
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

  /** 登录 / 验证 / 改密码之后统一走这条：本机是全新的就用云端整份覆盖，
   *  两边都有内容就停下来把两份档案摆出来让他挑（用云端的 / 用这台设备上的 / 合并），
   *  其余照常合并。判据全在 core/fresh.ts */
  async function settleSignIn(s: cloud.Session, fallbackMsg: string): Promise<void> {
    const out = await signInWithLocalData(s, cb.current.ask);
    // 两边一模一样那条（out.same）不走 fallbackMsg：那几句都是「正在合并 / 正在传上去」，
    // 而这会儿什么都没合——回执由 signInToast 说实话
    const plain = !out.same && out.action === "merge" && out.folded === 0 && out.foldedTasks === 0;
    showToast(plain ? fallbackMsg : signInToast(out), false);
    // 用云端那份覆盖过就得刷一遍界面：ui 里记着的当前清单可能已经被云端那份换掉，
    // 留在原地会是一屏空白。刷之前先把攒着的写完、推完，否则刚清好的那份云端还不知道。
    // 另外两条路（用本机的 / 合并）本机内容还在原地，不用刷
    if (out.action === "cloud") {
      await flushSync();
      location.reload();
      return;
    }
    cb.current.onSignedIn?.();
  }

  const doRegister = () =>
    run(async () => {
      // 两遍不一样就在本地拦下：这一条服务端不管（它只看到一个密码），
      // 打错了却注册成功的话，人下次用记忆里那个密码登录会一直失败
      if (password !== password2) throw new Error("两次输入的密码不一样");
      await cloud.register(email.trim(), password);
      setNote(`验证码发到 ${email.trim()} 了，去邮箱找一下（可能在垃圾箱）`);
      setCodeRaw("");
      setStep("code");
      setCooldown(RESEND_SECONDS);
    });

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

  const doReset = () =>
    run(async () => {
      const s = await cloud.resetPassword(email.trim(), code.trim(), password);
      await settleSignIn(s, "密码改好了，已经登录");
    });

  const sendResetCode = () =>
    run(async () => {
      await cloud.forgot(email.trim());
      // 服务端对没注册过的邮箱也回同一句（不让人拿它探测谁注册过），这里照实说
      setNote(`如果 ${email.trim()} 已注册，验证码已发送`);
      setCooldown(RESEND_SECONDS);
    });

  const resend = () =>
    run(async () => {
      await cloud.resendCode(email.trim());
      setNote("又发了一封，去邮箱看看");
      setCooldown(RESEND_SECONDS);
    });

  function submit(): Promise<void> {
    switch (step) {
      case "login":
        return doLogin();
      case "register":
        return doRegister();
      case "code":
        return doVerify();
      case "forgot":
        return doReset();
    }
  }

  return {
    step, go,
    email, setEmail,
    password, setPassword,
    password2, setPassword2,
    code, setCode,
    busy, err, note, cooldown,
    ready: canSubmit(step, { email, password, password2, code }),
    submit, resend, sendResetCode,
  };
}
