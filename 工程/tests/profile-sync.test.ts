// 名字和头像跟着账号走（v1.15.1）。
//
// 用户原话：手机上设了名字和头像，电脑上看不到。原来它们住在 settings 里，而设置不同步；
// 现在挪到账本顶层的 profiles（按账号邮箱分键），合并时每个账号那一条谁改得晚听谁的。
//
// 这一份钉六样：
//   ① 两端各改一次，谁新听谁的；一样新也得两边算出同一个答案；
//   ② 一端缺这一条（或整个 profiles 都没有）不覆盖另一端；
//   ③ 不认识的字段一个不丢（条目里的、顶层的），读 → 改别的 → 写回 → 还在；
//   ④ 旧字段 settings.profileName / profileAvatar 只迁一次、盖 1970 年的戳；
//   ⑤ 换账号不串号：A 的那张脸不会显示成 B 的，也不会盖掉 B 自己那条；
//   ⑥ 同步那一轮：事一条没变、光是头像从云端带回新的，也得装回本机。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { DATA_VERSION, defaultData, migrate, newTask } from "../src/core/model";
import type { AppData, Profile } from "../src/core/model";
import { mergeData, mergeProfiles } from "../src/core/merge";
import {
  AVATAR_MAX_CHARS,
  LEGACY_PROFILE_AT,
  adoptLegacyProfile,
  getProfile,
  profileKey,
  setProfileAvatar,
  setProfileName,
} from "../src/core/profile";
import { addTask, appStore, undo } from "../src/core/store";
import * as cloud from "../src/core/cloud";
import { adoptSession, signOut, syncNow, syncStore } from "../src/core/syncCtl";

vi.mock("../src/core/cloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/cloud")>();
  return {
    ...actual,
    syncOnce: vi.fn(),
    saveSession: vi.fn(async () => {}),
  };
});

const syncOnce = cloud.syncOnce as unknown as Mock;

const A = "bower@example.com";
const B = "zoe@example.cn";
/** 一张 10KB 上下的头像（真压出来的就是这个量级） */
const AVATAR_10K = `data:image/jpeg;base64,${"A".repeat(10 * 1024)}`;

function prof(name: string, updatedAt: string, extra: Record<string, unknown> = {}): Profile {
  return { name, avatar: "", updatedAt, ...extra } as Profile;
}

function withProfiles(profiles: AppData["profiles"] | undefined, base = defaultData()): AppData {
  const d = { ...base };
  if (profiles !== undefined) d.profiles = profiles;
  return d;
}

function loadIntoStore(data: AppData) {
  appStore.setState({ data, loaded: true, loadError: null, dataFromNewer: null, rescue: null });
}

// ---------------------------------------------------------------- ① 谁新听谁的

describe("两端各改一次：谁改得晚听谁的", () => {
  it("云端那条更新 → 听云端；本机那条更新 → 听本机", () => {
    const phone = prof("手机上改的", "2026-09-21T10:00:00.000Z");
    const desk = prof("电脑上改的", "2026-09-21T09:00:00.000Z");
    const k = profileKey(A);
    expect(mergeData(withProfiles({ [k]: desk }), withProfiles({ [k]: phone })).data.profiles?.[k]).toBe(phone);
    expect(mergeData(withProfiles({ [k]: phone }), withProfiles({ [k]: desk })).data.profiles?.[k]).toBe(phone);
  });

  it("一样新的时候两台设备算出同一个答案（不是各听各的，免得云端每轮翻一次面）", () => {
    const k = profileKey(A);
    const x = prof("甲", LEGACY_PROFILE_AT);
    const y = prof("乙", LEGACY_PROFILE_AT);
    const onX = mergeProfiles({ [k]: x }, { [k]: y })?.[k];
    const onY = mergeProfiles({ [k]: y }, { [k]: x })?.[k];
    expect(onX).toBe(onY);
  });

  it("两个账号各比各的，互不牵连", () => {
    const ka = profileKey(A);
    const kb = profileKey(B);
    const out = mergeProfiles(
      { [ka]: prof("A 新", "2026-09-21T10:00:00.000Z"), [kb]: prof("B 旧", "2026-09-01T00:00:00.000Z") },
      { [ka]: prof("A 旧", "2026-09-01T00:00:00.000Z"), [kb]: prof("B 新", "2026-09-21T10:00:00.000Z") },
    );
    expect(out?.[ka].name).toBe("A 新");
    expect(out?.[kb].name).toBe("B 新");
  });

  it("结果跟本机一模一样时原样返回本机那个对象（同步那边靠身份判断要不要装回来）", () => {
    const k = profileKey(A);
    const local = { [k]: prof("阿杜", "2026-09-21T10:00:00.000Z") };
    expect(mergeProfiles(local, { [k]: prof("旧的", "2026-09-01T00:00:00.000Z") })).toBe(local);
    expect(mergeProfiles(local, undefined)).toBe(local);
  });

  it("写入口每次盖新戳；这台设备的钟慢了也排在上一次后面", () => {
    const k = profileKey(A);
    loadIntoStore(withProfiles({ [k]: prof("旧", "2999-01-01T00:00:00.000Z") }));
    expect(setProfileName(A, "新")).toBe(true);
    const p = appStore.getState().data.profiles![k];
    expect(p.name).toBe("新");
    expect(p.updatedAt > "2999-01-01T00:00:00.000Z").toBe(true);
  });

  it("改成一模一样的不算改（不白白盖戳、不白推一轮）", () => {
    const k = profileKey(A);
    const data = withProfiles({ [k]: prof("阿杜", "2026-09-21T10:00:00.000Z") });
    loadIntoStore(data);
    expect(setProfileName(A, "  阿杜 ")).toBe(false);
    expect(appStore.getState().data).toBe(data);
  });
});

