// 设置页「反馈」一节（2026-09-21，用户：「三端：反馈入口做出来（放到设置里面）」；
// 「查看大家的反馈」那个管理员入口同一天又撤掉了——用户：「反馈那里：不需要查看大家的反馈」）。
//
// 钉三样：
//   ① 挂在哪：设置页「账号」后面一节，三端同一份（不包在任何平台判断里）
//   ② 没登录：只有一句「登录后就能发反馈」+「去登录」，没有输入框
//   ③ 发送：带对的 platform / version / device；成了清空并说「收到了，谢谢」；
//      没成给人话（太长、太频繁、网络不通），框里的字留着；
//      401 跟同步一样断开登录态（本机数据不动），503 / 429 不断；
//      这一节不问 /api/me，没有「查看大家的反馈」这条路
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/core/cloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/cloud")>();
  return {
    ...actual,
    submitFeedback: vi.fn(),
    whoAmI: vi.fn(),
    saveSession: vi.fn(async () => {}),
  };
});

import * as cloud from "../src/core/cloud";
import { ApiError, deviceName } from "../src/core/cloud";
import FeedbackPanel from "../src/components/FeedbackPanel";
import { syncStore } from "../src/core/syncCtl";
import { appStore } from "../src/core/store";
import { loginStore } from "../src/mobile/sheetStore";
import { APP_PLATFORM, APP_VERSION } from "../src/core/version";
import { FEEDBACK_MAX, canSendFeedback, feedbackCountText, feedbackErr, feedbackLength } from "../src/core/feedback";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const submitFeedback = vi.mocked(cloud.submitFeedback);
const whoAmI = vi.mocked(cloud.whoAmI);

const nl = (s: string) => s.replace(/\r\n/g, "\n");
const stripComments = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const settingsCode = stripComments(nl(readFileSync("src/views/Settings.tsx", "utf8")));
const panelSrc = nl(readFileSync("src/components/FeedbackPanel.tsx", "utf8"));

const roots: Root[] = [];
function render(): HTMLDivElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(FeedbackPanel)));
  roots.push(root);
  return host;
}

async function signIn(): Promise<void> {
  await act(async () => {
    syncStore.setState({ session: { token: "tok", email: "a@b.c", rev: 1, syncedAt: null }, phase: "idle", message: "" });
  });
}

