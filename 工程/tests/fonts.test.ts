// 字体（v1.11.0）：标题文楷、正文思源黑体，都是子集化的本地 woff2。
// 钉住三件事：① 两族都在 fonts.css 里声明并且文件真的在；② 每个文件别悄悄胀回去（以前那套切片字体 35 MB）；
// ③ base.css 不再引那个 npm 切片包，字体栈以自家字体开头。
import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";

const fontsCss = readFileSync("src/styles/fonts.css", "utf8");
const baseCss = readFileSync("src/styles/base.css", "utf8");

describe("字体子集", () => {
  it("fonts.css 声明了正文（Noto Sans SC）和标题（LXGW WenKai）两族", () => {
    expect(fontsCss).toMatch(/font-family:\s*"Noto Sans SC"/);
    expect(fontsCss).toMatch(/font-family:\s*"LXGW WenKai"/);
  });

  it("四个 woff2 都在，且每个不超过 2 MB（子集化没失效）", () => {
    for (const f of ["notosanssc-regular", "notosanssc-bold", "lxgwwenkai-regular", "lxgwwenkai-medium"]) {
      const size = statSync(`src/assets/fonts/${f}.woff2`).size;
      expect(size, f).toBeGreaterThan(100_000);
      expect(size, f).toBeLessThan(2_000_000);
      expect(fontsCss).toContain(`${f}.woff2`);
    }
  });

  it("base.css 引本地 fonts.css，不再引 35 MB 的切片包；字体栈以自家字体开头", () => {
    expect(baseCss).toContain('@import "./fonts.css";');
    expect(baseCss).not.toContain("lxgw-wenkai-lite-webfont");
    expect(baseCss).toMatch(/--serif:\s*"LXGW WenKai"/);
    expect(baseCss).toMatch(/--sans:\s*"Noto Sans SC"/);
  });

  it("粗细映射：正文 500–900 一档、文楷 501–900 一档（文楷没有 Bold，Medium 顶上）", () => {
    expect(fontsCss).toMatch(/font-weight:\s*500 900;[\s\S]*notosanssc-bold/);
    expect(fontsCss).toMatch(/font-weight:\s*501 900;[\s\S]*lxgwwenkai-medium/);
  });
});
