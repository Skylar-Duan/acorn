// 登录页（v1.11.0，画板 ⑦ 手机整页 / ⑦b 桌面居中弹窗）。
//
// 这一页在 jsdom 里没法「看」（没有布局引擎，也没装 React 的测试渲染器），所以这份测试钉三样：
//   ① **文案**：用户 2026-09-02 一句一句定过的那几句，原句必须在源码里。
//      文案是这一页的产品本体——它被谁顺手「优化」成排比句、推销句，就是把这一页做废了。
//   ② **纪律**：请求全部走 core/cloud 那几个函数（没有第二套 fetch）；
//      登录成功那一刻仍旧走 loginCtl.signInWithLocalData（数据安全级别的分叉，只许有一份）；
//      「先看看，不登录」在首启那次要记下 markLoginLater。
//   ③ **判据**：表单状态机里那些纯函数（能不能按下主按钮、邮箱像不像邮箱）单独跑。
//
// 样式只能用 node:fs 读：vitest 默认不处理 CSS，`import x from "a.css?raw"` 读回来是空串。
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import loginPageSource from "../src/components/LoginPage.tsx?raw";
import authFlowSource from "../src/core/useAuthFlow.ts?raw";
import accountPanelSource from "../src/components/AccountPanel.tsx?raw";
import settingsSource from "../src/views/Settings.tsx?raw";
import { dismissLogin, profileLines } from "../src/components/LoginPage";
import { closeLogin, loginStore, openLogin } from "../src/mobile/sheetStore";
import { LOGIN_LATER_KEY, isLoginLater } from "../src/core/fresh";
import {
  CODE_LEN, MIN_PASSWORD, RESEND_SECONDS, canSubmit, errText, looksLikeEmail, signInToast,
} from "../src/core/useAuthFlow";
import type { AuthFields } from "../src/core/useAuthFlow";
import { ApiError } from "../src/core/cloud";

const loginCss = readFileSync("src/styles/login.css", "utf8");

/** 表单四个格子的默认值，用例只覆盖自己关心的那一两个 */
function fields(over: Partial<AuthFields> = {}): AuthFields {
  return { email: "", password: "", password2: "", code: "", ...over };
}

// ---------------------------------------------------------------- ① 文案

