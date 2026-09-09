// v1.14.1 · 手机上的更新日志弹窗：从「几乎全屏的一张纸」收成「中间偏下的一张卡」。
//
// PM 的原话是「上下界限太宽，尤其是上端位置过高」。390×844 上量出来的病根：
//   改前 margin-top: 5vh → 顶端 42px。真机上状态栏就有 24～47px，
//   等于弹窗几乎贴着信号格；再配 max-height: 88vh，高 743px、占掉 88% 的屏，
//   底下只剩 59px——比底部导航（60px）还窄，卡片是「压在导航上」而不是「浮在屏幕里」。
//
// 这份测试钉两样东西：
//   ① 那几个数还在源码里（改法没被后来的人顺手改掉）；
//   ② **算出来的观感**还成立——把 CSS 里的数读出来，代进几台真实设备的
//      safe-area，验「顶端离状态栏有呼吸 / 高度不过八成 / 底下给手势条留得出余量」。
//      ② 才是真正要守的东西：谁想调那三个数都行，调到难看就红。
//
// 为什么不用 jsdom 直接量：jsdom 没有布局引擎、媒体查询也不生效，
// getBoundingClientRect 恒等于 0。真的像素在 Playwright 那一轮量（390×844 安卓 UA），
// 那一轮的数字记在交付回报里。
// 样式只能用 node:fs 读：vitest 默认不处理 CSS，`import x from "a.css?raw"` 读回来是空串。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");
/** 仓库里 CRLF / LF 混着用，断言不许把行尾当内容的一部分 */
const nl = (s: string) => s.replace(/\r\n/g, "\n");
const overlaysCss = nl(read("src/styles/overlays.css"));

const NARROW = "@media (max-width: 760px)";

/** 取一个 @media 块的完整内容（数花括号，别用「找下一个 }」——那会在第一条规则就断）。
 *  overlays.css 里 `@media (max-width: 760px)` 有**两处**（前一处只管 .update-modal），
 *  所以 at 得由调用方点名，不能想当然拿 indexOf 的第一个。 */
function mediaBlock(css: string, at: number): string {
  expect(at, "找不到窄屏断点").toBeGreaterThan(-1);
  let depth = 0;
  for (let j = css.indexOf("{", at); j < css.length; j++) {
    if (css[j] === "{") depth++;
    else if (css[j] === "}" && --depth === 0) return css.slice(at, j + 1);
  }
  throw new Error("窄屏断点这个块没有收口");
}

/** 取一条规则的声明体。选择器要连后面那个 `{` 一起找，`.modal.cl-modal` 不会误命中注释里那句 */
function ruleBody(css: string, selector: string): string {
  const head = selector + " {";
  const i = css.indexOf(head);
  expect(i, `找不到规则：${selector}`).toBeGreaterThan(-1);
  const end = css.indexOf("}", i);
  expect(end, `${selector} 这条规则没有收口`).toBeGreaterThan(i);
  return css.slice(i + head.length, end);
}

const narrow = mediaBlock(overlaysCss, overlaysCss.lastIndexOf(NARROW));
const mobileCl = ruleBody(narrow, ".modal.cl-modal");
const desktopCl = ruleBody(overlaysCss.slice(0, overlaysCss.lastIndexOf(NARROW)), ".modal.cl-modal");

