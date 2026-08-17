import { describe, it, expect } from "vitest";
import { newTask, type List, type Task } from "../src/core/model";
import { searchTasks, type SearchHit } from "../src/core/search";

// 固定 createdAt，测试不依赖真实当前时间
const T0 = "2026-01-01T00:00:00.000Z";

function mk(partial: Partial<Task> & { title: string }): Task {
  return newTask({ createdAt: T0, ...partial });
}

const LISTS: List[] = [
  { id: "l-work", name: "工作", color: "clay", order: 0 },
  { id: "l-life", name: "Life stuff", color: "moss", order: 1 },
];

function titles(hits: SearchHit[]): string[] {
  return hits.map((h) => h.task.title);
}

describe("searchTasks · query 处理", () => {
  it("空 query 与纯空白 query 都返回 []", () => {
    const tasks = [mk({ title: "写周报" })];
    expect(searchTasks(tasks, LISTS, "")).toEqual([]);
    expect(searchTasks(tasks, LISTS, "   ")).toEqual([]);
  });

  it("query 首尾空白被去除", () => {
    const tasks = [mk({ title: "写周报给李哥" })];
    const hits = searchTasks(tasks, LISTS, "  周报  ");
    expect(titles(hits)).toEqual(["写周报给李哥"]);
  });

  it("英文大小写不敏感", () => {
    const tasks = [mk({ title: "Write REPORT draft" })];
    expect(searchTasks(tasks, LISTS, "report")).toHaveLength(1);
    expect(searchTasks(tasks, LISTS, "WRITE")).toHaveLength(1);
  });
});

describe("searchTasks · 命中域与权重", () => {
  it("中文标题子串命中，得 100 分", () => {
    const tasks = [mk({ title: "写周报给李哥" })];
    const hits = searchTasks(tasks, LISTS, "周报");
    expect(hits).toHaveLength(1);
    expect(hits[0].score).toBe(100);
  });

  it("标题前缀额外 +30（130 分）", () => {
    const tasks = [mk({ title: "report draft" }), mk({ title: "my report" })];
    const hits = searchTasks(tasks, LISTS, "report");
    expect(titles(hits)).toEqual(["report draft", "my report"]);
    expect(hits[0].score).toBe(130);
    expect(hits[1].score).toBe(100);
  });

  it("标题子序列命中：'zb' 命中 'zoo bar'，得 40 分", () => {
    const tasks = [mk({ title: "zoo bar" }), mk({ title: "book zone" })]; // 后者 b 在 z 前，非按序
    const hits = searchTasks(tasks, LISTS, "zb");
    expect(titles(hits)).toEqual(["zoo bar"]);
    expect(hits[0].score).toBe(40);
  });

  it("需求方 who 子串命中，得 30 分", () => {
    const tasks = [mk({ title: "对账", who: "@李哥" })];
    const hits = searchTasks(tasks, LISTS, "李哥");
    expect(hits).toHaveLength(1);
    expect(hits[0].score).toBe(30);
  });

  it("标签子串命中，得 30 分", () => {
    const tasks = [mk({ title: "跑数据", tags: ["紧急", "CFA备考"] })];
    const hits = searchTasks(tasks, LISTS, "cfa");
    expect(hits).toHaveLength(1);
    expect(hits[0].score).toBe(30);
  });

  it("清单名子串命中，得 30 分；不在该清单的任务不沾光", () => {
    const tasks = [mk({ title: "改简历", listId: "l-work" }), mk({ title: "买菜", listId: "l-life" })];
    const hits = searchTasks(tasks, LISTS, "工作");
    expect(titles(hits)).toEqual(["改简历"]);
    expect(hits[0].score).toBe(30);
  });

  it("备注子串命中，得 20 分", () => {
    const tasks = [mk({ title: "开会", notes: "记得带周报纸质版" })];
    const hits = searchTasks(tasks, LISTS, "周报");
    expect(hits).toHaveLength(1);
    expect(hits[0].score).toBe(20);
  });

  it("同一词多域命中只取最高域：标题+备注同时含词仍是 100", () => {
    const tasks = [mk({ title: "写周报", notes: "周报要发邮箱" })];
    const hits = searchTasks(tasks, LISTS, "周报");
    expect(hits[0].score).toBe(100);
  });

  it("子序列(40)高于标签(30)：两者同时命中取 40", () => {
    const tasks = [mk({ title: "zoo bar", tags: ["zb小组"] })];
    const hits = searchTasks(tasks, LISTS, "zb");
    expect(hits[0].score).toBe(40);
  });
});

