// 电脑上自动去云端取最新（v1.15.1，用户 2026-09-21 定的）。
//
// 原来桌面只在开机和本机有改动时同步：手机上刚记的事，电脑上光看不改就永远等不来。
// 现在加两条：窗口回到眼前取一次（距上次成功不到 60 秒跳过）、登录着每 5 分钟取一次。
//
// 这一份钉：什么时候发、什么时候不发、出错不吵、登出就停、手机上不挂、走的是现成的 syncNow。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { readFileSync } from "node:fs";
import { defaultData } from "../src/core/model";
import { appStore } from "../src/core/store";
import * as cloud from "../src/core/cloud";
import {
  AUTO_PULL_EVERY_MS,
  AUTO_PULL_GAP_MS,
  UPGRADE_RETRY_MS,
  autoPullIfDue,
  signOut,
  startAutoPull,
  stopAutoPull,
  syncStore,
} from "../src/core/syncCtl";

vi.mock("../src/core/cloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/cloud")>();
  return {
    ...actual,
    syncOnce: vi.fn(),
    saveSession: vi.fn(async () => {}),
  };
});

const syncOnce = cloud.syncOnce as unknown as Mock;
const T0 = new Date("2026-09-21T09:00:00.000Z").getTime();

function signedIn(syncedAt: string | null = null) {
  syncStore.setState({
    session: { token: "t", email: "a@b.co", rev: 1, syncedAt },
    phase: "idle", message: "", dirty: false, needsUpgrade: false, upgradeRetryAt: null, lastAttemptAt: null,
  });
}

/** 让挂起的 promise 链走完（假计时器下 syncNow 里那几个 await 也得有人推） */
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function setOnline(v: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => v });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  syncOnce.mockReset();
  syncOnce.mockImplementation(async (_s: unknown, data: unknown) => ({
    rev: 2, data, changed: false, summary: { added: 0, updated: 0, removed: 0 },
  }));
  appStore.setState({ data: defaultData(), loaded: true, loadError: null, dataFromNewer: null, rescue: null });
  setOnline(true);
  stopAutoPull();
  signedIn();
});

afterEach(async () => {
  stopAutoPull();
  await settle();
  vi.useRealTimers();
});

describe("该不该取这一轮（autoPullIfDue）", () => {
  it("登录着、从没同步过：取", async () => {
    expect(await autoPullIfDue()).toBe(true);
    expect(syncOnce).toHaveBeenCalledTimes(1);
  });

  it("距上次成功同步不到 60 秒：跳过；过了 60 秒：取", async () => {
    signedIn(new Date(T0 - 30 * 1000).toISOString());
    expect(await autoPullIfDue()).toBe(false);
    signedIn(new Date(T0 - AUTO_PULL_GAP_MS - 1).toISOString());
    expect(await autoPullIfDue()).toBe(true);
    expect(syncOnce).toHaveBeenCalledTimes(1);
  });

  it("没登录不发", async () => {
    syncStore.setState({ session: null, phase: "off" });
    expect(await autoPullIfDue()).toBe(false);
    expect(syncOnce).not.toHaveBeenCalled();
  });

  it("离线不发", async () => {
    setOnline(false);
    expect(await autoPullIfDue()).toBe(false);
    expect(syncOnce).not.toHaveBeenCalled();
  });

  it("被服务端挡着等升级不发", async () => {
    syncStore.setState({ needsUpgrade: true, upgradeRetryAt: T0 + UPGRADE_RETRY_MS });
    expect(await autoPullIfDue()).toBe(false);
    expect(syncOnce).not.toHaveBeenCalled();
  });

  it("正在同步不发（也不另起一轮）", async () => {
    syncStore.setState({ phase: "syncing" });
    expect(await autoPullIfDue()).toBe(false);
    expect(syncOnce).not.toHaveBeenCalled();
  });

  it("失败了也算试过：一分钟里再来不重撞；过了一分钟再试", async () => {
    syncOnce.mockRejectedValue(new Error("网断了"));
    expect(await autoPullIfDue()).toBe(true);
    expect(await autoPullIfDue()).toBe(false);
    vi.setSystemTime(T0 + AUTO_PULL_GAP_MS + 1);
    expect(await autoPullIfDue()).toBe(true);
    expect(syncOnce).toHaveBeenCalledTimes(2);
  });

  it("出错安静处理：不抛出去，只把那行小字照实改了，登录态和本机数据都不动", async () => {
    const before = appStore.getState().data;
    syncOnce.mockRejectedValue(new Error("网断了"));
    await expect(autoPullIfDue()).resolves.toBe(true);
    expect(syncStore.getState().phase).toBe("error");
    expect(syncStore.getState().session?.email).toBe("a@b.co");
    expect(appStore.getState().data).toBe(before);
  });
});

