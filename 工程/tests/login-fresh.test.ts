// 登录那一刻本机数据怎么办 + 首次启动的两个判据。
//
// 起因（用户 2026-09-02 在手机上第一次装 v1.10.1 之后的三条反馈）：
// ①「登录后，已经有的东西应该全部删除，这里两个『工作』的分类肯定不行」
//    —— 新装的橡果自带「工作 / 生活」，一登录跟云端一合就出现两个「工作」；
// ②「下载后没有检查更新的消息框」—— 查过版本却什么都不说；
// ③ 登录入口要从设置页里挪出来，首启该主动请人登录。
//
// 这一份钉的是判据本身。**下游动作是整份覆盖本机数据**，判松一点就是真丢数据，
// 所以每个分支都得有用例，尤其是那些「不算全新」的分支——它们才是保命的那一半。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import appSource from "../src/App.tsx?raw";
import sidebarSource from "../src/components/Sidebar.tsx?raw";
import accountPanelSource from "../src/components/AccountPanel.tsx?raw";
import authFlowSource from "../src/core/useAuthFlow.ts?raw";
import { defaultData, newTask } from "../src/core/model";
import type { AppData, List, Task } from "../src/core/model";
import { appStore, clearUndo, flushSave } from "../src/core/store";
import * as cloud from "../src/core/cloud";
import * as persist from "../src/core/persist";
import { signOut, syncStore } from "../src/core/syncCtl";
import {
  dedupeListsByName, dedupeSameTasks, keepLocalOverCloud, mergeData,
} from "../src/core/merge";
import {
  DEFAULT_LIST_NAMES, LOGIN_LATER_KEY, isLoginLater, isPristineLocal, markLoginLater,
  planLoginData, shouldOfferLogin,
} from "../src/core/fresh";
import { signInWithLocalData, summarizeProfile } from "../src/core/loginCtl";
import type { LoginAsk } from "../src/core/loginCtl";
import {
  firstRunKind, readLastVersion, rememberLaunch, updateFootState,
} from "../src/core/updateCtl";

vi.mock("../src/core/cloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/cloud")>();
  return {
    ...actual,
    syncOnce: vi.fn(),
    pullOnly: vi.fn(),
    whoAmI: vi.fn(),
    saveSession: vi.fn(async () => {}),
  };
});

vi.mock("../src/core/persist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/persist")>();
  return { ...actual, snapshotBackup: vi.fn(async () => "pre-restore-20260902-101010.json") };
});

const syncOnce = cloud.syncOnce as unknown as Mock;
const pullOnly = cloud.pullOnly as unknown as Mock;
const whoAmI = cloud.whoAmI as unknown as Mock;

const SESSION: cloud.Session = { token: "tok", email: "a@b.c", rev: 3, syncedAt: null };
const OLD = "2026-01-01T00:00:00.000Z";

function list(id: string, name: string, order: number, updatedAt = OLD): List {
  return { id, name, color: "clay", order, updatedAt };
}

function task(id: string, title: string, listId: string | null, extra: Partial<Task> = {}): Task {
  return { ...newTask({ title }), id, listId, updatedAt: OLD, ...extra };
}

/** 刚装好、一个字都没记过的样子 */
function brandNew(): AppData {
  return defaultData();
}

// ---------------------------------------------------------------- A · 全新判据

