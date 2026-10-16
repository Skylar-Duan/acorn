import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendedSubCategories, editedTitlePatch, parseEditedTitle } from "../src/core/editSyntax";
import { dedupeListsByName, mergeData } from "../src/core/merge";
import { DATA_VERSION, defaultData, migrate, newTask, type AppData, type Subtask } from "../src/core/model";
import { searchTasks } from "../src/core/search";
import { byList, byWho } from "../src/core/stats";
import { allWho, appStore, categoryRows, deleteList, flushSave, undo, updateSubtask } from "../src/core/store";

function fixture(): AppData {
  const data = defaultData();
  data.lists = [
    { id: "work", name: "工作", color: "clay", order: 1, updatedAt: "2026-10-16T00:00:00Z" },
    { id: "extra", name: "独立协作", color: "moss", order: 2, updatedAt: "2026-10-16T00:00:00Z" },
  ];
  data.tasks = [newTask({ id: "parent", title: "母任务", listId: "work", who: ["父需求方"], updatedAt: "2026-10-16T00:00:00Z", subtasks: [
    { id: "one", title: "第一步", done: false, who: ["父需求方", "子需求方"], listIds: ["work", "extra"], futureField: { keep: true } } as Subtask,
    { id: "two", title: "第二步", done: false, who: ["子需求方"], listIds: ["extra"] },
    { id: "done", title: "已完成", done: true, doneAt: "2026-10-16T03:00:00Z", who: ["子需求方"], listIds: ["extra"] },
    { id: "drop", title: "已放弃", done: false, droppedAt: "2026-10-16T03:00:00Z", who: ["子需求方"], listIds: ["extra"] },
    { id: "deleted", title: "已删除", done: false, deletedAt: "2026-10-16T03:00:00Z", who: ["子需求方"], listIds: ["extra"] },
  ] })];
  return data;
}

beforeEach(async () => {
  await flushSave();
  while (appStore.getState().undoDepth > 0) undo();
  await flushSave();
  localStorage.clear();
  appStore.setState({ data: fixture(), loaded: true, loadError: null, wiped: false, undoDepth: 0 });
});
afterEach(async () => { await flushSave(); });

describe("子任务追加归类的筛选和兼容", () => {
  it("父归类只列母1行，子追加只列相应开放子行，角标与统计一致", () => {
    const data = fixture();
    expect(categoryRows(data, { who: "父需求方" }).map((r) => r.sub?.id ?? r.task.id)).toEqual(["parent"]);
    expect(categoryRows(data, { who: "子需求方" }).map((r) => r.sub?.id)).toEqual(["one", "two"]);
    expect(categoryRows(data, { listId: "work" })).toHaveLength(1);
    expect(categoryRows(data, { listId: "extra" })).toHaveLength(2);
    expect(allWho(data).find((w) => w.who === "子需求方")?.open).toBe(2);
    expect(byWho(data.tasks, "2026-10-16", "2026-10-16").find((w) => w.who === "子需求方")).toMatchObject({ open: 2, done: 1 });
    expect(byList(data.tasks, data.lists, "2026-10-16", "2026-10-16").find((l) => l.id === "extra")).toMatchObject({ open: 2, done: 1 });
    data.tasks[0].done = true;
    expect(categoryRows(data, { who: "子需求方" })).toEqual([]);
    expect(allWho(data).find((w) => w.who === "子需求方")?.open).toBe(0);
  });

  it("搜索能找到子任务追加的需求方和清单名，已删除子不贡献", () => {
    const data = fixture();
    expect(searchTasks(data.tasks, data.lists, "子需求方").map((h) => h.task.id)).toEqual(["parent"]);
    expect(searchTasks(data.tasks, data.lists, "独立协作").map((h) => h.task.id)).toEqual(["parent"]);
    data.tasks[0].subtasks.forEach((s) => { s.deletedAt = "2026-10-16T03:00:00Z"; });
    expect(searchTasks(data.tasks, data.lists, "子需求方")).toEqual([]);
  });

  it("追加去重，未支持的#保留正文，时间和循环仍替换", () => {
    const sub = fixture().tasks[0].subtasks[0];
    expect(appendedSubCategories(sub, ["新伙伴", "新伙伴"], ["extra", "extra"])).toEqual({ who: ["父需求方", "子需求方", "新伙伴"] });
    const p = parseEditedTitle("第一步 #正文 ~每周五 !高", { now: new Date(2026, 9, 16, 12), listNames: [], skip: ["tag"], keepNewlines: true });
    expect(editedTitlePatch(sub, p)).toMatchObject({ title: "第一步 #正文", repeat: { kind: "weekly", days: [5] }, priority: 3, due: "2026-10-16" });
  });

  it("老数据不补新键，读入后改其它字段再写出，未来字段和追加归类原样保留", () => {
    const data = fixture();
    data.tasks[0].subtasks.push({ id: "old", title: "旧步骤", done: false });
    const read = migrate(JSON.parse(JSON.stringify(data)));
    expect(read.tasks[0].subtasks.find((s) => s.id === "old")).not.toHaveProperty("who");
    expect(read.tasks[0].subtasks.find((s) => s.id === "old")).not.toHaveProperty("listIds");
    appStore.setState({ data: read });
    updateSubtask("parent", "one", { title: "只改标题" });
    const saved = JSON.parse(JSON.stringify(appStore.getState().data));
    expect(saved.tasks[0].subtasks[0]).toMatchObject({ title: "只改标题", who: ["父需求方", "子需求方"], listIds: ["work", "extra"], futureField: { keep: true } });
    const remote = structuredClone(saved);
    remote.tasks[0].updatedAt = "2099-01-01T00:00:00Z";
    expect(mergeData(data, remote).data.tasks[0].subtasks[0]).toEqual(remote.tasks[0].subtasks[0]);
    expect(DATA_VERSION).toBe(8);
  });

  it("同名清单合并会重挂子追加ID、去重并更新母任务改动时刻，母归属不变", () => {
    const data = fixture();
    data.lists.push({ id: "copy", name: "独立协作", color: "moss", order: 3, updatedAt: "2026-10-17T00:00:00Z" });
    data.tasks[0].subtasks[0].listIds = ["extra", "copy"];
    const at = "2026-10-18T00:00:00Z";
    const result = dedupeListsByName(data, at);
    expect(result.folded).toBe(1);
    expect(result.data.tasks[0]).toMatchObject({ listId: "work", updatedAt: at });
    const keep = result.data.lists.find((l) => l.name === "独立协作")!.id;
    expect(result.data.tasks[0].subtasks[0].listIds).toEqual([keep]);
    expect(result.data.tasks[0].subtasks[0]).toHaveProperty("futureField", { keep: true });
  });

  it("删除清单只移除该清单的子签，母归属/其余子签保留，撤销能完整恢复", () => {
    deleteList("extra");
    const parent = appStore.getState().data.tasks[0];
    expect(parent.listId).toBe("work");
    expect(parent.subtasks[0]).toMatchObject({ who: ["父需求方", "子需求方"], listIds: ["work"] });
    expect(parent.subtasks[0]).toHaveProperty("futureField", { keep: true });
    undo();
    expect(appStore.getState().data.tasks[0].subtasks[0].listIds).toEqual(["work", "extra"]);
  });
});
