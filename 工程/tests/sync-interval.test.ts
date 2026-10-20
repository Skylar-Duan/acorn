import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { defaultData, DATA_VERSION, migrate, type Settings } from "../src/core/model";
import { appStore, flushSave, updateSettings } from "../src/core/store";
import { loadData } from "../src/core/persist";
import { mergeData } from "../src/core/merge";
import * as cloud from "../src/core/cloud";
import { adoptSession, autoPullIfDue, expireSession, requestSync, signOut, startAutoPull, stopAutoPull, syncNow, syncStore } from "../src/core/syncCtl";
import { SYNC_INTERVAL_CHOICES, syncIntervalMinutes, syncIntervalMs } from "../src/core/syncInterval";

vi.mock("../src/core/cloud", async original => ({
  ...await original<typeof import("../src/core/cloud")>(),
  syncOnce: vi.fn(async (_session, data) => ({ rev: 2, data, changed: false, summary: { added: 0, updated: 0, removed: 0 } })),
  whoAmI: vi.fn(async () => ({ email: "a@example.test", rev: 2, hasData: true })),
  saveSession: vi.fn(async () => {}),
}));

const identity = { token: "synthetic-a", email: "a@example.test", rev: 1, syncedAt: null };
const T0 = new Date("2026-10-20T05:00:00Z").getTime();
const settle = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
function interval(minutes: Settings["syncIntervalMinutes"]) {
  appStore.setState(state => ({ data: { ...state.data, settings: { ...state.data.settings, syncIntervalMinutes: minutes } } }));
}
function online(value: boolean) { Object.defineProperty(navigator, "onLine", { configurable: true, get: () => value }); }

