// 桌面侧栏宽度可拖（用户原话「桌面版：左侧栏位宽度可拖动」）。
// 钉住：宽度夹在 180–360、每台电脑各记各的（localStorage acorn-sidew，不许撞 acorn-side- 那个折叠前缀）、
// 坏值 / 读不到回落 232、拖动中只改 CSS 变量松手才写、双击恢复默认、启动第一帧就套上、
// 窄屏抽屉和手机都不认它。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SIDE_W_DEFAULT, SIDE_W_KEY, SIDE_W_MAX, SIDE_W_MIN,
  applySavedSideW, applySideW, clampSideW, loadSideW, saveSideW,
} from "../src/core/sideWidth";
import { SideGrip } from "../src/components/SideGrip";
import { clearLocalPrefs } from "../src/core/persist";
import appSource from "../src/App.tsx?raw";
import mainSource from "../src/main.tsx?raw";
import { readFileSync } from "node:fs";

// css 走 ?raw 在测试里拿到的是空串（被 vite 的 css 处理吃掉了），跟 row-tail.test.ts 一样现读
const appCss = readFileSync("src/styles/app.css", "utf8");
const baseCss = readFileSync("src/styles/base.css", "utf8");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cssVar = () => document.documentElement.style.getPropertyValue("--side-w");

beforeEach(() => {
  localStorage.clear();
  document.documentElement.style.removeProperty("--side-w");
});

describe("宽度的读写与夹取", () => {
  it("默认 232，跟 base.css 里那个默认值是同一个数", () => {
    expect(SIDE_W_DEFAULT).toBe(232);
    expect(baseCss).toContain(`--side-w: ${SIDE_W_DEFAULT}px;`);
    expect(loadSideW()).toBe(232);
  });

  it("夹在 180–360 之间，小数取整", () => {
    expect(SIDE_W_MIN).toBe(180);
    expect(SIDE_W_MAX).toBe(360);
    expect(clampSideW(50)).toBe(180);
    expect(clampSideW(9999)).toBe(360);
    expect(clampSideW(250.6)).toBe(251);
    expect(clampSideW(Number.NaN)).toBe(232);
    expect(clampSideW(Infinity)).toBe(232);
  });

  it("存了再读回来是同一个数；存下去的值也是夹过的", () => {
    saveSideW(300);
    expect(localStorage.getItem(SIDE_W_KEY)).toBe("300");
    expect(loadSideW()).toBe(300);
    saveSideW(1000);
    expect(loadSideW()).toBe(360);
  });

  it("坏值、空串、超范围的旧值都回落 / 夹回去，不会把侧栏弄成 0 宽", () => {
    localStorage.setItem(SIDE_W_KEY, "abc");
    expect(loadSideW()).toBe(232);
    localStorage.setItem(SIDE_W_KEY, "");
    expect(loadSideW()).toBe(232);
    localStorage.setItem(SIDE_W_KEY, "20");
    expect(loadSideW()).toBe(180);
  });

  it("存储读不到 / 写不进去（隐私窗口之类）也不抛错", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      expect(loadSideW()).toBe(232);
      expect(() => saveSideW(300)).not.toThrow();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  it("恢复成默认宽就把本机那条记录删掉，不留一条没用的", () => {
    saveSideW(300);
    saveSideW(SIDE_W_DEFAULT);
    expect(localStorage.getItem(SIDE_W_KEY)).toBeNull();
  });

  it("键名带 acorn- 前缀（清空本机会扫掉），但绝不以 acorn-side- 开头（那是侧栏折叠的前缀）", () => {
    expect(SIDE_W_KEY).toBe("acorn-sidew");
    expect(SIDE_W_KEY.startsWith("acorn-")).toBe(true);
    expect(SIDE_W_KEY.startsWith("acorn-side-")).toBe(false);
    saveSideW(300);
    clearLocalPrefs();
    expect(localStorage.getItem(SIDE_W_KEY)).toBeNull();
  });

  it("套上 = 改 --side-w 这一个变量；默认值就撤掉内联那条，回到 base.css", () => {
    applySideW(300);
    expect(cssVar()).toBe("300px");
    applySideW(9999);
    expect(cssVar()).toBe("360px");
    applySideW(SIDE_W_DEFAULT);
    expect(cssVar()).toBe("");
  });

  it("启动时套上本机记的那个值", () => {
    localStorage.setItem(SIDE_W_KEY, "280");
    applySavedSideW();
    expect(cssVar()).toBe("280px");
  });
});

describe("把手：拖动 / 双击", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.classList.remove("side-resizing");
  });

  function mount(): HTMLElement {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(createElement(SideGrip)));
    const grip = host.querySelector<HTMLElement>(".side-grip")!;
    // jsdom 没有指针捕获，拖动的逻辑不靠它，给个空实现就行
    (grip as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
    return grip;
  }

  const fire = (el: HTMLElement, type: string, init: MouseEventInit) =>
    act(() => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
    });

  it("拖动途中只改 CSS 变量，松手才写一次本机存储", () => {
    const grip = mount();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    try {
      fire(grip, "pointerdown", { button: 0, clientX: 232 });
      expect(document.body.classList.contains("side-resizing")).toBe(true);
      fire(grip, "pointermove", { clientX: 262 });
      fire(grip, "pointermove", { clientX: 292 });
      expect(cssVar()).toBe("292px");
      expect(setItem).not.toHaveBeenCalled();
      fire(grip, "pointerup", { clientX: 292 });
      expect(setItem).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(SIDE_W_KEY)).toBe("292");
      expect(document.body.classList.contains("side-resizing")).toBe(false);
    } finally {
      setItem.mockRestore();
    }
  });

  it("拖过头也夹在范围里", () => {
    const grip = mount();
    fire(grip, "pointerdown", { button: 0, clientX: 232 });
    fire(grip, "pointermove", { clientX: 900 });
    expect(cssVar()).toBe("360px");
    fire(grip, "pointermove", { clientX: 0 });
    expect(cssVar()).toBe("180px");
    fire(grip, "pointerup", { clientX: 0 });
    expect(loadSideW()).toBe(180);
  });

  it("右键按下不算拖", () => {
    const grip = mount();
    fire(grip, "pointerdown", { button: 2, clientX: 232 });
    fire(grip, "pointermove", { clientX: 300 });
    expect(cssVar()).toBe("");
  });

  it("双击恢复 232", () => {
    saveSideW(320);
    applySideW(320);
    const grip = mount();
    fire(grip, "dblclick", {});
    expect(cssVar()).toBe("");
    expect(loadSideW()).toBe(232);
    expect(localStorage.getItem(SIDE_W_KEY)).toBeNull();
  });
});

