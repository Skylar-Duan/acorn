// 登录改成 cdpandas 账号（2026-09-21 服务端把账号并进 cdpandas，路径和请求体没变）。
//
// 服务端多了四种回话，客户端各有各的接法：
//   · 409 already_registered（注册时邮箱已经有账号）→ 红字 +「去登录」「忘记密码」两颗
//   · 409 already_verified（验证时早就验证过）→ 回登录那一屏，说「直接登录吧」
//   · 503 account_unavailable（cdpandas 连不上）→ 「过一会儿再试」，**绝不当成要重新登录**
//   · 403 unverified（登录时邮箱还没验证）→ 带去填验证码那一屏，并自动重发一封
// 老服务器没有这几种回话时，行为一个字不变。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/core/cloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/cloud")>();
  return {
    ...actual,
    register: vi.fn(),
    login: vi.fn(),
    verify: vi.fn(),
    resendCode: vi.fn(),
    forgot: vi.fn(),
    whoAmI: vi.fn(),
    syncOnce: vi.fn(),
    saveSession: vi.fn(async () => {}),
  };
});

import * as cloud from "../src/core/cloud";
import { ApiError } from "../src/core/cloud";
import { ACCOUNT_LINE, LoginPageHost } from "../src/components/LoginPage";
import { UNAVAILABLE_TEXT, errText, isApiErr } from "../src/core/useAuthFlow";
import { loginStore } from "../src/mobile/sheetStore";
import { syncNow, syncStore } from "../src/core/syncCtl";
import { appStore } from "../src/core/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const m = {
  register: vi.mocked(cloud.register),
  login: vi.mocked(cloud.login),
  verify: vi.mocked(cloud.verify),
  resendCode: vi.mocked(cloud.resendCode),
  syncOnce: vi.mocked(cloud.syncOnce),
  saveSession: vi.mocked(cloud.saveSession),
};

const EMAIL = "bower@example.com";
const PW = "hunter2hunter2";

// ---------------------------------------------------------------- 渲染登录页的小工具

const roots: Root[] = [];
function renderLogin(): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    loginStore.setState({ open: true, reason: "manual" });
    root.render(createElement(LoginPageHost));
  });
  roots.push(root);
}

const page = () => document.body;
const text = () => page().textContent ?? "";
const btn = (label: string) =>
  [...page().querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement | undefined;

function fill(sel: string, v: string, nth = 0): void {
  const el = page().querySelectorAll<HTMLInputElement>(sel)[nth];
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(label: string): Promise<void> {
  const b = btn(label);
  expect(b, `找不到按钮「${label}」`).toBeDefined();
  await act(async () => {
    b!.click();
  });
}

/** 走到注册那一屏，填好邮箱和两遍密码 */
async function fillRegister(): Promise<void> {
  await press("还没有账号？注册");
  fill('input[type="email"]', EMAIL);
  fill('input[type="password"]', PW, 0);
  fill('input[type="password"]', PW, 1);
}

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.saveSession.mockResolvedValue(undefined);
  syncStore.setState({ session: null, phase: "off", message: "" });
});

afterEach(() => {
  act(() => roots.splice(0).forEach((r) => r.unmount()));
  document.body.innerHTML = "";
  loginStore.setState({ open: false });
});

// ---------------------------------------------------------------- 503：不是要重新登录

