// 子任务按时间顺序自动排列（用户 2026-09-03 提的）。
// 规矩：没做完的按日期从早到晚；没填日期的沉到后面、彼此保持原序；做完的那堆不动。
import { describe, expect, it } from "vitest";
import type { Subtask } from "../src/core/model";
import { splitSubtasks } from "../src/core/store";

function sub(id: string, due: string | null, done = false): Subtask {
  return { id, title: id, done, due, priority: null } as unknown as Subtask;
}

describe("splitSubtasks：没做完的按日期排", () => {
  it("有日期的从早到晚，没日期的沉到后面", () => {
    const { open } = splitSubtasks([sub("c", "2026-09-10"), sub("x", null), sub("a", "2026-09-01"), sub("b", "2026-09-05")]);
    expect(open.map((s) => s.id)).toEqual(["a", "b", "c", "x"]);
  });

  it("同一天的、以及都没日期的，保持原来的先后（稳定）", () => {
    const { open } = splitSubtasks([sub("p", null), sub("q", "2026-09-03"), sub("r", null), sub("s", "2026-09-03")]);
    expect(open.map((s) => s.id)).toEqual(["q", "s", "p", "r"]);
  });

  it("做完的那堆不参与排序、原序不动", () => {
    const { done } = splitSubtasks([sub("z", "2026-09-09", true), sub("y", "2026-09-01", true), sub("k", "2026-09-02")]);
    expect(done.map((s) => s.id)).toEqual(["z", "y"]);
  });

  it("不改原数组", () => {
    const arr = [sub("b", "2026-09-05"), sub("a", "2026-09-01")];
    splitSubtasks(arr);
    expect(arr.map((s) => s.id)).toEqual(["b", "a"]);
  });
});