// ---------------------------------------------------------------- ② 缺失不覆盖

describe("一端缺这一条：缺失 = 没有信息，不覆盖另一端", () => {
  it("云端整个没有 profiles（老客户端推上去的那种）→ 本机那条原样留着", () => {
    const k = profileKey(A);
    const local = withProfiles({ [k]: prof("阿杜", "2026-09-21T10:00:00.000Z") });
    expect(mergeData(local, withProfiles(undefined)).data.profiles?.[k].name).toBe("阿杜");
  });

  it("本机没有 → 云端那条带回来（手机设的，电脑这边第一次同步就看得到）", () => {
    const k = profileKey(A);
    const remote = withProfiles({ [k]: prof("手机上设的", "2026-09-21T10:00:00.000Z", { avatar: AVATAR_10K }) });
    const got = mergeData(withProfiles(undefined), remote).data;
    expect(getProfile(got, A)).toEqual({ name: "手机上设的", avatar: AVATAR_10K });
  });

  it("两边都没有：合完连这个键都不加，老数据长相一个字不变", () => {
    const got = mergeData(withProfiles(undefined), withProfiles(undefined)).data;
    expect("profiles" in got).toBe(false);
  });

  it("一边那条形状不对（拿不来比）：不判它赢，也不扔掉它", () => {
    const k = profileKey(A);
    const good = prof("阿杜", "2026-09-21T10:00:00.000Z");
    expect(mergeProfiles({ [k]: good }, { [k]: { name: "坏的" } as never })?.[k]).toBe(good);
    const weird = { future: "shape" } as never;
    expect(mergeProfiles({ [k]: weird }, undefined)?.[k]).toBe(weird);
  });
});

// ---------------------------------------------------------------- ③ 不认识的字段

