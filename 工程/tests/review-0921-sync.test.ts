// 9-21 那批（9c66f1a0）复核后修的同步 / 账号那几条：
//   ① 云端只改了清单（名字 / 颜色 / 顺序 / 删掉）、墓碑、专注记录，本机也要装回来
//   ② 「从云端覆盖本机」、登录挑档案那一段，后台自动取不许插进来合并
//   ③ 账号面板的名字草稿跟着同步来的新名字走，没改过关面板不写
//   ④ 面板开着按 Esc 只关面板，不连带收卡片、清多选
//   ⑤ 旧字段迁移：电脑先改了名字，手机的旧头像留得住
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { readFileSync } from "node:fs";
import { defaultData, newTask } from "../src/core/model";
import type { AppData, Profile } from "../src/core/model";
import { LEGACY_PROFILE_AT, mergeData, sideDataChanged } from "../src/core/merge";
import { adoptLegacyProfile, getProfile, profileKey } from "../src/core/profile";
import { appStore, clearUndo, flushSave, setProfiles } from "../src/core/store";
import * as cloud from "../src/core/cloud";
import {
  autoPullIfDue, autoSyncHeld, holdAutoSync, signOut, stopAutoPull, syncNow, syncStore,
} from "../src/core/syncCtl";
import { restoreFromCloud } from "../src/core/wipe";
import AccountCorner from "../src/components/AccountPopover";

vi.mock("../src/core/cloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/cloud")>();
  return { ...actual, syncOnce: vi.fn(), pullOnly: vi.fn(), saveSession: vi.fn(async () => {}) };
});
vi.mock("../src/core/persist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/persist")>();
  return { ...actual, snapshotBackup: vi.fn(async () => "pre-restore-x.json") };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const syncOnce = cloud.syncOnce as unknown as Mock;
const pullOnly = cloud.pullOnly as unknown as Mock;
const A = "bower@example.com";

function signedIn() {
  syncStore.setState({
    session: { token: "t", email: A, rev: 1, syncedAt: null },
    phase: "idle", message: "", dirty: false, needsUpgrade: false, upgradeRetryAt: null, lastAttemptAt: null,
  });
}

/** 云端 = remote：syncOnce 照真的合一遍，changed 只看「事」（跟 cloud.syncOnce 一个口径） */
function cloudHas(remote: AppData) {
  syncOnce.mockImplementation(async (_s: unknown, local: AppData) => {
    const m = mergeData(local, remote);
    const { added, updated, removed } = m.summary;
    return { rev: 2, data: m.data, changed: added + updated + removed > 0, summary: m.summary };
  });
}

beforeEach(async () => {
  vi.useRealTimers();
  await flushSave();
  clearUndo();
  localStorage.clear();
  syncOnce.mockReset();
  pullOnly.mockReset();
  stopAutoPull();
  appStore.setState({ data: defaultData(), loaded: true, loadError: null, dataFromNewer: null, rescue: null });
  signedIn();
});

afterEach(async () => {
  await signOut();
});

// ---------------------------------------------------------------- ①

describe("① 云端只改了清单，本机也装回来", () => {
  function twoSides() {
    const local = defaultData();
    const work = { ...defaultData().lists[0], name: "工作", updatedAt: "2026-09-20T00:00:00.000Z" };
    local.lists = [work];
    local.tasks = [newTask({ title: "一件事" })];
    const remote: AppData = { ...local, lists: [{ ...work, name: "公司", updatedAt: "2026-09-21T08:00:00.000Z" }] };
    return { local, remote };
  }

  it("sideDataChanged：只改名 / 只删清单 / 多一条专注记录都算变了；一模一样不算", () => {
    const { local, remote } = twoSides();
    expect(sideDataChanged(mergeData(local, remote).data, local)).toBe(true);
    expect(sideDataChanged(mergeData(local, local).data, local)).toBe(false);
    const gone: AppData = { ...local, lists: [], graveyard: [{ id: local.lists[0].id, at: "2026-09-21T09:00:00.000Z" }] };
    expect(sideDataChanged(mergeData(local, gone).data, local)).toBe(true);
    const focused: AppData = { ...local, sessions: [{ taskId: null, startedAt: "2026-09-21T01:00:00.000Z", minutes: 25 }] as AppData["sessions"] };
    expect(sideDataChanged(mergeData(local, focused).data, local)).toBe(true);
  });

  it("syncNow 之后本机那张清单名字跟着变成「公司」", async () => {
    const { local, remote } = twoSides();
    appStore.setState({ data: local });
    cloudHas(remote);
    await syncNow();
    expect(appStore.getState().data.lists.map((l) => l.name)).toEqual(["公司"]);
  });

  it("云端删掉的空清单，本机也没了", async () => {
    const { local } = twoSides();
    appStore.setState({ data: local });
    cloudHas({ ...local, lists: [], graveyard: [{ id: local.lists[0].id, at: "2026-09-21T09:00:00.000Z" }] });
    await syncNow();
    expect(appStore.getState().data.lists).toEqual([]);
  });
});

