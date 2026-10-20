// Legacy filename retained: Plus users now receive the exact same public app package.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
const flags = vi.hoisted(() => ({ token: "synthetic-session", saved: [] as string[] }));
vi.mock("../src/core/cloud", () => ({ API_BASE: "https://acorn.cdpandas.com", loadSession: async () => flags.token ? { token: flags.token, email: "demo@example.test" } : null }));
vi.mock("../src/core/persist", async (original) => ({ ...await original<typeof import("../src/core/persist")>(), inTauri: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (cmd: string, _data?: unknown, opts?: { headers?: Record<string, string> }) => {
  if (cmd === "save_download_raw") { const name = opts?.headers?.["acorn-file-name"] ?? ""; flags.saved.push(name); return "saved:" + name; }
  return null;
} }));
import { downloadPackage, fetchUpdate, packageName, parseManifest, type UpdateInfo } from "../src/core/updater";
import { CHECK_FAILED_MSG, checkUpdateNow, checkUpdateOnBoot, updateFootState, updateStore } from "../src/core/updateCtl";
import { createPlusController } from "../src/core/plus";
import UpdatePanel from "../src/components/UpdatePanel";
const BASE = "https://acorn.cdpandas.com";
const bytes = new TextEncoder().encode("Synthetic installer bytes");
const hash = createHash("sha256").update(bytes).digest("hex");
const manifest = (patch: Record<string, unknown> = {}) => ({ available: true, version: "99.0.0", schema: 8,
  url: `${BASE}/download/windows/Acorn_99.0.0_x64-setup.exe`, size: bytes.length, sha256: hash, notes: "合成更新", publishedAt: "2026-10-20T00:00:00Z", pageUrl: `${BASE}/intro/`, ...patch });
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);
function stream(content = bytes): Response {
  let read = false;
  return { ok: true, status: 200, headers: { get: () => String(content.length) }, body: { getReader: () => ({
    read: async () => read ? { done: true } : (read = true, { done: false, value: content }), cancel: async () => {},
  }) } } as unknown as Response;
}
beforeEach(() => {
  flags.token = "synthetic-session";flags.saved=[];localStorage.clear();
  vi.stubGlobal("crypto", webcrypto);vi.stubGlobal("fetch",vi.fn(async()=>response({available:false})));
  updateStore.setState({ pending: null, found: null, memo: null, lastCheck: null });
});
afterEach(() => { vi.unstubAllGlobals();vi.useRealTimers(); });

