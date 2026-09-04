// 数据迁移的总台。以后每次动数据模型，都在这个文件里照同样的骨架加一节。
//
// 为什么单开一个文件：迁移用例原先散在 who / habits / transfer 三处，
// 谁都不知道「v3 → v4 到底有没有测过」（答案是没有）。台账在 docs/数据模型变更.md，
// 那份文档里「测试清单」那一栏指的就是这里。
//
// 骨架分六块：
//   1. v1~v6 每条升级路径各一条（v6 → v7 那组：子任务的 deletedAt 缺失就缺失，什么都不补）
//   2. migrate 幂等（migrate(migrate(x)) 深等于 migrate(x)）
//   3. 未知字段一个不丢：任务 / 子任务 / 设置 / **墓碑** / **顶层未知集合** / version 取 max
//      （墓碑那条 2026-09-01 从「锁现状：会丢」反转成「不许丢」）
//   4. 本次新增：子任务的 doneAt
//   5. migrate 不许集体刷新 updatedAt（刷了 = 下一次同步拿本机盖掉云端）
//   6. 循环推进时子任务的 done/doneAt 怎么清

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_VERSION, defaultData, migrate } from "../src/core/model";
import {
  addSubtask, addTask, appStore, completeTask, completeTasks, flushSave, toggleSubtask, undo,
} from "../src/core/store";
import type { Task } from "../src/core/model";

/** 每条升级路径的样本都自带 lists，不走 defaultData 兜底——
 *  兜底那条路每次都 newId()，幂等断言会挂在「两次的清单 id 不一样」上，
 *  那是测试没写对，不是 migrate 有问题 */
const LISTS = [{ id: "l1", name: "工作", color: "clay", order: 0, updatedAt: "2026-01-01T00:00:00.000Z" }];

describe("升级路径：v1 → 当前", () => {
  it("someday 丢掉、子任务补齐五个可选字段、任务一条不少", () => {
    const v1 = {
      version: 1,
      lists: LISTS,
      sessions: [],
      settings: { theme: "forest", mode: "light" },
      tasks: [
        {
          id: "t1", title: "老任务", someday: true, listId: "l1", tags: [], who: null,
          priority: 1, due: null, createdAt: "2026-01-02T00:00:00.000Z",
          subtasks: [{ id: "s1", title: "子", done: false }],
        },
      ],
    };
    const d = migrate(v1);
    expect(d.version).toBe(DATA_VERSION);
    expect(d.tasks).toHaveLength(1);
    expect("someday" in d.tasks[0]).toBe(false);
    expect(d.tasks[0].subtasks[0]).toEqual({
      id: "s1", title: "子", done: false, due: null, dueTime: null, priority: null,
      doneAt: null, droppedAt: null,
    });
  });
});

describe("升级路径：v2 → 当前", () => {
  it("who 从一个人变成一串人", () => {
    const d = migrate({
      version: 2, lists: LISTS, sessions: [], settings: {},
      tasks: [
        { id: "t1", title: "交周报", who: "李哥", subtasks: [], createdAt: "2026-01-02T00:00:00.000Z" },
        { id: "t2", title: "没需求方", who: null, subtasks: [], createdAt: "2026-01-02T00:00:00.000Z" },
      ],
    });
    expect(d.tasks[0].who).toEqual(["李哥"]);
    expect(d.tasks[1].who).toEqual([]);
  });
});

describe("升级路径：v3 → 当前", () => {
  // 这条路径以前一条测试都没有。写出来才发现：**实际行为和 model.ts 的注释对不上**——
  // 注释说「缺 updatedAt 就拿创建时刻顶」，可 merge 的第一步是 `{...newTask(...), ...t}`，
  // newTask 已经把 updatedAt 填成「现在」了，后面那句 `?? createdAt` 永远轮不到。
  // 这条锁的是**现状**，不是认可它：真要改，得连着 merge 的合并结果一起想清楚（见台账的 followUps）。
  // 好在从 v4 起每条真实数据都带着这个戳，踩到的只有「导入一份很老的备份」这一种情况
  it("【锁现状】任务缺 updatedAt 时落到的是「现在」，不是注释说的 createdAt", () => {
    const before = new Date().toISOString();
    const d = migrate({
      version: 3, lists: LISTS, sessions: [], settings: {},
      tasks: [{ id: "t1", title: "老任务", who: [], subtasks: [], createdAt: "2026-01-02T03:04:05.000Z" }],
    });
    expect(d.tasks[0].updatedAt >= before).toBe(true);
  });

  it("清单缺 updatedAt 退到 epoch（和任务退 createdAt 是两套口径，别顺手统一）", () => {
    const d = migrate({
      version: 3, sessions: [], settings: {}, tasks: [],
      lists: [{ id: "l9", name: "生活", color: "moss", order: 0 }],
    });
    expect(d.lists[0].updatedAt).toBe(new Date(0).toISOString());
  });

  it("没有墓碑表也不炸，补成空的", () => {
    const d = migrate({ version: 3, lists: LISTS, sessions: [], settings: {}, tasks: [] });
    expect(d.graveyard).toEqual([]);
  });
});