describe("A · 本机是不是「全新的」（宁可判严不判松）", () => {
  it("刚装好，只有默认那两条清单：算全新", () => {
    expect(isPristineLocal({ data: brandNew(), everSynced: false })).toBe(true);
  });

  it("默认清单名就是「工作 / 生活」——判据跟着 defaultData 走，不写死", () => {
    expect([...DEFAULT_LIST_NAMES]).toEqual(["工作", "生活"]);
  });

  it("记过一条事：不算全新，绝不覆盖", () => {
    const d = brandNew();
    d.tasks = [task("t1", "交周报", null)];
    expect(isPristineLocal({ data: d, everSynced: false })).toBe(false);
  });

  it("那条事已经在回收站里：照样不算——回收站里的东西也是用户的东西", () => {
    const d = brandNew();
    d.tasks = [task("t1", "删掉的事", null, { deletedAt: OLD })];
    expect(isPristineLocal({ data: d, everSynced: false })).toBe(false);
  });

  it("那条是习惯：照样不算", () => {
    const d = brandNew();
    d.tasks = [task("t1", "每天喝水", null, { kind: "habit", checkIns: ["2026-09-01"] })];
    expect(isPristineLocal({ data: d, everSynced: false })).toBe(false);
  });

  it("默认清单被改过名：不算——改过名就是用过", () => {
    const d = brandNew();
    d.lists = [list("a", "公司", 0), list("b", "生活", 1)];
    expect(isPristineLocal({ data: d, everSynced: false })).toBe(false);
  });

  it("自己多建了一条清单：不算", () => {
    const d = brandNew();
    d.lists = [...d.lists, list("c", "读书", 2)];
    expect(isPristineLocal({ data: d, everSynced: false })).toBe(false);
  });

  it("自己删掉了一条默认清单：不算——留下的那条是他挑过的", () => {
    const d = brandNew();
    d.lists = [d.lists[0]];
    expect(isPristineLocal({ data: d, everSynced: false })).toBe(false);
  });

  it("清单一条都没有：算全新——那正是「清空本机」之后那一次启动的样子", () => {
    const d = brandNew();
    d.lists = [];
    expect(isPristineLocal({ data: d, everSynced: false })).toBe(true);
  });

  it("有专注记录：不算", () => {
    const d = brandNew();
    d.sessions = [{ taskId: null, date: "2026-09-01", minutes: 25, startedAt: OLD }];
    expect(isPristineLocal({ data: d, everSynced: false })).toBe(false);
  });

  it("墓碑里有东西（彻底删过）：不算", () => {
    const d = brandNew();
    d.graveyard = [{ id: "gone", at: OLD }];
    expect(isPristineLocal({ data: d, everSynced: false })).toBe(false);
  });

  it("排过需求方顺序：不算——需求方不是记录，但排过就是用过", () => {
    const d = brandNew();
    d.settings = { ...d.settings, whoOrder: ["李哥"] };
    expect(isPristineLocal({ data: d, everSynced: false })).toBe(false);
  });

  it("这台设备成功同步过：一律不算，哪怕现在看着是空的", () => {
    expect(isPristineLocal({ data: brandNew(), everSynced: true })).toBe(false);
  });
});

describe("A · 登录时的处置决策表", () => {
  it("本机全新 + 云端有内容 → 覆盖", () => {
    expect(planLoginData({ pristine: true, cloudHasData: true })).toBe("replace");
  });

  it("本机有内容 + 云端有内容 → 问用户", () => {
    expect(planLoginData({ pristine: false, cloudHasData: true })).toBe("ask");
  });

  it("云端是空的 → 一律合并，不问也不覆盖（第一台设备开账号就是这样）", () => {
    expect(planLoginData({ pristine: true, cloudHasData: false })).toBe("merge");
    expect(planLoginData({ pristine: false, cloudHasData: false })).toBe("merge");
  });
});

// ------------------------------------------------------- A · 同名清单去重