describe("不认识的字段一个不丢", () => {
  it("塞一个 futureField → 读进来 → 改名字 → 写回去 → 还在（条目里的和顶层的都在）", () => {
    const k = profileKey(A);
    const onDisk = JSON.stringify({
      ...defaultData(),
      futureTop: { keep: true },
      profiles: { [k]: { name: "阿杜", avatar: "", updatedAt: "2026-09-01T00:00:00.000Z", futureField: 42 } },
    });
    loadIntoStore(migrate(JSON.parse(onDisk)));
    setProfileName(A, "杜");
    const back = JSON.parse(JSON.stringify(appStore.getState().data));
    expect(back.profiles[k].name).toBe("杜");
    expect(back.profiles[k].futureField).toBe(42);
    expect(back.futureTop).toEqual({ keep: true });
  });

  it("赢家整条走：云端那条带着新字段赢了，新字段跟着来", () => {
    const k = profileKey(A);
    const got = mergeData(
      withProfiles({ [k]: prof("旧", "2026-09-01T00:00:00.000Z") }),
      withProfiles({ [k]: prof("新", "2026-09-21T00:00:00.000Z", { futureField: "x" }) }),
    ).data;
    expect((got.profiles?.[k] as unknown as { futureField: string }).futureField).toBe("x");
  });

  it("老客户端（v1.15.0，不认 profiles）读一遍、合一遍、推回去：这个键原样还在", () => {
    // 老客户端的两条路：migrate 顶层先铺开原对象；mergeData 顶层「先 remote 后 local」铺开。
    // 这里用现在的 migrate 顶着（那一段 v1.9.1 起就没变过），合并按老版本的铺法手写一遍
    const k = profileKey(A);
    const cloudData = withProfiles({ [k]: prof("手机上设的", "2026-09-21T10:00:00.000Z") });
    const oldLocal = migrate(JSON.parse(JSON.stringify(defaultData())));
    const oldMerged = { ...cloudData, ...oldLocal }; // 老版本本机没这个键 → 云端那条原样带走
    const pushed = migrate(JSON.parse(JSON.stringify(oldMerged)));
    expect(getProfile(pushed, A).name).toBe("手机上设的");
  });

  it("老客户端手里揣着一份旧的、把云端推回旧的：新版本下一轮按先后又推回新的，头像不丢", () => {
    const k = profileKey(A);
    const fresh = prof("新名字", "2026-09-21T10:00:00.000Z", { avatar: AVATAR_10K });
    const stale = prof("旧名字", "2026-09-01T00:00:00.000Z");
    const cloudAfterOld = { ...withProfiles({ [k]: fresh }), ...withProfiles({ [k]: stale }) }; // 老版本「同名听本机」
    expect(cloudAfterOld.profiles?.[k]).toBe(stale);
    const onNew = mergeData(withProfiles({ [k]: fresh }), cloudAfterOld).data;
    expect(onNew.profiles?.[k]).toBe(fresh);
  });

  it("DATA_VERSION 一个字不动", () => {
    expect(DATA_VERSION).toBe(8);
  });
});

// ---------------------------------------------------------------- ④ 旧字段迁移

describe("旧字段迁进来：只一次、盖 1970 年", () => {
  function legacy(name: string, avatar = ""): AppData {
    const d = defaultData();
    d.settings = { ...d.settings, profileName: name, profileAvatar: avatar };
    return d;
  }

  it("迁给此刻登录着的账号，戳是 1970 年，旧字段本身不删（老版本照旧靠它显示）", () => {
    const got = adoptLegacyProfile(legacy(" 阿杜 ", AVATAR_10K), A);
    expect(got.profiles?.[profileKey(A)]).toEqual({ name: "阿杜", avatar: AVATAR_10K, updatedAt: LEGACY_PROFILE_AT });
    expect(got.settings.profileName).toBe(" 阿杜 ");
  });

  it("任何一端的真实修改都盖得过它；对面完全没有时它又传得过去", () => {
    const k = profileKey(A);
    const moved = adoptLegacyProfile(legacy("旧名"), A);
    const real = withProfiles({ [k]: prof("另一台上改的", "2026-09-02T00:00:00.000Z") });
    expect(mergeData(moved, real).data.profiles?.[k].name).toBe("另一台上改的");
    expect(mergeData(real, moved).data.profiles?.[k].name).toBe("另一台上改的");
    expect(mergeData(withProfiles(undefined), moved).data.profiles?.[k].name).toBe("旧名");
  });

  it("不用迁就原样返回同一个对象：没登录、旧字段空着、已经有过任何一条", () => {
    const d1 = legacy("阿杜");
    expect(adoptLegacyProfile(d1, null)).toBe(d1);
    const d2 = legacy("");
    expect(adoptLegacyProfile(d2, A)).toBe(d2);
    const d3 = withProfiles({ [profileKey(B)]: prof("B", "2026-09-01T00:00:00.000Z") }, legacy("阿杜"));
    expect(adoptLegacyProfile(d3, A)).toBe(d3);
  });

  it("登录那一刻就迁（跟随后那一轮同步一起上云）", async () => {
    loadIntoStore(legacy("阿杜"));
    await adoptSession({ token: "t", email: A, rev: 0, syncedAt: null }, { sync: false });
    expect(getProfile(appStore.getState().data, A).name).toBe("阿杜");
    await signOut();
  });
});

// ---------------------------------------------------------------- ⑤ 不串号