describe("升级路径：v4 → 当前", () => {
  it("老任务一律是普通事，不会被误判成习惯", () => {
    const d = migrate({
      version: 4, lists: LISTS, sessions: [], settings: {},
      tasks: [{
        id: "t1", title: "旧任务", repeat: { kind: "daily", every: 1 }, subtasks: [],
        createdAt: "2026-01-02T00:00:00.000Z",
      }],
    });
    expect(d.tasks[0].kind).toBe("task");
    expect(d.tasks[0].checkIns).toEqual([]);
  });

  it("打卡日期归一：非法的丢掉、重复的合并、乱序的排好", () => {
    const d = migrate({
      version: 4, lists: LISTS, sessions: [], settings: {},
      tasks: [{
        id: "h1", title: "喝水", kind: "habit", subtasks: [], createdAt: "2026-01-02T00:00:00.000Z",
        checkIns: ["2026-08-03", "2026-08-01", "2026-08-03", "昨天", 7],
      }],
    });
    expect(d.tasks[0].checkIns).toEqual(["2026-08-01", "2026-08-03"]);
  });
});

describe("升级路径：v5 → v6（只补子任务的 doneAt，别的什么都不该变）", () => {
  it("习惯原样保留", () => {
    const d = migrate({
      version: 5, lists: LISTS, sessions: [], settings: {},
      tasks: [{
        id: "h1", title: "喝水", kind: "habit", checkIns: ["2026-08-01"], subtasks: [],
        createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-02-02T00:00:00.000Z",
      }],
    });
    expect(d.tasks[0].kind).toBe("habit");
    expect(d.tasks[0].checkIns).toEqual(["2026-08-01"]);
    expect(d.tasks[0].updatedAt).toBe("2026-02-02T00:00:00.000Z");
  });

  it("已经带了 doneAt 的子任务（本版自己写出来的）原样保留", () => {
    const d = migrate({
      version: 5, lists: LISTS, sessions: [], settings: {},
      tasks: [{
        id: "t1", title: "装修", subtasks: [
          { id: "s1", title: "量尺寸", done: true, due: null, dueTime: null, priority: null, doneAt: "2026-08-20T02:00:00.000Z" },
        ],
        createdAt: "2026-01-02T00:00:00.000Z",
      }],
    });
    expect(d.tasks[0].subtasks[0].doneAt).toBe("2026-08-20T02:00:00.000Z");
  });
});