describe("文案：用户定过的那几句，一个字都不许改", () => {
  // 每一句都是 2026-09-02 用户在画板上认可的原句。改这里之前先去问他，
  // 别在这一页上加推销句、排比句、拟人句——那正是这一版要去掉的东西
  const LINES = [
    "你好，这里是橡果。",
    "电脑上记的，手机上接着做。登录一次，两边就是同一本。",
    "还没有账号？注册",
    "忘记密码",
    "先看看，不登录",
  ];

  for (const line of LINES) {
    it(`「${line}」在源码里`, () => {
      expect(loginPageSource).toContain(line);
    });
  }

  it("底部那句「不登录的话，事情只存在这台…上」两端两态都去掉了", () => {
    // 用户 2026-09-03：「底部文字去掉」。一张登录卡不该在最后再吓一句——
    // 不登录本来就是这个应用的正常用法，不是需要被提醒的例外
    expect(loginPageSource).not.toContain("不登录的话");
    expect(loginPageSource).not.toContain("只存在这台");
  });

  it("注册那句说的是现在真能做到的事：设一个密码，忘了用验证码重设", () => {
    // 画板原句是「之后用密码或验证码都能登录」。现有服务端做不到「验证码登录」
    // （见下面那一组），照抄就是骗人，所以只改了这半句
    expect(loginPageSource).toContain("注册时会设一个密码，之后用密码登录；忘了就用邮箱收一个验证码，重设一个新的。");
  });

  it("「两份档案」是这一页自己画的一段，不再是系统确认框", () => {
    // 2026-09-03 用户逐句点过的那一版：标题一句问候，下面一句说清出了什么事，
    // 两张卡就叫「云端 / 本设备」（不用「那份」这种绕口的指代），
    // 第二颗按钮说清合并是怎么合的。「合起来」那种自造词不许再出现
    expect(loginPageSource).toContain("欢迎回到橡果~");
    expect(loginPageSource).toContain("目前检测到您的本地档案和云端不一致：");
    expect(loginPageSource).toContain('"云端" : "本设备"');
    expect(loginPageSource).toContain("用这份");
    expect(loginPageSource).toContain("差异化合并（保留不同之处）");
    expect(loginPageSource).not.toContain("合起来");
    // 上一版那几句绕口的指代不许再回来
    expect(loginPageSource).not.toContain("云端和这台设备上各有一份。");
    expect(loginPageSource).not.toContain("云端的那份");
    expect(loginPageSource).not.toContain("这台设备上的那份");
    // 系统确认框那两条路一条都不许留在这一页里
    expect(loginPageSource).not.toContain("window.confirm");
    expect(loginPageSource).not.toContain("plugin-dialog");
  });

  it("标题那句走衬线体，跟应用里别的标题一个调子", () => {
    expect(loginPageSource).toContain('className="login-ask-title serif"');
  });

  it("两张档案卡各写「几件事 · 几个清单」和「更新于什么时候」，同一个写法才好比", () => {
    // 存的是 UTC，显示的是**本机时刻**——用户对得上的只有自己的钟。
    // 用户 2026-09-03：「不要最近两个字」
    const at = new Date(2026, 8, 2, 14, 30).toISOString();
    expect(profileLines({ tasks: 12, lists: 3, updatedAt: at }))
      .toEqual(["12 件事 · 3 个清单", "更新于 9月2日 14:30"]);
    // 拼这一行的地方只有一处，钉住它（注释里写着为什么不写「最近」，别一起被匹配上）
    expect(loginPageSource).toContain("lines.push(`更新于 ${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`);");
  });

  it("那份还什么都没有时不写时刻（写「更新于 —」比不写更让人犯嘀咕）", () => {
    expect(profileLines({ tasks: 0, lists: 0, updatedAt: null })).toEqual(["0 件事 · 0 个清单"]);
  });

  it("默认选中云端那张——会走到这一问的多半是换了新设备的人", () => {
    expect(loginPageSource).toContain('useState<"cloud" | "local">("cloud")');
  });
});

describe("左上角那个标志就是桌面上那只橡果", () => {
  // 用户 2026-09-03：「这个标志也要换成橡果的」。原来画的是一枚手绘线条橡果，
  // 跟任务栏、桌面快捷方式上那只对不上，看着像另一个软件
  it("用的是应用图标本身，不是另画一枚", () => {
    expect(loginPageSource).toContain('import appIconUrl from "../assets/app-icon.svg";');
    expect(loginPageSource).toContain("<img src={appIconUrl} alt=\"\" />");
    expect(loginPageSource).not.toContain("M6.5 9c0 6 2.5 9 5.5 11"); // 手绘那三条线
  });

  it("assets 里那份跟 Tauri 打包用的那份一个字节不差（换图标时别只换一处）", () => {
    expect(readFileSync("src/assets/app-icon.svg", "utf8"))
      .toBe(readFileSync("src-tauri/icons/icon.svg", "utf8"));
  });

  it("图标填满那个圆角框（框自己不再画卡片底，图标自带底板）", () => {
    expect(loginCss).toContain(".login-mark > img { width: 100%; height: 100%; display: block; }");
  });
});

describe("两个 tab 是「密码登录 / 忘记密码」", () => {
  // 画板上画的是「验证码登录 / 密码登录」。现有服务端的验证码只有两种用途：
  // 注册时验证邮箱（/verify —— 已验证的账号再也拿不到这种码，/resend 对已验证账号什么都不发），
  // 和忘记密码（/forgot → /reset）。拿后者去顶「验证码登录」，必然要求当场设一个新密码：
  // 叫「登录」却把人密码换掉，是误导，还多一步。所以这一页做的是「密码登录 / 忘记密码」。
  it("两颗 tab 的字就是这两个", () => {
    expect(loginPageSource).toContain("密码登录");
    expect(loginPageSource).toContain("忘记密码");
  });

  it("不许出现「验证码登录」这个说法（服务端支持不了，写上就是误导）", () => {
    expect(loginPageSource).not.toContain("验证码登录");
  });

  it("为什么不做验证码登录，源码里写着（下一个人别照画板又加回来）", () => {
    expect(loginPageSource).toContain("/verify");
    expect(loginPageSource).toContain("是误导");
  });
});

