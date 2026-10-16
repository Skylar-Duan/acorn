import { describe, expect, it } from "vitest";
import { newTask, type Priority, type Subtask, type Task } from "../src/core/model";
import { addDays } from "../src/core/dates";
import { deadlineAtX, deadlineX, importanceBand, quadrantAxisTicks, quadrantDragPreview, quadrantPoints, quadrantPreview, stepQuadrantDate, QUADRANT_SCALE } from "../src/core/quadrantLayout";

const today = "2026-10-16";
const task = (id: string, patch: Partial<Task> = {}) => newTask({ id, title: id, ...patch });
const sub = (id: string, patch: Partial<Subtask> = {}): Subtask => ({ id, title: id, done: false, ...patch });
const point = (patch: Partial<Task> = {}) => quadrantPoints({ tasks: [task("t", patch)] }, today)[0];

describe("坐标点只代表仍可执行的任务", () => {
  it("有开放步骤只列步骤，母完成/放弃/删除/习惯全部排除，无开放步骤才列母", () => {
    const parent = task("parent", { subtasks: [sub("open"), sub("done", { done: true }), sub("drop", { droppedAt: "2026-10-15T00:00:00Z" }), sub("delete", { deletedAt: "2026-10-15T00:00:00Z" })] });
    const tasks = [parent, task("alone"), task("closedSteps", { subtasks: [sub("s", { done: true })] }),
      task("doneParent", { done: true, subtasks: [sub("pending")] }), task("dropParent", { droppedAt: "x", subtasks: [sub("pending")] }),
      task("deletedParent", { deletedAt: "x", subtasks: [sub("pending")] }), task("habit", { kind: "habit" })];
    const before = JSON.stringify(tasks);
    const result = quadrantPoints({ tasks }, today);
    expect(result.map((p) => [p.taskId, p.subId])).toEqual([["parent", "open"], ["alone", null], ["closedSteps", null]]);
    expect(result[0].task).toBe(parent); expect(result[0].sub).toBe(parent.subtasks[0]);
    expect(JSON.stringify(tasks)).toBe(before);
  });

  it("子日期与重要度按自身/母手排继承，不借兄弟的近期安排；零重要度不误继承", () => {
    const a = task("parent", { priority: 3, due: null, subtasks: [sub("own", { due: today, priority: 0 }), sub("none")] });
    let points = quadrantPoints({ tasks: [a] }, today);
    expect(points.map((p) => [p.due, p.priority])).toEqual([[today, 0], [null, 3]]);
    points = quadrantPoints({ tasks: [{ ...a, due: "2027-01-01" }] }, today);
    expect(points.map((p) => p.due)).toEqual([today, "2027-01-01"]);
    expect(points[0].title).toBe("own"); expect(points[0].parentTitle).toBe("parent");
  });
});