describe("挂在哪、谁看得到", () => {
  it("只在桌面那段（!isMobile）里、紧挨着侧栏挂；手机不渲染", () => {
    // 整份 App 里只挂这一处
    expect(appSource.split("<SideGrip />").length - 1).toBe(1);
    const at = appSource.indexOf("<SideGrip />");
    const before = appSource.slice(0, at);
    const seg = appSource.slice(before.lastIndexOf("{!isMobile && ("), at);
    // 跟 <Sidebar> 在同一个 !isMobile 的片段里，中间没有收口
    expect(seg).toContain("<Sidebar ");
    expect(seg).not.toContain("</>");
    expect(before.lastIndexOf("{!isMobile && (")).toBeGreaterThan(before.lastIndexOf("{isMobile && ("));
  });

  it("启动第一帧之前就套上（main.tsx 里在 createRoot 之前），手机不碰", () => {
    const at = mainSource.indexOf("applySavedSideW();");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(mainSource.indexOf("ReactDOM.createRoot"));
    expect(mainSource).toContain("if (!isMobile) applySavedSideW();");
  });

  it("把手 no-drag、左右箭头、贴在侧栏边线上；窄屏抽屉模式藏掉", () => {
    const rule = appCss.slice(appCss.indexOf(".side-grip {"), appCss.indexOf("}", appCss.indexOf(".side-grip {")));
    expect(rule).toContain("-webkit-app-region: no-drag;");
    expect(rule).toContain("cursor: col-resize;");
    expect(rule).toContain("position: fixed;");
    expect(rule).toContain("left: calc(var(--side-w) - 1px);");
    const narrow = appCss.slice(appCss.indexOf("@media (max-width: 760px) {"));
    expect(narrow.slice(0, 400)).toContain(".side-grip { display: none; }");
    // 抽屉宽度仍是写死的，不跟 --side-w 走
    expect(narrow).toContain("width: min(82vw, 300px);");
  });

  it("侧栏竖向滚动条藏掉，滚轮还能滚（同一条 .side 规则窄屏抽屉也一起盖到）", () => {
    const rule = appCss.slice(appCss.indexOf(".side {"), appCss.indexOf("}", appCss.indexOf(".side {")));
    expect(rule).toContain("overflow-y: auto;");
    expect(rule).toContain("scrollbar-width: none;");
    expect(appCss).toContain(".side::-webkit-scrollbar { display: none; }");
  });
});