describe("A · 同名清单去重", () => {
  const AT = "2026-09-02T10:00:00.000Z";

  it("两条「工作」并成一条，任务全归到留下的那条名下", () => {
    const d: AppData = {
      ...brandNew(),
      lists: [list("cloud", "工作", 0), list("local", "工作", 1)],
      tasks: [task("t1", "云端的事", "cloud"), task("t2", "本机的事", "local")],
    };
    const out = dedupeListsByName(d, AT);
    expect(out.folded).toBe(1);
    expect(out.moved).toBe(1);
    expect(out.data.lists.map((l) => l.name)).toEqual(["工作"]);
    expect(out.data.tasks.map((t) => t.listId)).toEqual(["cloud", "cloud"]);
  });

  it("留下的是任务多的那条——空的默认清单不该让所有任务集体搬家", () => {
    const d: AppData = {
      ...brandNew(),
      // 空的那条更「老」，但它是空的：任务多的那条赢
      lists: [list("empty", "工作", 0, "2020-01-01T00:00:00.000Z"), list("used", "工作", 1)],
      tasks: [task("t1", "甲", "used"), task("t2", "乙", "used")],
    };
    const out = dedupeListsByName(d, AT);
    expect(out.data.lists.map((l) => l.id)).toEqual(["used"]);
    expect(out.moved).toBe(0); // 一条任务都不用搬
  });

  it("任务一样多就留老的——老的那条的颜色和位置是用户排过的", () => {
    const d: AppData = {
      ...brandNew(),
      lists: [
        list("new", "工作", 0, "2026-08-01T00:00:00.000Z"),
        list("old", "工作", 1, "2025-01-01T00:00:00.000Z"),
      ],
      tasks: [],
    };
    expect(dedupeListsByName(d, AT).data.lists.map((l) => l.id)).toEqual(["old"]);
  });

  it("剩下的清单顺序一个字没动：用户看见的只是少了重复那条", () => {
    const d: AppData = {
      ...brandNew(),
      lists: [list("a", "工作", 0), list("b", "生活", 1), list("c", "工作", 2), list("e", "读书", 3)],
      tasks: [task("t1", "甲", "c")],
    };
    // c 有任务所以 c 留下、a 被折掉；剩下三条的先后原样
    expect(dedupeListsByName(d, AT).data.lists.map((l) => l.id)).toEqual(["b", "c", "e"]);
  });

  it("被改挂的任务重新盖了改动时刻戳——不盖的话别的设备手里那份会赢，listId 指向一条已经不存在的清单", () => {
    const d: AppData = {
      ...brandNew(),
      lists: [list("keep", "工作", 0), list("gone", "工作", 1)],
      // keep 名下两条、gone 名下一条 → keep 留下，gone 被折掉
      tasks: [
        task("still", "没动的", "keep"), task("still2", "也没动", "keep"),
        task("moved", "搬过来的", "gone"),
      ],
    };
    const out = dedupeListsByName(d, AT);
    expect(out.data.lists.map((l) => l.id)).toEqual(["keep"]);
    expect(out.data.tasks.find((t) => t.id === "moved")!.updatedAt).toBe(AT);
    // 没动的那条不许被顺手盖戳，否则一次登录把整库标成「本机刚改过」
    expect(out.data.tasks.find((t) => t.id === "still")!.updatedAt).toBe(OLD);
  });

  it("被折掉的那条立墓碑：别的设备同步过来也不会把它拉回去", () => {
    const now = new Date().toISOString();
    const d: AppData = {
      ...brandNew(),
      lists: [list("keep", "工作", 0), list("gone", "工作", 1)],
      // 任务都挂在 keep 名下 → 空着的 gone 被折掉
      tasks: [task("t1", "甲", "keep")],
    };
    const cleaned = dedupeListsByName(d, now).data;
    expect(cleaned.graveyard.map((g) => g.id)).toEqual(["gone"]);
    // 另一台设备手里还揣着被折掉那条：合并之后它不许复活
    const stale: AppData = { ...brandNew(), lists: [list("gone", "工作", 1)], tasks: [] };
    const merged = mergeData(cleaned, stale).data;
    expect(merged.lists.map((l) => l.id)).toEqual(["keep"]);
  });

  it("三条同名也只留一条", () => {
    const d: AppData = {
      ...brandNew(),
      lists: [list("a", "工作", 0), list("b", "工作", 1), list("c", "工作", 2)],
      tasks: [task("t1", "甲", "b"), task("t2", "乙", "c")],
    };
    const out = dedupeListsByName(d, AT);
    expect(out.folded).toBe(2);
    expect(out.data.lists).toHaveLength(1);
    expect(new Set(out.data.tasks.map((t) => t.listId)).size).toBe(1);
  });

  it("名字前后有空格算同一个——用户看见的是一样的两条", () => {
    const d: AppData = {
      ...brandNew(),
      lists: [list("a", "工作", 0), list("b", " 工作 ", 1)],
      tasks: [],
    };
    expect(dedupeListsByName(d, AT).folded).toBe(1);
  });

  it("没有重名时原样返回同一个对象——同步那边靠对象身份判断动没动过，不能白推一轮", () => {
    const d = brandNew();
    const out = dedupeListsByName(d, AT);
    expect(out.data).toBe(d);
    expect(out.folded).toBe(0);
  });

  it("随手记（listId 为 null）的事一条都不受影响", () => {
    const d: AppData = {
      ...brandNew(),
      lists: [list("a", "工作", 0), list("b", "工作", 1)],
      tasks: [task("t1", "随手记的", null)],
    };
    const out = dedupeListsByName(d, AT);
    expect(out.data.tasks[0].listId).toBeNull();
    expect(out.data.tasks[0].updatedAt).toBe(OLD);
  });
});

// ------------------------------------------------------- A · 两份档案的门面数

describe("A · 档案摘要（摆给用户看的三个数）", () => {
  it("数的是还活着的事、清单条数，和两者 updatedAt 的最大值", () => {
    const d: AppData = {
      ...brandNew(),
      lists: [list("a", "工作", 0, "2026-08-01T00:00:00.000Z"), list("b", "生活", 1, OLD)],
      tasks: [
        task("t1", "甲", "a", { updatedAt: "2026-09-02T14:30:00.000Z" }),
        task("t2", "乙", "a"),
      ],
    };
    expect(summarizeProfile(d)).toEqual({
      tasks: 2, lists: 2, updatedAt: "2026-09-02T14:30:00.000Z",
    });
  });

  it("回收站里的不算——用户在界面上数不到它们", () => {
    const d: AppData = {
      ...brandNew(),
      lists: [],
      tasks: [task("t1", "甲", null), task("t2", "删掉的", null, { deletedAt: OLD })],
    };
    expect(summarizeProfile(d).tasks).toBe(1);
  });

  it("一条内容都没有时 updatedAt 是 null（界面那行就不写时刻）", () => {
    expect(summarizeProfile({ ...brandNew(), lists: [], tasks: [] }).updatedAt).toBeNull();
  });
});

// ------------------------------------------------------- A · 同一件事去重（「合并两份」那条路）