describe("挂上之后：回到眼前取一次、每 5 分钟取一次、登出就停", () => {
  it("窗口重新拿到焦点：取一次", async () => {
    startAutoPull(false);
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(syncOnce).toHaveBeenCalledTimes(1);
  });

  it("页面变回可见：取一次；focus 和 visibilitychange 前后脚一起来也只发一轮", async () => {
    startAutoPull(false);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(syncOnce).toHaveBeenCalledTimes(1);
  });

  it("每 5 分钟自己取一次", async () => {
    startAutoPull(false);
    await vi.advanceTimersByTimeAsync(AUTO_PULL_EVERY_MS);
    expect(syncOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AUTO_PULL_EVERY_MS);
    expect(syncOnce).toHaveBeenCalledTimes(2);
  });

  it("重复挂只挂一份", async () => {
    startAutoPull(false);
    startAutoPull(false);
    await vi.advanceTimersByTimeAsync(AUTO_PULL_EVERY_MS);
    expect(syncOnce).toHaveBeenCalledTimes(1);
  });

  it("登出之后计时器和监听都摘掉", async () => {
    startAutoPull(false);
    await signOut();
    signedIn(); // 就算有人又把登录态塞回来，没重新挂就不该再自己跑
    await vi.advanceTimersByTimeAsync(AUTO_PULL_EVERY_MS * 3);
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(syncOnce).not.toHaveBeenCalled();
  });

  it("手机上不挂（手机有进后台推一把 + 每天补一轮，不在计费流量上定时拉）", async () => {
    startAutoPull(true);
    await vi.advanceTimersByTimeAsync(AUTO_PULL_EVERY_MS * 2);
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(syncOnce).not.toHaveBeenCalled();
  });
});

describe("接线", () => {
  const src = readFileSync("src/core/syncCtl.ts", "utf8");

  it("走的是现成的 syncNow，不另写一套（base_rev、409 重试、合并都在那一条里）", () => {
    const body = src.slice(src.indexOf("export async function autoPullIfDue"), src.indexOf("export function startAutoPull"));
    expect(body).toContain("await syncNow();");
    expect(body).not.toContain("cloud.");
  });

  it("登录态落定时挂上（开机恢复、刚登录），登出和令牌过期时摘掉", () => {
    const init = src.slice(src.indexOf("export async function initSync"), src.indexOf("function adoptLegacyProfileNow"));
    expect(init).toContain("startAutoPull();");
    const adopt = src.slice(src.indexOf("export async function adoptSession"), src.indexOf("export async function signOut"));
    expect(adopt).toContain("startAutoPull();");
    const out = src.slice(src.indexOf("export async function signOut"), src.indexOf("export type SyncGate"));
    expect(out).toContain("stopAutoPull();");
    const expired = src.slice(src.indexOf("if (err?.needsLogin)"));
    expect(expired.slice(0, 300)).toContain("stopAutoPull();");
  });

  it("默认按 isMobile 判端：电脑浏览器上的网页版也算电脑", () => {
    expect(src).toContain("export function startAutoPull(mobile = isMobile)");
  });
});
