// 版本错位时的硬约束（用户 2026-08-24 定的口径）：
// 桌面版会跑在手机版前面。**旧客户端遇到读不了的新数据，必须明说，不许当成老格式填进去。**
// 硬填的后果是新版本才有的东西（比如习惯的打卡记录）被悄悄抹掉，而且用户毫不知情。
import { describe, expect, it } from "vitest";
import { pack, unpack } from "../src/core/transfer";
import { DATA_VERSION, defaultData, newTask } from "../src/core/model";

function sample() {
  const d = defaultData();
  d.tasks = [newTask({ title: "对账" })];
  return d;
}

describe("unpack 要如实报出「这份数据是第几版」", () => {
  it("本机自己导出的：schema = 当前版本，不算新", () => {
    const r = unpack(pack(sample(), "1.6.0"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.schema).toBe(DATA_VERSION);
    expect(r.tooNew).toBe(false);
  });

  it("更老版本导出的：认，且不算新", () => {
    const r = unpack({
      app: "acorn",
      schema: 2,
      appVersion: "1.3.0",
      exportedAt: "2026-08-01T00:00:00Z",
      data: { version: 2, tasks: [{ id: "t1", title: "老任务", who: "李哥" }], lists: [] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.schema).toBe(2);
    expect(r.tooNew).toBe(false);
    expect(r.data.tasks[0].who).toEqual(["李哥"]); // 老格式照样升得上来
  });

  it("**更新版本导出的：必须标成 tooNew**", () => {
    const r = unpack({
      app: "acorn",
      schema: DATA_VERSION + 1,
      appVersion: "9.9.9",
      exportedAt: "2027-01-01T00:00:00Z",
      data: { version: DATA_VERSION + 1, tasks: [], lists: [] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.schema).toBe(DATA_VERSION + 1);
    expect(r.tooNew).toBe(true);
  });

  it("信封上没写 schema 时退到数据里的 version", () => {
    const r = unpack({ app: "acorn", data: { version: DATA_VERSION + 3, tasks: [], lists: [] } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.schema).toBe(DATA_VERSION + 3);
    expect(r.tooNew).toBe(true);
  });

  it("老式裸数据（没信封）：按里面的 version 算，没有就当最老的", () => {
    const bare = unpack({ tasks: [], lists: [] });
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    expect(bare.schema).toBe(1);
    expect(bare.tooNew).toBe(false);

    const bareNew = unpack({ version: DATA_VERSION + 1, tasks: [], lists: [] });
    expect(bareNew.ok).toBe(true);
    if (!bareNew.ok) return;
    expect(bareNew.tooNew).toBe(true);
  });

  it("不是橡果的数据照旧明确报错", () => {
    expect(unpack({ hello: "world" }).ok).toBe(false);
    expect(unpack("一个字符串").ok).toBe(false);
    expect(unpack(null).ok).toBe(false);
  });
});

describe("往返不变", () => {
  it("导出→导入，任务原样回来", () => {
    const d = sample();
    const r = unpack(JSON.parse(JSON.stringify(pack(d, "1.6.0"))));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.tasks.map((t) => t.title)).toEqual(["对账"]);
    expect(r.tooNew).toBe(false);
  });
});
