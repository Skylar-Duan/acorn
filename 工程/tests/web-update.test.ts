// 网页版的「有新版了」轮询（v1.15.0）。
//
// 这块要挡住的错，都是「提示会骗人」那一类：
// 1. 断网 / 404 时把「查不到」当成「有新版」，给人弹一句莫名其妙的话
// 2. 拿到一张 404 的 HTML 当成版本号（服务器上还没发过 version.json 就是这个场面）
// 3. 版本号按字符串比 —— 1.10.0 会小于 1.9.0，跟 updater.ts 一样的老坑，所以这里直接复用它的比较函数
// 4. 查到之后反复提示：toast 每隔四小时再弹一次，比不提示还烦人
//
// 注意这个模块**故意不碰 store、不碰界面**，只回调。挂在哪儿、怎么提示是上层的事。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  fetchWebVersion, parseWebVersion, reloadForUpdate, startWebUpdateWatch, WEB_POLL_MS, WEB_VERSION_URL,
} from "../src/core/webUpdate";

const source = readFileSync("src/core/webUpdate.ts", "utf8");

/** 一个够用的假 fetch：按顺序吐出给定的返回值，并记下被请求过的 URL */
function fakeFetch(...responses: Array<{ ok?: boolean; body?: unknown; throws?: boolean }>) {
  const calls: string[] = [];
  let i = 0;
  const impl = (async (url: string) => {
    calls.push(String(url));
    const r = responses[Math.min(i++, responses.length - 1)] ?? { ok: false };
    if (r.throws) throw new Error("网线被拔了");
    return {
      ok: r.ok !== false,
      json: async () => r.body,
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("parseWebVersion：只认像版本号的东西", () => {
  it("正常清单取得出版本号", () => {
    expect(parseWebVersion({ version: "1.15.0", publishedAt: "2026-09-14T14:00:00Z" })).toBe("1.15.0");
    expect(parseWebVersion({ version: " 1.15 " })).toBe("1.15");
  });

  it("缺斤少两、或者压根不是版本号的，一律当查不到", () => {
    expect(parseWebVersion(null)).toBeNull();
    expect(parseWebVersion("1.15.0")).toBeNull(); // 整个是字符串，不是清单
    expect(parseWebVersion({})).toBeNull();
    expect(parseWebVersion({ version: 115 })).toBeNull();
    expect(parseWebVersion({ version: "" })).toBeNull();
    // 服务器上还没有 version.json 时，nginx 可能回一张 HTML；那不是版本号
    expect(parseWebVersion({ version: "<!doctype html>" })).toBeNull();
    expect(parseWebVersion({ version: "v1.15.0" })).toBeNull();
  });
});

describe("fetchWebVersion", () => {
  it("查的是 base 底下的 version.json，并且带一个时间戳绕开缓存", async () => {
    // 查到一份旧清单，这个模块就完全白做了 —— 所以 URL 上必须有东西是每次都变的
    const { impl, calls } = fakeFetch({ body: { version: "1.15.0" } });
    const v = await fetchWebVersion({ fetchImpl: impl, stamp: () => 123 });
    expect(v).toBe("1.15.0");
    expect(calls[0]).toBe(`${WEB_VERSION_URL}?t=123`);
  });

  it("测试环境里 base 是 /，网页版打包时是 /app/（由 vite 的 BASE_URL 决定）", () => {
    expect(WEB_VERSION_URL.endsWith("version.json")).toBe(true);
    // 写死成 "/app/version.json" 就跟 base 脱钩了，本地预览时会查错地方
    expect(source).toContain("import.meta.env.BASE_URL");
  });

  it("断网、404、返回的不是 JSON —— 全都安静地返回 null，不许抛出去", async () => {
    for (const r of [{ throws: true }, { ok: false }, { body: "不是 JSON" }]) {
      const { impl } = fakeFetch(r);
      await expect(fetchWebVersion({ fetchImpl: impl })).resolves.toBeNull();
    }
  });
});

describe("startWebUpdateWatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("一开始就查一次；服务器比手里这份新才叫", async () => {
    const onNewVersion = vi.fn();
    const { impl } = fakeFetch({ body: { version: "1.16.0" } });
    const stop = startWebUpdateWatch({ onNewVersion, current: "1.15.0", fetchImpl: impl });
    await vi.waitFor(() => expect(onNewVersion).toHaveBeenCalledWith("1.16.0"));
    stop();
  });

  it("版本一样、或者服务器上反而是旧的，都不叫", async () => {
    for (const remote of ["1.15.0", "1.14.9"]) {
      const onNewVersion = vi.fn();
      const { impl } = fakeFetch({ body: { version: remote } });
      const stop = startWebUpdateWatch({ onNewVersion, current: "1.15.0", fetchImpl: impl });
      await vi.advanceTimersByTimeAsync(0);
      expect(onNewVersion, remote).not.toHaveBeenCalled();
      stop();
    }
  });

  it("版本号按数字比，不按字符串：1.9.0 的手机看得到 1.10.0", async () => {
    const onNewVersion = vi.fn();
    const { impl } = fakeFetch({ body: { version: "1.10.0" } });
    const stop = startWebUpdateWatch({ onNewVersion, current: "1.9.0", fetchImpl: impl });
    await vi.waitFor(() => expect(onNewVersion).toHaveBeenCalledWith("1.10.0"));
    stop();
  });

  it("到点会再查一轮；但查到之后只叫一次，不反复烦人", async () => {
    const onNewVersion = vi.fn();
    const { impl, calls } = fakeFetch(
      { body: { version: "1.15.0" } }, // 第一轮：还没发新版
      { body: { version: "1.16.0" } }, // 后面几轮：发了
    );
    const stop = startWebUpdateWatch({ onNewVersion, current: "1.15.0", intervalMs: 1000, fetchImpl: impl });
    await vi.advanceTimersByTimeAsync(0);
    expect(onNewVersion).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(onNewVersion).toHaveBeenCalledTimes(1);

    const callsWhenFound = calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(onNewVersion).toHaveBeenCalledTimes(1);
    // 叫过之后连问都不再问了：结论不会变，白费流量
    expect(calls.length).toBe(callsWhenFound);
    stop();
  });

  it("页面重新回到前台会补查一次 —— 加到主屏幕后定时器可能被系统冻住，这条才是主力", async () => {
    const onNewVersion = vi.fn();
    const { impl, calls } = fakeFetch({ body: { version: "1.15.0" } }, { body: { version: "1.16.0" } });
    const stop = startWebUpdateWatch({ onNewVersion, current: "1.15.0", intervalMs: 1000, fetchImpl: impl });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBe(1);

    // 隔得还不够久（窗口只是切走又切回来），不该每次切回来都发一次请求
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBe(1);

    // 隔了一轮以上再回来 —— 这时候要问
    await vi.advanceTimersByTimeAsync(1500);
    vi.setSystemTime(Date.now() + 2000);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(onNewVersion).toHaveBeenCalledWith("1.16.0"));
    stop();
  });

  it("停掉之后既不再查，也不再叫", async () => {
    const onNewVersion = vi.fn();
    const { impl, calls } = fakeFetch({ body: { version: "1.16.0" } });
    const stop = startWebUpdateWatch({ onNewVersion, current: "1.15.0", intervalMs: 1000, fetchImpl: impl });
    stop();
    const after = calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBe(after);
    expect(onNewVersion).not.toHaveBeenCalled();
  });

  it("四小时问一次：太勤是白费用户流量，太懒就等于没有", () => {
    expect(WEB_POLL_MS).toBe(4 * 60 * 60 * 1000);
  });
});

describe("这个模块的边界", () => {
  it("换上新版就是刷新一次（网页版没有包可下）", () => {
    const reload = vi.fn();
    const orig = window.location;
    Object.defineProperty(window, "location", { value: { ...orig, reload }, writable: true });
    reloadForUpdate();
    expect(reload).toHaveBeenCalled();
    Object.defineProperty(window, "location", { value: orig, writable: true });
  });

  it("不碰 store、不碰界面 —— 挂载和提示归上层，这里只回调", () => {
    expect(source).not.toMatch(/from "\.\/store"/);
    expect(source).not.toMatch(/showToast/);
  });

  it("版本比较复用 updater.ts 那一份，不在这儿再写一遍", () => {
    expect(source).toMatch(/import \{ compareVersions \} from "\.\/updater"/);
  });
});
