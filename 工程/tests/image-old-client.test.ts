import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as ts from "typescript";
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import * as dates from "../src/core/dates";
import * as habits from "../src/core/habits";
import * as recur from "../src/core/recur";
import * as taskDue from "../src/core/taskDue";
import { defaultData, migrate, newTask } from "../src/core/model";
import { mergeData } from "../src/core/merge";
import { toJsonFile, unpack } from "../src/core/transfer";

/** 实际已交付普通 beta.2 的四份核心源码，不跟随本轮实现变化。只在内存执行；磁盘与网络均为测试替身。 */
const OLD_NORMAL = "be1b3268f1d21db32f954752b62a9d204f86b7e1";
function oldClient() {
  const cache: Record<string, any> = {};
  let saved = "";
  const external: Record<string, unknown> = {
    "zustand/vanilla": { createStore }, zustand: { useStore }, "./version": { APP_VERSION: "1.16.1-beta.2" },
    "./dates": dates, "./habits": habits, "./recur": recur, "./taskDue": taskDue, "./platform": { isMobile: false },
    "./persist": { saveData: async (data: unknown) => { saved = JSON.stringify(data); } }, "./cloud": { loadSession: async () => null },
  };
  const load = (name: string): any => {
    if (name in external) return external[name];
    if (cache[name]) return cache[name];
    const source = execFileSync("git", ["show", `${OLD_NORMAL}:工程/src/core/${name.replace("./", "")}.ts`], { encoding: "utf8" });
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS } }).outputText;
    const module = { exports: {} }; cache[name] = module.exports;
    new Function("require", "exports", "module", code)(load, module.exports, module);
    return module.exports;
  };
  return { model: load("./model"), store: load("./store"), merge: load("./merge"), transfer: load("./transfer"), saved: () => saved };
}

const image = { id: "synthetic", name: "合成小图.jpg", dataUrl: "data:image/jpeg;base64,/9j/2Q==", width: 1, height: 1, bytes: 4, futureImageField: { keep: true } };
function dataWithImages() {
  return { ...defaultData(), futureCollection: { keep: true }, tasks: [newTask({ id: "photo-task", title: "带图任务", images: [image], subtasks: [
    { id: "photo-sub", title: "带图步骤", done: false, images: [{ ...image, id: "sub-image" }], futureSubField: ["keep"] } as any,
  ] })] };
}

describe("普通版和冻结旧客户端保留图片", () => {
  it("当前普通版读取、同步与导出均保留主子图片和未来字段", () => {
    const original = dataWithImages();
    const read = migrate(JSON.parse(JSON.stringify(original)));
    const merged = mergeData(defaultData(), read).data;
    const result = unpack(JSON.parse(toJsonFile(merged, "normal")));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.data.tasks.find((t) => t.id === "photo-task")!.images).toEqual([image]);
    expect(result.data.tasks.find((t) => t.id === "photo-task")!.subtasks[0].images).toEqual([{ ...image, id: "sub-image" }]);
    expect(result.data).toHaveProperty("futureCollection", { keep: true });
  });
  it("真实旧普通beta源码读取→改文字→保存→合并→导出，一个图片字段都不丢", async () => {
    const old = oldClient();
    const original = dataWithImages();
    const read = old.model.migrate(JSON.parse(JSON.stringify(original)));
    old.store.appStore.setState({ data: read, loaded: true, loadError: null, wiped: false, undoDepth: 0 });
    old.store.updateTask("photo-task", { title: "普通版只改文字" });
    old.store.updateSubtask("photo-task", "photo-sub", { title: "普通版只改子文字" });
    await old.store.flushSave();
    const saved = JSON.parse(old.saved());
    const merged = old.merge.mergeData(old.model.defaultData(), saved).data;
    const result = old.transfer.unpack(JSON.parse(old.transfer.toJsonFile(merged, "1.16.1-beta.2")));
    expect(result.ok).toBe(true);
    const task = result.data.tasks.find((t: { id: string }) => t.id === "photo-task");
    expect(task.title).toBe("普通版只改文字"); expect(task.images).toEqual([image]);
    expect(task.subtasks[0]).toMatchObject({ title: "普通版只改子文字", images: [{ ...image, id: "sub-image" }], futureSubField: ["keep"] });
    expect(result.data.futureCollection).toEqual({ keep: true });
  });
});