describe("手机上的更新日志弹窗：三个数写在源码里", () => {
  it("改前那三个值一个都不许留下", () => {
    // 这三个就是 PM 看着别扭的那一版：顶端 5vh、高 88vh、左右各 8px
    expect(mobileCl).not.toContain("margin-top: 5vh");
    expect(mobileCl).not.toContain("max-height: 88vh");
    expect(mobileCl).not.toContain("calc(100vw - 16px)");
  });

  it("顶端 = safe-area + 一段呼吸，不是直接一个百分比", () => {
    // 少了 safe-area 这一截，刘海屏上那段呼吸会被状态栏吃掉
    expect(mobileCl).toMatch(/margin-top:\s*calc\(var\(--m-safe-top,[^)]*\)[^;]*\+\s*\d+dvh\)/);
    expect(mobileCl).toMatch(/margin-bottom:\s*calc\(var\(--m-safe-bottom,/);
  });

  it("高度按内容走、封一个上限，内容多了在 .cl-body 里滚", () => {
    expect(mobileCl).toMatch(/max-height:\s*min\(\s*\d+dvh/);
    // 上限里把上下两段安全区都减掉了，底部才留得出手势条的位置
    expect(mobileCl).toContain("--m-safe-bottom");
    // 滚动条在卡内：.cl-body 一直是 overflow-y: auto（桌面那条，没动过）
    expect(overlaysCss).toContain(".cl-body { overflow-y: auto;");
  });

  it("每条 dvh 前面都压着一条 vh 保底（老 WebView 不认 dvh 会整条作废）", () => {
    for (const prop of ["margin-top", "max-height"]) {
      const decls = [...mobileCl.matchAll(new RegExp(`${prop}:([^;]*);`, "g"))].map((m) => m[1]);
      expect(decls.length, `${prop} 应该写两遍：先 vh 保底，再 dvh 升一档`).toBe(2);
      expect(decls[0], `${prop} 第一条必须是不带 dvh 的保底`).not.toContain("dvh");
      expect(decls[0]).toContain("vh");
      expect(decls[1], `${prop} 第二条才是 dvh 那一档`).toContain("dvh");
    }
  });
});

describe("算出来的观感：换几台真机代进去，比例还得成立", () => {
  /** 从 CSS 里把那三个数读回来，测的是「调成什么样都不许难看」，不是「必须等于 13」 */
  const topVh = Number(/margin-top:[^;]*\+\s*(\d+(?:\.\d+)?)dvh/.exec(mobileCl)![1]);
  const capVh = Number(/max-height:\s*min\(\s*(\d+(?:\.\d+)?)dvh/.exec(mobileCl)![1]);
  const bottomReserve = Number(/-\s*\d+(?:\.\d+)?dvh\s*-\s*(\d+(?:\.\d+)?)px/.exec(mobileCl)![1]);

  /** 弹窗铺满内容时的几何：.overlay 是 align-items: flex-start，顶端就是 margin-top */
  function box(vh: number, safeTop: number, safeBottom: number) {
    const top = safeTop + (topVh / 100) * vh;
    const cap = Math.min(
      (capVh / 100) * vh,
      vh - safeTop - safeBottom - (topVh / 100) * vh - bottomReserve,
    );
    return { top, height: cap, bottom: top + cap, gapBottom: vh - (top + cap) };
  }

  // 三台：headless / Pixel 8 那档打孔屏 / iPhone 那档刘海 + 手势条
  const devices: [string, number, number, number][] = [
    ["390×844 无安全区（Playwright 量的就是这台）", 844, 0, 0],
    ["Pixel 8 一档：状态栏 24 / 手势条 24", 844, 24, 24],
    ["刘海屏一档：状态栏 47 / 手势条 34", 844, 47, 34],
    ["小屏 360×640", 640, 24, 24],
  ];

  it.each(devices)("%s：顶端不贴状态栏，底下给手势条留得出余量", (_name, vh, st, sb) => {
    const b = box(vh, st, sb);
    // 状态栏底下至少还有 60px 的空——低于这个数就又回到「贴着信号格」那种观感
    expect(b.top - st).toBeGreaterThanOrEqual(60);
    // 底部余量要盖得住手势条，再多留一截，卡片才是「浮着」不是「压在导航上」
    expect(b.gapBottom).toBeGreaterThanOrEqual(sb + 60);
  });

  it.each(devices)("%s：高度不过八成，是一张卡不是一张纸", (_name, vh, st, sb) => {
    const b = box(vh, st, sb);
    expect(b.height / vh).toBeLessThanOrEqual(0.8);
    // 也不许矫枉过正缩成一条缝：内容多的时候得撑得开
    expect(b.height / vh).toBeGreaterThanOrEqual(0.55);
  });

  it.each(devices)("%s：整体落在屏幕中间偏下", (_name, vh, st, sb) => {
    const b = box(vh, st, sb);
    // 卡片中心不高于屏幕中心（改前是 -8.5px，偏上）
    expect((b.top + b.bottom) / 2).toBeGreaterThanOrEqual(vh / 2);
  });

  it("改前那一版会被上面几条拦下来（说明这些断言不是摆设）", () => {
    // 改前：margin-top: 5vh、max-height: 88vh、没有 safe-area、没有底部预留
    const before = (vh: number, st: number) => {
      const top = 0.05 * vh; // 那时候 safe-area 一点没算
      const height = Math.min(0.88 * vh, vh - top);
      return { topGap: top - st, gapBottom: vh - top - height };
    };
    const b = before(844, 47);
    expect(b.topGap).toBeLessThan(60); // 42 − 47 = −5，直接被状态栏压住
    expect(b.gapBottom).toBeLessThan(60 + 34); // 59，比底部导航还窄
  });
});

describe("只动了版本日志这一个弹窗，同一个壳子上的别人一个字没改", () => {
  it("窄屏块里那条规则只挂 .modal.cl-modal，没跟别的浮层写在一起", () => {
    expect(narrow).toContain(".modal.cl-modal {");
    // 没被并进那条「命令面板 / 全局搜索 / 找回数据」的选择器组里
    expect(narrow).not.toMatch(/[^}]*\.cl-modal[^{]*,[^{]*\{/);
  });

  it("命令面板 / 全局搜索 / 找回数据 / 「有新版」那条窄屏规则原样", () => {
    expect(narrow).toContain(
      ".modal.cp-modal, .modal.so-modal, .modal.rescue {\n    min-width: 0; width: calc(100vw - 24px); max-width: calc(100vw - 24px);\n  }",
    );
    expect(narrow).toContain(".nd-modal { min-width: 0; width: calc(100vw - 24px); }");
    expect(overlaysCss).toContain(".modal.update-modal { min-width: 0; width: calc(100vw - 28px); }");
  });

  it("公用壳子 .overlay / .modal 本身没被拿来改（那会连累所有弹窗）", () => {
    // 尺寸和定位一律写在 .cl-modal 上；overlays.css 里根本不该出现裸的 .overlay/.modal 规则
    expect(overlaysCss).not.toMatch(/(^|\n)\s*\.overlay\s*\{/);
    expect(overlaysCss).not.toMatch(/(^|\n)\s*\.modal\s*\{/);
    // 「记一条」和登录在手机上压根不吃这个壳子（.msheet / .login-scrim），这里也不该提到它们
    expect(overlaysCss).not.toContain(".msheet");
    expect(overlaysCss).not.toContain(".login-scrim");
  });

  it("桌面那条 .modal.cl-modal 一个字没动", () => {
    expect(desktopCl.trim()).toBe(
      "width: min(680px, calc(100vw - 48px)); min-width: 0; max-width: 680px; display: flex; flex-direction: column; max-height: 82vh; padding: 0;",
    );
    // 窄屏那条不许去碰桌面才有的那几件（宽度上限 / 排版方向 / 内边距）
    expect(mobileCl).not.toContain("flex-direction");
    expect(mobileCl).not.toContain("max-width");
    expect(mobileCl).not.toContain("padding:");
  });

  it("尺寸这一块没夹带写死的毫秒或颜色", () => {
    expect(mobileCl).not.toMatch(/\b\d+m?s\b/);
    expect(mobileCl).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });
});
