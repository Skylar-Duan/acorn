// 电脑上自动去云端取最新（v1.15.1，用户 2026-09-21 定的）。
//
// 原来桌面只在开机和本机有改动时同步：手机上刚记的事，电脑上光看不改就永远等不来。
// 现在加两条：窗口回到眼前取一次（距上次成功不到 60 秒跳过）、登录着每 5 分钟取一次。
//
// 这一份钉：什么时候发、什么时候不发、出错不吵、登出就停、手机上不挂、走的是现成的 syncNow。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { readFileSync } from "node:fs";
import { defaultData, newTask } from "../src/core/model";
import { appStore } from "../src/core/store";
import * as cloud from "../src/core/cloud";
import {
  AUTO_PULL_EVERY_MS,
  AUTO_PULL_GAP_MS,
  UPGRADE_RETRY_MS,
  autoPullIfDue,
  holdAutoSync,
  signOut,
  startAutoPull,
  stopAutoPull,
  syncStore,
  syncNow,
  syncNowChecked,
} from "../src/core/syncCtl";

vi.mock("../src/core/cloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/cloud")>();
  return {
    ...actual,
    syncOnce: vi.fn(),
    whoAmI: vi.fn(),
    saveSession: vi.fn(async () => {}),
  };
});

const syncOnce = cloud.syncOnce as unknown as Mock;
const whoAmI = cloud.whoAmI as unknown as Mock;
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
  whoAmI.mockReset();
  whoAmI.mockResolvedValue({ email: "a@b.co", rev: 2, hasData: true });
  syncOnce.mockImplementation(async (_s: unknown, data: unknown) => ({
    rev: 2, data, changed: false, summary: { added: 0, updated: 0, removed: 0 },
  }));
  appStore.setState({ data: defaultData(), loaded: true, loadError: null, dataFromNewer: null, rescue: null, wiped: false });
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
    vi.setSystemTime(Date.now() + AUTO_PULL_GAP_MS + 1);
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

  it("每 5 分钟自己检查，已同步的同一份账本只探测rev", async () => {
    startAutoPull(false);
    await vi.advanceTimersByTimeAsync(AUTO_PULL_EVERY_MS);
    expect(syncOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AUTO_PULL_EVERY_MS);
    expect(syncOnce).toHaveBeenCalledTimes(1);
    expect(whoAmI).toHaveBeenCalledTimes(1);
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
    expect(body).toContain("cloud.whoAmI");
    expect(body).not.toContain("cloud.syncOnce");
  });

  it("登录态落定时挂上（开机恢复、刚登录），登出和令牌过期时摘掉", () => {
    const init = src.slice(src.indexOf("export async function initSync"), src.indexOf("function adoptLegacyProfileNow"));
    expect(init).toContain("startAutoPull();");
    const adopt = src.slice(src.indexOf("export async function adoptSession"), src.indexOf("export async function signOut"));
    expect(adopt).toContain("startAutoPull();");
    const out = src.slice(src.indexOf("export async function signOut"), src.indexOf("export type SyncGate"));
    expect(out).toContain("stopAutoPull();");
    // 令牌过期（同步和发反馈撞上 401）统一走 expireSession
    const expired = src.slice(src.indexOf("export async function expireSession"), src.indexOf("export type SyncGate"));
    expect(expired).toContain("stopAutoPull();");
    expect(src.slice(src.indexOf("if (err?.needsLogin)")).slice(0, 80)).toContain("await expireSession();");
  });

  it("默认按 isMobile 判端：电脑浏览器上的网页版也算电脑", () => {
    expect(src).toContain("export function startAutoPull(mobile = isMobile)");
  });
});