describe("A · 同一件事两边各一份，只留一份", () => {
  const AT = "2026-09-03T10:00:00.000Z";
  const NEW = "2026-09-02T00:00:00.000Z";
  const sides = (localIds: string[], remoteIds: string[]) => ({
    local: new Set(localIds), remote: new Set(remoteIds),
  });

  it("标题 / 清单 / 日期都一样、id 不同 → 并成一条，留改得晚的那条", () => {
    const d: AppData = {
      ...brandNew(),
      lists: [list("w", "工作", 0)],
      tasks: [
        task("mine", "交周报", "w", { due: "2026-09-10" }),
        task("theirs", "交周报", "w", { due: "2026-09-10", updatedAt: NEW }),
      ],
    };
    const out = dedupeSameTasks(d, sides(["mine"], ["theirs"]), AT);
    expect(out.folded).toBe(1);
    expect(out.data.tasks.map((t) => t.id)).toEqual(["theirs"]);
    // 被折掉的那条立墓碑，别的设备下一轮同步不会把它推回来
    expect(out.data.graveyard.map((g) => g.id)).toEqual(["mine"]);
  });

  it("日期不一样就不是同一件事——「周五交周报」和「下周五交周报」是两件", () => {
    const d: AppData = {
      ...brandNew(),
      lists: [],
      tasks: [
        task("mine", "交周报", null, { due: "2026-09-10" }),
        task("theirs", "交周报", null, { due: "2026-09-17" }),
      ],
    };
    expect(dedupeSameTasks(d, sides(["mine"], ["theirs"]), AT).folded).toBe(0);
  });

  it("两台设备各自的「工作」是两个 id，按**名字**算才对得上", () => {
    const d: AppData = {
      ...brandNew(),
      lists: [list("local-work", "工作", 0), list("cloud-work", "工作", 1)],
      tasks: [
        task("mine", "交周报", "local-work"),
        task("theirs", "交周报", "cloud-work", { updatedAt: NEW }),
      ],
    };
    const out = dedupeSameTasks(d, sides(["mine"], ["theirs"]), AT);
    expect(out.folded).toBe(1);
    expect(out.data.tasks.map((t) => t.id)).toEqual(["theirs"]);
  });

  it("清单不一样也不是同一件事", () => {
    const d: AppData = {
      ...brandNew(),
      lists: [list("w", "工作", 0), list("h", "生活", 1)],
      tasks: [task("mine", "打电话", "w"), task("theirs", "打电话", "h")],
    };
    expect(dedupeSameTasks(d, sides(["mine"], ["theirs"]), AT).folded).toBe(0);
  });

  it("习惯不跟同名的事并——那是两种东西", () => {
    const d: AppData = {
      ...brandNew(),
      lists: [],
      tasks: [
        task("mine", "喝水", null),
        task("theirs", "喝水", null, { kind: "habit" }),
      ],
    };
    expect(dedupeSameTasks(d, sides(["mine"], ["theirs"]), AT).folded).toBe(0);
  });

  it("同一台设备上自己记了两条一模一样的：不动——那是他自己的事", () => {
    const d: AppData = {
      ...brandNew(),
      lists: [],
      tasks: [task("a", "买菜", null), task("b", "买菜", null)],
    };
    expect(dedupeSameTasks(d, sides(["a", "b"], ["z"]), AT).folded).toBe(0);
  });

  it("回收站里那条不参与——否则活着的那条会被折成一条删掉的", () => {
    const d: AppData = {
      ...brandNew(),
      lists: [],
      tasks: [
        task("mine", "交周报", null),
        task("theirs", "交周报", null, { updatedAt: NEW, deletedAt: NEW }),
      ],
    };
    const out = dedupeSameTasks(d, sides(["mine"], ["theirs"]), AT);
    expect(out.folded).toBe(0);
    expect(out.data.tasks.map((t) => t.id)).toEqual(["mine", "theirs"]);
  });

  it("没有重复时原样返回同一个对象（同步那边靠对象身份判断动没动过）", () => {
    const d = brandNew();
    expect(dedupeSameTasks(d, sides([], []), AT).data).toBe(d);
  });
});

// ------------------------------------------------------- A · 「用这台设备上的那份」

