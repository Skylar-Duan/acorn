// 三端各排各的号 + 测试版（用户 2026-09-18 定，见 src/core/version.ts）。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  APP_PLATFORM, APP_VERSION, IS_BETA, compareVersions, displayVersion, isBeta, pickVersion, shortVersion,
} from "../src/core/version";
import { isNewer, shouldOffer, parseManifest } from "../src/core/updater";

const table = JSON.parse(readFileSync("versions.json", "utf8")) as {
  public: Record<string, string>;
  beta: Record<string, number>;
};

describe("号码从哪来", () => {
  it("versions.json 三端都有公开的号，也都有测试版计数", () => {
    for (const p of ["desktop", "android", "web"]) {
      expect(table.public[p], p).toMatch(/^\d+\.\d+\.\d+$/);
      expect(Number.isInteger(table.beta[p]), p).toBe(true);
    }
  });

  it("第一位三端共用（v1 → v2 一起跳，一个大版本一份验收单）", () => {
    const majors = new Set(Object.values(table.public).map((v) => v.split(".")[0]));
    expect(majors.size).toBe(1);
  });

  it("测试环境里算桌面版，号就是 versions.json 里桌面那个", () => {
    expect(APP_PLATFORM).toBe("desktop");
    expect(APP_VERSION).toBe(table.public.desktop);
    expect(IS_BETA).toBe(false);
  });

  it("打包脚本盖的戳：对得上这一端才用戳上的号", () => {
    const pub = { desktop: "1.15.0", android: "1.15.8", web: "1.15.2" };
    expect(pickVersion("desktop", pub, { platform: "", version: "" })).toBe("1.15.0");
    expect(pickVersion("android", pub, { platform: "android", version: "1.15.9-beta.1" })).toBe("1.15.9-beta.1");
    // 桌面测试版的戳，不能让同一份代码跑在安卓上时也自称是它
    expect(pickVersion("android", pub, { platform: "desktop", version: "1.15.1-beta.1" })).toBe("1.15.8");
    expect(pickVersion("web", undefined, undefined)).toBe("dev");
  });
});

describe("界面上怎么写", () => {
  it("跟以前一样，不带端名：各端只写自己的号", () => {
    // 用户 2026-09-18：「从哪个端进去别人自己知道什么端」
    expect(shortVersion("1.15.0")).toBe("v1.15.0");
    expect(displayVersion("1.15.8")).toBe("1.15.8");
  });

  it("测试版原来写号的地方只写 beta，不加别的字，也不露 1.15.1 这个占位号", () => {
    expect(isBeta("1.15.1-beta.3")).toBe(true);
    expect(isBeta("1.15.1")).toBe(false);
    expect(shortVersion("1.15.1-beta.3")).toBe("beta");
    expect(displayVersion("1.15.1-beta.3")).toBe("beta");
  });

  it("显示版本的几处都走这两个函数，没有哪里还在直接写 APP_VERSION 或端名", () => {
    const files = [
      "src/components/Sidebar.tsx", "src/components/ChangelogDialog.tsx", "src/components/UpdateDialog.tsx",
      "src/components/UpdatePanel.tsx", "src/views/Settings.tsx", "src/core/cloud.ts",
    ];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/v\{APP_VERSION\}|v\$\{APP_VERSION\}|桌面版|安卓版|网页版 v/);
    }
  });
});

describe("比大小认得测试版", () => {
  it("测试版比它接着的那个正式版新", () => {
    expect(compareVersions("1.15.1-beta.1", "1.15.0")).toBe(1);
  });

  it("任何正式的下一版都比测试版新：正式版出来能正常盖掉测试版", () => {
    expect(compareVersions("1.15.1", "1.15.1-beta.9")).toBe(1);
    expect(compareVersions("1.16.0", "1.15.1-beta.9")).toBe(1);
  });

  it("测试版之间按序号比，按数字不按字符串", () => {
    expect(compareVersions("1.15.1-beta.10", "1.15.1-beta.9")).toBe(1);
    expect(compareVersions("1.15.1-beta.2", "1.15.1-beta.2")).toBe(0);
  });

  it("老规矩不变：1.10 > 1.9，1.7 = 1.7.0，dev 最小", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.7", "1.7.0")).toBe(0);
    expect(compareVersions("dev", "1.0.0")).toBe(-1);
  });
});

describe("装着测试版时的更新提示", () => {
  const manifest = (version: string) =>
    parseManifest({ available: true, version, url: "https://acorn.cdpandas.com/download/x.exe" });

  it("服务器上还是 1.15.0：不劝人从测试版「更新」回去", () => {
    expect(isNewer("1.15.0", "1.15.1-beta.2")).toBe(false);
    expect(shouldOffer(manifest("1.15.0"), "1.15.1-beta.2")).toBe(false);
  });

  it("正式版发出来了：照常提示更新", () => {
    expect(shouldOffer(manifest("1.15.1"), "1.15.1-beta.2")).toBe(true);
  });
});
