// 合并口径的硬约束。两台设备各改各的，合到一起绝不能凭空丢东西——
// 这些用例就是那条底线，改动前先想清楚为什么。
import { describe, expect, it } from "vitest";
import { bury, mergeData } from "../src/core/merge";
import { DATA_VERSION, defaultData, newTask, pruneGraveyard } from "../src/core/model";
import type { AppData, List, Task } from "../src/core/model";

const T0 = "2026-08-20T10:00:00.000Z";
const T1 = "2026-08-20T11:00:00.000Z";
const T2 = "2026-08-20T12:00:00.000Z";

function base(tasks: Task[] = [], lists: List[] = []): AppData {
  const d = defaultData();
  return { ...d, tasks, lists, sessions: [], graveyard: [] };
}

function task(id: string, title: string, updatedAt: string, extra: Partial<Task> = {}): Task {
  return { ...newTask({ title }), id, updatedAt, ...extra };
}

function list(id: string, name: string, updatedAt: string): List {
  return { id, name, color: "clay", order: 0, updatedAt };
}

const titles = (d: AppData) => d.tasks.map((t) => t.title).sort();

describe("只有一边有的东西", () => {
  it("本机新加的，云端没有 → 留着", () => {
    const local = base([task("a", "本机加的", T1)]);
    const remote = base([]);
    expect(titles(mergeData(local, remote).data)).toEqual(["本机加的"]);
  });

  it("云端有的，本机没有 → 拉下来", () => {
    const local = base([]);
    const remote = base([task("b", "手机上加的", T1)]);
    expect(titles(mergeData(local, remote).data)).toEqual(["手机上加的"]);
  });

  it("两边各加各的 → 两条都在，一条不丢", () => {
    const local = base([task("a", "电脑上加的", T1)]);
    const remote = base([task("b", "手机上加的", T1)]);
    expect(titles(mergeData(local, remote).data)).toEqual(["手机上加的", "电脑上加的"]);
  });
});

describe("同一件事两边都改过", () => {
  it("谁改得晚听谁的（云端晚）", () => {
    const local = base([task("a", "旧标题", T1)]);
    const remote = base([task("a", "手机上改的", T2)]);
    expect(titles(mergeData(local, remote).data)).toEqual(["手机上改的"]);
  });

  it("谁改得晚听谁的（本机晚）", () => {
    const local = base([task("a", "电脑上改的", T2)]);
    const remote = base([task("a", "旧标题", T1)]);
    expect(titles(mergeData(local, remote).data)).toEqual(["电脑上改的"]);
  });

  it("时刻一模一样时听本机的——两台机器不能来回打架", () => {
    const local = base([task("a", "本机", T1)]);
    const remote = base([task("a", "云端", T1)]);
    expect(titles(mergeData(local, remote).data)).toEqual(["本机"]);
  });

  it("整条替换，不逐字段拼——赢的那条的所有字段都跟着走", () => {
    const local = base([task("a", "旧", T1, { priority: 3, due: "2026-09-01", notes: "旧备注" })]);
    const remote = base([task("a", "新", T2, { priority: 1, due: null, notes: "" })]);
    const t = mergeData(local, remote).data.tasks[0];
    expect(t.title).toBe("新");
    expect(t.priority).toBe(1);
    expect(t.due).toBeNull();
    expect(t.notes).toBe("");
  });
});

describe("删除", () => {
  it("进回收站是「改」不是「消失」：删得晚就以删为准，条目还在（在回收站里）", () => {
    const local = base([task("a", "事", T1)]);
    const remote = base([task("a", "事", T2, { deletedAt: T2 })]);
    const t = mergeData(local, remote).data.tasks[0];
    expect(t.deletedAt).toBe(T2);
  });

  it("一边删进回收站、另一边又改过而且改得更晚 → 以「改」为准，事还活着", () => {
    const local = base([task("a", "改回来了", T2)]);
    const remote = base([task("a", "事", T1, { deletedAt: T1 })]);
    expect(mergeData(local, remote).data.tasks[0].deletedAt).toBeNull();
  });

  it("彻底删除留墓碑：另一边同步过来不会把它拉回来", () => {
    const local: AppData = { ...base([]), graveyard: [{ id: "a", at: T2 }] };
    const remote = base([task("a", "已经被我清掉的", T1)]);
    expect(mergeData(local, remote).data.tasks).toEqual([]);
  });

  it("墓碑立得比改动早 → 那是「删完又建了同 id 的」，以改动为准（不误杀）", () => {
    const local: AppData = { ...base([]), graveyard: [{ id: "a", at: T0 }] };
    const remote = base([task("a", "后来又有的", T1)]);
    expect(titles(mergeData(local, remote).data)).toEqual(["后来又有的"]);
  });

  it("墓碑双向生效：云端清掉的，本机也跟着清", () => {
    const local = base([task("a", "本机还留着", T1)]);
    const remote: AppData = { ...base([]), graveyard: [{ id: "a", at: T2 }] };
    const r = mergeData(local, remote);
    expect(r.data.tasks).toEqual([]);
    expect(r.summary.removed).toBe(1);
  });

  it("墓碑本身也合并，两边的都留下", () => {
    const local: AppData = { ...base([]), graveyard: [{ id: "a", at: T1 }] };
    const remote: AppData = { ...base([]), graveyard: [{ id: "b", at: T1 }] };
    expect(mergeData(local, remote).data.graveyard.map((g) => g.id).sort()).toEqual(["a", "b"]);
  });
});