describe("Plus and non-Plus use one app update channel", () => {
  it("accepts the common public manifest and rejects old private-edition/ticket manifests", () => {
    expect(parseManifest(manifest())?.version).toBe("99.0.0");
    for(const patch of [{edition:"ultra"},{requiresAuth:true},{downloadId:"private-ticket"},{url:"https://other.example.test/app.exe"}])expect(parseManifest(manifest(patch))).toBeNull();
    expect(packageName("1.17.0")).toBe("Acorn_1.17.0.exe");
  });
  it("public latest is anonymous; only normal beta probing receives the session bearer", async () => {
    const fetcher=vi.fn(async(url:string)=>response(url.endsWith('/beta')?{available:false}:manifest()));vi.stubGlobal("fetch",fetcher);
    expect((await fetchUpdate()).ok).toBe(true);
    expect(fetcher.mock.calls.map(c=>c[0])).toEqual([`${BASE}/api/desktop/latest`,`${BASE}/api/desktop/beta`]);
    const calls=fetcher.mock.calls as unknown as [string,RequestInit][];
    expect(calls[0][1].headers).toBeUndefined();expect(calls[1][1].headers).toEqual({Authorization:"Bearer synthetic-session"});
  });
  it("signed-out users can check the same public updates without any entitlement request", async () => {
    flags.token="";const fetcher=vi.fn(async(_url:string)=>response(manifest()));vi.stubGlobal("fetch",fetcher);
    expect((await fetchUpdate()).ok).toBe(true);expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(`${BASE}/api/desktop/latest`);
  });
  it("newest authorized common beta is offered without changing Plus entitlement/cache", async () => {
    const values=new Map<string,string>();const plus=createPlusController({supported:()=>true,storage:()=>({getItem:k=>values.get(k)??null,setItem:(k,v)=>{values.set(k,v)}})});
    const identity={email:"demo@example.test",token:"synthetic-session"};plus.setSession(identity);plus.applyMetadata(identity.token,{email:identity.email,plus:true});
    const before=[...values];const fetcher=vi.fn(async(url:string)=>response(manifest({version:url.endsWith('/beta')?'99.0.1-beta.3':'99.0.0'})));vi.stubGlobal("fetch",fetcher);
    const result=await fetchUpdate();expect(result.ok&&result.info?.version).toBe("99.0.1-beta.3");expect(plus.store.getState().enabled).toBe(true);expect([...values]).toEqual(before);
  });
  it("download rejects an old private ticket even when parseManifest is bypassed", async () => {
    const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
    await expect(downloadPackage({...manifest(),edition:"ultra",requiresAuth:true,downloadId:"private"} as UpdateInfo,()=>{})).rejects.toThrow("版本类型");
    expect(fetcher).not.toHaveBeenCalled();expect(flags.saved).toEqual([]);
  });
  it("complete common bytes pass SHA then save once, with no bearer or download-confirm POST", async () => {
    const fetcher=vi.fn(async()=>stream());vi.stubGlobal("fetch",fetcher);const progress:number[]=[];
    expect(await downloadPackage(parseManifest(manifest())!,p=>progress.push(p.received))).toBe("saved:Acorn_99.0.0.exe");
    expect(flags.saved).toEqual(["Acorn_99.0.0.exe"]);expect(progress).toEqual([bytes.length]);expect(fetcher).toHaveBeenCalledTimes(1);
    const [url,init]=(fetcher.mock.calls as unknown as [string,RequestInit][])[0];expect(url).toBe(manifest().url);expect(init.headers).toBeUndefined();expect(init.method).toBeUndefined();
  });
  it("truncated, extra or invalid-SHA bytes never become an installable file", async () => {
    for(const patch of [{size:bytes.length+1},{size:bytes.length-1},{sha256:'0'.repeat(64)}]){
      const fetcher=vi.fn(async()=>stream());vi.stubGlobal("fetch",fetcher);
      await expect(downloadPackage(parseManifest(manifest(patch))!,()=>{})).rejects.toThrow(/完整|大小|校验/);expect(flags.saved).toEqual([]);
    }
  });
  it("network failure remains a failed check rather than claiming up-to-date or asking for Plus", async () => {
    flags.token="";vi.stubGlobal("fetch",()=>Promise.reject(new TypeError("offline")));
    expect(await checkUpdateNow()).toBe("failed");expect(CHECK_FAILED_MSG).toContain("网络");expect(updateFootState(updateStore.getState().lastCheck)?.text).toContain("失败");
  });
  it("ordinary signed-out boot checks public latest silently without an authorization gate", async () => {
    flags.token="";const fetcher=vi.fn(async()=>response({available:false}));vi.stubGlobal("fetch",fetcher);
    await checkUpdateOnBoot();expect(fetcher).toHaveBeenCalledTimes(1);expect(updateStore.getState().pending).toBeNull();
  });
  it("Settings update panel works for signed-out users and does not mention a separate Plus binary", async () => {
    (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;flags.token="";
    const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
    await act(async()=>root.render(createElement(UpdatePanel)));
    await act(async()=>{(host.querySelector('button') as HTMLButtonElement).click()});
    expect(host.textContent).not.toMatch(/登录|授权|Ultra|Plus/);expect(host.textContent).toMatch(/最新|已检查/);
    act(()=>root.unmount());host.remove();
  });
  it("legacy Ultra migration reads launch history only; common package/skip/check keys are shared", async () => {
    localStorage.setItem('acorn-last-version-ultra','1.16.1');localStorage.setItem('acorn-update-ready-ultra',JSON.stringify({version:'99.0.0',path:'private-old.exe'}));
    localStorage.setItem('acorn-update-skip-ultra','99.0.0');vi.resetModules();const ctl=await import('../src/core/updateCtl');
    expect(ctl.readLastVersion()).toBe('1.16.1');expect(ctl.readyPackageFor('99.0.0')).toBeNull();expect(ctl.skippedVersion()).toBe('');
    ctl.rememberReadyPackage('99.0.0','common.exe');ctl.skipVersion('100.0.0');ctl.rememberLaunch('1.17.0');ctl.rememberCheck('found','99.0.0','2026-10-20');
    expect(JSON.parse(localStorage.getItem('acorn-update-ready')!).path).toBe('common.exe');expect(localStorage.getItem('acorn-update-skip')).toBe('100.0.0');expect(ctl.readLastVersion()).toBe('1.17.0');
    expect(JSON.parse(localStorage.getItem('acorn-update-last-check')!).version).toBe('99.0.0');expect(JSON.parse(localStorage.getItem('acorn-update-ready-ultra')!).path).toBe('private-old.exe');
  });
});
