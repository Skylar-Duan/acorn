// 导入 / 导出的口径守卫。用户明确要求：勾了「保留数据」就必须真的保留，
// 以后接服务器同步也走同一份信封——所以这些用例是硬约束，别为了图方便改掉。
import { describe, expect, it } from "vitest";
import { defaultData, migrate, newTask, DATA_VERSION } from "../src/core/model";
import type { AppData } from "../src/core/model";
import { pack, toJsonFile, unpack, TRANSFER_APP } from "../src/core/transfer";

function sample(): AppData {
  const d = defaultData();
  d.tasks = [
    newTask({ title: "交周报", due: "2026-08-20", dueTime: "15:00", priority: 3, tags: ["汇报"], who: "李哥" }),
    newTask({ title: "带自己日期的子任务", subtasks: [{ id: "s1", title: "先列提纲", done: false, due: "2026-08-19", dueTime: null, priority: 2 }] }),
    newTask({ title: "回收站里的", deletedAt: new Date("2026-08-10T00:00:00Z").toISOString() }),
  ];
  d.sessions = [{ taskId: null, date: "2026-08-17", minutes: 25, startedAt: "2026-08-17T01:00:00.000Z" }];
  d.settings.theme = "desert";
  d.settings.sortMode = "priority";
  return d;
}

describe("导出信封", () => {
  it("带上 app / schema / 版本 / 时刻，数据原样装在 data 里", () => {
    const d = sample();
    const env = pack(d, "1.2.1", new Date("2026-08-17T10:00:00Z"));
    expect(env.app).toBe(TRANSFER_APP);
    expect(env.schema).toBe(DATA_VERSION);
    expect(env.appVersion).toBe("1.2.1");
    expect(env.exportedAt).toBe("2026-08-17T10:00:00.000Z");
    expect(env.data).toEqual(d);
  });

  it("导出的是缩进过的可读 JSON", () => {
    const text = toJsonFile(sample(), "1.2.1");
    expect(text).toContain('"app": "acorn"');
    expect(text.split("\n").length).toBeGreaterThan(20);
  });
});

describe("导入解包", () => {
  it("信封 → 原样还回来（往返不丢东西）", () => {
    const d = sample();
    const back = unpack(JSON.parse(toJsonFile(d, "1.2.1")));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.kind).toBe("envelope");
    expect(back.appVersion).toBe("1.2.1");
    expect(back.data).toEqual(migrate(d));
  });

  it("导出→导入→再导出，逐字节一致（同步到服务器时不会凭空产生差异）", () => {
    // 应用里的数据总是 migrate 过的，所以基准取 migrate 后的那份
    const at = new Date("2026-08-17T10:00:00Z");
    const first = toJsonFile(migrate(sample()), "1.2.1", at);
    const back = unpack(JSON.parse(first));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    const second = toJsonFile(back.data, "1.2.1", at);
    expect(second).toBe(first);
  });

  it("老版本导出的裸数据仍然能导入（去年的备份不能作废）", () => {
    const d = sample();
    const legacy = JSON.parse(JSON.stringify(d)); // v1.0/v1.1 导出的就是裸 AppData
    const back = unpack(legacy);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.kind).toBe("bare");
    expect(back.appVersion).toBeNull();
    expect(back.data.tasks.map((t) => t.title)).toEqual(d.tasks.map((t) => t.title));
  });

  it("v1 老数据（有 someday、子任务没日期字段）导入后补齐且不丢任务", () => {
    const v1 = {
      version: 1,
      lists: [{ id: "l1", name: "工作", color: "clay", order: 0 }],
      tasks: [
        { id: "t1", title: "老任务", someday: true, listId: "l1", tags: [], who: null, priority: 1, due: null, subtasks: [{ id: "s", title: "子", done: false }] },
      ],
      settings: { theme: "forest", mode: "light" },
    };
    const back = unpack(v1);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.data.tasks).toHaveLength(1);
    expect(back.data.tasks[0].title).toBe("老任务");
    expect("someday" in back.data.tasks[0]).toBe(false);
    expect(back.data.tasks[0].subtasks[0]).toMatchObject({ title: "子", due: null, priority: null });
    expect(back.data.version).toBe(DATA_VERSION);
  });

  it("回收站里的任务照样带过去（保留数据就是全部保留）", () => {
    const back = unpack(JSON.parse(toJsonFile(sample(), "1.2.1")));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.data.tasks.filter((t) => t.deletedAt).length).toBe(1);
  });

  it("专注记录与设置一并带过去", () => {
    const back = unpack(JSON.parse(toJsonFile(sample(), "1.2.1")));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.data.sessions).toHaveLength(1);
    expect(back.data.settings.theme).toBe("desert");
    expect(back.data.settings.sortMode).toBe("priority");
  });

  it("不是橡果的文件一律拒绝，不会把现有数据清空", () => {
    for (const bad of [null, 42, "字符串", {}, { hello: 1 }, { app: "acorn" }, { app: "acorn", data: {} }, []]) {
      const r = unpack(bad);
      expect(r.ok).toBe(false);
    }
  });

  it("信封里 schema 比本机新也照样尽力读（只补不删）", () => {
    const env = { app: TRANSFER_APP, schema: 99, appVersion: "9.9.9", exportedAt: "x", data: { ...sample(), version: 99 } };
    const r = unpack(env);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.tasks.length).toBe(3);
    expect(r.data.version).toBe(DATA_VERSION);
  });
});
