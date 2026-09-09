// 子任务按时间顺序自动排列（用户 2026-09-03 提的）。
// 规矩：没做完的按**生效日期**从早到晚（自己没填日期的算母任务那天，见 subtask-order-inherit.test.ts）；
// 连母任务都没日期的沉到后面、彼此保持原序；做完的那堆不动。
// 这一份只管「母任务本身没安排日期」那一档——继承那一档单独一个文件，两边的边界正好接上。
import { describe, expect, it } from "vitest";
import type { Subtask } from "../src/core/model";
import { splitSubtasks } from "../src/core/store";

function sub(id: string, due: string | null, done = false): Subtask {
  return { id, title: id, done, due, priority: null } as unknown as Subtask;
}

/** 母任务自己也没安排日期：子任务无从继承，「没填」就真的是没日期 */
const NO_DUE = { due: null, dueTime: null };

describe("splitSubtasks：没做完的按日期排（母任务没日期时）", () => {
  it("有日期的从早到晚，没日期的沉到后面", () => {
    const { open } = splitSubtasks(
      [sub("c", "2026-09-10"), sub("x", null), sub("a", "2026-09-01"), sub("b", "2026-09-05")],
      NO_DUE,
    );
    expect(open.map((s) => s.id)).toEqual(["a", "b", "c", "x"]);
  });

  it("同一天的、以及都没日期的，保持原来的先后（稳定）", () => {
    const { open } = splitSubtasks(
      [sub("p", null), sub("q", "2026-09-03"), sub("r", null), sub("s", "2026-09-03")],
      NO_DUE,
    );
    expect(open.map((s) => s.id)).toEqual(["q", "s", "p", "r"]);
  });

  it("做完的那堆不参与排序、原序不动", () => {
    const { done } = splitSubtasks(
      [sub("z", "2026-09-09", true), sub("y", "2026-09-01", true), sub("k", "2026-09-02")],
      NO_DUE,
    );
    expect(done.map((s) => s.id)).toEqual(["z", "y"]);
  });

  it("不改原数组", () => {
    const arr = [sub("b", "2026-09-05"), sub("a", "2026-09-01")];
    splitSubtasks(arr, NO_DUE);
    expect(arr.map((s) => s.id)).toEqual(["b", "a"]);
  });
});