describe("升级路径：v6 → v7（子任务的 deletedAt：什么都不补、什么都不改）", () => {
  // 一份 v1.12.0 写出来的真数据的样子：子任务五个可选字段都带着 null，没有 deletedAt
  const v6 = () => ({
    version: 6, lists: LISTS, sessions: [], settings: {}, graveyard: [],
    tasks: [{
      id: "t1", title: "装修", kind: "task", checkIns: [], notes: "", listId: null, tags: [], who: [],
      priority: 0, due: null, dueTime: null, reminder: null, repeat: null, done: false, doneAt: null,
      droppedAt: null, createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-02-02T00:00:00.000Z",
      order: 0, postponeCount: 0, focusMinutes: 0, deletedAt: null,
      subtasks: [
        { id: "s1", title: "量尺寸", done: true, due: null, dueTime: null, priority: null, doneAt: "2026-08-20T02:00:00.000Z", droppedAt: null },
        { id: "s2", title: "选瓷砖", done: false, due: "2026-09-10", dueTime: null, priority: 2, doneAt: null, droppedAt: null },
      ],
    }],
  });

  it("老数据原样：子任务一条不少、每个字段原值，version 升到 7", () => {
    const d = migrate(v6());
    expect(d.version).toBe(DATA_VERSION);
    expect(d.tasks[0].subtasks).toEqual(v6().tasks[0].subtasks);
    expect(d.tasks[0].updatedAt).toBe("2026-02-02T00:00:00.000Z");
  });

  it("缺 deletedAt 的子任务**不补**：不补 null、不补时间，连这个键都不出现", () => {
    const d = migrate(v6());
    for (const s of d.tasks[0].subtasks) {
      expect("deletedAt" in s).toBe(false);
      expect(Object.keys(JSON.parse(JSON.stringify(s))).sort()).toEqual(
        ["done", "doneAt", "droppedAt", "due", "dueTime", "id", "priority", "title"],
      );
    }
  });

  it("version 取 max：v6 升到 7，自称第 8 版的不许降回 7", () => {
    expect(migrate(v6()).version).toBe(7);
    expect(migrate({ ...v6(), version: 8 }).version).toBe(8);
  });

  it("v7 的数据被 v6 的客户端读进来：deletedAt 原样活下来（那边子任务那句是 spread，不重建）", () => {
    // v1.12.0（schema 6）migrate 里子任务那句字面量，逐字照抄——它就是老客户端处理子任务的全部逻辑
    const v6Client = (s: Record<string, unknown>) => ({ due: null, dueTime: null, priority: null, doneAt: null, droppedAt: null, ...s });
    const gone = {
      id: "s9", title: "删掉的那步", done: false, due: null, dueTime: null, priority: null,
      doneAt: null, droppedAt: null, deletedAt: "2026-09-01T00:00:00.000Z",
    };
    expect(v6Client(gone)).toEqual(gone);
    // 本机（v7）读同一份也不丢，version 仍是 7；已删的那条没被当成活的改写
    const d = migrate({ ...v6(), version: 7, tasks: [{ ...v6().tasks[0], subtasks: [gone] }] });
    expect(d.tasks[0].subtasks[0]).toEqual(gone);
    expect(d.version).toBe(7);
  });

  it("migrate 不刷新 updatedAt——带着 deletedAt 的子任务也不例外", () => {
    const d = migrate({
      ...v6(),
      tasks: [{
        ...v6().tasks[0],
        subtasks: [{ ...v6().tasks[0].subtasks[1], deletedAt: "2026-09-01T00:00:00.000Z" }],
      }],
    });
    expect(d.tasks[0].updatedAt).toBe("2026-02-02T00:00:00.000Z");
  });

  it("带着已删子任务的 v7 数据 migrate 两遍等于一遍", () => {
    const raw = {
      ...v6(), version: 7,
      tasks: [{ ...v6().tasks[0], subtasks: [{ ...v6().tasks[0].subtasks[0], deletedAt: "2026-09-01T00:00:00.000Z" }] }],
    };
    const once = migrate(raw);
    expect(migrate(once)).toEqual(once);
  });
});

describe("幂等：迁移过的东西再迁一遍还是它自己", () => {
  const samples: Record<string, unknown> = {
    v1: {
      version: 1, lists: LISTS, sessions: [], settings: {},
      tasks: [{
        id: "t1", title: "老任务", someday: true, who: "李哥",
        createdAt: "2026-01-02T00:00:00.000Z", subtasks: [{ id: "s1", title: "子", done: true }],
      }],
    },
    v4: {
      version: 4, lists: LISTS, sessions: [], settings: {},
      tasks: [{
        id: "t1", title: "旧任务", who: ["李哥"], subtasks: [],
        createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z",
        checkIns: ["2026-08-01", "2026-08-01"],
      }],
      graveyard: [{ id: "gone", at: new Date().toISOString() }],
    },
    当前: defaultData(),
  };
  for (const [name, raw] of Object.entries(samples)) {
    it(`${name} 的数据 migrate 两遍等于一遍`, () => {
      const once = migrate(raw);
      expect(migrate(once)).toEqual(once);
    });
  }
});