describe("503 account_unavailable：过一会儿再试，不当成要重新登录", () => {
  it("needsLogin 只认 401", () => {
    expect(new ApiError(401, "bad_token", "x").needsLogin).toBe(true);
    expect(new ApiError(503, "account_unavailable", "x").needsLogin).toBe(false);
    expect(new ApiError(403, "unverified", "x").needsLogin).toBe(false);
  });

  it("同步撞上 503：登录态留着、不清会话，只说一句同步失败", async () => {
    const session = { token: "t", email: EMAIL, rev: 1, syncedAt: null };
    appStore.setState({ loaded: true, loadError: null, rescue: null });
    syncStore.setState({ session, phase: "idle", message: "" });
    m.syncOnce.mockRejectedValue(new ApiError(503, "account_unavailable", "账号服务暂时连不上，过一会儿再试（不是密码的问题）"));
    await syncNow({ force: true });
    expect(m.syncOnce).toHaveBeenCalled();
    expect(syncStore.getState().session).toEqual(session);
    expect(m.saveSession).not.toHaveBeenCalledWith(null);
    expect(syncStore.getState().message).not.toContain("重新登录");
  });

  it("登录时 503：红字说过一会儿再试，停在登录那一屏，没有登录态", async () => {
    m.login.mockRejectedValue(new ApiError(503, "account_unavailable", "账号服务暂时连不上，过一会儿再试（不是密码的问题）"));
    renderLogin();
    fill('input[type="email"]', EMAIL);
    fill('input[type="password"]', PW);
    await press("登录");
    expect(text()).toContain("账号服务暂时连不上，过一会儿再试");
    expect(page().querySelector('input[type="password"]')).not.toBeNull();
    expect(syncStore.getState().session).toBeNull();
  });

  it("服务端没带中文说法时，用这边的默认说法", () => {
    expect(errText(new ApiError(503, "account_unavailable", "Service Unavailable"))).toBe(UNAVAILABLE_TEXT);
    // 带了就用服务端的（改密码那条会说「密码已经改好了」，这一句比默认的有用）
    const reset = "密码已经改好了，账号服务一时没回话——用新密码登录就行";
    expect(errText(new ApiError(503, "account_unavailable", reset))).toBe(reset);
  });
});

