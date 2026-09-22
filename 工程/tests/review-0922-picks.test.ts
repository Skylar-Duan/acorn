// 09-22 统一选项那一波复核后修的几处界面细节（源码 / 样式守卫；逻辑那几条在 habits / recur / postpone-presets 里）。
//  · 顺延菜单「选日期…」、循环「每隔几天…」回车后不再冒泡到全局快捷键（不然会把之前单选中的另一件事展开）
//  · 右键「调整日期 ▸」摊开「选日期…」变宽后重判往左弹；子任务右键菜单也会往左弹
//  · 习惯页「今天不用做」那组：淡下去的只是行头，展开后的周期菜单不半透明、不被后面的行盖住
//  · 手机：习惯纸里的自定义面板去掉 hover 残留；习惯行「下次」跨年那句不被截成省略号
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import datePickSource from "../src/components/DatePickRow.tsx?raw";
import repeatMenuSource from "../src/components/RepeatMenu.tsx?raw";
import ctxSource from "../src/components/ContextMenu.tsx?raw";

// 样式只能用 node:fs 读（vitest 不处理 CSS，?raw 读回来是空串）
const habitsCss = readFileSync("src/styles/habits.css", "utf8");
const pagesCss = readFileSync("src/styles/mobile-pages.css", "utf8");

function stripComments(src: string): string {
  return src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
function block(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `找不到选择器 ${selector}`).toBeGreaterThan(-1);
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
}

describe("回车只归输入框自己", () => {
  it("DatePickRow 的回车分支 stopPropagation", () => {
    const src = stripComments(datePickSource);
    const enter = src.slice(src.indexOf('e.key === "Enter"'), src.indexOf("confirm();", src.indexOf('e.key === "Enter"')));
    expect(enter).toContain("e.stopPropagation()");
  });
  it("「每隔几天…」的回车分支 stopPropagation", () => {
    const src = stripComments(repeatMenuSource);
    const at = src.indexOf('if (e.key === "Enter")');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, src.indexOf("onDone(rule)", at))).toContain("e.stopPropagation()");
  });
});

describe("右键「调整日期 ▸」往左弹", () => {
  const src = stripComments(ctxSource);
  it("任务菜单：摊开「选日期…」后重判", () => {
    expect(src).toContain("}, [sub, datePicking]);");
  });
  it("子任务菜单：也有往左弹，并随「选日期…」重判", () => {
    expect(src).toContain("}, [subOpen, datePicking]);");
    expect(src.match(/ctx-submenu\$\{subFlip \? " flip" : ""\}/g) ?? []).toHaveLength(5); // 任务菜单 3 个 + 子任务菜单 2 个
    expect(src).not.toContain('className="ctx-submenu"');
  });
});

describe("习惯页「今天不用做」那组的周期菜单", () => {
  it("淡的是行头，不是整行", () => {
    expect(habitsCss).not.toMatch(/\n\.hb-row\.off\s*\{/);
    expect(block(habitsCss, ".hb-row.off > .hb-head")).toContain("opacity: .62");
  });
  it("展开的那一行压在后面几行上面", () => {
    const open = habitsCss.slice(habitsCss.indexOf("\n.hb-row.open { position"));
    expect(open).toContain("position: relative; z-index: 1;");
  });
});

describe("手机习惯", () => {
  it("习惯纸自定义面板跟任务纸一样去掉 hover 残留", () => {
    expect(pagesCss).toContain(".mhs-custom .rp-cell:hover { background: var(--bg); color: var(--ink); }");
    expect(pagesCss).toContain(".mhs-custom .rp-cell.on:hover { background: var(--accent); color: var(--on-accent); }");
    expect(pagesCss).toContain(".mhs-custom .rp-cell:active { background: var(--accent-soft); }");
  });
  it("「下次」那句不再卡死在七个点的 92px 宽里（跨年「下次 2027年1月10日」要放得下）", () => {
    const next = block(pagesCss, ".mshell .mhb-next");
    const max = Number(/max-width:\s*(\d+)px/.exec(next)?.[1] ?? "0");
    // 12px 字号下「下次 2027年12月31日」约 115px
    expect(max).toBeGreaterThanOrEqual(120);
  });
});
