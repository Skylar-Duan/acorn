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
    expect(sheet).not.toContain("左滑可放弃 / 删除");
  });
  it("手机四象限不写「空格键调整」", () => {
    expect(read("src/views/Quadrant.tsx")).toContain("{!isMobile && <span>拖动安排 · 空格键调整</span>}");
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

describe("手机 Plus（10-30，安卓 1.17.0）：资格跟账号走，跟电脑同一套", () => {
  const plus = read("src/core/plus.ts");
  it("认 Plus 的端：Windows 上的橡果 + 安卓上的橡果；网页版不认", () => {
    expect(plus).toContain("&& (isDesktopShell && /Windows/i.test(navigator.userAgent) || (inTauri || PLUS_PREVIEW) && isAndroid);");
    expect(plus).toContain("const supported = () => !isWebBuild");
  });
  it("截图预览开关只在专门的构建里生效，正式包里是 false", () => {
    expect(plus).toContain('const PLUS_PREVIEW = import.meta.env.VITE_ACORN_PLUS_PREVIEW === "1";');
    expect(read(".env.plus-preview").trim()).toBe("VITE_ACORN_PLUS_PREVIEW=1");
  });
  it("图片组件不再按「是不是手机」藏起来，只看 Plus", () => {
    const img = read("src/components/ImageAttachments.tsx");
    expect(img).not.toContain("isMobile");
    expect(img).toContain("if (!plus) return null;");
  });
  it("详情、子任务、记一条、列表行都接上图片，且都只在 Plus 时出现", () => {
    expect(sheet).toContain("function TaskImagesBlock");
    expect(sheet).toContain("if (!plus) return null;");
    expect(sheet).toContain("{plus && !sub.done && (");
    const qa = read("src/mobile/QuickAddSheet.tsx");
    expect(qa).toContain('pickerLabel="给这件事添加图片"');
    expect(qa).toContain("const draftImages = plusEnabled() ? imagesRef.current : [];");
    expect(row).toContain("const pics = plus ? renderableTaskImages(taskImages((sub ?? task).images)) : [];");
  });
});

describe("去冗余说明（10-30 用户点名）", () => {
  it("点名的几句都不在手机上出现", () => {
    const acct = read("src/mobile/AccountSheet.tsx");
    for (const t of ["下次打开还认这台手机", "让提醒准时响", "这台设备上的事一条都不动"]) expect(acct).not.toContain(t);
    const quad = read("src/views/Quadrant.tsx");
    expect(quad).not.toContain('sub="重要向上，截止越近越靠右"');
    expect(quad).toContain("{!isMobile && <p className=\"quad-footnote\">");
    expect(quad).toContain('{isMobile ? "截止" : "截止越近，越靠右"}');
  });
  it("设置页手机上不摆说明小字；安卓上没有导出那一节", () => {
    expect(v2).toContain(".shell.mobile .mshell .set-desc { display: none; }");
    expect(read("src/views/Settings.tsx")).toContain("{canSaveFile && <SetSection");
  });
});
