import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
const flags = vi.hoisted(() => ({ ultra: true, token: "synthetic-ultra-token", saved: [] as string[] }));
vi.mock("../src/core/version", async (original) => ({ ...await original<typeof import("../src/core/version")>(), get IS_ULTRA() { return flags.ultra; } }));
vi.mock("../src/core/cloud", () => ({ API_BASE: "https://acorn.cdpandas.com", loadSession: async () => flags.token ? { token: flags.token, email: "demo@example.test" } : null }));
vi.mock("../src/core/persist", async (original) => ({ ...await original<typeof import("../src/core/persist")>(), inTauri: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (cmd: string, _data?: unknown, opts?: { headers?: Record<string, string> }) => {
  if (cmd === "save_download_raw") { const name = opts?.headers?.["acorn-file-name"] ?? ""; flags.saved.push(name); return "saved:" + name; }
  return null;
} }));
import { downloadPackage, fetchUpdate, packageName, parseManifest, type UpdateInfo } from "../src/core/updater";
import { CHECK_UNAVAILABLE_MSG, CHECK_FAILED_MSG, checkUpdateNow, checkUpdateOnBoot, updateFootState, updateStore } from "../src/core/updateCtl";
import UpdatePanel from "../src/components/UpdatePanel";

const BASE = "https://acorn.cdpandas.com";
const bytes = new TextEncoder().encode("Synthetic installer bytes");
const hash = createHash("sha256").update(bytes).digest("hex");
const manifest = (patch: Record<string, unknown> = {}) => ({ available: true, edition: "ultra", requiresAuth: true, downloadId: "demo-download-id", version: "99.0.0", schema: 8,
  url: `${BASE}/api/ultra/download/demo-ticket`, size: bytes.length, sha256: hash, notes: "合成更新", publishedAt: "2026-10-16T09:00:00Z", pageUrl: `${BASE}/intro/`, ...patch });
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);
function stream(content = bytes): Response {
  let read = false;
  return { ok: true, status: 200, headers: { get: () => String(content.length) }, body: { getReader: () => ({
    read: async () => read ? { done: true } : (read = true, { done: false, value: content }), cancel: async () => {},
  }) } } as unknown as Response;
}
beforeEach(() => {
  flags.ultra = true; flags.token = "synthetic-ultra-token"; flags.saved = [];
  localStorage.clear();
  vi.stubGlobal("crypto", webcrypto);
  updateStore.setState({ pending: null, found: null, memo: null, lastCheck: null });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Ultra固定鉴权通道", () => {
  it("公开普通清单、缺鉴权/大小/SHA或伪装路径一律不当Ultra更新", () => {
    for (const patch of [
      { edition: "normal" }, { edition: undefined }, { requiresAuth: false }, { downloadId: undefined }, { sha256: "abc" }, { size: 0 },
      { url: `${BASE}/download/windows/normal.exe` }, { url: `${BASE}/api/ultra/download/../desktop/latest` },
      { url: `${BASE}/api/ultra/download/demo?redirect=other` }, { url: `${BASE}/api/ultra/download/demo/complete` },
      { url: "https://other.example.test/api/ultra/download/demo" },
    ]) expect(parseManifest(manifest(patch))).toBeNull();
    expect(parseManifest(manifest())?.edition).toBe("ultra");
  });

  it("latest与beta都带Bearer，且从不请求普通更新接口", async () => {
    const fetcher = vi.fn(async (url: string) => response(url.endsWith("/beta") ? { available: false } : manifest()));
    vi.stubGlobal("fetch", fetcher);
    expect((await fetchUpdate()).ok).toBe(true);
    expect(fetcher.mock.calls.map((c) => c[0])).toEqual([`${BASE}/api/ultra/desktop/latest`, `${BASE}/api/ultra/desktop/beta`]);
    for (const call of fetcher.mock.calls) expect((call as unknown as [string, RequestInit])[1].headers).toEqual({ Authorization: "Bearer synthetic-ultra-token" });
  });

  it("未登录或未获授权报auth，不误报网络，也不回退普通清单", async () => {
    flags.token = ""; const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect(await fetchUpdate()).toEqual({ ok: false, reason: "auth" }); expect(fetcher).not.toHaveBeenCalled();
    flags.token = "synthetic-ultra-token";
    for (const code of [401, 403]) {
      fetcher.mockReset().mockResolvedValue(response({}, code));
      expect(await fetchUpdate()).toEqual({ ok: false, reason: "auth" }); expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("实际下载入口自身拒绝丢失标志的普通包，即使绕过parseManifest也不能降级", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(downloadPackage({ ...manifest(), requiresAuth: false, edition: "normal" } as UpdateInfo, () => {})).rejects.toThrow("版本类型");
    expect(fetcher).not.toHaveBeenCalled(); expect(flags.saved).toEqual([]);
  });

  it("完整字节SHA通过才落盘并带相同Bearer确认，两个请求均拒绝重定向", async () => {
    const fetcher = vi.fn(async (url: string) => url.endsWith("/complete") ? response({ ok: true }) : stream());
    vi.stubGlobal("fetch", fetcher);
    const progress: number[] = [];
    expect(await downloadPackage(parseManifest(manifest())!, (p) => progress.push(p.received))).toBe("saved:AcornUltra_99.0.0.exe");
    expect(flags.saved).toEqual(["AcornUltra_99.0.0.exe"]); expect(progress).toEqual([bytes.length]);
    expect(fetcher.mock.calls.map((c) => c[0])).toEqual([`${BASE}/api/ultra/download/demo-ticket`, `${BASE}/api/ultra/download/demo-download-id/complete`]);
    for (const call of fetcher.mock.calls) {
      const init = (call as unknown as [string, RequestInit])[1];
      expect(init.redirect).toBe("error"); expect((init.headers as Record<string, string>).Authorization).toBe("Bearer synthetic-ultra-token");
    }
    expect(JSON.parse((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).toEqual({ sha256: hash });
  });

  it("少字节或SHA不符时不落盘、不complete", async () => {
    for (const patch of [{ size: bytes.length + 1 }, { sha256: "0".repeat(64) }]) {
      const fetcher = vi.fn(async () => stream()); vi.stubGlobal("fetch", fetcher);
      await expect(downloadPackage(parseManifest(manifest(patch))!, () => {})).rejects.toThrow(/完整|校验/);
      expect(fetcher).toHaveBeenCalledTimes(1); expect(flags.saved).toEqual([]);
    }
  });

  it("下载未登录不发请求；complete被拒绝时不能返回可安装成功路径", async () => {
    const fetcher = vi.fn(async (url: string) => url.endsWith("/complete") ? response({}, 403) : stream()); vi.stubGlobal("fetch", fetcher);
    flags.token = "";
    await expect(downloadPackage(parseManifest(manifest())!, () => {})).rejects.toThrow("暂时无法下载更新"); expect(fetcher).not.toHaveBeenCalled();
    flags.token = "synthetic-ultra-token";
    await expect(downloadPackage(parseManifest(manifest())!, () => {})).rejects.toThrow("下载确认未完成");
  });

  it("普通构建不接受Ultra，包名/公开更新仍按普通路线", async () => {
    flags.ultra = false;
    expect(parseManifest(manifest())).toBeNull(); expect(packageName("1.2.3")).toBe("Acorn_1.2.3.exe");
    const fetcher = vi.fn(async () => response({ available: false })); vi.stubGlobal("fetch", fetcher);
    expect(await fetchUpdate({ token: null })).toEqual({ ok: true, info: null });
    expect(fetcher.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual([`${BASE}/api/desktop/latest`]);
  });
});

describe("Ultra静默授权与缓存隔离", () => {
  it("手动检查不要求登录授权账号，开机与侧栏保持安静；网络失败仍保留原文案", async () => {
    flags.token = "";
    const { appStore } = await import("../src/core/store");
    appStore.setState({ ui: { ...appStore.getState().ui, toast: null } });
    expect(await checkUpdateNow()).toBe("unavailable");
    expect(updateFootState(updateStore.getState().lastCheck)).toBeNull();
    expect(updateFootState({ kind: "failed", reason: "auth" })).toBeNull();
    await checkUpdateOnBoot();
    expect(appStore.getState().ui.toast).toBeNull();
    expect(updateStore.getState().pending).toBeNull();
    flags.token = "synthetic-ultra-token"; vi.stubGlobal("fetch", () => Promise.reject(new TypeError("offline")));
    expect(await checkUpdateNow()).toBe("failed");
    expect(CHECK_FAILED_MSG).toContain("网络");
  });

  it("设置自动检查不显示授权提示，主动检查只给通用重试信息", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    flags.token = "";
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    await act(async () => root.render(createElement(UpdatePanel)));
    expect(host.textContent).not.toMatch(/登录|授权|Ultra|暂时无法|检测失败/);
    await act(async () => { (host.querySelector("button") as HTMLButtonElement).click(); });
    expect(host.textContent).toContain(CHECK_UNAVAILABLE_MSG);
    expect(host.textContent).not.toMatch(/登录|授权|Ultra/);
    act(() => root.unmount()); host.remove();
  });

  it("Ultra安装包/跳过版本/查询缓存隔离，首次启动历史沿用普通版，写入只走-ultra键", async () => {
    localStorage.setItem("acorn-update-ready", JSON.stringify({ version: "99.0.0", path: "normal.exe" }));
    localStorage.setItem("acorn-update-skip", "99.0.0");
    localStorage.setItem("acorn-last-version", "99.0.0");
    localStorage.setItem("acorn-update-last-check", JSON.stringify({ date: "2026-10-16", result: "latest", version: "99.0.0" }));
    vi.resetModules(); flags.ultra = true;
    const ctl = await import("../src/core/updateCtl");
    expect(ctl.readyPackageFor("99.0.0")).toBeNull(); expect(ctl.skippedVersion()).toBe(""); expect(ctl.readLastVersion()).toBe("99.0.0"); expect(ctl.updateStore.getState().memo).toBeNull();
    expect(ctl.updateStore.getState().firstRun).toBe("upgrade"); expect(ctl.updateStore.getState().prevVersion).toBe("99.0.0");
    ctl.rememberReadyPackage("99.0.0", "ultra.exe"); ctl.skipVersion("100.0.0"); ctl.rememberLaunch("100.0.0"); ctl.rememberCheck("found", "101.0.0", "2026-10-16");
    expect(JSON.parse(localStorage.getItem("acorn-update-ready-ultra")!).path).toBe("ultra.exe");
    expect(localStorage.getItem("acorn-update-skip-ultra")).toBe("100.0.0"); expect(localStorage.getItem("acorn-last-version-ultra")).toBe("100.0.0");
    expect(JSON.parse(localStorage.getItem("acorn-update-last-check-ultra")!).version).toBe("101.0.0");
    expect(JSON.parse(localStorage.getItem("acorn-update-ready")!).path).toBe("normal.exe"); expect(localStorage.getItem("acorn-update-skip")).toBe("99.0.0");
    expect(ctl.readLastVersion()).toBe("100.0.0");
    expect(localStorage.getItem("acorn-last-version")).toBe("99.0.0");
  });
});
