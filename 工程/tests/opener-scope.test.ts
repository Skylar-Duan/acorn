// 「改用浏览器下载」按了没反应（2026-09-02 用户第一次点更新就撞上）——两处病：
//   ① capabilities 只给了 opener 的命令权限，没给 URL / 路径范围，插件一律拒绝；
//   ② updater.openFallback 兜底用 window.open，在 Tauri 的 webview 里静默无效。
// 这两处都是「代码看起来对、跑起来什么都不发生」，所以钉在这儿。
// 另一半病在服务器：/download/ 静态目录没有 CORS 头，webview 里 fetch 直接「Failed to fetch」——
// 那在 nginx 配置里，这里顺带钉住配置文件里有那几行。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import updaterSource from "../src/core/updater.ts?raw";
import dialogSource from "../src/components/UpdateDialog.tsx?raw";
import panelSource from "../src/components/UpdatePanel.tsx?raw";

const caps = JSON.parse(readFileSync("src-tauri/capabilities/default.json", "utf8")) as {
  permissions: (string | { identifier: string; allow?: { url?: string; path?: string }[] })[];
};
const nginx = readFileSync("server/deploy/nginx-acorn.conf", "utf8");

describe("opener 权限得带范围，不然 openUrl / openPath 一律被拒", () => {
  it("有 opener:default（自带 http/https/mailto/tel 的默认 URL 范围）", () => {
    expect(caps.permissions).toContain("opener:default");
  });

  it("open-url 显式放行自家下载域名（备用下载走它）", () => {
    const e = caps.permissions.find(
      (p) => typeof p === "object" && p.identifier === "opener:allow-open-url",
    ) as { allow?: { url?: string }[] } | undefined;
    expect(e?.allow?.some((a) => a.url?.startsWith("https://acorn.cdpandas.com"))).toBe(true);
  });

  it("open-path 放行应用缓存目录——安卓装 APK 靠 openPath 打开 write_to_cache 存下的那个文件", () => {
    const e = caps.permissions.find(
      (p) => typeof p === "object" && p.identifier === "opener:allow-open-path",
    ) as { allow?: { path?: string }[] } | undefined;
    expect(e?.allow?.some((a) => a.path === "$APPCACHE/**")).toBe(true);
  });

  it("不再残留没有范围的裸命令权限", () => {
    expect(caps.permissions).not.toContain("opener:allow-open-url");
    expect(caps.permissions).not.toContain("opener:allow-open-path");
  });
});

describe("openFallback：开直链、失败要有回话", () => {
  it("先开安装包直链，不是 Release 页（Release 没发时那页是旧版本，国内还时好时坏）", () => {
    expect(updaterSource).toContain("const url = info.url || info.pageUrl;");
  });

  it("不再用 window.open 兜底（Tauri 的 webview 里它静默无效）", () => {
    expect(updaterSource).not.toContain("window.open(");
  });

  it("三种结果都返回给界面：opened / copied / failed", () => {
    expect(updaterSource).toContain('return "opened";');
    expect(updaterSource).toContain('return "copied";');
    expect(updaterSource).toContain('return "failed";');
    expect(updaterSource).toContain("export function fallbackText(");
  });

  it("两个入口都把结果显示出来", () => {
    for (const src of [dialogSource, panelSource]) {
      expect(src).toContain("openFallback(info).then(setFb)");
      expect(src).toContain("fallbackText(fb, info)");
    }
  });
});

describe("nginx：/download/ 静态目录必须带 CORS 头", () => {
  it("Allow-Origin / Expose-Headers / OPTIONS 预检三样都在 /download/ 那个 location 里", () => {
    const loc = nginx.slice(nginx.indexOf("location /download/"), nginx.indexOf("location /api/auth/"));
    expect(loc).toContain('add_header Access-Control-Allow-Origin "*" always;');
    expect(loc).toMatch(/Access-Control-Expose-Headers "[^"]*Content-Length/);
    expect(loc).toContain("if ($request_method = OPTIONS) { return 204; }");
  });
});