beforeEach(async () => {
  await signOut(); await flushSave(); localStorage.clear(); vi.useFakeTimers(); vi.setSystemTime(T0);
  vi.mocked(cloud.syncOnce).mockClear(); vi.mocked(cloud.whoAmI).mockClear(); vi.mocked(cloud.saveSession).mockClear();
  appStore.setState({ data: defaultData(), loaded: true, loadError: null, rescue: null, wiped: false });
  syncStore.setState({ session: { ...identity }, phase: "idle", dirty: false, needsUpgrade: false, upgradeRetryAt: null });
  online(true);
});
afterEach(async () => { await signOut(); await settle(); await flushSave(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("local cloud check interval", () => {
  it.each(SYNC_INTERVAL_CHOICES)("$label waits the full period, then repeats once", async ({ minutes }) => {
    interval(minutes); startAutoPull(false); startAutoPull(false);
    await vi.advanceTimersByTimeAsync(minutes * 60000 - 1); expect(cloud.syncOnce).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(cloud.syncOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(minutes * 60000); expect(cloud.syncOnce).toHaveBeenCalledTimes(1); expect(cloud.whoAmI).toHaveBeenCalledTimes(1);
  });
  it("changing from a day to an hour replaces the pending timer immediately", async () => {
    interval(1440); startAutoPull(false); await vi.advanceTimersByTimeAsync(30 * 60000);
    interval(60); await vi.advanceTimersByTimeAsync(60 * 60000 - 1); expect(cloud.syncOnce).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(cloud.syncOnce).toHaveBeenCalledTimes(1);
    interval(360); await vi.advanceTimersByTimeAsync(5 * 3600000); expect(cloud.syncOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3600000); expect(cloud.syncOnce).toHaveBeenCalledTimes(2);
  });
  it("focus and visible events respect the selected hour instead of the old minute bypass", async () => {
    interval(60); await syncNow(); startAutoPull(false); vi.mocked(cloud.syncOnce).mockClear();
    await vi.advanceTimersByTimeAsync(5 * 60000); window.dispatchEvent(new Event("focus")); await settle();
    expect(cloud.whoAmI).not.toHaveBeenCalled(); expect(cloud.syncOnce).not.toHaveBeenCalled();
    vi.setSystemTime(T0 + 3600000); window.dispatchEvent(new Event("focus"));
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange")); await settle(); expect(cloud.whoAmI).toHaveBeenCalledTimes(1);
  });
  it("main's mobile-only ten-minute focus gate cannot block the independent desktop five-minute check", async () => {
    const main = readFileSync("src/main.tsx", "utf8");
    const begin = main.indexOf("const FOCUS_SYNC_GAP_MS");
    const lastLine = 'window.addEventListener("focus", onBackToApp);';
    const end = main.indexOf(lastLine, begin) + lastLine.length;
    const listeners: [EventTarget, string, EventListener][] = [];
    const subscribe = (target: EventTarget) => (type: string, listener: EventListener) => {
      target.addEventListener(type, listener); listeners.push([target, type, listener]);
    };
    const daily = vi.fn();
    new Function("isMobile", "dailySyncIfNeeded", "window", "document", main.slice(begin, end))(
      false, daily, { addEventListener: subscribe(window) }, { addEventListener: subscribe(document), visibilityState: "visible" },
    );
    try {
      await syncNow(); startAutoPull(false); vi.mocked(cloud.syncOnce).mockClear();
      vi.setSystemTime(T0 + 4 * 60000); window.dispatchEvent(new Event("focus")); await settle();
      expect(cloud.whoAmI).not.toHaveBeenCalled();
      vi.setSystemTime(T0 + 5 * 60000 + 1); window.dispatchEvent(new Event("focus")); await settle();
      expect(cloud.whoAmI).toHaveBeenCalledTimes(1); expect(daily).not.toHaveBeenCalled();
    } finally { for (const [target, type, listener] of listeners) target.removeEventListener(type, listener); }
  });
  it("offline checks remain quiet; coming back online can check when due", async () => {
    interval(60); startAutoPull(false); online(false); await vi.advanceTimersByTimeAsync(3600000);
    window.dispatchEvent(new Event("focus")); await settle(); expect(cloud.syncOnce).not.toHaveBeenCalled();
    expect(syncStore.getState().phase).toBe("idle"); online(true); window.dispatchEvent(new Event("focus"));
    await settle(); expect(cloud.syncOnce).toHaveBeenCalledTimes(1);
  });
  it("a failure is throttled for the selected period without throwing", async () => {
    interval(60); vi.mocked(cloud.syncOnce).mockRejectedValueOnce(new Error("synthetic offline"));
    await expect(autoPullIfDue()).resolves.toBe(true); expect(syncStore.getState().phase).toBe("error");
    vi.setSystemTime(T0 + 5 * 60000); expect(await autoPullIfDue()).toBe(false);
    vi.setSystemTime(T0 + 3600000); expect(await autoPullIfDue()).toBe(true);
  });
  it("manual sync and an edited local record still upload without waiting for a day", async () => {
    interval(1440); startAutoPull(false); await syncNow(); expect(cloud.syncOnce).toHaveBeenCalledTimes(1);
    requestSync(); await vi.advanceTimersByTimeAsync(3999); expect(cloud.syncOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(cloud.syncOnce).toHaveBeenCalledTimes(2);
  });
  it("a four-second edit upload moves the next check to one period after success rather than skipping to two periods", async () => {
    interval(60); startAutoPull(false); requestSync(); await vi.advanceTimersByTimeAsync(4000);
    expect(cloud.syncOnce).toHaveBeenCalledTimes(1); expect(cloud.whoAmI).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3600000 - 1); expect(cloud.whoAmI).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(cloud.whoAmI).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3600000); expect(cloud.whoAmI).toHaveBeenCalledTimes(2);
  });
  it("signing out removes the timer and pending edit before credential persistence completes", async () => {
    interval(60); startAutoPull(false); requestSync(); let finish!: () => void;
    vi.mocked(cloud.saveSession).mockImplementationOnce(() => new Promise(resolve => finish = resolve));
    const pending = signOut(); await vi.advanceTimersByTimeAsync(3600000); expect(cloud.syncOnce).not.toHaveBeenCalled();
    finish(); await pending;
  });
  it("expiry stops the timer before its pending credential write completes", async () => {
    interval(60); startAutoPull(false); let finish!: () => void;
    vi.mocked(cloud.saveSession).mockImplementationOnce(() => new Promise(resolve => finish = resolve));
    const pending = expireSession(); await vi.advanceTimersByTimeAsync(3600000); expect(cloud.syncOnce).not.toHaveBeenCalled(); finish(); await pending;
  });
  it("changing account cancels old edit and interval callbacks and starts a fresh period", async () => {
    interval(60); startAutoPull(false); requestSync(); await vi.advanceTimersByTimeAsync(1000);
    const replacement = { ...identity, email: "b@example.test", token: "synthetic-b" };
    await adoptSession(replacement, { sync: false }); vi.mocked(cloud.whoAmI).mockClear();
    await vi.advanceTimersByTimeAsync(3599999); expect(cloud.syncOnce).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(cloud.syncOnce).toHaveBeenCalledTimes(1);
    expect(vi.mocked(cloud.syncOnce).mock.calls[0][0].email).toBe(replacement.email);
  });
  it("a pending account credential save cannot keep an old timer or edit running", async () => {
    interval(60); startAutoPull(false); requestSync(); let finish!: () => void;
    vi.mocked(cloud.saveSession).mockImplementationOnce(() => new Promise(resolve => finish = resolve));
    const pending = adoptSession({ ...identity, token: "synthetic-b", email: "b@example.test" }, { sync: false });
    await vi.advanceTimersByTimeAsync(3600000); expect(cloud.syncOnce).not.toHaveBeenCalled();
    finish(); await pending;
  });
  it("a delayed periodic response cannot merge the old account into the replacement ledger", async () => {
    interval(60); startAutoPull(false); let finish!: (value: cloud.SyncOutcome) => void;
    vi.mocked(cloud.syncOnce).mockImplementationOnce(() => new Promise(resolve => finish = resolve));
    await vi.advanceTimersByTimeAsync(3600000); expect(cloud.syncOnce).toHaveBeenCalledTimes(1);
    await signOut(); const replacement = { ...identity, token: "synthetic-b", email: "b@example.test" };
    syncStore.setState({ session: replacement, phase: "idle" }); const nextBook = defaultData(); appStore.setState({ data: nextBook });
    vi.mocked(cloud.saveSession).mockClear(); const oldBook = defaultData();
    finish({ rev: 99, data: oldBook, changed: true, summary: { added: 1, updated: 0, removed: 0 } }); await settle();
    expect(appStore.getState().data).toBe(nextBook); expect(syncStore.getState().session).toBe(replacement);
    expect(cloud.saveSession).not.toHaveBeenCalled();
  });
  it("a wiped ledger loses its old timer, then a recovered ledger gets a fresh period", async () => {
    interval(60); startAutoPull(false); await vi.advanceTimersByTimeAsync(30 * 60000);
    appStore.setState({ wiped: true }); await vi.advanceTimersByTimeAsync(3600000); expect(cloud.syncOnce).not.toHaveBeenCalled();
    appStore.setState({ data: defaultData(), wiped: false }); interval(60);
    await vi.advanceTimersByTimeAsync(3600000 - 1); expect(cloud.syncOnce).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(cloud.syncOnce).toHaveBeenCalledTimes(1);
  });
  it("a pending edit from before a ledger reset cannot wake up on the recovered book", async () => {
    requestSync(); appStore.setState({ wiped: true }); appStore.setState({ wiped: false });
    await vi.advanceTimersByTimeAsync(4000); expect(cloud.syncOnce).not.toHaveBeenCalled();
  });
  it("unknown future values fall back to five minutes without deleting data; local choice persists and remains device-local", async () => {
    const raw = { ...defaultData(), futureField: { untouched: true }, settings: { ...defaultData().settings, syncIntervalMinutes: 19, futureSetting: "keep" } };
    const data = migrate(raw); expect(syncIntervalMinutes(data.settings)).toBe(5); expect(syncIntervalMs()).toBe(300000);
    expect((data.settings as unknown as Record<string, unknown>).syncIntervalMinutes).toBe(19);
    appStore.setState({ data }); updateSettings({ syncIntervalMinutes: 360 }); await flushSave();
    const saved = (await loadData()).data; expect(saved?.settings.syncIntervalMinutes).toBe(360);
    expect((saved as unknown as typeof raw).futureField).toEqual({ untouched: true });
    expect((saved?.settings as unknown as Record<string, unknown>).futureSetting).toBe("keep");
    const remote = defaultData(); remote.settings.syncIntervalMinutes = 1440;
    expect(mergeData(appStore.getState().data, remote).data.settings.syncIntervalMinutes).toBe(360);
    expect(DATA_VERSION).toBe(8);
  });
});