describe("大账本自动轻探测的边界", () => {
  async function clean() {
    await syncNow();
    syncOnce.mockClear();
    whoAmI.mockClear();
    (cloud.saveSession as Mock).mockClear();
    vi.setSystemTime(Date.now() + AUTO_PULL_GAP_MS + 1);
  }

  it("已确认上传的同一对象且云rev不变，只查小元信息，不拉推整本", async () => {
    await clean();
    const snapshot = appStore.getState().data;
    expect(await autoPullIfDue()).toBe(true);
    expect(whoAmI).toHaveBeenCalledOnce();
    expect(syncOnce).not.toHaveBeenCalled();
    expect(appStore.getState().data).toBe(snapshot);
    expect(syncStore.getState().dirty).toBe(false);
  });

  it("冷启动dirty=false不代表上传过，必须走真实整本同步", async () => {
    expect(syncStore.getState().dirty).toBe(false);
    await autoPullIfDue();
    expect(syncOnce).toHaveBeenCalledOnce();
    expect(whoAmI).not.toHaveBeenCalled();
  });

  it("本地对象改变，即使dirty漏置也不能只查rev", async () => {
    await clean();
    appStore.setState({ data: { ...appStore.getState().data, tasks: [newTask({ title: "未上传合成任务" })] } });
    await autoPullIfDue();
    expect(syncOnce).toHaveBeenCalledOnce();
    expect(whoAmI).not.toHaveBeenCalled();
    expect((syncOnce.mock.calls[0][1] as ReturnType<typeof defaultData>).tasks[0].title).toBe("未上传合成任务");
  });

  it("明确有待推改动时直接整本同步", async () => {
    await clean();
    syncStore.setState({ dirty: true });
    await autoPullIfDue();
    expect(syncOnce).toHaveBeenCalledOnce();
    expect(whoAmI).not.toHaveBeenCalled();
  });

  it("云rev升高会继续拉推，不能错把轻查成功当成已同步", async () => {
    await clean();
    whoAmI.mockResolvedValue({ email: "a@b.co", rev: 8 });
    await autoPullIfDue();
    expect(whoAmI).toHaveBeenCalledOnce();
    expect(syncOnce).toHaveBeenCalledOnce();
  });

  it("探测等待期间又编辑，不丢刚记的内容，也不清dirty后跳过", async () => {
    await clean();
    let reply!: (value: unknown) => void;
    whoAmI.mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }));
    const pending = autoPullIfDue();
    await settle();
    const data = { ...appStore.getState().data, tasks: [newTask({ title: "探测期间的新记录" })] };
    appStore.setState({ data });
    syncStore.setState({ dirty: true });
    reply({ email: "a@b.co", rev: 2 });
    await pending;
    expect(syncOnce).toHaveBeenCalledOnce();
    expect(syncOnce.mock.calls[0][1]).toBe(data);
    expect(appStore.getState().data.tasks[0].title).toBe("探测期间的新记录");
  });

  it("独占覆盖闸门在探测期间关闭，旧探测不擅自插入合并", async () => {
    await clean();
    let reply!: (value: unknown) => void;
    whoAmI.mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }));
    const pending = autoPullIfDue();
    await settle();
    const release = await holdAutoSync();
    reply({ email: "a@b.co", rev: 9 });
    await pending;
    expect(syncOnce).not.toHaveBeenCalled();
    release();
  });

  it("探测期间切账号后旧成功/401都不改新账号或账本", async () => {
    for (const error of [false, true]) {
      stopAutoPull();
      signedIn();
      await clean();
      let reply!: (value: unknown) => void;
      let reject!: (reason: unknown) => void;
      whoAmI.mockImplementationOnce(() => new Promise((yes, no) => { reply = yes; reject = no; }));
      const pending = autoPullIfDue();
      await settle();
      const replacement = { token: "new-token", email: "other@example.test", rev: 15, syncedAt: null };
      const book = { ...defaultData(), tasks: [newTask({ title: "另一个账号的合成任务" })] };
      syncStore.setState({ session: replacement, phase: "idle" });
      appStore.setState({ data: book });
      if (error) reject(new cloud.ApiError(401, "bad_token", "旧账号已过期"));
      else reply({ email: "a@b.co", rev: 10 });
      await pending;
      expect(syncStore.getState().session).toBe(replacement);
      expect(appStore.getState().data).toBe(book);
      expect(syncOnce).not.toHaveBeenCalled();
      expect(cloud.saveSession).not.toHaveBeenCalled();
    }
  });

  it("清空本机的检查闸门仍做真实同步，轻探测不能代替上传证据", async () => {
    await clean();
    const gate = await syncNowChecked();
    expect(gate.ok).toBe(true);
    expect(syncOnce).toHaveBeenCalledOnce();
    expect(whoAmI).not.toHaveBeenCalled();
  });

  it("清空中的账本不再起飞，检查闸门也不能凭空说已上传", async () => {
    appStore.setState({ wiped: true });
    await syncNow();
    expect(await autoPullIfDue()).toBe(false);
    const gate = await syncNowChecked();
    expect(gate.ok).toBe(false);
    expect(syncOnce).not.toHaveBeenCalled();
    expect(whoAmI).not.toHaveBeenCalled();
  });

  it("检查闸门等待期间账本失效又恢复，也不能把旧请求当作上传证明", async () => {
    let reply!: (value: unknown) => void;
    syncOnce.mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }));
    const book = appStore.getState().data;
    const checking = syncNowChecked();
    await settle();
    appStore.setState({ loaded: false });
    appStore.setState({ loaded: true });
    reply({ rev: 9, data: book, changed: false, summary: { added: 0, updated: 0, removed: 0 } });
    expect((await checking).ok).toBe(false);
    expect(appStore.getState().data).toBe(book);
  });

  it("检查闸门等待期间切账号，即使账本对象不变也不给新账号错误证明", async () => {
    let reply!: (value: unknown) => void;
    syncOnce.mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }));
    const book = appStore.getState().data;
    const checking = syncNowChecked();
    await settle();
    syncStore.setState({ session: { token: "other", email: "other@example.test", rev: 5, syncedAt: null }, phase: "idle" });
    reply({ rev: 9, data: book, changed: false, summary: { added: 0, updated: 0, removed: 0 } });
    expect((await checking).ok).toBe(false);
    expect(syncStore.getState().session?.rev).toBe(5);
  });

  it("整本请求期间登出再登同账号，旧结果也不能恢复账本或写回令牌", async () => {
    let reply!: (value: unknown) => void;
    syncOnce.mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }));
    const pending = syncNow();
    await settle();
    const session = syncStore.getState().session;
    syncStore.setState({ session: null });
    syncStore.setState({ session, phase: "idle" });
    const book = appStore.getState().data;
    (cloud.saveSession as Mock).mockClear();
    reply({ rev: 99, data: { ...book, tasks: [newTask({ title: "过期结果" })] }, changed: true, summary: { added: 1, updated: 0, removed: 0 } });
    await pending;
    expect(appStore.getState().data).toBe(book);
    expect(syncStore.getState().session?.rev).toBe(1);
    expect(cloud.saveSession).not.toHaveBeenCalled();
  });
});