describe("日期轴连续可逆，明天/后天与旧紧急判据一致", () => {
  it("今天70、明天55、后天46，未来凸映射的近期间距大于远期", () => {
    expect(deadlineX(today, today)).toBe(70);
    expect(deadlineX(addDays(today, 1), today)).toBe(55);
    expect(deadlineX(addDays(today, 2), today)).toBe(46);
    expect(deadlineAtX(50, today)).toBe(addDays(today, 2));
    const x = (n: number) => deadlineX(addDays(today, n), today);
    expect(x(0) - x(1)).toBeGreaterThan(x(1) - x(2));
    expect(x(30) - x(31)).toBeGreaterThan(x(365) - x(366));
    for (const d of [1, 2, 7, 30, 365, 3650]) expect(x(d - 1) - 2 * x(d) + x(d + 1)).toBeGreaterThan(0);
  });

  it("逾期段与今天连续，越早越靠右；无日期独立左带，反解不混进未来", () => {
    expect(deadlineX(addDays(today, -1), today)).toBe(73.5);
    expect(deadlineX(addDays(today, -7), today)).toBe(84);
    expect(deadlineX(addDays(today, -365), today)).toBeGreaterThan(84);
    expect(deadlineX(null, today)).toBe(4);
    for (const x of [-1, 0, 4, 8, 9, 10]) expect(deadlineAtX(x, today)).toBeNull();
    expect(deadlineAtX(QUADRANT_SCALE.overdueStartX + 0.01, today)).toBe(addDays(today, -1));
  });

  it("跨年/闰年/全年及多年日期都能往返，不把远未来截到固定天数", () => {
    for (const due of ["1900-01-01", "2024-02-29", "2026-10-15", today, "2026-10-17", "2026-10-18", "2027-10-16", "2046-10-16", "2999-12-31"]) {
      expect(deadlineAtX(deadlineX(due, today), today), due).toBe(due);
    }
    expect(deadlineAtX(100, today)).toBe("1900-01-01");
    expect(deadlineAtX(10 + Number.EPSILON * 16, today)).toBe("2999-12-31");
    expect(deadlineX("0001-01-01", today)).toBeGreaterThan(97);
    expect(deadlineX("9999-12-31", today)).toBeGreaterThan(10);
  });

  it("无效日期不会产生NaN点，公历计算与本地DST长度无关", () => {
    for (const due of ["bad", "2026-02-30", "2026-13-01", "0000-01-01"]) expect(deadlineX(due, today)).toBe(4);
    expect(() => quadrantPoints({ tasks: [] }, "2026-02-30")).toThrow(RangeError);
    for (const due of ["2026-03-07", "2026-03-08", "2026-03-09", "2026-11-01", "2026-11-02"]) expect(deadlineAtX(deadlineX(due, "2026-03-08"), "2026-03-08")).toBe(due);
    const preview = quadrantPreview(NaN, NaN, today);
    expect(preview.due).toBeNull(); expect([0, 1, 2, 3]).toContain(preview.priority);
  });
});

describe("ID散点只在本日期单元与重要等级内，刷新不漂", () => {
  it("所有日期与四重要度的大量点均不越界，反解仍回原日期/重要度", () => {
    const dates = [null, "1900-01-01", ...[-3650, -365, -30, -7, -1, 0, 1, 2, 7, 30, 365, 10000].map((d) => addDays(today, d)), "2999-12-31"];
    const tasks = dates.flatMap((due, d) => ([0, 1, 2, 3] as Priority[]).flatMap((priority) => Array.from({ length: 24 }, (_, i) => task(`d${d}-p${priority}-${i}`, { due, priority }))));
    const points = quadrantPoints({ tasks }, today);
    expect(points).toHaveLength(dates.length * 4 * 24);
    for (const p of points) {
      expect(p.xPct).toBeGreaterThan(p.xRange[0]); expect(p.xPct).toBeLessThan(p.xRange[1]);
      expect(p.yPct).toBeGreaterThan(p.yRange[0]); expect(p.yPct).toBeLessThan(p.yRange[1]);
      expect(quadrantPreview(p.xPct, p.yPct, today)).toMatchObject({ due: p.due, priority: p.priority });
      const urgent = !!p.due && p.due <= addDays(today, 1);
      expect(p.xPct > 50).toBe(urgent); expect(p.yPct < 50).toBe(p.priority >= 2);
      if (p.dateKind === "overdue") expect(p.xPct).toBeGreaterThan(QUADRANT_SCALE.overdueStartX);
    }
  });

  it("同级同日多点能散开，重排或新增记录不会使原点漂移", () => {
    const tasks = Array.from({ length: 150 }, (_, i) => task(`same${i}`, { due: today, priority: 2 }));
    const first = quadrantPoints({ tasks }, today);
    const second = quadrantPoints({ tasks: [task("new"), ...[...tasks].reverse()] }, today);
    const byId = new Map(second.map((p) => [p.id, p]));
    expect(new Set(first.map((p) => `${p.xPct}/${p.yPct}`)).size).toBe(150);
    for (const p of first) expect([byId.get(p.id)!.xPct, byId.get(p.id)!.yPct]).toEqual([p.xPct, p.yPct]);
  });

  it("四重要度独立bands；中/低分界在横轴50，坐标端点也只落四级", () => {
    expect(([3, 2, 1, 0] as Priority[]).map((p) => importanceBand(p))).toEqual([
      { min: 0, max: 25, center: 12.5, label: "高" }, { min: 25, max: 50, center: 37.5, label: "中" },
      { min: 50, max: 75, center: 62.5, label: "低" }, { min: 75, max: 100, center: 87.5, label: "无" },
    ]);
    expect([0, 24.99, 25, 49.99, 50, 74.99, 75, 100].map((y) => quadrantPreview(4, y, today).priority)).toEqual([3, 3, 2, 2, 1, 1, 0, 0]);
  });
});