describe("登出 / 换账号不串号", () => {
  it("只认当前账号那一条：A 的脸不会显示成 B 的；没登录什么都不显示", () => {
    const data = withProfiles({ [profileKey(A)]: prof("阿杜", "2026-09-21T00:00:00.000Z", { avatar: AVATAR_10K }) });
    expect(getProfile(data, A).avatar).toBe(AVATAR_10K);
    expect(getProfile(data, B)).toEqual({ name: "", avatar: "" });
    expect(getProfile(data, null)).toEqual({ name: "", avatar: "" });
  });

  it("退出 A 登上 B 再合并：A 那条盖不掉 B 自己那条，哪怕 A 那条更新", () => {
    const local = withProfiles({ [profileKey(A)]: prof("阿杜", "2026-09-21T10:00:00.000Z") });
    const bCloud = withProfiles({ [profileKey(B)]: prof("佐伊", "2026-09-01T00:00:00.000Z") });
    const got = mergeData(local, bCloud).data;
    expect(getProfile(got, B).name).toBe("佐伊");
  });

  it("B 的云端一条都没有：B 显示的是邮箱首字那一套，不是 A 的名字", () => {
    const local = withProfiles({ [profileKey(A)]: prof("阿杜", "2026-09-21T10:00:00.000Z") });
    const got = mergeData(local, withProfiles(undefined)).data;
    expect(getProfile(got, B).name).toBe("");
  });

  it("邮箱大小写、前后空格不分出两条", () => {
    const data = withProfiles({ [profileKey(A)]: prof("阿杜", "2026-09-21T00:00:00.000Z") });
    expect(getProfile(data, `  ${A.toUpperCase()} `).name).toBe("阿杜");
  });

  it("没登录不写（名字是账号的，不是这台设备的）", () => {
    const data = defaultData();
    loadIntoStore(data);
    expect(setProfileName(null, "阿杜")).toBe(false);
    expect(setProfileAvatar(undefined, AVATAR_10K)).toBe(false);
    expect(appStore.getState().data).toBe(data);
  });
});

// ---------------------------------------------------------------- 头像体积与撤销

describe("头像：体积有闸，撤销不连带", () => {
  it("10KB 的头像离 5MB 的同步额度差得远；超长的、不是图的一律不收", () => {
    loadIntoStore(defaultData());
    expect(setProfileAvatar(A, AVATAR_10K)).toBe(true);
    expect(JSON.stringify(appStore.getState().data).length).toBeLessThan(64 * 1024);
    expect(setProfileAvatar(A, `data:image/jpeg;base64,${"A".repeat(AVATAR_MAX_CHARS)}`)).toBe(false);
    expect(setProfileAvatar(A, "https://example.com/a.jpg")).toBe(false);
    expect(getProfile(appStore.getState().data, A).avatar).toBe(AVATAR_10K);
    expect(setProfileAvatar(A, "")).toBe(true); // 空串 = 不要头像了
  });

  it("换完头像再撤销一件事：事撤回去了，头像不跟着撤", () => {
    loadIntoStore(defaultData());
    addTask({ title: "对账" });
    setProfileAvatar(A, AVATAR_10K);
    undo();
    expect(appStore.getState().data.tasks).toHaveLength(0);
    expect(getProfile(appStore.getState().data, A).avatar).toBe(AVATAR_10K);
  });
});

// ---------------------------------------------------------------- ⑥ 同步那一轮

describe("同步那一轮：光是头像从云端带回新的，也要装回本机", () => {
  beforeEach(() => {
    syncOnce.mockReset();
    syncStore.setState({
      session: { token: "t", email: A, rev: 1, syncedAt: null },
      phase: "idle", message: "", dirty: false, needsUpgrade: false, upgradeRetryAt: null, lastAttemptAt: null,
    });
  });

  it("事一条没变（changed=false），profiles 换了 → 装回来", async () => {
    const local = defaultData();
    local.tasks = [newTask({ title: "对账" })];
    loadIntoStore(local);
    const merged = { ...local, profiles: { [profileKey(A)]: prof("手机上设的", "2026-09-21T10:00:00.000Z") } };
    syncOnce.mockResolvedValue({ rev: 2, data: merged, changed: false, summary: { added: 0, updated: 0, removed: 0 } });
    await syncNow();
    expect(getProfile(appStore.getState().data, A).name).toBe("手机上设的");
  });

  it("profiles 没变、事也没变：本机那份一个字不换（不白写一次盘）", async () => {
    const local = withProfiles({ [profileKey(A)]: prof("阿杜", "2026-09-21T10:00:00.000Z") });
    loadIntoStore(local);
    syncOnce.mockResolvedValue({
      rev: 2, data: { ...local }, changed: false, summary: { added: 0, updated: 0, removed: 0 },
    });
    await syncNow();
    expect(appStore.getState().data).toBe(local);
  });
});