// ---------------------------------------------------------------- ② 纪律

describe("首启弹过的那一次，「先看看，不登录」要记住", () => {
  beforeEach(() => {
    localStorage.clear();
    closeLogin();
  });

  it("首启自动弹的（first-run）：关掉之后下次不再自动弹", () => {
    openLogin("first-run");
    expect(loginStore.getState().open).toBe(true);
    dismissLogin("first-run");
    expect(loginStore.getState().open).toBe(false);
    expect(isLoginLater()).toBe(true);
    expect(localStorage.getItem(LOGIN_LATER_KEY)).toBe("1");
  });

  it("自己点开的（manual）：只是关掉，不动那个标记", () => {
    openLogin("manual");
    dismissLogin("manual");
    expect(loginStore.getState().open).toBe(false);
    expect(isLoginLater()).toBe(false);
    expect(localStorage.getItem(LOGIN_LATER_KEY)).toBeNull();
  });

  it("×、遮罩、Esc、「先看看，不登录」四个出口走的是同一个 leave()", () => {
    // 四处各写各的话，早晚有一处忘了记 markLoginLater
    expect((loginPageSource.match(/onClick=\{leave\}/g) ?? []).length).toBe(3); // × 两处外壳共用一个变量 + 两颗「先看看」
    expect(loginPageSource).toContain("if (e.target === e.currentTarget) leave();");
    expect(loginPageSource).toContain('if (e.key !== "Escape") return;');
    expect(loginPageSource).toContain("function leave(): void {");
    expect(loginPageSource).toContain("dismissLogin(reason);");
  });

  it("Esc 拦住冒泡：App 那条全局 Escape 会顺手清选中、收任务卡", () => {
    expect(loginPageSource).toContain("e.stopPropagation();");
    expect(loginPageSource).toContain('document.addEventListener("keydown", onKey, true);');
    expect(loginPageSource).toContain('document.removeEventListener("keydown", onKey, true);');
  });

  it("正等着「合并还是覆盖」时不许半路退出（那个 Promise 会永远悬着）", () => {
    expect(loginPageSource).toContain("if (asking) return;");
  });
});