it("键盘步进只生成1900..2999，零步进和只展示保留原始极端年份", () => {
  expect(stepQuadrantDate("2024-02-28", 1)).toBe("2024-02-29");
  expect(stepQuadrantDate("2024-02-29", 1)).toBe("2024-03-01");
  expect(stepQuadrantDate("1900-01-01", -1)).toBe("1900-01-01");
  expect(stepQuadrantDate("2999-12-31", 1)).toBe("2999-12-31");
  expect(stepQuadrantDate("0001-01-01", 1)).toBe("1900-01-01");
  expect(stepQuadrantDate("9999-12-31", -1)).toBe("2999-12-31");
  expect(stepQuadrantDate("0001-01-01", 0)).toBe("0001-01-01");
  for (const due of ["0001-01-01", "9999-12-31"]) {
    const p = point({ due });
    expect(p.due).toBe(due);
    expect(quadrantDragPreview(p, 50, 0, today, { moveX: false, moveY: true }).due).toBe(due);
  }
});

describe("拖动预览只改变实际移动的轴，保持继承与远日期", () => {
  it("只改重要度时保留全年/多年日期与时间，未移动轴不按指针极端值反解", () => {
    const p = point({ due: "9999-12-31", dueTime: "18:30", priority: 0 });
    const preview = quadrantDragPreview(p, 99, 5, today, { moveX: false, moveY: true });
    expect(preview).toMatchObject({ due: "9999-12-31", priority: 3, changedX: false, changedY: true });
    expect(p.task.dueTime).toBe("18:30");
    expect(quadrantDragPreview(p, 4, 0, today, { moveX: false, moveY: false })).toMatchObject({ due: p.due, priority: 0, changedX: false, changedY: false });
  });

  it("同日/同级内鼠标移动不固化继承属性；横移到新日期只改日期轴", () => {
    const p = quadrantPoints({ tasks: [task("parent", { due: today, priority: 2, subtasks: [sub("child")] })] }, today)[0];
    expect(quadrantDragPreview(p, p.xPct, p.yPct, today, { moveX: true, moveY: true })).toMatchObject({ due: today, priority: 2, changedX: false, changedY: false, inheritsDue: true });
    expect(quadrantDragPreview(p, deadlineX(addDays(today, 7), today), 99, today, { moveX: true, moveY: false })).toMatchObject({ due: addDays(today, 7), priority: 2, changedX: true, changedY: false });
  });

  it("子拖无日期表示继承母日期，实际落点仍是母日期；母任务则确实清日期", () => {
    const taskValue = task("parent", { due: today, subtasks: [sub("child", { due: "2027-01-01" })] });
    const p = quadrantPoints({ tasks: [taskValue] }, today)[0];
    expect(quadrantDragPreview(p, 4, p.yPct, today, { moveX: true, moveY: false })).toMatchObject({ due: null, effectiveDue: today, inheritsDue: true, changedX: true, dayOffset: 0, dateKind: "dated" });
    const inherited = quadrantPoints({ tasks: [{ ...taskValue, subtasks: [sub("child")] }] }, today)[0];
    expect(quadrantDragPreview(inherited, 4, inherited.yPct, today, { moveX: true, moveY: false })).toMatchObject({ due: null, effectiveDue: today, inheritsDue: true, changedX: false });
    expect(quadrantDragPreview(point({ due: today }), 4, 60, today, { moveX: true, moveY: false })).toMatchObject({ due: null, effectiveDue: null, inheritsDue: false, changedX: true, dateKind: "undated" });
  });
});

it("坐标轴标注有明确信息，390窄屏减少标签且保留紧急判据", () => {
  const full = quadrantAxisTicks(today), compact = quadrantAxisTicks(today, { compact: true });
  expect(full.map((t) => t.label)).toEqual(["无日期", "远期", "一月后", "下周", "后天", "明天", "今天", "逾期"]);
  expect(compact.map((t) => t.label)).toEqual(["无日期", "下周", "明天", "今天", "逾期"]);
  for (let i = 1; i < compact.length; i++) expect((compact[i].xPct - compact[i - 1].xPct) / 100 * 290).toBeGreaterThan(38);
});