// ---------------------------------------------------------------- ②

describe("② 覆盖 / 登录挑档案那一段挡住后台同步", () => {
  it("holdAutoSync 期间自动取不发；放行后照常", async () => {
    const release = await holdAutoSync();
    expect(autoSyncHeld()).toBe(true);
    expect(await autoPullIfDue()).toBe(false);
    expect(syncOnce).not.toHaveBeenCalled();
    release();
    release(); // 多调只算一次
    expect(autoSyncHeld()).toBe(false);
    cloudHas(defaultData());
    expect(await autoPullIfDue()).toBe(true);
  });

  it("restoreFromCloud 拉取那段工夫里窗口拿回焦点：自动取不发，覆盖照常", async () => {
    const local = defaultData();
    local.tasks = [newTask({ title: "要丢的本机那条" })];
    appStore.setState({ data: local });
    const remote = defaultData();
    remote.tasks = [newTask({ title: "云端那条" })];
    let resolvePull!: (v: unknown) => void;
    pullOnly.mockImplementation(() => new Promise((r) => { resolvePull = r; }));
    const p = restoreFromCloud();
    await Promise.resolve();
    await Promise.resolve();
    expect(autoSyncHeld()).toBe(true);
    expect(await autoPullIfDue()).toBe(false);
    resolvePull({ rev: 5, data: remote, updatedAt: null });
    await p;
    expect(syncOnce).not.toHaveBeenCalled();
    expect(appStore.getState().data.tasks.map((t) => t.title)).toEqual(["云端那条"]);
    expect(autoSyncHeld()).toBe(false);
  });

  it("源码：确认框那一步、登录挑档案那一段都挡着", () => {
    const panel = readFileSync("src/components/AccountPanel.tsx", "utf8");
    const restore = panel.slice(panel.indexOf("const doRestoreFromCloud"), panel.indexOf("if (session && step === \"signedIn\")"));
    expect(restore.indexOf("holdAutoSync()")).toBeGreaterThan(-1);
    expect(restore.indexOf("holdAutoSync()")).toBeLessThan(restore.indexOf("await ask("));
    const login = readFileSync("src/core/loginCtl.ts", "utf8");
    expect(login.indexOf("holdAutoSync()")).toBeGreaterThan(-1);
    expect(login.indexOf("holdAutoSync()")).toBeLessThan(login.indexOf("await adoptSession(session, { sync: false })"));
  });
});

// ---------------------------------------------------------------- ③ ④

const roots: Root[] = [];
function render(): HTMLDivElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(AccountCorner)));
  roots.push(root);
  return host;
}
const prof = (name: string, updatedAt: string, avatar = ""): Profile => ({ name, avatar, updatedAt });
const k = profileKey(A);
const nameNow = () => getProfile(appStore.getState().data, A).name;

