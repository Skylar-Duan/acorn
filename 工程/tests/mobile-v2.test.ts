// 手机第二版（2026-10-30）：用户拍板「一组一张大卡 / 母子跟桌面一致 / 详情属性胶囊」，
// 外加 10-30 拍图找到的几处毛病。这里钉住每一条，免得下一次改样式又悄悄退回去。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");
const v2 = read("src/styles/mobile-v2.css");
const today = read("src/views/Today.tsx");
const plan = read("src/views/Plan.tsx");
const rowList = read("src/components/RowList.tsx");
const row = read("src/mobile/MobileRow.tsx");
const sheet = read("src/mobile/TaskSheet.tsx");

describe("母子任务：手机跟桌面同一套结构", () => {
  it("今天 / 计划不再按端分两条路，一律母任务一行 + 摊开待办步骤", () => {
    expect(today).toContain("const parents = parentRowsForToday(data, today);");
    expect(today).toContain("const fold = useFoldPlan(allRows, true);");
    expect(today).not.toContain("parentGroups={!isMobile}");
    expect(plan).toContain("const openAll = useMemo(() => mergeParentRows(rawOpen), [rawOpen]);");
    expect(plan).not.toContain("parentGroups={!isMobile}");
  });
  it("手机 RowList 把步骤摊在母任务那一行底下，收着时不画步骤", () => {
    const mobile = rowList.slice(rowList.indexOf("if (isMobile) {"), rowList.indexOf("// 手搭一个**平铺**"));
    expect(mobile).toContain("pendingChildRows(r.task)");
    expect(mobile).toContain("toggleParentFolded(r.task.id)");
    expect(mobile).toContain("{!folded && children.map((c) => <MobileRow key={rowKey(c)} task={c.task} sub={c.sub} nested />)}");
  });
  it("母任务行尾写「做完几步 / 共几步」，收着时第二层写下一步", () => {
    expect(row).toContain("{stepDone}/{stepAll}");
    expect(row).toContain("`下一步 · ${parent.next.title || \"（未命名）\"}`");
    expect(row).toContain("aria-expanded={!parent.folded}");
  });
});

describe("10-30 拍图找到的毛病", () => {
  it("卡片右缘那道粉边：行没让开时滑动底色整层不画", () => {
    expect(v2).toContain(".swipe-wrap:not(.shifted):not(.dragging) > .swipe-under { visibility: hidden; }");
  });
  it("＋ 不再压住最后一行：正文底部按导航 + ＋ 的高度留白", () => {
    expect(v2).toContain("padding-bottom: calc(var(--m-nav-h) + var(--m-safe-bottom) + var(--m2-fab) + 36px);");
  });
  it("今天页副标题不被截成「还剩 3 …」", () => {
    const sub = v2.slice(v2.indexOf(".shell.mobile .mshell .mhead-sub {"), v2.indexOf(".shell.mobile .mshell .mhead-acorn"));
    expect(sub).toContain("white-space: normal;");
    expect(sub).toContain("text-overflow: clip;");
  });
  it("设置页收起的卡底下不再空一截", () => {
    expect(v2).toContain(".set-section.set-closed .set-fold-inner { padding-top: 0; }");
  });
  it("详情里没有子任务时不写「0/0」，也不提示左滑", () => {
    expect(sheet).toContain("子任务{aliveSubtasks(task).length > 0 && ` · ${doneSubs.length}/${aliveSubtasks(task).length}`}");
    expect(sheet).toContain("{openSubs.length > 0 && <span className=\"msh-sec-hint\">左滑可放弃 / 删除</span>}");
  });
  it("手机四象限不写「空格键调整」", () => {
    expect(read("src/views/Quadrant.tsx")).toContain('{isMobile ? "按住拖动安排" : "拖动安排 · 空格键调整"}');
  });
  it("重要性全应用一套颜色：四象限的点跟任务行 .flag 一样（高红、中暖褐）", () => {
    const quad = read("src/styles/quadrant.css");
    expect(quad).toContain(".quad-point.p3 > span { background: #C0564A; }");
    expect(quad).toContain(".quad-point.p2 > span { background: var(--warn); }");
    expect(read("src/styles/base.css")).toContain(".flag.p3 { background: #C0564A; }");
  });
});

describe("手感", () => {
  it("勾掉、滑过生效线、长按都有一下轻震；只在手机上", () => {
    const h = read("src/mobile/haptic.ts");
    expect(h).toContain("if (!isMobile) return;");
    expect(h).toContain("navigator.vibrate?.(ms);");
    expect(row).toContain("onThreshold: haptic,");
    expect(row).toContain("haptic(16);");
    expect(read("scripts/build-android.sh")).toContain("android.permission.VIBRATE");
  });
  it("滑动跨线只震一次，退回再越过才再震", () => {
    const s = read("src/mobile/swipe.ts");
    expect(s).toContain("if (over !== past.current) {");
  });
  it("指针被系统收回时滑动不中断（setPointerCapture 抛错兜住）", () => {
    expect(read("src/mobile/swipe.ts")).toMatch(/try \{\s*\(e\.currentTarget as HTMLElement\)\.setPointerCapture\(s\.id\);\s*\} catch/);
  });
  it("往下滚大标题收成一行，有防抖的两道线", () => {
    const head = read("src/mobile/MobileHead.tsx");
    expect(head).toContain('page.addEventListener("scroll", onScroll, { capture: true, passive: true });');
    expect(head).toContain("was ? el.scrollTop > 8 : el.scrollTop > 28");
  });
  it("新样式里的动效时长只用 --dur-1 / --dur-2", () => {
    for (const line of v2.split(/\r?\n/).filter((l) => /\b(transition|animation):/.test(l))) {
      expect(line, line).not.toMatch(/\d(ms|s)\b/);
    }
  });
});

describe("更新弹窗", () => {
  it("「装完打开…」那行跟上面的框一样有左右留白（1.15.0 里只挂了小字样式，贴着弹窗边）", () => {
    expect(read("src/components/UpdateDialog.tsx")).toContain('<p className="update-hint update-note">');
    expect(read("src/styles/overlays.css")).toContain(".update-note { padding: 0 22px 12px;");
  });
});

describe("补齐桌面已有的功能", () => {
  it("手机上的日期选项、顺延都读自定义快捷日期", () => {
    for (const p of ["src/mobile/TaskSheet.tsx", "src/mobile/QuickAddSheet.tsx", "src/mobile/ActionSheet.tsx", "src/mobile/PostponeSheet.tsx"]) {
      expect(read(p), p).toContain("dateShortcuts");
    }
    expect(read("src/views/Settings.tsx")).not.toContain("{hasDesktopFeatures && <DateShortcutSettings />}");
  });
  it("手机切回橡果时按间隔查云端；设置里能选间隔", () => {
    expect(read("src/views/Settings.tsx")).toContain("{(isDesktopShell || isMobile) && <div className=\"set-row\">");
    expect(read("src/core/syncCtl.ts")).toContain('document.addEventListener("visibilitychange", onShow);');
  });
  it("详情底部有「完成」主按钮", () => {
    expect(sheet).toContain('{task.done ? "放回未完成" : "完成"}');
  });
});
