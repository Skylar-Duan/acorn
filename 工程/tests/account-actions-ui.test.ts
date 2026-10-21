import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/core/accountActions", () => ({ clearLocalAccountData: vi.fn(async () => {}), eraseAcornAccount: vi.fn(async () => ({ deleted: true, scope: "acorn" })) }));
const { releaseSyncHold } = vi.hoisted(() => ({ releaseSyncHold: vi.fn() }));
vi.mock("../src/core/syncCtl", async original => ({ ...await original<typeof import("../src/core/syncCtl")>(), signOut: vi.fn(async () => {}), holdAutoSync: vi.fn(async () => releaseSyncHold) }));
vi.mock("../src/core/wipe", async original => ({ ...await original<typeof import("../src/core/wipe")>(), restoreFromCloud: vi.fn(async () => ({ rev: 2, tasks: 1, backup: "synthetic-backup.json" })) }));
import AccountPanel from "../src/components/AccountPanel";
import { clearLocalAccountData, eraseAcornAccount } from "../src/core/accountActions";
import { signOut, syncStore } from "../src/core/syncCtl";
import { restoreFromCloud } from "../src/core/wipe";
import { appStore, flushSave } from "../src/core/store";
import { defaultData } from "../src/core/model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const identity = { token: "synthetic-owner", email: "synthetic@example.test", rev: 1, syncedAt: null };
let root: Root, host: HTMLDivElement;
const button = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent === label)!;
async function click(label: string) { await act(async () => { button(label).click(); }); }
const dialogMessage = () => host.ownerDocument.body.querySelector<HTMLElement>(".acct-confirm p")?.textContent ?? "";
async function decide(confirmed: boolean) { await act(async () => { document.body.querySelector<HTMLButtonElement>(confirmed ? ".acct-confirm-actions .danger" : "[data-account-confirm-cancel]")!.click(); }); }
beforeEach(async () => {
  await flushSave(); vi.clearAllMocks(); localStorage.clear();
  vi.stubGlobal("location", { reload: vi.fn() });
  appStore.setState({ data: defaultData(), loaded: true, loadError: null, rescue: null, wiped: false });
  syncStore.setState({ session: { ...identity }, phase: "idle", message: "已同步", dirty: false, needsUpgrade: false });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(AccountPanel)));
});
afterEach(async () => { act(() => root.unmount()); host.remove(); await flushSave(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("compact settings account actions and confirmations", () => {
  it("shows three visible action buttons and puts cloud download immediately before sync", () => {
    expect(Array.from(host.querySelectorAll('[aria-label="账号操作"] button')).map(item => item.textContent)).toEqual(["退出登录", "删除本地数据", "注销橡果账号"]);
    expect(host.querySelector('[aria-label="账号操作"] .ghost')).toBeNull();
    expect(Array.from(host.querySelectorAll(".acct-sync-actions button")).map(item => item.textContent)).toEqual(["云端下载", "立即同步"]);
    expect(host.querySelector("p.hint")).toBeNull(); expect(host.textContent).not.toContain("从云端覆盖"); expect(host.textContent).not.toContain("上次同步来自");
  });
  it("cancelling each of the three confirmation dialogs performs no action", async () => {
    for (const label of ["退出登录", "删除本地数据", "注销橡果账号"]) { await click(label); expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull(); await decide(false); }
    expect(signOut).not.toHaveBeenCalled();
    expect(clearLocalAccountData).not.toHaveBeenCalled(); expect(eraseAcornAccount).not.toHaveBeenCalled(); expect(location.reload).not.toHaveBeenCalled();
  });
  it("confirmed logout only signs out; the confirmation explicitly preserves the local book", async () => {
    await click("退出登录"); expect(dialogMessage()).toContain("本机数据保留"); await decide(true);
    expect(signOut).toHaveBeenCalledOnce();
    expect(clearLocalAccountData).not.toHaveBeenCalled(); expect(eraseAcornAccount).not.toHaveBeenCalled();
  });
  it("explicit local clear warns about logout and local-only images and does not call account deletion", async () => {
    await click("删除本地数据"); const message = dialogMessage(); await decide(true);
    for (const text of ["退出登录", "仅保存在本机的图片", "已同步到云端的内容保留", "未同步内容无法从云端找回"]) expect(message).toContain(text);
    expect(clearLocalAccountData).toHaveBeenCalledOnce(); expect(eraseAcornAccount).not.toHaveBeenCalled(); expect(location.reload).toHaveBeenCalledOnce();
  });
  it("account erasure confirmation explains exact Acorn/cloud/local scope and retained shared account", async () => {
    await click("注销橡果账号"); const message = dialogMessage(); await decide(true);
    for (const text of ["橡果云端", "反馈", "Plus授权", "申请、下载", "仅保存在本机的图片", "cdpandas统一账号保留", "服务器访问日志", "独立备份"]) expect(message).toContain(text);
    expect(eraseAcornAccount).toHaveBeenCalledOnce(); expect(location.reload).toHaveBeenCalledOnce();
  });
  it("a confirmation opened for an old account cannot delete after account replacement", async () => {
    await click("删除本地数据");
    await act(async () => { syncStore.setState({ session: { ...identity, token: "synthetic-replacement", email: "other@example.test" } }); });
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(clearLocalAccountData).not.toHaveBeenCalled(); expect(location.reload).not.toHaveBeenCalled();
  });
  it("rapid repeated clicks cannot submit the destructive operation twice", async () => {
    let finish!: () => void;
    vi.mocked(clearLocalAccountData).mockImplementationOnce(() => new Promise(resolve => finish = resolve));
    await click("删除本地数据"); await decide(true);
    expect(clearLocalAccountData).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });
  it("cloud download still confirms replacement and errors stay concise without claiming completion", async () => {
    vi.mocked(restoreFromCloud).mockRejectedValueOnce(new Error("synthetic download failed"));
    await click("云端下载"); expect(dialogMessage()).toContain("替换本机账本"); await decide(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("synthetic download failed"); expect(location.reload).not.toHaveBeenCalled();
  });
  it("leaving settings cancels pending download confirmation and releases the auto-sync hold", async () => {
    await click("云端下载");
    await act(async () => { root.render(createElement("div")); });
    expect(releaseSyncHold).toHaveBeenCalledOnce();
    expect(restoreFromCloud).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
  });
  it("Escape cancels only the dialog and does not reach application shortcuts", async () => {
    await click("注销橡果账号");
    const globalHandler = vi.fn();
    document.addEventListener("keydown", globalHandler);
    await act(async () => { document.querySelector(".acct-confirm button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    document.removeEventListener("keydown", globalHandler);
    expect(globalHandler).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(eraseAcornAccount).not.toHaveBeenCalled();
  });
});