describe("A · 用这台设备上的那份（云端换成本机这份）", () => {
  const AT = "2026-09-03T10:00:00.000Z";
  const NEWER = "2026-09-02T00:00:00.000Z";

  it("云端有、本机没有的事和清单一律立墓碑——不立的话下一轮同步又把它们合回来", () => {
    const local: AppData = {
      ...brandNew(), lists: [list("mine", "工作", 0)], tasks: [task("t1", "本机的事", "mine")],
    };
    const remote: AppData = {
      ...brandNew(), lists: [list("theirs", "读书", 0)], tasks: [task("c1", "云端的事", "theirs")],
    };
    const out = keepLocalOverCloud(local, remote, AT);
    expect(out.tasks.map((t) => t.id)).toEqual(["t1"]);
    expect(out.graveyard.map((g) => g.id).sort()).toEqual(["c1", "theirs"]);
    // 立完墓碑再跟云端合一轮：云端独有的那条不许复活
    const merged = mergeData(out, remote).data;
    expect(merged.tasks.map((t) => t.id)).toEqual(["t1"]);
    expect(merged.lists.map((l) => l.id)).toEqual(["mine"]);
  });

  it("两边都有、云端改得更晚的那条重新盖本机的戳——否则合并时云端那条会赢，选择当场被翻案", () => {
    const local: AppData = {
      ...brandNew(), lists: [], tasks: [task("t1", "本机写的", null), task("t2", "没冲突的", null)],
    };
    const remote: AppData = {
      ...brandNew(), lists: [], tasks: [task("t1", "云端写的", null, { updatedAt: NEWER })],
    };
    const out = keepLocalOverCloud(local, remote, AT);
    expect(out.tasks.find((t) => t.id === "t1")!.updatedAt).toBe(AT);
    expect(out.tasks.find((t) => t.id === "t1")!.title).toBe("本机写的");
    // 没冲突的那条不许被顺手盖戳：一次登录把整库标成「本机刚改过」是另一种祸
    expect(out.tasks.find((t) => t.id === "t2")!.updatedAt).toBe(OLD);
    expect(mergeData(out, remote).data.tasks.find((t) => t.id === "t1")!.title).toBe("本机写的");
  });

  it("数据版本号取两边最大——本机是老版本时不许把云端的 schema 拉回去", () => {
    const local = { ...brandNew(), version: 6 };
    const remote = { ...brandNew(), version: 9 };
    expect(keepLocalOverCloud(local, remote, AT).version).toBe(9);
  });
});

// ------------------------------------------------------- A · 登录那一刻的实际走向

