// 版本错位时的口径（2026-09-01 用户重定，推翻 08-24 那版「必须明说 + 拒绝加载」）：
//
// **一定不能拒绝读取客户之前的日志。** 多了几列特征就空着，等用户升级了再显示，
// 但绝不许因为「这份比我新」就把整个账本挡在外面——那是产品原则上的错。
// 08-24 那版口径里对的那一半仍然成立：**不许悄悄抹掉**。所以这个文件现在钉两件事：
//   ① 读得进来（不空账本、不早退、改了存得回去）
//   ② 一个字不丢（任务 / 子任务 / 墓碑 / 顶层未知集合 / version 五样）
import { beforeEach, describe, expect, it } from "vitest";
import { pack, unpack } from "../src/core/transfer";
import { DATA_VERSION, defaultData, migrate, newTask } from "../src/core/model";
import { mergeData } from "../src/core/merge";
import type { AppData } from "../src/core/model";
import { loadData } from "../src/core/persist";
import { addTask, appStore, flushSave, initStore, undo } from "../src/core/store";

function sample() {
  const d = defaultData();
  d.tasks = [newTask({ title: "对账" })];
  return d;
}

describe("unpack 要如实报出「这份数据是第几版」", () => {
  it("本机自己导出的：schema = 当前版本，不算新", () => {
    const r = unpack(pack(sample(), "1.6.0"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.schema).toBe(DATA_VERSION);
    expect(r.tooNew).toBe(false);
  });

  it("更老版本导出的：认，且不算新", () => {
    const r = unpack({
      app: "acorn",
      schema: 2,
      appVersion: "1.3.0",
      exportedAt: "2026-08-01T00:00:00Z",
      data: { version: 2, tasks: [{ id: "t1", title: "老任务", who: "李哥" }], lists: [] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.schema).toBe(2);
    expect(r.tooNew).toBe(false);
    expect(r.data.tasks[0].who).toEqual(["李哥"]); // 老格式照样升得上来
  });

  it("**更新版本导出的：必须标成 tooNew**", () => {
    const r = unpack({
      app: "acorn",
      schema: DATA_VERSION + 1,
      appVersion: "9.9.9",
      exportedAt: "2027-01-01T00:00:00Z",
      data: { version: DATA_VERSION + 1, tasks: [], lists: [] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.schema).toBe(DATA_VERSION + 1);
    expect(r.tooNew).toBe(true);
  });

  it("信封上没写 schema 时退到数据里的 version", () => {
    const r = unpack({ app: "acorn", data: { version: DATA_VERSION + 3, tasks: [], lists: [] } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.schema).toBe(DATA_VERSION + 3);
    expect(r.tooNew).toBe(true);
  });

  it("老式裸数据（没信封）：按里面的 version 算，没有就当最老的", () => {
    const bare = unpack({ tasks: [], lists: [] });
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    expect(bare.schema).toBe(1);
    expect(bare.tooNew).toBe(false);

    const bareNew = unpack({ version: DATA_VERSION + 1, tasks: [], lists: [] });
    expect(bareNew.ok).toBe(true);
    if (!bareNew.ok) return;
    expect(bareNew.tooNew).toBe(true);
  });

  it("不是橡果的数据照旧明确报错", () => {
    expect(unpack({ hello: "world" }).ok).toBe(false);
    expect(unpack("一个字符串").ok).toBe(false);
    expect(unpack(null).ok).toBe(false);
  });
});

describe("往返不变", () => {
  it("导出→导入，任务原样回来", () => {
    const d = sample();
    const r = unpack(JSON.parse(JSON.stringify(pack(d, "1.6.0"))));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.tasks.map((t) => t.title)).toEqual(["对账"]);
    expect(r.tooNew).toBe(false);
  });
});

// 本地磁盘那条路。这个项目的数据目录就放在两台机器共用的移动硬盘上，
// 「一台已经升级、另一台还没」是天天发生的事。
describe("本地文件比本机新时：照常读进来，照常存回去", () => {
  const LS_KEY = "acorn-data";

  beforeEach(async () => {
    while (appStore.getState().undoDepth > 0) undo();
    await flushSave();
    localStorage.clear();
    appStore.setState({ data: defaultData(), loaded: false, loadError: null, dataFromNewer: null, undoDepth: 0 });
  });

  it("loadData 如实报 tooNew，不假装看懂", async () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ version: DATA_VERSION + 1, tasks: [], lists: [] }));
    const r = await loadData();
    expect(r.tooNew).toBe(true);
    expect(r.schema).toBe(DATA_VERSION + 1);
  });

  it("同版本的照常读，什么都不拦", async () => {
    const d = sample();
    localStorage.setItem(LS_KEY, JSON.stringify(d));
    const r = await loadData();
    expect(r.tooNew).toBe(false);
    expect(r.data!.tasks.map((t) => t.title)).toEqual(["对账"]);
  });

  it("**initStore 照常读进来**：任务一条不少，只点亮提示条，不空账本、不早退", async () => {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        version: DATA_VERSION + 1,
        tasks: [{ id: "t1", title: "新版本记的一件事", createdAt: "2026-01-02T00:00:00.000Z" }],
        lists: [{ id: "l1", name: "工作", color: "clay", order: 0, updatedAt: "2026-01-02T00:00:00.000Z" }],
      }),
    );
    await initStore();
    const s = appStore.getState();
    // 提示条：只是一条可关的横幅，不是闸门
    expect(s.dataFromNewer).toEqual({ schema: DATA_VERSION + 1 });
    expect(s.loadError).toBeNull();
    // 用户自己的日志必须在眼前，一条都不许少
    expect(s.data.tasks.map((t) => t.title)).toEqual(["新版本记的一件事"]);
    expect(s.data.lists.map((l) => l.name)).toEqual(["工作"]);
    // 「这份本来是第几版」这个事实也要活下来
    expect(s.data.version).toBe(DATA_VERSION + 1);
  });

  it("**改了存得下去**，而且存回去的那份未知字段一个不少、version 仍是新的", async () => {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        version: DATA_VERSION + 1,
        projects: [{ id: "p1", name: "第 7 版才有的顶层集合" }],
        lists: [],
        sessions: [],
        settings: {},
        graveyard: [{ id: "gone", at: new Date().toISOString(), kind: "list" }],
        tasks: [{
          id: "t1", title: "新版本记的一件事", createdAt: "2026-01-02T00:00:00.000Z",
          energy: "high",
          subtasks: [{ id: "s1", title: "子", done: false, blockedBy: "t9" }],
        }],
      }),
    );
    await initStore();
    addTask({ title: "老客户端随手记一条" });
    await flushSave();

    const back = JSON.parse(localStorage.getItem(LS_KEY)!) as Record<string, any>;
    expect(back.version).toBe(DATA_VERSION + 1);
    expect(back.projects).toEqual([{ id: "p1", name: "第 7 版才有的顶层集合" }]);
    const t1 = back.tasks.find((t: any) => t.id === "t1");
    expect(t1.energy).toBe("high");
    expect(t1.subtasks[0].blockedBy).toBe("t9");
    expect(back.graveyard[0].kind).toBe("list");
    // 新记的那条当然也在
    expect(back.tasks.some((t: any) => t.title === "老客户端随手记一条")).toBe(true);
  });
});

