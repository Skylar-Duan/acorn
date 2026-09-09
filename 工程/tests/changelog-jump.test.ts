// 跨版本升级时，更新日志得把「这次一起装上的每一版」都摊开讲，不能只讲最新那一条。
//
// 用户 2026-09-09 原话（他电脑停在 v1.14.0，服务器已经是 v1.14.2）：
// 「电脑版点开还是会弹出来更新到 1.14.2，这种怎么处理？」——问题不在装不装得上（代码是累积的），
// 而在**话说没说到**：升级弹窗只念服务器清单里最新那一版的说明（那一版讲的还是手机上的事），
// 装完弹出的更新日志也只把最新一条做成主卡，中间那版专门给电脑做的改动被折叠进了「之前的版本」。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { entriesSince } from "../src/core/updateCtl";

const read = (p: string) => readFileSync(p, "utf8");
const dialogSource = read("src/components/ChangelogDialog.tsx");
const updateDialogSource = read("src/components/UpdateDialog.tsx");
const ctlSource = read("src/core/updateCtl.ts");

const V = (version: string) => ({ version });

describe("entriesSince：这次一起装上的是哪几版", () => {
  it("跨了两版：两版都算这次的，更早的不算", () => {
    const list = [V("1.14.2"), V("1.14.1"), V("1.14.0"), V("1.13.0")];
    expect(entriesSince(list, "1.14.0").map((e) => e.version)).toEqual(["1.14.2", "1.14.1"]);
  });

  it("只跨一版：就一条，跟原来的样子一致", () => {
    const list = [V("1.14.2"), V("1.14.1")];
    expect(entriesSince(list, "1.14.1").map((e) => e.version)).toEqual(["1.14.2"]);
  });

  it("头一次装（没有上一版可比）：退回「只讲最新那条」，不把整部历史摊开糊人一脸", () => {
    const list = [V("1.14.2"), V("1.14.1"), V("1.14.0")];
    expect(entriesSince(list, null).map((e) => e.version)).toEqual(["1.14.2"]);
    expect(entriesSince(list, "").map((e) => e.version)).toEqual(["1.14.2"]);
  });

  it("上一版比日志里最新的还新（回退安装 / 日志漏写）：不至于空着，仍然给最新那条", () => {
    const list = [V("1.14.2"), V("1.14.1")];
    expect(entriesSince(list, "1.99.0").map((e) => e.version)).toEqual(["1.14.2"]);
  });

  it("版本号按数字比大小，不是按字符串（1.14.2 > 1.9.1）", () => {
    const list = [V("1.14.2"), V("1.9.1")];
    expect(entriesSince(list, "1.9.1").map((e) => e.version)).toEqual(["1.14.2"]);
  });
});

describe("界面真的用上了", () => {
  it("🔴 升级前记下「上一版是谁」：rememberLaunch 会把 localStorage 那个值改掉，只能在模块初始化时读", () => {
    expect(ctlSource).toContain("prevVersion: readLastVersion()");
    // 读的这一行必须在 store 初始化里，不能挪到某个 effect 里再读（那时已经被覆盖了）
    const init = ctlSource.slice(ctlSource.indexOf("export const updateStore"));
    expect(init.slice(0, init.indexOf("}))")).includes("prevVersion: readLastVersion()")).toBe(true);
  });

  it("更新日志把这几版都做成主卡，不是只做最新一条", () => {
    expect(dialogSource).toContain("entriesSince(CHANGELOG, prevVersion)");
    expect(dialogSource).toContain("fresh.map((e) => (");
    // 剩下的才进「之前的版本」，别把已经摊开的那几条又折叠一遍
    expect(dialogSource).toContain("CHANGELOG.filter((e) => !freshVers.has(e.version))");
  });

  it("跨版本时顶上有一句交代，说清这次一共带来几版", () => {
    expect(dialogSource).toContain("你上次用的是 v");
    expect(dialogSource).toContain("这次一起装上了");
    expect(dialogSource).toContain("jumped");
  });

  it("升级弹窗里也说一句：装完能看到这次一起装上的所有版本", () => {
    expect(updateDialogSource).toContain("更新日志里会列出这次一起装上的所有版本");
  });
});