/** React 受控的 textarea：得走原生 setter 再发 input 事件，React 才认 */
function type(el: HTMLTextAreaElement, v: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement | undefined;

async function clickSend(host: HTMLElement): Promise<void> {
  await act(async () => {
    button(host, "发送")!.click();
  });
}

const toast = () => appStore.getState().ui.toast?.msg ?? null;

beforeEach(() => {
  submitFeedback.mockReset();
  whoAmI.mockReset();
  syncStore.setState({ session: null, phase: "off", message: "" });
  loginStore.setState({ open: false, reason: "manual" });
  appStore.setState({ ui: { ...appStore.getState().ui, toast: null } });
});

afterEach(() => {
  act(() => roots.splice(0).forEach((r) => r.unmount()));
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- ① 挂在哪

describe("① 设置页「账号」后面一节，三端同一份", () => {
  it("「反馈」紧跟在「账号」那一节后面", () => {
    const cloudAt = settingsCode.indexOf('<SetSection\n          id="cloud"');
    const fbAt = settingsCode.indexOf('<SetSection\n          id="feedback"');
    const generalAt = settingsCode.indexOf('<SetSection\n          id="general"');
    expect(cloudAt).toBeGreaterThan(-1);
    expect(fbAt).toBeGreaterThan(cloudAt);
    expect(generalAt).toBeGreaterThan(fbAt);
    expect(settingsCode).toContain('title="反馈"');
    expect(settingsCode).toContain("<FeedbackPanel />");
  });

  it("不包在任何平台判断里（三端都有）", () => {
    const before = settingsCode.slice(settingsCode.indexOf('id="feedback"') - 200, settingsCode.indexOf('id="feedback"'));
    for (const gate of ["isMobile &&", "isDesktopShell &&", "isWeb &&", "inTauri &&", "hasDesktopFeatures &&"]) {
      expect(before).not.toContain(gate);
    }
  });

  it("界面上不写端名", () => {
    for (const w of ["桌面版", "电脑版", "网页版", "手机版", "安卓", "Windows"]) expect(panelSrc).not.toContain(w);
  });

  it("网络只走 core/cloud，这一页没有 fetch", () => {
    expect(panelSrc).not.toContain("fetch(");
    expect(panelSrc).toContain("cloud.submitFeedback(");
  });
});

// ---------------------------------------------------------------- ② 没登录

describe("② 没登录：只有一句提示和「去登录」", () => {
  it("一行灰字 + 去登录，没有输入框，也不去问 /api/me", () => {
    const host = render();
    expect(host.textContent).toContain("登录后就能发反馈");
    expect(host.querySelector("textarea")).toBeNull();
    expect(button(host, "发送")).toBeUndefined();
    expect(whoAmI).not.toHaveBeenCalled();
  });

  it("点「去登录」把登录页顶出来", () => {
    const host = render();
    act(() => button(host, "去登录")!.click());
    expect(loginStore.getState()).toMatchObject({ open: true, reason: "manual" });
  });
});

// ---------------------------------------------------------------- ③ 发送

describe("③ 发送", () => {
  it("没写字时「发送」按不了；这一节不问 /api/me，也没有「查看大家的反馈」", async () => {
    const host = render();
    await signIn();
    expect(button(host, "发送")!.disabled).toBe(true);
    type(host.querySelector("textarea")!, "   \n ");
    expect(button(host, "发送")!.disabled).toBe(true);
    expect(whoAmI).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("查看大家的反馈");
  });

  it("带上端、版本、设备名；成了清空框子、说「收到了，谢谢」", async () => {
    submitFeedback.mockResolvedValue({ id: 1, message: "收到了，谢谢" });
    const host = render();
    await signIn();
    const area = host.querySelector("textarea")!;
    type(area, "  周视图字太小了\r\n希望能调  ");
    await clickSend(host);
    expect(submitFeedback).toHaveBeenCalledTimes(1);
    expect(submitFeedback).toHaveBeenCalledWith("tok", {
      text: "周视图字太小了\n希望能调",
      platform: APP_PLATFORM,
      version: APP_VERSION,
      device: deviceName(),
    });
    expect(["desktop", "android", "web"]).toContain(submitFeedback.mock.calls[0][1].platform);
    expect(host.querySelector("textarea")!.value).toBe("");
    expect(toast()).toBe("收到了，谢谢");
  });

  it("太长：服务端回 feedback_too_long → 人话，写的字留着", async () => {
    submitFeedback.mockRejectedValue(new ApiError(400, "feedback_too_long", "反馈最多 2000 字，拆成几条发"));
    const host = render();
    await signIn();
    type(host.querySelector("textarea")!, "一些话");
    await clickSend(host);
    expect(host.textContent).toContain(`太长了，一条最多 ${FEEDBACK_MAX} 字，拆成几条发`);
    expect(host.querySelector("textarea")!.value).toBe("一些话");
    expect(toast()).toBeNull();
  });

  it("太频繁：429 → 过一会儿再发", async () => {
    submitFeedback.mockRejectedValue(new ApiError(429, "too_many", "反馈发得太勤了，过一小时再发"));
    const host = render();
    await signIn();
    type(host.querySelector("textarea")!, "又一条");
    await clickSend(host);
    expect(host.textContent).toContain("发得太勤了，过一会儿再发");
  });

  it("登录过期：401 → 跟同步一样断开登录态，说清为什么，给「去登录」；重新登录回来字还在", async () => {
    submitFeedback.mockRejectedValue(new ApiError(401, "bad_token", "登录状态过期了，重新登录一下"));
    const host = render();
    await signIn();
    type(host.querySelector("textarea")!, "一条");
    await clickSend(host);
    expect(syncStore.getState().session).toBeNull();
    expect(cloud.saveSession).toHaveBeenCalledWith(null);
    expect(syncStore.getState().message).toContain("重新登录");
    expect(host.textContent).toContain("登录已经过期，重新登录后再发。写的字还在。");
    expect(host.querySelector("textarea")).toBeNull();
    act(() => button(host, "去登录")!.click());
    expect(loginStore.getState().open).toBe(true);
    await signIn();
    expect(host.querySelector("textarea")!.value).toBe("一条");
    expect(host.textContent).not.toContain("登录已经过期");
  });

  it("503 和 429 不断开登录态", async () => {
    for (const err of [
      new ApiError(503, "account_unavailable", "账号服务暂时连不上，过一会儿再试（不是密码的问题）"),
      new ApiError(429, "too_many", "反馈发得太勤了，过一小时再发"),
    ]) {
      vi.mocked(cloud.saveSession).mockClear();
      submitFeedback.mockRejectedValue(err);
      const host = render();
      await signIn();
      type(host.querySelector("textarea")!, "一条");
      await clickSend(host);
      expect(syncStore.getState().session).not.toBeNull();
      expect(cloud.saveSession).not.toHaveBeenCalledWith(null);
      expect(host.querySelector("textarea")!.value).toBe("一条");
    }
  });

  it("网络不通：说清没发出去、字还在", async () => {
    submitFeedback.mockRejectedValue(new ApiError(0, "offline", "连不上服务器，这次没有同步"));
    const host = render();
    await signIn();
    type(host.querySelector("textarea")!, "一条");
    await clickSend(host);
    expect(host.textContent).toContain("网络不通，没发出去。写的字还在，连上网再发");
    expect(host.textContent).not.toContain("同步");
    expect(host.querySelector("textarea")!.value).toBe("一条");
  });

  it("字数：平时不显示；剩不到 200 字才显示，超了按不了", () => {
    expect(feedbackCountText("短短一句")).toBeNull();
    expect(feedbackCountText("字".repeat(FEEDBACK_MAX - 150))).toBe("还能写 150 字");
    expect(feedbackCountText("字".repeat(FEEDBACK_MAX + 3))).toBe("超出 3 字，删掉一些再发");
    expect(canSendFeedback("字".repeat(FEEDBACK_MAX))).toBe(true);
    expect(canSendFeedback("字".repeat(FEEDBACK_MAX + 1))).toBe(false);
    // 跟服务端一样数：一个表情算一个字，首尾空白不算
    expect(feedbackLength(" 😀好 ")).toBe(2);
  });

  it("其余几种说法", () => {
    expect(feedbackErr(new ApiError(404, "error", "服务器出错（404）")).text).toBe("现在还发不了反馈，过几天再试");
    expect(feedbackErr(new ApiError(503, "account_unavailable", "x")).text).toBe("暂时发不出去，过一会儿再试");
    expect(feedbackErr(new ApiError(503, "account_unavailable", "x")).login).toBe(false);
    // 网关只回了个 503 页面（解析不出 JSON）：同一句，不是「没发出去：服务器出错（503）」
    expect(feedbackErr(new ApiError(503, "error", "服务器出错（503）")).text).toBe("暂时发不出去，过一会儿再试");
    expect(feedbackErr(new ApiError(403, "unverified", "邮箱还没验证")).login).toBe(true);
  });

  it("发送成功也不问 /api/me、不出现「查看大家的反馈」（那条路已经撤掉）", async () => {
    submitFeedback.mockResolvedValue({ id: 1, message: "收到了，谢谢" });
    const host = render();
    await signIn();
    type(host.querySelector("textarea")!, "一条");
    await clickSend(host);
    expect(whoAmI).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("查看大家的反馈");
    expect(host.textContent).not.toContain("先退出再登录一次");
  });
});