// 这一批的核心资产。造一份 schema 7 的数据，五样东西各代表一个曾经的丢法：
//   ① 任务上的未知字段  ② 子任务上的未知字段  ③ 墓碑上的未知字段
//   ④ 顶层未知集合（migrate/mergeData 那两个 6 键字面量整块吞掉的就是它）
//   ⑤ version（被写死成 DATA_VERSION，「这份本来是第 7 版」这个事实本身被抹掉）
// 磁盘一遍、云端一遍，两条路都要走完。
describe("schema 7 的数据在 schema 6 的客户端上走一圈：五样一个不少", () => {
  const LS_KEY = "acorn-data";
  const AT = "2026-08-20T02:00:00.000Z";

  function schema7(): Record<string, unknown> {
    return {
      version: DATA_VERSION + 1,
      lists: [{ id: "l1", name: "工作", color: "clay", order: 0, updatedAt: AT }],
      sessions: [],
      settings: { theme: "forest", futureSetting: 42 },
      graveyard: [{ id: "gone", at: AT, kind: "list" }],
      projects: [{ id: "p1", name: "第 7 版才有的顶层集合" }],
      tasks: [
        { id: "t1", title: "新版本记的", createdAt: AT, updatedAt: AT, energy: "high",
          subtasks: [{ id: "s1", title: "子", done: false, blockedBy: "t9" }] },
        { id: "t2", title: "改这一条", createdAt: AT, updatedAt: AT },
      ],
    };
  }

  /** 五样一起验：哪一样丢了都当场点名 */
  function expectAllFive(d: unknown) {
    const x = d as Record<string, any>;
    expect(x.version).toBe(DATA_VERSION + 1); // ⑤
    expect(x.projects).toEqual([{ id: "p1", name: "第 7 版才有的顶层集合" }]); // ④
    expect(x.graveyard.find((g: any) => g.id === "gone").kind).toBe("list"); // ③
    const t1 = x.tasks.find((t: any) => t.id === "t1");
    expect(t1.energy).toBe("high"); // ①
    expect(t1.subtasks[0].blockedBy).toBe("t9"); // ②
  }

  beforeEach(async () => {
    while (appStore.getState().undoDepth > 0) undo();
    await flushSave();
    localStorage.clear();
    appStore.setState({ data: defaultData(), loaded: false, loadError: null, dataFromNewer: null, undoDepth: 0 });
  });

  it("磁盘：读入 → 改一条别的任务 → 存回 → 再读出来，五样都在", async () => {
    localStorage.setItem(LS_KEY, JSON.stringify(schema7()));
    await initStore();
    expectAllFive(appStore.getState().data); // 读进内存这一步就不许丢

    // 改一条**别的**任务：未知字段所在的那条一动不动，走的是最普通的编辑路径
    const { updateTask } = await import("../src/core/store");
    updateTask("t2", { title: "老客户端改过了" });
    await flushSave();

    const onDisk = JSON.parse(localStorage.getItem(LS_KEY)!);
    expectAllFive(onDisk);
    expect(onDisk.tasks.find((t: any) => t.id === "t2").title).toBe("老客户端改过了");

    // 再读一遍（重启橡果）：还在
    appStore.setState({ data: defaultData(), loaded: false, dataFromNewer: null });
    await initStore();
    expectAllFive(appStore.getState().data);
  });

  it("云端合并：本机 6 ↔ 云端 7，两个方向各来一遍，五样都在", () => {
    const remote = migrate(schema7());
    const local = migrate({
      version: DATA_VERSION,
      lists: [], sessions: [], settings: {}, graveyard: [],
      tasks: [{ id: "t3", title: "本机记的", createdAt: AT, updatedAt: AT }],
    });

    const a = mergeData(local, remote).data;
    expectAllFive(a);
    expect(a.tasks.map((t) => t.id).sort()).toEqual(["t1", "t2", "t3"]);

    // 反过来（这台设备当云端那一侧）同样不许丢
    const b = mergeData(remote, local).data;
    expectAllFive(b);

    // 幂等：再合一次，还是那五样
    expectAllFive(mergeData(a, remote).data);
  });

  it("推上云时信封盖的是 max 后的 schema，服务端那道 409 才不会误伤", () => {
    const d = migrate(schema7()) as AppData;
    expect(pack(d, "1.9.1").schema).toBe(DATA_VERSION + 1);
    // 本机自己那份照旧报本机版本
    expect(pack(defaultData(), "1.9.1").schema).toBe(DATA_VERSION);
  });
});