describe("③ ④ 桌面账号面板", () => {
  afterEach(() => {
    act(() => roots.splice(0).forEach((r) => r.unmount()));
    document.body.innerHTML = "";
  });

  function openPanel(host: HTMLDivElement) {
    act(() => host.querySelector<HTMLButtonElement>(".acct-fab")!.click());
    return host.querySelector<HTMLInputElement>(".acct-pop-name")!;
  }

  it("面板开着时同步带回新名字：框里跟着变；什么都没输入就关面板，新名字不被旧名字盖回去", () => {
    act(() => setProfiles({ [k]: prof("旧名", "2026-09-21T00:00:00.000Z") }));
    const host = render();
    const input = openPanel(host);
    expect(input.value).toBe("旧名");
    act(() => setProfiles({ [k]: prof("新名", "2026-09-21T09:00:00.000Z") }));
    expect(input.value).toBe("新名");
    act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(host.querySelector(".acct-pop")).toBeNull();
    expect(nameNow()).toBe("新名");
    expect((appStore.getState().data.profiles![k] as Profile).updatedAt).toBe("2026-09-21T09:00:00.000Z");
  });

  it("首轮同步还没回来就打开（名字空着），名字回来以后关面板：不会被清空", () => {
    act(() => setProfiles({}));
    const host = render();
    openPanel(host);
    act(() => setProfiles({ [k]: prof("B", "2026-09-21T09:00:00.000Z") }));
    act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(nameNow()).toBe("B");
  });

  it("真改了的照存", () => {
    act(() => setProfiles({ [k]: prof("旧名", "2026-09-21T00:00:00.000Z") }));
    const host = render();
    const input = openPanel(host);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "我改的");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(nameNow()).toBe("我改的");
  });

  it("按 Esc 只关面板：document 上别的 Esc 监听（App 快捷键、展开的任务卡）收不到这一下", () => {
    act(() => setProfiles({ [k]: prof("旧名", "2026-09-21T00:00:00.000Z") }));
    const host = render();
    openPanel(host);
    const other = vi.fn();
    document.addEventListener("keydown", other);
    act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    document.removeEventListener("keydown", other);
    expect(host.querySelector(".acct-pop")).toBeNull();
    expect(other).not.toHaveBeenCalled();
  });

  it("名字框里改了一半按 Esc：退回字、面板不关", () => {
    act(() => setProfiles({ [k]: prof("旧名", "2026-09-21T00:00:00.000Z") }));
    const host = render();
    const input = openPanel(host);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "改一半");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.querySelector(".acct-pop")).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>(".acct-pop-name")!.value).toBe("旧名");
  });

  it("手机账号纸用同一份草稿（没改过不写）", () => {
    const sheet = readFileSync("src/mobile/AccountSheet.tsx", "utf8");
    expect(sheet).toContain("useNameDraft(profileName");
    expect(sheet).not.toContain("useState(profileName)");
  });
});

// ---------------------------------------------------------------- ⑤

describe("⑤ 旧字段迁移：电脑先改了名字，手机的旧头像留得住", () => {
  const IMG = "data:image/jpeg;base64,xxxx";
  function phone(profiles?: AppData["profiles"]): AppData {
    const d = defaultData();
    d.settings = { ...d.settings, profileName: "小D", profileAvatar: IMG };
    if (profiles) d.profiles = profiles;
    return d;
  }
  const desk = prof("Skylar", "2026-09-21T09:00:00.000Z");

  it("手机升级前没同步过：迁出 1970 那条，合并时电脑的名字赢、手机的头像补上，两边算出同一条", () => {
    const moved = adoptLegacyProfile(phone(), A);
    expect((moved.profiles![k] as Profile).updatedAt).toBe(LEGACY_PROFILE_AT);
    const cloudSide: AppData = { ...defaultData(), profiles: { [k]: desk } };
    const a = mergeData(moved, cloudSide).data.profiles![k] as Profile;
    const b = mergeData(cloudSide, moved).data.profiles![k] as Profile;
    expect(a.name).toBe("Skylar");
    expect(a.avatar).toBe(IMG);
    expect(b).toEqual(a);
    // 戳往后挪了一下：还揣着空头像那条的电脑下一轮直接收下
    expect(a.updatedAt > desk.updatedAt).toBe(true);
    expect((mergeData({ ...defaultData(), profiles: { [k]: desk } }, { ...defaultData(), profiles: { [k]: a } }).data.profiles![k] as Profile).avatar).toBe(IMG);
  });

  it("老版本已经把云端的 profiles 带回本机（电脑那条头像空着）：迁移逐字段补上头像，不整体跳过", () => {
    const got = adoptLegacyProfile(phone({ [k]: desk }), A);
    const p = got.profiles![k] as Profile;
    expect(p.name).toBe("Skylar");
    expect(p.avatar).toBe(IMG);
    expect(got.settings.legacyProfileDone).toEqual([k]);
  });

  it("只迁一次：迁过以后用户自己清掉头像，下次打开不再被旧字段补回来", () => {
    const once = adoptLegacyProfile(phone({ [k]: desk }), A);
    const cleared: AppData = { ...once, profiles: { [k]: prof("Skylar", "2026-09-22T00:00:00.000Z") } };
    expect(adoptLegacyProfile(cleared, A)).toBe(cleared);
  });

  it("两边都是真实修改时照旧整条听新的（空头像不补）", () => {
    const older = prof("旧", "2026-09-01T00:00:00.000Z", IMG);
    const got = mergeData({ ...defaultData(), profiles: { [k]: older } }, { ...defaultData(), profiles: { [k]: desk } }).data.profiles![k];
    expect(got).toBe(desk);
  });
});