describe("未知字段", () => {
  it("任务和子任务上不认识的字段原样带走（新版本写的东西不能被老版本抹掉）", () => {
    const d = migrate({
      version: 5, lists: LISTS, sessions: [], settings: {},
      tasks: [{
        id: "t1", title: "未来任务", subtasks: [{ id: "s1", title: "子", done: false, futureField: "子的新东西" }],
        createdAt: "2026-01-02T00:00:00.000Z", futureField: "任务的新东西",
      }],
    });
    expect((d.tasks[0] as unknown as { futureField: string }).futureField).toBe("任务的新东西");
    expect((d.tasks[0].subtasks[0] as unknown as { futureField: string }).futureField).toBe("子的新东西");
  });

  it("设置里不认识的字段也带走", () => {
    const d = migrate({
      version: 5, lists: LISTS, sessions: [], settings: { futureSetting: 42 }, tasks: [],
    });
    expect((d.settings as unknown as { futureSetting: number }).futureSetting).toBe(42);
  });

  // 【2026-09-01 反转】以前这条锁的是「墓碑上的额外字段会被丢掉」，注释里写着
  // 「锁的是现状不是理想，哪天给墓碑加字段这条会变红」——这一天到了。
  // 墓碑曾是 migrate 里唯一显式重建（`.map(g => ({id, at}))`）的结构，
  // 而 pruneGraveyard 又是 migrate / mergeData / bury 三条路的共同咽喉，
  // 于是新版本给墓碑加的字段，每迁移一次、每同步一次、每彻底删一次各丢一遍
  it("墓碑上的额外字段也原样带走（新版本给墓碑加的字段不能被老版本抹掉）", () => {
    const at = new Date().toISOString();
    const d = migrate({
      version: 5, lists: LISTS, sessions: [], settings: {}, tasks: [],
      graveyard: [{ id: "gone", at, kind: "list" }],
    });
    expect(d.graveyard).toEqual([{ id: "gone", at, kind: "list" }]);
  });

  it("**顶层多出来的整个集合也不许吞**（migrate 曾是 6 键字面量，连痕迹都不留）", () => {
    const d = migrate({
      version: DATA_VERSION + 1, lists: LISTS, sessions: [], settings: {}, tasks: [],
      projects: [{ id: "p1", name: "第 7 版才有的" }],
      notebooks: { a: 1 },
    });
    expect((d as unknown as { projects: unknown }).projects).toEqual([{ id: "p1", name: "第 7 版才有的" }]);
    expect((d as unknown as { notebooks: unknown }).notebooks).toEqual({ a: 1 });
  });

  it("version 取 max：老数据升上来，新数据**不许降回去**", () => {
    // 降回去 = 磁盘上那份从此自称第 6 版 = 下次推上云把服务端的 schema 棘轮也拉回去
    expect(migrate({ version: 2, tasks: [], lists: LISTS }).version).toBe(DATA_VERSION);
    expect(migrate({ version: DATA_VERSION + 1, tasks: [], lists: LISTS }).version).toBe(DATA_VERSION + 1);
    expect(migrate({ tasks: [], lists: LISTS }).version).toBe(DATA_VERSION); // 压根没写版本号的老裸数据
  });

  it("不是对象的东西照旧不许铺开（字符串会被 spread 成 {0:'a'}，那是垃圾不是数据）", () => {
    for (const junk of ["一个字符串", 42, [], null, undefined]) {
      const d = migrate(junk);
      expect(d.tasks).toEqual([]);
      expect(d.version).toBe(DATA_VERSION);
      expect(Object.keys(d).sort()).toEqual(
        ["graveyard", "lists", "sessions", "settings", "tasks", "version"],
      );
    }
  });
});

describe("本次新增：子任务的 doneAt", () => {
  it("老子任务补的是 null，不是 undefined（undefined 会被 JSON.stringify 整个吞掉）", () => {
    const d = migrate({
      version: 5, lists: LISTS, sessions: [], settings: {},
      tasks: [{
        id: "t1", title: "装修", createdAt: "2026-01-02T00:00:00.000Z",
        subtasks: [{ id: "s1", title: "量尺寸", done: false }],
      }],
    });
    const s = d.tasks[0].subtasks[0];
    expect(s.doneAt).toBeNull();
    expect("doneAt" in s).toBe(true);
    expect(JSON.parse(JSON.stringify(s))).toHaveProperty("doneAt", null);
  });

  it("已经勾掉但没有完成时刻的老子任务，补的还是 null——绝不拿「现在」冒充", () => {
    const d = migrate({
      version: 5, lists: LISTS, sessions: [], settings: {},
      tasks: [{
        id: "t1", title: "装修", createdAt: "2026-01-02T00:00:00.000Z",
        subtasks: [{ id: "s1", title: "量尺寸", done: true }],
      }],
    });
    expect(d.tasks[0].subtasks[0].done).toBe(true);
    expect(d.tasks[0].subtasks[0].doneAt).toBeNull();
  });
});