describe("登录成功那一刻，判断还是那一份", () => {
  it("走的是 loginCtl.signInWithLocalData，没有自己 adoptSession", () => {
    expect(authFlowSource).toContain('import { signInWithLocalData } from "./loginCtl";');
    expect(authFlowSource).toContain("await signInWithLocalData(s, cb.current.ask)");
    expect(authFlowSource).not.toContain("adoptSession");
  });

  it("三个入口（验证 / 登录 / 改密码）都经过 settleSignIn", () => {
    expect((authFlowSource.match(/settleSignIn\(/g) ?? []).length).toBe(4); // 1 定义 + 3 调用
  });

  it("走了覆盖就先落盘再刷界面（顺序反了，刚清好的那份云端不知道）", () => {
    const settle = authFlowSource.slice(authFlowSource.indexOf("async function settleSignIn"));
    expect(settle.indexOf("await flushSync();")).toBeLessThan(settle.indexOf("location.reload();"));
    // 只有「用云端的」那条才刷界面：另外两条本机内容还在原地，刷了只是白闪一下
    expect(settle).toContain('out.action === "cloud"');
  });

  it("「两份档案」的问法由界面给，hook 自己不弹任何框", () => {
    expect(authFlowSource).toContain("ask: (info: LoginAsk) => Promise<LoginChoice>;");
    expect(authFlowSource).not.toContain("window.confirm");
    expect(loginPageSource).toContain("new Promise<LoginChoice>");
  });
});

describe("请求全走 core/cloud，没有第二套 fetch", () => {
  const CALLS = [
    "cloud.register(",
    "cloud.resendCode(",
    "cloud.verify(",
    "cloud.login(",
    "cloud.forgot(",
    "cloud.resetPassword(",
  ];

  for (const call of CALLS) {
    it(`${call}…) 用的是 cloud.ts 里现成那个`, () => {
      expect(authFlowSource).toContain(call);
    });
  }

  it("这三份源码里一个 fetch / XMLHttpRequest 都没有", () => {
    for (const src of [loginPageSource, authFlowSource, accountPanelSource]) {
      expect(src).not.toContain("fetch(");
      expect(src).not.toContain("XMLHttpRequest");
      expect(src).not.toContain("/api/auth/");
    }
  });
});

describe("设置页「云账号」未登录时只剩一个入口", () => {
  it("按钮是「登录 / 注册」，按了 openLogin(\"manual\")", () => {
    expect(accountPanelSource).toContain('openLogin("manual")');
    expect(accountPanelSource).toContain("登录 / 注册");
  });

  it("注册 / 验证码 / 忘记密码那一整套表单不在这儿了", () => {
    for (const gone of ["acct-form", "6 位验证码", "没收到，重发", "改密码并登录", "我已经有账号"]) {
      expect(accountPanelSource).not.toContain(gone);
    }
  });

  it("已登录那一半一个字没动：邮箱、立即同步、两条退出登录的路、注销都还在", () => {
    for (const kept of [
      "立即同步", "从云端覆盖到这台设备", "退出登录并清空本机", "只退出登录，保留本机", "注销账号",
    ]) {
      expect(accountPanelSource).toContain(kept);
    }
  });

  it("设置页那节收起来时的一句话分登录没登录说", () => {
    expect(settingsSource).toContain('summary={session ? "同步 · 从云端覆盖到这台设备" : "登录后手机和电脑是同一本"}');
  });
});

describe("两端都是悬浮弹窗，外壳按 isMobile 分，不按窗口宽度", () => {
  it("分叉读的是 platform.isMobile", () => {
    expect(loginPageSource).toContain('import { isMobile } from "../core/platform";');
    expect(loginPageSource).toContain("if (isMobile) {");
    // 桌面把窗口拖窄仍然是桌面，不该突然换一套外壳
    expect(loginPageSource).not.toContain("innerWidth");
    expect(loginPageSource).not.toContain("matchMedia");
  });

  it("手机是遮罩 + 居中悬浮卡，不再是盖住整个应用的一整页", () => {
    // 用户 2026-09-03：「不要一整页的登录，只要中间正常放下…的悬浮弹窗就好」
    expect(loginPageSource).toContain('className="login-scrim"');
    expect(loginPageSource).toContain('className="login-sheet"');
    expect(loginPageSource).not.toContain('className="login-page"');
    expect(loginCss).not.toContain(".login-page");
  });

  it("手机的登录表单态和选档案态是同一张悬浮卡（不是两套外壳）", () => {
    const sheet = loginPageSource.slice(loginPageSource.indexOf('className="login-sheet"'));
    const askAt = sheet.indexOf("askPane");
    const formAt = sheet.indexOf('className="login-form"');
    expect(askAt).toBeGreaterThan(0);
    expect(formAt).toBeGreaterThan(askAt); // 同一张卡里的三目：asking ? askPane : 表单
  });

  it("点遮罩就关掉——两端同一句写法", () => {
    expect((loginPageSource.match(/if \(e\.target === e\.currentTarget\) leave\(\);/g) ?? []).length).toBe(2);
  });

  it("两端都挂 portal 到 body（手机壳子里的 transform 会把 fixed 关进盒子）", () => {
    expect((loginPageSource.match(/createPortal\(/g) ?? []).length).toBe(2);
    expect((loginPageSource.match(/document\.body,/g) ?? []).length).toBe(2);
  });

  it("关着的时候一个 hook 都不挂（整页里有计时器和 document 监听）", () => {
    expect(loginPageSource).toContain("if (!open) return null;");
  });
});

describe("样式：颜色只用 token，时长只用 --dur-*", () => {
  it("六主题 × 深浅靠 token 自动成立，不写死颜色", () => {
    // 唯一放行的是那抹错误红：settings.css 里的 .acct-err 用的就是同一个值
    const hex = (loginCss.match(/#[0-9A-Fa-f]{3,8}\b/g) ?? []).filter((c) => c !== "#C0564A");
    expect(hex).toEqual([]);
    for (const token of ["var(--bg)", "var(--card)", "var(--ink)", "var(--accent)", "var(--accent-soft)", "var(--hair)"]) {
      expect(loginCss).toContain(token);
    }
  });

  it("弹窗盖在抽屉之上、toast 之下", () => {
    expect(loginCss).toContain("z-index: 140;");
  });

  it("顶上留出状态栏、底下留出手势条（安全区留在遮罩上）", () => {
    expect(loginCss).toContain("padding-top: env(safe-area-inset-top, 0px);");
    expect(loginCss).toContain("padding-bottom: env(safe-area-inset-bottom, 0px);");
  });

  it("手机那张卡：宽 min(92vw, 380px)，高按内容，长过一屏卡内自己滚", () => {
    expect(loginCss).toContain("width: min(92vw, 380px);");
    expect(loginCss).toContain("overflow-y: auto; overscroll-behavior: contain;");
  });

  it("卡高用 dvh 不用 vh——键盘顶上来时可视高度会缩，vh 不缩就把输入框留在键盘底下了", () => {
    expect(loginCss).toMatch(/max-height: calc\(100dvh - env\(safe-area-inset-top/);
    // 认不认识 dvh 的老 WebView 都得有个高度，所以 vh 那条兜底也留着
    expect(loginCss).toMatch(/max-height: calc\(100vh - env\(safe-area-inset-top/);
  });

  it("手机卡跟别的抽屉一个语言：22 圆角、按钮 14 圆角、柔和双层投影", () => {
    expect(loginCss).toContain("border-radius: 22px;");
    expect(loginCss).toContain("box-shadow: 0 2px 6px rgba(62, 74, 52, .06), 0 12px 28px rgba(62, 74, 52, .10);");
    expect(loginCss).toContain("border-radius: 14px;");
  });

  it("桌面登录表单那张卡还是 680 宽、左 300 扉页右表单", () => {
    expect(loginCss).toContain("width: min(680px, calc(100vw - 32px));");
    expect(loginCss).toContain("grid-template-columns: 300px 1fr;");
  });

  it("桌面选档案那一步收成单栏 440 窄卡（摊成双栏左半边就干站着）", () => {
    expect(loginCss).toContain("width: min(440px, calc(100vw - 32px));");
    expect(loginPageSource).toContain('className="login-modal solo"');
  });
});

// ---------------------------------------------------------------- ③ 判据

describe("主按钮什么时候能按（canSubmit）", () => {
  it("密码登录：邮箱像个邮箱、密码非空", () => {
    expect(canSubmit("login", fields({ email: "a@b.co", password: "x" }))).toBe(true);
    expect(canSubmit("login", fields({ email: "a@b.co" }))).toBe(false);
    expect(canSubmit("login", fields({ email: "还没填完", password: "x" }))).toBe(false);
  });

  it("注册：密码不到 8 位就按不动——服务端也是这条线，别让人白等一趟网络", () => {
    expect(MIN_PASSWORD).toBe(8);
    expect(canSubmit("register", fields({ email: "a@b.co", password: "1234567", password2: "1234567" }))).toBe(false);
    expect(canSubmit("register", fields({ email: "a@b.co", password: "12345678", password2: "12345678" }))).toBe(true);
    // 第二遍空着也按不动（两遍不一样由提交时那道本地检查说话）
    expect(canSubmit("register", fields({ email: "a@b.co", password: "12345678" }))).toBe(false);
  });

  it("验证码那屏：够 6 位才算填完", () => {
    expect(CODE_LEN).toBe(6);
    expect(canSubmit("code", fields({ code: "12345" }))).toBe(false);
    expect(canSubmit("code", fields({ code: "123456" }))).toBe(true);
  });

  it("忘记密码：邮箱 + 验证码 + 够长的新密码，三样齐了才行", () => {
    expect(canSubmit("forgot", fields({ email: "a@b.co", code: "123456", password: "12345678" }))).toBe(true);
    expect(canSubmit("forgot", fields({ email: "a@b.co", code: "123456", password: "123" }))).toBe(false);
    expect(canSubmit("forgot", fields({ email: "a@b.co", password: "12345678" }))).toBe(false);
  });

  it("邮箱前后的空格不算数", () => {
    expect(canSubmit("login", fields({ email: "  a@b.co  ", password: "x" }))).toBe(true);
  });
});

describe("邮箱只挡明显没填完的（真正的判定在服务端）", () => {
  it("带加号、带子域名的正经邮箱不许被拦", () => {
    expect(looksLikeEmail("a+tag@mail.example.co.uk")).toBe(true);
  });

  it("没 @、没点、带空格的挡掉", () => {
    expect(looksLikeEmail("abc")).toBe(false);
    expect(looksLikeEmail("a@b")).toBe(false);
    expect(looksLikeEmail("a b@c.co")).toBe(false);
    expect(looksLikeEmail("")).toBe(false);
  });
});

describe("出错说什么", () => {
  it("服务器给的中文原样显示（比「出了点问题」有用）", () => {
    expect(errText(new ApiError(401, "bad_login", "邮箱或密码不对"))).toBe("邮箱或密码不对");
    expect(errText(new ApiError(0, "offline", "连不上服务器，这次没有同步"))).toBe("连不上服务器，这次没有同步");
  });

  it("本地抛的（两次密码不一样）也是写给人看的中文", () => {
    expect(errText(new Error("两次输入的密码不一样"))).toBe("两次输入的密码不一样");
  });

  it("什么都没有时才用那句兜底", () => {
    expect(errText(null)).toBe("操作失败，请稍后重试");
    expect(errText(new Error(""))).toBe("操作失败，请稍后重试");
  });
});

describe("登录完那句回执，三条路各说各的", () => {
  it("用了云端那份：说清取回的是第几版、多少条、备份存哪儿", () => {
    const msg = signInToast({
      action: "cloud", asked: true, folded: 0, foldedTasks: 0, plan: "ask",
      restored: { rev: 7, tasks: 12, backup: "pre-restore-20260902-101010.json" },
    });
    expect(msg).toContain("第 7 版");
    expect(msg).toContain("12 条事");
    expect(msg).toContain("backups/pre-restore-20260902-101010.json");
  });

  it("用了这台设备上那份：说清云端已经换成本机这份", () => {
    const msg = signInToast({
      action: "local", asked: true, folded: 0, foldedTasks: 0, plan: "ask", restored: null,
    });
    expect(msg).toContain("换成这台设备上的这一份");
  });

  it("走了合并：说合并，顺手折掉的重名清单和重复的事都报一句", () => {
    const msg = signInToast({
      action: "merge", asked: false, folded: 2, foldedTasks: 3, plan: "merge", restored: null,
    });
    expect(msg).toContain("正在合并两端数据");
    expect(msg).toContain("2 条重名的清单");
    expect(msg).toContain("3 件两边都有的事");
  });
});

describe("重发验证码有冷却", () => {
  it("60 秒，界面上倒着数给人看", () => {
    expect(RESEND_SECONDS).toBe(60);
    expect(authFlowSource).toContain("setCooldown(RESEND_SECONDS);");
    expect(loginPageSource).toContain("`${flow.cooldown} 秒`");
  });

  it("倒计时用 setTimeout 一跳一跳，组件卸载不留计时器", () => {
    expect(authFlowSource).toContain("return () => clearTimeout(id);");
  });
});
