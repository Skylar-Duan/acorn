// 需求方可以挂多个人（v1.4.0）。这里守三件事：
// ① 老数据（who 是单个字符串）升上来一个不丢；② 解析/增删改的口径；③ 统计里一人算一次。
import { beforeEach, describe, expect, it } from "vitest";
import {
  addTask,
  addTasksWho,
  aliveTasks,
  allWho,
  appStore,
  completeTask,
  deleteTasks,
  removeTaskWho,
  setTasksWho,
  updateTask,
} from "../src/core/store";
import { defaultData, migrate, newTask, normalizeWho, DATA_VERSION } from "../src/core/model";
import type { Task } from "../src/core/model";
import { parseQuickAdd } from "../src/core/parse";
import { byWho } from "../src/core/stats";
import { searchTasks } from "../src/core/search";

const LS_KEY = "acorn-data";

function getTask(id: string): Task {
  const t = appStore.getState().data.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`task ${id} not found`);
  return t;
}

beforeEach(() => {
  localStorage.removeItem(LS_KEY);
  appStore.setState({ data: defaultData(), loaded: true, loadError: null });
});

describe("normalizeWho：脏数据进来一律洗干净", () => {
  it("单个字符串 → 单元素数组", () => {
    expect(normalizeWho("李哥")).toEqual(["李哥"]);
  });
  it("null / undefined / 空串 → 空数组", () => {
    expect(normalizeWho(null)).toEqual([]);
    expect(normalizeWho(undefined)).toEqual([]);
    expect(normalizeWho("")).toEqual([]);
    expect(normalizeWho("   ")).toEqual([]);
  });
  it("去重、去首尾空白、丢空项，顺序按第一次出现", () => {
    expect(normalizeWho([" 李哥 ", "王姐", "李哥", "", "  ", "张总"])).toEqual(["李哥", "王姐", "张总"]);
  });
  it("非字符串项直接忽略，不炸", () => {
    expect(normalizeWho([1, null, "李哥", {}] as unknown)).toEqual(["李哥"]);
  });
});

describe("老数据升级（v2 → v3）", () => {
  it("who 是单个字符串的老任务，升上来变成一个人的数组，人没丢", () => {
    const old = {
      version: 2,
      lists: [],
      sessions: [],
      settings: {},
      tasks: [
        { id: "t1", title: "交周报", who: "李哥", subtasks: [] },
        { id: "t2", title: "没需求方", who: null, subtasks: [] },
      ],
    };
    const d = migrate(old);
    expect(d.version).toBe(DATA_VERSION);
    expect(d.tasks[0].who).toEqual(["李哥"]);
    expect(d.tasks[1].who).toEqual([]);
  });

  it("更老的数据里根本没有 who 字段也不炸", () => {
    const d = migrate({ version: 1, tasks: [{ id: "t1", title: "远古任务" }] });
    expect(d.tasks[0].who).toEqual([]);
  });

  it("已经是数组的（v3 自己导出的）原样保留", () => {
    const d = migrate({ version: 3, tasks: [{ id: "t1", title: "a", who: ["李哥", "王姐"], subtasks: [] }] });
    expect(d.tasks[0].who).toEqual(["李哥", "王姐"]);
  });
});

describe("解析：一句话里写几个 @ 就是几个人", () => {
  const p = (s: string) => parseQuickAdd(s, { now: new Date("2026-08-17T09:00:00"), listNames: ["工作"] });

  it("两个人", () => {
    expect(p("@李哥 @王姐 对账").who).toEqual(["李哥", "王姐"]);
  });
  it("跟其他语法混写，各管各的", () => {
    const r = p("明天下午3点 季度复盘 /工作 @李哥 @张总 #汇报 !高");
    expect(r.who).toEqual(["李哥", "张总"]);
    expect(r.listName).toBe("工作");
    expect(r.tags).toEqual(["汇报"]);
    expect(r.priority).toBe(3);
    expect(r.title).toBe("季度复盘");
  });
});