describe("migrate 不许集体刷新 updatedAt", () => {
  // 全库刷新 = 本机所有任务都显得比云端新 = 下一次同步拿本机盖掉另一台的改动。
  // 真实数据从 v4 起每条都带着这个戳，所以「一个都不动」就是这条防线的全部内容——
  // 给 Subtask 加字段最容易破的也正是这里（加完字段顺手在 migrate 里盖个戳，全库就废了）
  it("原本有戳的一条都不刷新，加了 doneAt 之后也不刷新", () => {
    const stamps = ["2026-03-04T00:00:00.000Z", "2026-05-06T00:00:00.000Z", "2026-07-08T00:00:00.000Z"];
    const d = migrate({
      version: 5, lists: LISTS, sessions: [], settings: {},
      tasks: stamps.map((at, i) => ({
        id: `t${i}`, title: `第${i}件`, createdAt: "2026-01-02T00:00:00.000Z", updatedAt: at,
        subtasks: [{ id: `s${i}`, title: "子", done: true }], // 正是会被补 doneAt 的那种子任务
      })),
    });
    expect(d.tasks.map((t) => t.updatedAt)).toEqual(stamps);
    expect(d.tasks.every((t) => t.subtasks[0].doneAt === null)).toBe(true);
  });

  it("清单原本有戳的也不刷新", () => {
    const d = migrate({ version: 5, lists: LISTS, sessions: [], settings: {}, tasks: [] });
    expect(d.lists[0].updatedAt).toBe(LISTS[0].updatedAt);
  });
});

describe("循环推进：子任务的 done 和 doneAt 一起清", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    while (appStore.getState().undoDepth > 0) undo();
    await flushSave();
    localStorage.clear();
    appStore.setState({ data: defaultData(), loaded: true, loadError: null, dataFromNewer: null, undoDepth: 0 });
  });

  const getTask = (id: string): Task => {
    const t = appStore.getState().data.tasks.find((x) => x.id === id);
    if (!t) throw new Error(`task ${id} not found`);
    return t;
  };

  /** 建一件带已完成子任务的循环任务，返回它的 id */
  function makeRepeating(title: string): string {
    const id = addTask({ title, due: "2026-08-17", repeat: { kind: "weekly", days: [1] } });
    addSubtask(id, "写议程");
    toggleSubtask(id, getTask(id).subtasks[0].id);
    expect(getTask(id).subtasks[0].doneAt).toBeTruthy(); // 勾上就该有戳
    return id;
  }

  it("单条完成：本体推进后子任务 done=false 且 doneAt=null，已完成副本保留 doneAt", () => {
    const id = makeRepeating("周会");
    const stamp = getTask(id).subtasks[0].doneAt;
    completeTask(id);

    const advanced = getTask(id);
    expect(advanced.subtasks[0].done).toBe(false);
    expect(advanced.subtasks[0].doneAt).toBeNull();

    const copy = appStore.getState().data.tasks.find((t) => t.id !== id)!;
    expect(copy.subtasks[0].done).toBe(true);
    expect(copy.subtasks[0].doneAt).toBe(stamp);
  });

  it("批量完成：跟单条逐字同口径（这两处是复制粘贴的双胞胎，改一处必挂）", () => {
    const a = makeRepeating("周会");
    const b = makeRepeating("月报");
    const stampA = getTask(a).subtasks[0].doneAt;
    completeTasks([a, b]);

    for (const id of [a, b]) {
      expect(getTask(id).subtasks[0].done).toBe(false);
      expect(getTask(id).subtasks[0].doneAt).toBeNull();
    }
    const copies = appStore.getState().data.tasks.filter((t) => t.id !== a && t.id !== b);
    expect(copies).toHaveLength(2);
    for (const c of copies) expect(c.subtasks[0].doneAt).toBeTruthy();
    expect(copies.find((c) => c.title === "周会")!.subtasks[0].doneAt).toBe(stampA);
  });
});
