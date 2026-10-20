import { describe, expect, it } from "vitest";
import { newTask, type Subtask, type Task } from "../src/core/model";
import { subtaskTitlePreview, taskTitlePreview, type EditPreviewContext } from "../src/core/editPreview";

const context: EditPreviewContext = {
  now: new Date(2026, 9, 20, 12),
  lists: [{ id: "work", name: "工作" }, { id: "life", name: "生活" }],
  weekendDay: "sat",
};
const task = (patch: Partial<Task> = {}): Task => ({
  ...newTask({ title: "原任务", listId: "work" }),
  due: "2026-10-25", dueTime: "18:00", priority: 1,
  who: ["李哥"], tags: ["原标签"], repeat: { kind: "daily", every: 1 },
  ...patch,
});

describe("已有标题输入时的只读预览", () => {
  it("打完 !!! 和 ~明天 即预览属性，删掉标记立即恢复持久值", () => {
    const current = task();
    const before = structuredClone(current);
    const result = taskTitlePreview(current, "原任务 !!! ~明天", context);
    expect(result.task).toMatchObject({ title: "原任务", priority: 3, due: "2026-10-21", dueTime: "18:00", repeat: current.repeat });
    expect(result.parsed?.chips.map((chip) => chip.kind)).toEqual(expect.arrayContaining(["priority", "date"]));
    expect(taskTitlePreview(current, "原任务", context).task).toBe(current);
    expect(current).toEqual(before);
  });

  it("取消、空输入、未改动旧标题不会生成补丁或重新识别旧正文", () => {
    const current = task({ title: "旧题 !!! ~明天", priority: 1 });
    for (const draft of [null, undefined, "", "   ", current.title]) {
      const result = taskTitlePreview(current, draft, context);
      expect(result.task).toBe(current);
      expect(result.parsed).toBeNull();
    }
  });

  it("只写标记保留原标题，未写日期、钟点、循环的字段不清空", () => {
    const current = task();
    expect(taskTitlePreview(current, "!!!", context).task).toMatchObject({ title: current.title, priority: 3, due: current.due, dueTime: current.dueTime, repeat: current.repeat });
    expect(taskTitlePreview(current, "~下午3点", context).task).toMatchObject({ title: current.title, due: current.due, dueTime: "15:00" });
    expect(taskTitlePreview(current, "~每周末", context).task.repeat).toEqual({ kind: "weekly", days: [6] });
    expect(taskTitlePreview(task({ due: null, dueTime: null }), "~下午3点", context).task).toMatchObject({ due: "2026-10-20", dueTime: "15:00" });
  });

  it("母任务只替换显式归类；未知清单可展示但没有临时 id 或创建动作", () => {
    const current = task();
    const result = taskTitlePreview(current, "原任务 @王工 /生 #新标签", context);
    expect(result.task).toMatchObject({ who: ["王工"], listId: "life", tags: ["新标签"], due: current.due, priority: 1 });
    expect(result.listName).toBe("生活");
    expect(result.unresolvedListNames).toEqual([]);
    const unknown = taskTitlePreview(current, "原任务 /全新清单", context);
    expect(unknown.listName).toBe("全新清单");
    expect(unknown.unresolvedListNames).toEqual(["全新清单"]);
    expect(unknown.task.listId).toBe("work");
    expect(context.lists).toHaveLength(2);
  });

  it("重名清单沿用当前归属，与确认保存时的首选 id 一致", () => {
    const duplicated = { ...context, lists: [{ id: "other", name: "工作" }, ...context.lists] };
    expect(taskTitlePreview(task(), "原任务 /工作", duplicated).task.listId).toBe("work");
  });

  it("循环、图片和未来字段全都保留，预览不会改写源对象或挂载字段", () => {
    const current = task({ images: [{ id: "im", name: "图", dataUrl: "data:image/png;base64,aA==", width: 1, height: 1, bytes: 1 }] });
    Object.assign(current, { futureField: { keep: true } });
    Object.freeze(current);
    Object.freeze(current.who);
    Object.freeze(current.tags);
    const result = taskTitlePreview(current, "新标题 !!!", context);
    expect(result.task.images).toBe(current.images);
    expect((result.task as Task & { futureField: unknown }).futureField).toBe((current as Task & { futureField: unknown }).futureField);
    expect(current.title).toBe("原任务");
    expect(current.priority).toBe(1);
  });

  it("当前记录在输入期间外部更新时，没显式编辑的元数据取最新值", () => {
    const current = task({ due: "2026-11-01", who: ["新需求方"], priority: 2 });
    expect(taskTitlePreview(current, "修改的标题", context).task).toMatchObject({ title: "修改的标题", due: "2026-11-01", who: ["新需求方"], priority: 2 });
  });
});

describe("子任务编辑预览", () => {
  const sub = (patch: Partial<Subtask> = {}): Subtask => ({ id: "s", title: "材料\n复核", done: false, due: null, priority: null, who: ["王工"], listIds: ["work"], ...patch });

  it("显式重要性覆盖继承；没有标记的空/零和继承值均不被默认值替换", () => {
    expect(subtaskTitlePreview(sub(), "材料\n复核 !!!", context).subtask.priority).toBe(3);
    expect(subtaskTitlePreview(sub(), "修改的标题", context).subtask.priority).toBeNull();
    expect(subtaskTitlePreview(sub({ priority: 0 }), "修改的标题", context).subtask.priority).toBe(0);
    expect(subtaskTitlePreview(sub({ priority: 0 }), "~明天", context).subtask).toMatchObject({ title: "材料\n复核", due: "2026-10-21", priority: 0 });
  });

  it("追加多个人和清单，不覆盖本步已有归类，不改母任务；#保留正文", () => {
    const parent = task();
    const current = sub();
    const before = structuredClone({ parent, current });
    const result = subtaskTitlePreview(current, "材料\n复核 @王工 @新人 /生活 /全新清单 #正文", context);
    expect(result.subtask).toMatchObject({ title: "材料\n复核 #正文", who: ["王工", "新人"], listIds: ["work", "life"] });
    expect(result.listNames).toEqual(["工作", "生活", "全新清单"]);
    expect(result.unresolvedListNames).toEqual(["全新清单"]);
    expect({ parent, current }).toEqual(before);
  });

  it("取消、标记移除与仅标记输入都保留原始子任务，包括继承和未知分类 id", () => {
    const current = sub({ listIds: ["work", "future-list"] });
    const draft = subtaskTitlePreview(current, "!!! ~明天", context);
    expect(draft.subtask).toMatchObject({ title: current.title, due: "2026-10-21", priority: 3, listIds: ["work", "future-list"] });
    expect(subtaskTitlePreview(current, null, context).subtask).toBe(current);
    expect(subtaskTitlePreview(current, current.title, context).subtask).toBe(current);
    expect(current.priority).toBeNull();
    expect(current.due).toBeNull();
  });
});
