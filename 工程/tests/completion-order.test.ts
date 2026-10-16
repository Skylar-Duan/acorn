import { describe, expect, it } from "vitest";
import { completedMillis, compareCompletedAt, rowCompletionAt } from "../src/core/completionOrder";
import { newTask } from "../src/core/model";

describe("实际完成时间排序", () => {
  it("按真实时刻而非字符串，等时戳稳定，输入数组不原地重排", () => {
    const values = ["2026-10-16T17:30:00+08:00", "2026-10-16T18:00:00+09:00", "2026-10-16T09:30:00Z", null, "invalid"];
    const before = [...values];
    expect([...values].sort(compareCompletedAt)).toEqual([values[0], values[2], values[1], null, "invalid"]);
    expect(values).toEqual(before);
    expect(compareCompletedAt(values[0], values[2])).toBe(0);
  });

  it("无效日期、滚动溢出的日时分秒、无时区和非字符串不会伪造结束时间", () => {
    for (const value of [null, undefined, "", "bad", 0, "2026-02-30T10:00:00Z", "2026-13-01T10:00:00Z", "2026-01-00T10:00:00Z", "2026-10-16T24:00:00Z", "2026-10-16T10:60:00Z", "2026-10-16T10:00:60Z", "2026-10-16T10:00:00", "2026-10-16"]) expect(completedMillis(value)).toBeNull();
    expect(completedMillis("2024-02-29T10:00:00.001Z")).toBe(Date.parse("2024-02-29T10:00:00.001Z"));
    expect(compareCompletedAt(null, "bad")).toBe(0);
  });

  it("老子无戳只回落已完成母戳，缺失及坏戳不借创建或编辑时间", () => {
    const task = newTask({ title: "合成母任务", done: true, doneAt: "2026-10-16T08:00:00Z", createdAt: "2099-01-01T00:00:00Z", updatedAt: "2099-01-01T00:00:00Z" });
    const sub = { id: "s", title: "旧步骤", done: true };
    expect(rowCompletionAt({ task, sub })).toBe(task.doneAt);
    expect(rowCompletionAt({ task: { ...task, done: false }, sub })).toBeNull();
    expect(rowCompletionAt({ task, sub: { ...sub, doneAt: "invalid" } })).toBeNull();
    expect(rowCompletionAt({ task: { ...task, doneAt: null }, sub: null })).toBeNull();
  });
});