describe("searchTasks · 多词 AND", () => {
  it("所有词都命中才返回", () => {
    const tasks = [
      mk({ title: "写周报给李哥" }),
      mk({ title: "写月报给王姐" }),
    ];
    const hits = searchTasks(tasks, LISTS, "周报 李哥");
    expect(titles(hits)).toEqual(["写周报给李哥"]);
    expect(searchTasks(tasks, LISTS, "周报 王姐")).toEqual([]);
  });

  it("多词得分为各词最高域之和（标题 100 + 备注 20 = 120）", () => {
    const tasks = [mk({ title: "写周报", notes: "发给邮箱" })];
    const hits = searchTasks(tasks, LISTS, "周报 邮箱");
    expect(hits[0].score).toBe(120);
  });

  it("中英混合多词查询", () => {
    const tasks = [
      mk({ title: "整理 CFA 二级笔记" }),
      mk({ title: "整理房间" }),
    ];
    const hits = searchTasks(tasks, LISTS, "cfa 笔记");
    expect(titles(hits)).toEqual(["整理 CFA 二级笔记"]);
  });
});

describe("searchTasks · 过滤与排序", () => {
  it("已删除任务不出现", () => {
    const tasks = [
      mk({ title: "报告 A" }),
      mk({ title: "报告 B", deletedAt: "2026-02-01T00:00:00.000Z" }),
    ];
    expect(titles(searchTasks(tasks, LISTS, "报告"))).toEqual(["报告 A"]);
  });

  it("同分时已完成排在未完成之后", () => {
    const tasks = [
      mk({ title: "报告甲", done: true, doneAt: "2026-02-01T00:00:00.000Z" }),
      mk({ title: "报告乙" }),
    ];
    const hits = searchTasks(tasks, LISTS, "报告");
    expect(hits[0].score).toBe(hits[1].score);
    expect(titles(hits)).toEqual(["报告乙", "报告甲"]);
  });

  it("score 降序优先于完成态：高分的已完成排在低分的未完成之前", () => {
    const tasks = [
      mk({ title: "报告存档", done: true, doneAt: "2026-02-01T00:00:00.000Z" }), // 前缀 130
      mk({ title: "写报告" }), // 100
    ];
    expect(titles(searchTasks(tasks, LISTS, "报告"))).toEqual(["报告存档", "写报告"]);
  });

  it("同分同完成态按 createdAt 降序（新的在前）", () => {
    const tasks = [
      mk({ title: "报告旧", createdAt: "2026-01-01T00:00:00.000Z" }),
      mk({ title: "报告新", createdAt: "2026-03-01T00:00:00.000Z" }),
    ];
    expect(titles(searchTasks(tasks, LISTS, "报告"))).toEqual(["报告新", "报告旧"]);
  });

  it("整体权重排序：标题 > 需求方 > 备注", () => {
    const tasks = [
      mk({ title: "别的事", notes: "问问李哥" }),
      mk({ title: "对账", who: "@李哥" }),
      mk({ title: "找李哥吃饭" }),
    ];
    expect(titles(searchTasks(tasks, LISTS, "李哥"))).toEqual([
      "找李哥吃饭",
      "对账",
      "别的事",
    ]);
  });

  it("结果截断到前 50 条", () => {
    const tasks: Task[] = [];
    for (let i = 0; i < 60; i++) tasks.push(mk({ title: `批量任务 ${i}` }));
    const hits = searchTasks(tasks, LISTS, "批量");
    expect(hits).toHaveLength(50);
  });
});