describe("网关只回一个 503 页面（不是 JSON）", () => {
  it("errText：slug 是 error、说法是「服务器出错（503）」时换成过一会儿再试；别的状态码原样", () => {
    expect(errText(new ApiError(503, "error", "服务器出错（503）"))).toBe(UNAVAILABLE_TEXT);
    expect(errText(new ApiError(500, "error", "服务器出错（500）"))).toBe("服务器出错（500）");
  });

  it("真走一遍 cloud.call：登录撞上 nginx 的 503 HTML 页，登录页红字是过一会儿再试", async () => {
    const actual = await vi.importActual<typeof import("../src/core/cloud")>("../src/core/cloud");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html><body><h1>503 Service Temporarily Unavailable</h1></body></html>", {
        status: 503,
        headers: { "Content-Type": "text/html" },
      }),
    );
    try {
      const e = await actual.login(EMAIL, PW).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(actual.ApiError);
      expect((e as InstanceType<typeof actual.ApiError>).status).toBe(503);
      expect((e as InstanceType<typeof actual.ApiError>).slug).toBe("error");
      m.login.mockRejectedValue(e);
      renderLogin();
      fill('input[type="email"]', EMAIL);
      fill('input[type="password"]', PW);
      await press("登录");
      expect(text()).toContain(UNAVAILABLE_TEXT);
      expect(text()).not.toContain("服务器出错");
      expect(syncStore.getState().session).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------- 409 already_registered

describe("409 already_registered：邮箱已有账号，直接给两条路", () => {
  it("红字 +「去登录」「忘记密码」，不只是一行字", async () => {
    m.register.mockRejectedValue(new ApiError(409, "already_registered", "这个邮箱已经有账号了（橡果和 cdpandas 用同一个账号）"));
    renderLogin();
    await fillRegister();
    await press("发验证码");
    expect(text()).toContain("这个邮箱已经有账号了");
    expect(btn("去登录")).toBeDefined();
    expect(btn("忘记密码")).toBeDefined();
    // 没往验证码那一屏跳
    expect(page().querySelector('input[inputmode="numeric"]')).toBeNull();
  });

  it("点「去登录」回到登录那一屏，邮箱密码都还在，直接能按登录", async () => {
    m.register.mockRejectedValue(new ApiError(409, "already_registered", "x"));
    renderLogin();
    await fillRegister();
    await press("发验证码");
    await press("去登录");
    expect(page().querySelector<HTMLInputElement>('input[type="email"]')!.value).toBe(EMAIL);
    expect(page().querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe(PW);
    expect(btn("登录")!.disabled).toBe(false);
    expect(text()).not.toContain("这个邮箱已经有账号了");
  });

  it("点「忘记密码」去重设密码那一屏", async () => {
    m.register.mockRejectedValue(new ApiError(409, "already_registered", "x"));
    renderLogin();
    await fillRegister();
    await press("发验证码");
    await press("忘记密码");
    expect(btn("重设密码并登录")).toBeDefined();
  });
});

// ---------------------------------------------------------------- 409 already_verified

describe("409 already_verified：早就验证过了，回登录那一屏", () => {
  it("回到登录那一屏并提示「邮箱已经验证过，直接登录吧」", async () => {
    m.register.mockResolvedValue(undefined);
    m.verify.mockRejectedValue(new ApiError(409, "already_verified", "这个邮箱已经验证过了，直接登录"));
    renderLogin();
    await fillRegister();
    await press("发验证码");
    fill('input[inputmode="numeric"]', "123456");
    await press("完成注册");
    expect(text()).toContain("邮箱已经验证过，直接登录吧");
    expect(btn("登录")).toBeDefined();
    expect(page().querySelector<HTMLInputElement>('input[type="email"]')!.value).toBe(EMAIL);
  });
});

// ---------------------------------------------------------------- 403 unverified

describe("403 unverified（登录时）：带去填验证码，并自动重发一封", () => {
  it("跳到验证码那一屏，替他要一封新的", async () => {
    m.login.mockRejectedValue(new ApiError(403, "unverified", "这个邮箱还没验证，去收验证码"));
    m.resendCode.mockResolvedValue(undefined);
    renderLogin();
    fill('input[type="email"]', EMAIL);
    fill('input[type="password"]', PW);
    await press("登录");
    expect(m.resendCode).toHaveBeenCalledWith(EMAIL);
    expect(page().querySelector('input[inputmode="numeric"]')).not.toBeNull();
    expect(text()).toContain("这个邮箱还没验证");
    expect(text()).toContain("邮件来自 cdpandas");
    expect(btn("完成注册")).toBeDefined();
  });

  it("重发没成（比如刚发过）：人照样停在验证码那一屏，红字写原因", async () => {
    m.login.mockRejectedValue(new ApiError(403, "unverified", "x"));
    m.resendCode.mockRejectedValue(new ApiError(429, "too_soon", "请 40 秒后再试"));
    renderLogin();
    fill('input[type="email"]', EMAIL);
    fill('input[type="password"]', PW);
    await press("登录");
    expect(page().querySelector('input[inputmode="numeric"]')).not.toBeNull();
    expect(text()).toContain("请 40 秒后再试");
  });

  it("403 的别的情况（被冻结）不跳，照旧一行红字", async () => {
    m.login.mockRejectedValue(new ApiError(403, "blocked", "账号已被冻结"));
    renderLogin();
    fill('input[type="email"]', EMAIL);
    fill('input[type="password"]', PW);
    await press("登录");
    expect(m.resendCode).not.toHaveBeenCalled();
    expect(text()).toContain("账号已被冻结");
    expect(page().querySelector('input[inputmode="numeric"]')).toBeNull();
  });
});

// ---------------------------------------------------------------- 文案与老服务器

describe("文案讲清「橡果和 cdpandas 用同一个账号」；老服务器行为不变", () => {
  it("登录 / 注册 / 忘记密码 三屏各一句", async () => {
    renderLogin();
    expect(text()).toContain(ACCOUNT_LINE.login!);
    expect(ACCOUNT_LINE.login).toContain("cdpandas");
    await press("还没有账号？注册");
    expect(text()).toContain(ACCOUNT_LINE.register!);
    await press("返回");
    await press("忘记密码");
    expect(text()).toContain(ACCOUNT_LINE.forgot!);
  });

  it("注册发出验证码之后提醒「邮件来自 cdpandas」", async () => {
    m.register.mockResolvedValue(undefined);
    renderLogin();
    await fillRegister();
    await press("发验证码");
    expect(text()).toContain(`验证码发到 ${EMAIL} 了，邮件来自 cdpandas`);
  });

  it("密码不对（401）：照旧一行红字，不跳屏、不重发", async () => {
    m.login.mockRejectedValue(new ApiError(401, "bad_login", "邮箱或密码不对"));
    renderLogin();
    fill('input[type="email"]', EMAIL);
    fill('input[type="password"]', PW);
    await press("登录");
    expect(text()).toContain("邮箱或密码不对");
    expect(m.resendCode).not.toHaveBeenCalled();
    expect(page().querySelector('input[inputmode="numeric"]')).toBeNull();
  });

  it("isApiErr 状态码和 slug 都对上才算", () => {
    expect(isApiErr(new ApiError(409, "already_registered", ""), 409, "already_registered")).toBe(true);
    expect(isApiErr(new ApiError(409, "busy", ""), 409, "already_registered")).toBe(false);
    expect(isApiErr(new Error("x"), 409, "already_registered")).toBe(false);
  });
});