describe("A · 登录时怎么处置本机数据", () => {
  /** 云端那一份：一条「工作」清单 + 一条事 */
  function cloudData(): AppData {
    return {
      ...defaultData(),
      lists: [list("cloud-work", "工作", 0)],
      tasks: [task("c1", "云端记的事", "cloud-work")],
    };
  }

  beforeEach(async () => {
    vi.useRealTimers();
    await flushSave();
    await signOut(); // 停掉上一条用例留下的数据监听与防抖
    clearUndo();
    localStorage.clear();
    syncOnce.mockReset();
    pullOnly.mockReset();
    whoAmI.mockReset();
    syncOnce.mockImplementation(async (_s: cloud.Session, local: AppData) => ({
      rev: 9, data: local, changed: false, summary: { added: 0, updated: 0, removed: 0 },
    }));
    pullOnly.mockResolvedValue({ rev: 7, data: cloudData(), updatedAt: OLD });
    whoAmI.mockResolvedValue({
      email: "a@b.c", rev: 7, updatedAt: OLD, device: "Android · 橡果 1.10.1", hasData: true,
    });
    appStore.setState({
      data: brandNew(), loaded: true, loadError: null, dataFromNewer: null, rescue: null, wiped: false,
    });
    syncStore.setState({ session: null, phase: "off", message: "", dirty: false });
  });

  it("本机全新 + 云端有内容 → 用云端整份覆盖，**不是**合并", async () => {
    const out = await signInWithLocalData({ ...SESSION });
    expect(out.action).toBe("cloud");
    expect(pullOnly).toHaveBeenCalledTimes(1);
    // 合并那条路一次都不许走：走了就会把本机的默认清单推上云
    expect(syncOnce).not.toHaveBeenCalled();
  });

  it("覆盖之后自带的默认清单没了，侧栏不会出现两个「工作」", async () => {
    await signInWithLocalData({ ...SESSION });
    const d = appStore.getState().data;
    expect(d.lists.map((l) => l.name)).toEqual(["工作"]);
    expect(d.tasks.map((t) => t.title)).toEqual(["云端记的事"]);
  });

  it("覆盖前照现有规矩留了一份备份（走的就是「从云端覆盖到这台设备」那条现成的路）", async () => {
    const out = await signInWithLocalData({ ...SESSION });
    expect(persist.snapshotBackup).toHaveBeenCalledWith("pre-restore");
    expect(out.restored?.backup).toBe("pre-restore-20260902-101010.json");
    expect(out.restored?.rev).toBe(7);
  });

  it("本机有内容 + 云端有内容 → 停下来把两份档案摆出来，不擅自决定", async () => {
    appStore.setState({ data: { ...brandNew(), tasks: [task("t1", "本机的事", null)] } });
    const ask = vi.fn(async (_info: LoginAsk) => "merge" as const);
    const out = await signInWithLocalData({ ...SESSION }, ask);
    expect(out.plan).toBe("ask");
    expect(out.asked).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    // 问法里得有料：两边各几件事、几个清单、最近什么时候动过，用户才判得了。
    // 这些只有把云端那份真拉下来才算得出——但**只拉不落**，拍板之前本机一个字不动
    expect(ask.mock.calls[0][0]).toMatchObject({
      rev: 7,
      cloud: { tasks: 1, lists: 1, updatedAt: OLD },
      local: { tasks: 1, lists: 2 },
    });
    expect(pullOnly).toHaveBeenCalledTimes(1);
  });

  it("问的那一下只拉不落：拍板之前本机数据一个字没变", async () => {
    const mine = { ...brandNew(), tasks: [task("t1", "本机的事", null)] };
    appStore.setState({ data: mine });
    let seenWhileAsking: AppData | null = null;
    await signInWithLocalData({ ...SESSION }, async () => {
      seenWhileAsking = appStore.getState().data;
      return "merge";
    });
    expect(seenWhileAsking).toBe(mine);
  });

  it("用户选了合并 → 两边的东西都在", async () => {
    appStore.setState({ data: { ...brandNew(), tasks: [task("t1", "本机的事", null)] } });
    const out = await signInWithLocalData({ ...SESSION }, async () => "merge");
    expect(out.action).toBe("merge");
    expect(syncOnce).toHaveBeenCalledTimes(1);
    expect(appStore.getState().data.tasks.map((t) => t.title).sort()).toEqual(["云端记的事", "本机的事"]);
  });

  it("用户选了「用云端的」→ 走覆盖", async () => {
    appStore.setState({ data: { ...brandNew(), tasks: [task("t1", "本机的事", null)] } });
    const out = await signInWithLocalData({ ...SESSION }, async () => "cloud");
    expect(out.action).toBe("cloud");
    // 一次是问之前算摘要那一拉，一次是 restoreFromCloud 自己那一拉
    expect(pullOnly).toHaveBeenCalledTimes(2);
    expect(appStore.getState().data.tasks.map((t) => t.title)).toEqual(["云端记的事"]);
  });

  it("用户选了「用这台设备上的」→ 本机内容原样留着，云端独有的立墓碑再推上去", async () => {
    appStore.setState({ data: { ...brandNew(), tasks: [task("t1", "本机的事", null)] } });
    const out = await signInWithLocalData({ ...SESSION }, async () => "local");
    expect(out.action).toBe("local");
    const d = appStore.getState().data;
    expect(d.tasks.map((t) => t.title)).toEqual(["本机的事"]);
    // 云端那条事和那条清单都立了碑：不立的话下一轮同步又把它们合回来
    expect(d.graveyard.map((g) => g.id).sort()).toEqual(["c1", "cloud-work"]);
    // 推送走的是现成那条路（base_rev 与 409 重试都在里面），没有另写一套
    expect(syncOnce).toHaveBeenCalledTimes(1);
  });

  it("界面还没接上问法时默认合并——绝不在没人拍板的时候覆盖", async () => {
    appStore.setState({ data: { ...brandNew(), tasks: [task("t1", "本机的事", null)] } });
    const out = await signInWithLocalData({ ...SESSION });
    expect(out.asked).toBe(true);
    expect(out.action).toBe("merge");
    expect(appStore.getState().data.tasks.map((t) => t.title).sort()).toEqual(["云端记的事", "本机的事"]);
  });

  it("云端那份拉不下来（断网）→ 不问了，退回合并，登录照样成功", async () => {
    appStore.setState({ data: { ...brandNew(), tasks: [task("t1", "本机的事", null)] } });
    pullOnly.mockRejectedValue(new cloud.ApiError(0, "offline", "连不上服务器"));
    const ask = vi.fn(async (_info: LoginAsk) => "cloud" as const);
    const out = await signInWithLocalData({ ...SESSION }, ask);
    expect(ask).not.toHaveBeenCalled(); // 没有第二份档案可挑，问了也白问
    expect(out.action).toBe("merge");
    expect(out.asked).toBe(false);
    expect(syncStore.getState().session?.email).toBe("a@b.c");
    expect(appStore.getState().data.tasks.map((t) => t.title)).toEqual(["本机的事"]);
  });

  it("云端还是空的 → 照常合并，不问也不覆盖（第一台设备开账号）", async () => {
    whoAmI.mockResolvedValue({
      email: "a@b.c", rev: 0, updatedAt: null, device: "", hasData: false,
    });
    const ask = vi.fn(async (_info: LoginAsk) => "cloud" as const);
    const out = await signInWithLocalData({ ...SESSION }, ask);
    expect(out.plan).toBe("merge");
    expect(ask).not.toHaveBeenCalled();
    expect(syncOnce).toHaveBeenCalledTimes(1);
  });

  it("云端有没有东西问不出来（断网）→ 一律合并，本机一个字不动", async () => {
    whoAmI.mockRejectedValue(new cloud.ApiError(0, "offline", "连不上服务器"));
    const out = await signInWithLocalData({ ...SESSION });
    expect(out.action).toBe("merge");
    expect(pullOnly).not.toHaveBeenCalled();
  });

  it("覆盖半路失败（断网）→ 退回合并，登录本身照样算成功", async () => {
    pullOnly.mockRejectedValue(new cloud.ApiError(0, "offline", "连不上服务器"));
    const out = await signInWithLocalData({ ...SESSION });
    expect(out.action).toBe("merge");
    expect(syncStore.getState().session?.email).toBe("a@b.c");
  });

  it("登录之后顺手把重名清单并掉——用户账号里现在就躺着两条「工作」", async () => {
    // 云端那份自己就带着一对重复（用户手机推上去的那一对）
    pullOnly.mockResolvedValue({
      rev: 7,
      data: {
        ...defaultData(),
        lists: [list("w1", "工作", 0), list("w2", "工作", 1)],
        tasks: [task("c1", "云端记的事", "w2")],
      },
      updatedAt: OLD,
    });
    const out = await signInWithLocalData({ ...SESSION });
    expect(out.folded).toBe(1);
    expect(appStore.getState().data.lists.map((l) => l.name)).toEqual(["工作"]);
    // 清干净的这份得推回云端，否则下次换台设备又是两条
    expect(syncOnce).toHaveBeenCalled();
  });

  it("合并那条路上，同一件事两边各一份的只留一份（改得晚的那条）", async () => {
    // 本机和云端各有一条「交周报」：清单同名、日期一样，只有 id 不同——
    // 这正是用户 2026-09-03 说的「确保交集不要重复」
    appStore.setState({
      data: {
        ...brandNew(),
        lists: [list("local-work", "工作", 0)],
        tasks: [task("mine", "交周报", "local-work", { due: "2026-09-10" })],
      },
    });
    pullOnly.mockResolvedValue({
      rev: 7,
      data: {
        ...defaultData(),
        lists: [list("cloud-work", "工作", 0)],
        tasks: [
          task("theirs", "交周报", "cloud-work", {
            due: "2026-09-10", updatedAt: "2026-09-02T00:00:00.000Z",
          }),
        ],
      },
      updatedAt: OLD,
    });
    const out = await signInWithLocalData({ ...SESSION }, async () => "merge");
    expect(out.foldedTasks).toBe(1);
    const d = appStore.getState().data;
    expect(d.tasks.map((t) => t.id)).toEqual(["theirs"]); // 改得晚的那条留下
    expect(d.lists.map((l) => l.name)).toEqual(["工作"]); // 同名清单也并成了一条
    expect(d.graveyard.map((g) => g.id)).toContain("mine"); // 折掉的立了碑
  });

  it("合并整套只落一次 state——侧栏不许先 double counting 再恢复", async () => {
    // 老做法是「先落合并结果、再落去重结果」，中间那一拍侧栏把两份都数了一遍，
    // 用户看见的就是数字先翻倍随后才恢复（2026-09-03 实测反馈）
    appStore.setState({
      data: {
        ...brandNew(),
        lists: [list("local-work", "工作", 0)],
        tasks: [task("mine", "交周报", "local-work", { due: "2026-09-10" })],
      },
    });
    pullOnly.mockResolvedValue({
      rev: 7,
      data: {
        ...defaultData(),
        lists: [list("cloud-work", "工作", 0)],
        tasks: [task("theirs", "交周报", "cloud-work", { due: "2026-09-10" })],
      },
      updatedAt: OLD,
    });
    const spy = vi.spyOn(appStore, "setState");
    await signInWithLocalData({ ...SESSION }, async () => "merge");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("三个入口（登录/验证/改密码）都走这条判断，没有漏网的 adoptSession", () => {
    // v1.11.0 起表单从 AccountPanel 搬到了 core/useAuthFlow（设置页那块只剩一个入口，
    // 界面在 components/LoginPage.tsx）。**判断本身一个字没动**：三个入口仍旧统一
    // 走 settleSignIn → signInWithLocalData，谁都不许自己去 adoptSession
    expect(authFlowSource).toContain("signInWithLocalData");
    expect(authFlowSource).not.toContain("adoptSession");
    expect((authFlowSource.match(/settleSignIn\(/g) ?? []).length).toBe(4); // 1 定义 + 3 调用
    // 设置页那块不许再自己接一套登录（那会绕开上面这条判断）
    expect(accountPanelSource).not.toContain("cloud.login(");
    expect(accountPanelSource).not.toContain("cloud.verify(");
    expect(accountPanelSource).not.toContain("cloud.resetPassword(");
  });
});

// ---------------------------------------------------------------- B · 首次启动

describe("B · 这一版是不是第一次开", () => {
  it("从没启动过（连版本号都没记过）→ install", () => {
    expect(firstRunKind(null, "1.10.1")).toBe("install");
    expect(firstRunKind("", "1.10.1")).toBe("install");
  });

  it("同一个版本又开了一次 → same，什么都不该弹", () => {
    expect(firstRunKind("1.10.1", "1.10.1")).toBe("same");
  });

  it("装了新版之后第一次开 → upgrade", () => {
    expect(firstRunKind("1.9.1", "1.10.1")).toBe("upgrade");
  });

  it("降级安装也算这一版第一次开——它同样该看见这一版的日志", () => {
    expect(firstRunKind("1.10.1", "1.9.1")).toBe("upgrade");
  });

  it("rememberLaunch 写回去之后再问就是 same 了", () => {
    localStorage.clear();
    expect(firstRunKind(readLastVersion(), "1.10.1")).toBe("install");
    rememberLaunch("1.10.1");
    expect(readLastVersion()).toBe("1.10.1");
    expect(firstRunKind(readLastVersion(), "1.10.1")).toBe("same");
  });

  it("键名按 acorn- 前缀，清空本机时会被一并扫掉", () => {
    localStorage.clear();
    rememberLaunch("1.10.1");
    const keys = Object.keys(localStorage).filter((k) => k.startsWith("acorn-"));
    expect(keys).toContain("acorn-last-version");
  });

  it("App 只在 upgrade 那一档弹更新日志：第一次装橡果的人该先看见登录，不是版本历史", () => {
    expect(appSource).toContain('firstRun === "upgrade"');
    expect(appSource).toContain("setChangelogOpen(true)");
  });
});

describe("B · 侧栏那截版本检查状态", () => {
  it("这台设备根本没有更新能力：不显示", () => {
    expect(updateFootState({ kind: "latest" }, false)).toBeNull();
  });

  it("这次还没查过：不显示（不是故障，不值得占地方）", () => {
    expect(updateFootState(null, true)).toBeNull();
  });

  it("查成功且已是最新：一句「已是最新」，不标红", () => {
    expect(updateFootState({ kind: "latest" }, true)).toEqual({
      bad: false, text: "已是最新", openable: false,
    });
  });

  it("查到新版：说清是哪一版，而且点得动", () => {
    expect(updateFootState({ kind: "found", version: "1.11.0" }, true)).toEqual({
      bad: false, text: "有新版本 v1.11.0", openable: true,
    });
  });

  it("查失败：标红说出来，不许骗人说「已经是最新版了」", () => {
    expect(updateFootState({ kind: "failed" }, true)).toEqual({
      bad: true, text: "版本检查失败", openable: false,
    });
  });

  it("侧栏真的把它渲染出来了，而且点得动那条能打开更新弹窗", () => {
    expect(sidebarSource).toContain("updateFootState");
    const foot = sidebarSource.slice(sidebarSource.indexOf('className="foot"'));
    expect(foot).toContain("upd.text");
    expect(foot).toContain("openFoundUpdate");
  });
});

// ---------------------------------------------------------------- C · 首启要不要请人登录

describe("C · 首次启动该不该请人登录", () => {
  beforeEach(() => localStorage.clear());

  it("没登录 + 本机全新 + 没点过「以后再说」→ 请他登录", () => {
    expect(shouldOfferLogin({ signedIn: false, pristine: true, later: false })).toBe(true);
  });

  it("已经登录了：不弹", () => {
    expect(shouldOfferLogin({ signedIn: true, pristine: true, later: false })).toBe(false);
  });

  it("本机已经记了东西：不弹——老用户不该被一个登录框拦在门口", () => {
    expect(shouldOfferLogin({ signedIn: false, pristine: false, later: false })).toBe(false);
  });

  it("点过「以后再说」：不弹", () => {
    expect(shouldOfferLogin({ signedIn: false, pristine: true, later: true })).toBe(false);
  });

  it("「以后再说」记得住、读得出来", () => {
    expect(isLoginLater()).toBe(false);
    markLoginLater();
    expect(isLoginLater()).toBe(true);
    expect(localStorage.getItem(LOGIN_LATER_KEY)).toBe("1");
  });

  it("键名按 acorn- 前缀：清空本机之后本来就该重新问一次", () => {
    expect(LOGIN_LATER_KEY.startsWith("acorn-")).toBe(true);
  });

  it("判据可以直接拿 isPristineLocal 的结果喂——两处是同一条口径", () => {
    const pristine = isPristineLocal({ data: brandNew(), everSynced: false });
    expect(shouldOfferLogin({ signedIn: false, pristine, later: false })).toBe(true);
  });
});