describe("清单", () => {
  it("两边各建各的清单 → 都在", () => {
    const local = base([], [list("l1", "工作", T1)]);
    const remote = base([], [list("l2", "生活", T1)]);
    expect(mergeData(local, remote).data.lists.map((l) => l.name).sort()).toEqual(["工作", "生活"]);
  });

  it("改名以晚的为准", () => {
    const local = base([], [list("l1", "工作", T1)]);
    const remote = base([], [list("l1", "工作（新）", T2)]);
    expect(mergeData(local, remote).data.lists[0].name).toBe("工作（新）");
  });

  it("删掉的清单不会被另一边拉回来（清单和任务共用同一本墓碑）", () => {
    const local: AppData = { ...base([], []), graveyard: [{ id: "l1", at: T2 }] };
    const remote = base([], [list("l1", "已删的清单", T1)]);
    expect(mergeData(local, remote).data.lists).toEqual([]);
  });
});

describe("专注记录", () => {
  const s = (taskId: string | null, startedAt: string, minutes: number) => ({
    taskId, date: startedAt.slice(0, 10), minutes, startedAt,
  });

  it("只增不减，两边合起来去重", () => {
    const local: AppData = { ...base([]), sessions: [s("a", T1, 25), s("a", T2, 25)] };
    const remote: AppData = { ...base([]), sessions: [s("a", T1, 25), s("b", T0, 50)] };
    const out = mergeData(local, remote).data.sessions;
    expect(out).toHaveLength(3);
    expect(out.map((x) => x.startedAt)).toEqual([T0, T1, T2]);
  });

  it("同一次记录两边分钟数不同 → 取多的（一边中途关机没记全）", () => {
    const local: AppData = { ...base([]), sessions: [s("a", T1, 10)] };
    const remote: AppData = { ...base([]), sessions: [s("a", T1, 25)] };
    expect(mergeData(local, remote).data.sessions[0].minutes).toBe(25);
  });
});

describe("设置不同步", () => {
  it("云端的主题不会覆盖这台机器的", () => {
    const local: AppData = { ...base([]), settings: { ...defaultData().settings, theme: "ocean" } };
    const remote: AppData = { ...base([]), settings: { ...defaultData().settings, theme: "desert" } };
    expect(mergeData(local, remote).data.settings.theme).toBe("ocean");
  });
});

describe("合并结果的形状", () => {
  it("版本号永远是当前版本", () => {
    expect(mergeData(base([]), base([])).data.version).toBe(DATA_VERSION);
  });

  it("summary 说清这次实际发生了什么", () => {
    const local = base([task("a", "本机的", T1), task("b", "两边都有的", T1)]);
    const remote = base([task("b", "云端改过的", T2), task("c", "云端新的", T1)]);
    const { summary } = mergeData(local, remote);
    expect(summary).toEqual({ added: 1, updated: 1, removed: 0 });
  });

  it("合并是幂等的：再合一次结果不变", () => {
    const local = base([task("a", "甲", T1)]);
    const remote = base([task("b", "乙", T2)]);
    const once = mergeData(local, remote).data;
    const twice = mergeData(once, remote).data;
    expect(titles(twice)).toEqual(titles(once));
    expect(mergeData(once, remote).summary).toEqual({ added: 0, updated: 0, removed: 0 });
  });
});

describe("墓碑维护", () => {
  const now = new Date("2026-08-21T00:00:00.000Z").getTime();

  it("超过 180 天的墓碑清掉", () => {
    const old = new Date(now - 200 * 86400000).toISOString();
    const fresh = new Date(now - 10 * 86400000).toISOString();
    const kept = pruneGraveyard([{ id: "old", at: old }, { id: "fresh", at: fresh }], now);
    expect(kept.map((g) => g.id)).toEqual(["fresh"]);
  });

  it("同一个 id 只留最晚那次", () => {
    const kept = pruneGraveyard([{ id: "a", at: T0 }, { id: "a", at: T2 }, { id: "a", at: T1 }], now);
    expect(kept).toEqual([{ id: "a", at: T2 }]);
  });

  it("时刻是乱码的墓碑直接丢掉，不至于让整次合并炸掉", () => {
    expect(pruneGraveyard([{ id: "a", at: "不是时间" }], now)).toEqual([]);
  });

  it("bury 追加，空数组什么都不做", () => {
    expect(bury([], [], T1)).toEqual([]);
    expect(bury([], ["a", "b"], T1).map((g) => g.id).sort()).toEqual(["a", "b"]);
  });
});
