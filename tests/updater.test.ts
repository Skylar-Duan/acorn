// 手机端自动更新的判断逻辑。这块最容易出的错是版本号按字符串比
// （那样 1.10.0 会小于 1.9.0，用户永远等不到更新），所以钉死。
import { describe, expect, it } from "vitest";
import {
  compareVersions, isNewer, isRequiredForSync, parseManifest, shouldOffer,
} from "../src/core/updater";
import { DATA_VERSION } from "../src/core/model";

const BASE = "https://acorn.cdpandas.com";

function manifest(over: Record<string, unknown> = {}) {
  return {
    available: true,
    version: "1.7.0",
    schema: DATA_VERSION,
    url: `${BASE}/download/android/Acorn_1.7.0_arm64.apk`,
    size: 33000000,
    sha256: "abc123",
    notes: "修了几个小问题",
    publishedAt: "2026-08-24T10:00:00Z",
    pageUrl: "https://github.com/Skylar-Duan/acorn/releases/latest",
    ...over,
  };
}

describe("版本号比较", () => {
  it("1.10.0 比 1.9.0 新（按字符串比会反）", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(isNewer("1.10.0", "1.9.0")).toBe(true);
  });

  it("一样就是一样，段数不同按缺位补零", () => {
    expect(compareVersions("1.7.0", "1.7.0")).toBe(0);
    expect(compareVersions("1.7", "1.7.0")).toBe(0);
    expect(compareVersions("1.7.0.0", "1.7")).toBe(0);
  });

  it("低版本不算新——绝不能提示「升级」到旧版", () => {
    expect(isNewer("1.5.0", "1.6.0")).toBe(false);
    expect(isNewer("1.6.0", "1.6.0")).toBe(false);
    expect(isNewer("0.9.9", "1.0.0")).toBe(false);
  });

  it("大版本进位", () => {
    expect(isNewer("2.0.0", "1.99.99")).toBe(true);
    expect(isNewer("1.6.1", "1.6.0")).toBe(true);
  });

  it("乱七八糟的版本号不炸，按 0 处理", () => {
    expect(compareVersions("", "")).toBe(0);
    expect(compareVersions("dev", "1.0.0")).toBe(-1);
  });
});

describe("清单校验", () => {
  it("正常清单解得出来", () => {
    const u = parseManifest(manifest());
    expect(u?.version).toBe("1.7.0");
    expect(u?.size).toBe(33000000);
  });

  it("available=false / 缺版本 / 缺地址 → 当没有更新", () => {
    expect(parseManifest({ available: false })).toBeNull();
    expect(parseManifest(manifest({ version: "" }))).toBeNull();
    expect(parseManifest(manifest({ url: "" }))).toBeNull();
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest("字符串")).toBeNull();
  });

  it("**下载地址不是自家服务器的一律不认**——清单被人改过也不能把用户引去别处装东西", () => {
    expect(parseManifest(manifest({ url: "https://evil.example.com/x.apk" }))).toBeNull();
    expect(parseManifest(manifest({ url: "http://acorn.cdpandas.com/x.apk" }))).toBeNull();
    expect(parseManifest(manifest({ url: `${BASE}/download/android/ok.apk` }))).not.toBeNull();
  });

  it("缺可选字段时给安全默认值，不至于渲染出 undefined", () => {
    const u = parseManifest({ available: true, version: "1.7.0", url: `${BASE}/a.apk` });
    expect(u).not.toBeNull();
    expect(u?.notes).toBe("");
    expect(u?.sha256).toBe("");
    expect(u?.size).toBe(0);
  });
});

describe("要不要提示用户", () => {
  it("有更新就提示", () => {
    expect(shouldOffer(parseManifest(manifest({ version: "1.9.0" })), "1.6.0")).toBe(true);
  });

  it("已是最新 / 更旧 / 没清单 → 不提示", () => {
    expect(shouldOffer(parseManifest(manifest({ version: "1.6.0" })), "1.6.0")).toBe(false);
    expect(shouldOffer(parseManifest(manifest({ version: "1.5.0" })), "1.6.0")).toBe(false);
    expect(shouldOffer(null, "1.6.0")).toBe(false);
  });

  it("开发环境（版本号不是数字开头）不提示，免得天天弹", () => {
    expect(shouldOffer(parseManifest(manifest({ version: "9.9.9" })), "dev")).toBe(false);
  });
});

describe("是不是非升不可", () => {
  it("新版数据模型比本机高 = 不升就同步不了", () => {
    expect(isRequiredForSync(parseManifest(manifest({ schema: DATA_VERSION + 1 })))).toBe(true);
  });

  it("同版本或更低就只是普通更新", () => {
    expect(isRequiredForSync(parseManifest(manifest({ schema: DATA_VERSION })))).toBe(false);
    expect(isRequiredForSync(parseManifest(manifest({ schema: 1 })))).toBe(false);
    expect(isRequiredForSync(null)).toBe(false);
  });
});
