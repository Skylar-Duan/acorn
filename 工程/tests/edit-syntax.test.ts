import { describe, expect, it } from "vitest";
import { newTask, type Task } from "../src/core/model";
import { editedCategoryPatch, editedTitlePatch, parseEditedTitle } from "../src/core/editSyntax";

const now = new Date(2026, 9, 16, 12);
const parse = (text: string) => parseEditedTitle(text, { now, listNames: ["工作", "生活"] });
const task = (patch: Partial<Task> = {}) => ({
  ...newTask({ title: "原任务", listId: "work" }), due: "2026-10-20", dueTime: "18:00", who: ["李哥"], tags: ["项目"], priority: 3 as const,
  ...patch,
});

describe("直接编辑标题的显式属性替换", () => {
  it("~今天替换旧日期，没写钟点、循环或归类时原样保留", () => {
    const current = task({ repeat: { kind: "daily", every: 1 } });
    const p = parse("新任务 ~今天");
    const patch = { ...editedTitlePatch(current, p), ...editedCategoryPatch(current, p, null) };
    expect(patch).toEqual({ title: "新任务", due: "2026-10-16" });
    expect({ ...current, ...patch }).toMatchObject({ dueTime: "18:00", repeat: { kind: "daily", every: 1 }, who: ["李哥"], tags: ["项目"], listId: "work", priority: 3 });
  });

  it("@和/覆盖对应字段，未提及的日期和重要性不清空", () => {
    const current = task();
    const p = parse("新任务 @张总 @王工 /生活");
    expect({ ...editedTitlePatch(current, p), ...editedCategoryPatch(current, p, "life") }).toEqual({ title: "新任务", who: ["张总", "王工"], listId: "life" });
  });

  it("无标记只改标题，符号未写完或无效日期仍是正文", () => {
    for (const text of ["改好的任务", "明天开会", "~不存在 @ /", "截止~2026-02-30"]) {
      expect(editedTitlePatch(task(), parse(text))).toEqual({ title: text });
      expect(editedCategoryPatch(task(), parse(text), null)).toEqual({});
    }
  });

  it("只写属性标记保留原标题，只写时间保留旧日期", () => {
    expect(editedTitlePatch(task(), parse("~今天"))).toEqual({ due: "2026-10-16" });
    expect(editedTitlePatch(task(), parse("~下午3点"))).toEqual({ dueTime: "15:00" });
    expect(editedTitlePatch(task({ due: null, dueTime: null }), parse("~下午3点"))).toEqual({ due: "2026-10-16", dueTime: "15:00" });
  });

  it("新循环覆盖旧循环，没写循环不删除，!低覆盖原重要性", () => {
    expect(editedTitlePatch(task({ repeat: { kind: "daily", every: 1 } }), parse("原任务 ~每周五"))).toMatchObject({ repeat: { kind: "weekly", days: [5] } });
    expect(editedTitlePatch(task(), parse("原任务 !低"))).toEqual({ priority: 1 });
  });

  it("网址、邮箱和文件路径中的符号不变成归类或日期", () => {
    for (const text of ["检查 a@example.com", "打开 https://example.com/@李哥#项目/~今天", "文件 C:/work/@某人/~明天.txt", "路径 /home/user/工作"]) {
      const p = parse(text);
      expect(p.title).toBe(text);
      expect(p.chips).toEqual([]);
      expect(editedCategoryPatch(task(), p, null)).toEqual({});
    }
  });

  it("子任务只改日期时保留分行正文和原来的时间", () => {
    const current = { id: "sub", title: "材料\n复核", done: false, due: "2026-10-20", dueTime: "09:00" };
    const p = parseEditedTitle("材料\n复核 ~今天", { now, listNames: [], keepNewlines: true });
    expect(editedTitlePatch(current, p)).toEqual({ due: "2026-10-16" });
  });
});