describe("增删改", () => {
  it("addTask 直接给几个人", () => {
    const id = addTask({ title: "对账", who: ["李哥", "王姐"] });
    expect(getTask(id).who).toEqual(["李哥", "王姐"]);
  });

  it("addTask 传进来的重复项和空串会被洗掉", () => {
    const id = addTask({ title: "对账", who: ["李哥", "李哥", " ", "王姐"] });
    expect(getTask(id).who).toEqual(["李哥", "王姐"]);
  });

  it("addTasksWho：是「也归 TA」，原来的人还在；重复挂不会挂两次", () => {
    const id = addTask({ title: "对账", who: ["李哥"] });
    addTasksWho([id], "王姐");
    expect(getTask(id).who).toEqual(["李哥", "王姐"]);
    addTasksWho([id], "王姐");
    expect(getTask(id).who).toEqual(["李哥", "王姐"]);
  });

  it("addTasksWho 空名字什么都不做", () => {
    const id = addTask({ title: "对账", who: ["李哥"] });
    addTasksWho([id], "   ");
    expect(getTask(id).who).toEqual(["李哥"]);
  });

  it("setTasksWho：整组换人，原来的清掉", () => {
    const a = addTask({ title: "a", who: ["李哥"] });
    const b = addTask({ title: "b", who: ["王姐", "张总"] });
    setTasksWho([a, b], ["赵总"]);
    expect(getTask(a).who).toEqual(["赵总"]);
    expect(getTask(b).who).toEqual(["赵总"]);
  });

  it("setTasksWho 给空数组 = 清空需求方", () => {
    const id = addTask({ title: "a", who: ["李哥", "王姐"] });
    setTasksWho([id], []);
    expect(getTask(id).who).toEqual([]);
  });

  it("removeTaskWho：只摘掉指定的那个人", () => {
    const id = addTask({ title: "a", who: ["李哥", "王姐", "张总"] });
    removeTaskWho(id, "王姐");
    expect(getTask(id).who).toEqual(["李哥", "张总"]);
  });

  it("updateTask 也能整体改", () => {
    const id = addTask({ title: "a", who: ["李哥"] });
    updateTask(id, { who: ["王姐", "张总"] });
    expect(getTask(id).who).toEqual(["王姐", "张总"]);
  });
});

describe("侧栏与统计：一件事挂几个人，几个人名下都看得到", () => {
  it("allWho：两个人各自 +1，同一件事不会只算一个人", () => {
    addTask({ title: "对账", who: ["李哥", "王姐"] });
    addTask({ title: "报销", who: ["王姐"] });
    expect(allWho(appStore.getState().data)).toEqual([
      { who: "王姐", open: 2 },
      { who: "李哥", open: 1 },
    ]);
  });

  it("allWho：完成的仍留条目但计 0，回收站里的整条不算", () => {
    const done = addTask({ title: "a", who: ["李哥", "王姐"] });
    completeTask(done);
    const del = addTask({ title: "b", who: ["张总"] });
    deleteTasks([del]);
    expect(allWho(appStore.getState().data)).toEqual([
      { who: "李哥", open: 0 },
      { who: "王姐", open: 0 },
    ]);
  });

  it("需求方视图的筛选口径：挂了 TA 就该出现", () => {
    const a = addTask({ title: "对账", who: ["李哥", "王姐"] });
    addTask({ title: "无关", who: ["张总"] });
    const forWang = aliveTasks(appStore.getState().data).filter((t) => t.who.includes("王姐"));
    expect(forWang.map((t) => t.id)).toEqual([a]);
  });

  it("byWho 统计：同一件完成的事在每个人名下各算一次", () => {
    const tasks = [
      newTask({ title: "合办的事", who: ["李哥", "王姐"], done: true, doneAt: "2026-08-12T02:00:00.000Z" }),
      newTask({ title: "只有李哥的", who: ["李哥"], done: false }),
    ];
    const r = byWho(tasks, "2026-08-10", "2026-08-16");
    expect(r).toEqual([
      { who: "李哥", done: 1, open: 1 },
      { who: "王姐", done: 1, open: 0 },
    ]);
  });
});

describe("搜索：任意一个需求方命中就算命中", () => {
  it("搜第二个人也能搜到", () => {
    const tasks = [newTask({ title: "对账", who: ["李哥", "王姐"] })];
    expect(searchTasks(tasks, [], "王姐")).toHaveLength(1);
    expect(searchTasks(tasks, [], "李哥")).toHaveLength(1);
    expect(searchTasks(tasks, [], "张总")).toHaveLength(0);
  });
});
