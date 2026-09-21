// v1.14.1 · 设置页重排。PM 原话：
//   「设置里面行为改名为通用，并且顺序上放在最前面，其他顺序也整理一下，
//     按照其他 app 的一般习惯；一句话记事作为快捷用语指南收入到通用中」
//
// 这一页的改动全是**摆放和叫法**：分节的先后、标题的字、哪一块并进了哪一块。
// jsdom 里没有布局引擎也没有 @testing-library，量不出来一个像素，
// 所以跟 mobile-pages / polish-fixes 一个路数——钉住源码里的结构与字面。
// 每一条都对应 PM 点过名的一件事：
//
//   ① 「行为」这个叫法退场，改叫「通用」，并且是第一节
//   ② 「一句话记事」不再单独一节，它并进「通用」，在里面叫「快捷用语指南」
//   ③ 其余顺序按主流 App 的习惯：通用 → 外观 → 云账号 → 数据 → 导出与导入 → 版本更新 → 关于
//      （v1.15.1 改成 账号 → 通用 → 外观 → 数据 → …：账号挪到最上面，「云账号」改叫「账号」）
//   ④ 一次只摊开一节（手风琴），靠 core/useFold 的同组互斥，不是自己另起一套
//   ⑤ 打开用法那个入口一条没少，而且那张纸还留在折叠容器外面（容器 overflow:hidden 会裁掉它）
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

const src = read("src/views/Settings.tsx");
const foldSrc = read("src/core/useFold.ts");
const setCss = read("src/styles/settings.css");

/** 仓库里 CRLF / LF 混着用，断言不许把行尾当内容的一部分 */
const nl = (s: string) => s.replace(/\r\n/g, "\n");
/** 写给后人的注释里出现什么都不算数，看的是真代码 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/.*$/gm, "");

const code = stripComments(nl(src));

/** 按出现顺序把每一节的 id 和标题捞出来 */
function sections(): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = [];
  const re = /<SetSection\s+id="([^"]+)"\s+title="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) out.push({ id: m[1], title: m[2] });
  return out;
}

/** 某一节从 `<SetSection id="x"` 到它自己那个 `</SetSection>` 之间的正文。
 *  缩进不能写死：「版本更新」包在 `{updaterSupported && (` 里，比别人深一级 */
function sectionBody(id: string): string {
  const at = code.search(new RegExp(`<SetSection\\s+id="${id}"`));
  expect(at, `找不到分节 ${id}`).toBeGreaterThan(-1);
  const end = code.indexOf("</SetSection>", at);
  expect(end, `分节 ${id} 没有收口`).toBeGreaterThan(at);
  return code.slice(at, end);
}

// v1.15.1 用户又点了一次名：「三端：设置中，账号卡片默认张开，并且移到最上面」。
// 所以「通用」让出第一位、排第二；一进来摊开的也换成了账号那一节（① ③ 按新口径改写）。
describe("① 「行为」改叫「通用」，紧跟在账号后面", () => {
  it("没有一节还叫「行为」了", () => {
    expect(code).not.toContain('title="行为"');
    expect(code).not.toContain('id="behavior"');
  });

  it("第一节是「账号」，紧跟着「反馈」（2026-09-21 加），「通用」排第三", () => {
    const [first, second, third] = sections();
    expect(first).toEqual({ id: "cloud", title: "账号" });
    expect(second).toEqual({ id: "feedback", title: "反馈" });
    expect(third).toEqual({ id: "general", title: "通用" });
  });

  it("只有账号那一节带 defaultOpen（新用户第一次进来摊开的就是它）", () => {
    const withDefault = sections().filter((s) => sectionBody(s.id).includes("defaultOpen"));
    expect(withDefault.map((s) => s.id)).toEqual(["cloud"]);
  });

  it("老用户每次进来也摊开账号：Settings 挂载时喊一次 preferFoldOpen，而且是在各节挂载之前", () => {
    // 光有 defaultOpen 不够——本机记着上次开的那一节，defaultOpen 只在从没记过时说了算
    expect(code).toContain('import { preferFoldOpen, useFold } from "../core/useFold";');
    expect(code).toContain('useState(() => preferFoldOpen("cloud", SET_FOLD_PREFIX));');
    // 喊在 Settings 函数体里、return 之前：父组件先渲染，这句赶在各节 claim 之前
    const body = code.slice(code.indexOf("export default function Settings()"));
    expect(body.indexOf("preferFoldOpen(")).toBeLessThan(body.indexOf("<SetSection"));
    // 不是 forceFoldOpen：那个会跟「数据异常 → 数据」那条路抢位子
    expect(body).not.toContain("forceFoldOpen(");
  });

  it("页眉那句副标题跟着改口，不再提「行为」", () => {
    expect(code).not.toContain("外观、账号、数据与行为");
    expect(code).toContain("通用、外观、账号与数据");
  });
});

describe("② 「一句话记事」并进「通用」，在里面叫「快捷用语指南」", () => {
  it("它不再是单独的一节", () => {
    expect(code).not.toContain('id="syntax"');
    expect(sections().map((s) => s.title)).not.toContain("一句话记事");
  });

  it("「快捷用语指南」这几个字长在「通用」那一节里", () => {
    expect(sectionBody("general")).toContain("快捷用语指南");
  });

  it("收起时那句摘要也先报它——不点开也知道这里有用法可看", () => {
    const head = sectionBody("general").slice(0, sectionBody("general").indexOf(">"));
    expect(head).toContain("快捷用语指南");
  });

  it("打开用法那个入口一条没少，还是走 GuideSheet 的 useGuideEntry", () => {
    expect(code).toContain("useGuideEntry");
    expect(sectionBody("general")).toContain("guide.open");
    expect(sectionBody("general")).toContain("打开用法");
  });

  it("那张纸留在折叠容器外面：容器 overflow:hidden，搁里面会被裁掉", () => {
    expect(sectionBody("general")).not.toContain("guide.sheet");
    expect(code).toContain("{guide.sheet}");
    // 收起用的是高度（grid 0fr↔1fr）+ overflow:hidden，这就是它不能待在里面的原因
    expect(nl(setCss)).toContain("overflow: hidden");
  });

  it("「随手记」这个词在这一页一个字都不剩", () => {
    expect(code).not.toContain("随手记");
  });
});

describe("③ 顺序按主流 App 的习惯来", () => {
  it("账号 → 反馈 → 通用 → 外观 → 数据 → 导出与导入 → 版本更新", () => {
    expect(sections().map((s) => s.id)).toEqual([
      "cloud", "feedback", "general", "look", "data", "io", "update",
    ]);
    expect(sections().map((s) => s.title)).toEqual([
      "账号", "反馈", "通用", "外观", "数据", "导出与导入", "版本更新",
    ]);
  });

  it("「云账号」这个叫法在设置页界面上一个字都不剩（跟头像点开的面板统一叫「账号」）", () => {
    expect(code).not.toContain("云账号");
  });

  it("「关于」压在最底下（它不折叠，是一张单独的卡）", () => {
    const lastSection = code.lastIndexOf("<SetSection");
    const about = code.indexOf("set-about");
    expect(about).toBeGreaterThan(lastSection);
  });

  it("「版本更新」沉到倒数第二——一年也点不了几次，别占着开头", () => {
    const ids = sections().map((s) => s.id);
    expect(ids[ids.length - 1]).toBe("update");
  });
});

describe("④ 一次只摊开一节，走 core/useFold 的同组互斥", () => {
  it("每一节都传同一个 group", () => {
    expect(code).toContain('const SET_GROUP = "settings"');
    expect(code).toContain("useFold(id, defaultOpen, SET_FOLD_PREFIX, SET_GROUP)");
  });

  it("没有自己另起一套手风琴（那会跟 useFold 抢着写同一批本机记忆）", () => {
    expect(code).not.toContain("useAccordion");
    expect(code).not.toContain('"acorn-set-open"');
  });

  it("useFold 真收得下第四个参数 group——签名要是被改回去，这里当场红", () => {
    const sig = nl(foldSrc).slice(
      nl(foldSrc).indexOf("export function useFold("),
      nl(foldSrc).indexOf("): [boolean, () => void] {"),
    );
    expect(sig).toContain("group?: string");
  });

  it("本机记忆的键还是 acorn- 开头：退出登录清空本机时按这个前缀扫", () => {
    expect(code).toContain('const SET_FOLD_PREFIX = "acorn-set-"');
  });

  it("侧栏那行同步指示还能把「云账号」掰开（它喊的是 acorn-set-cloud）", () => {
    expect(sections().map((s) => s.id)).toContain("cloud");
    expect(code).toContain('anchorId="set-cloud"');
    // v1.15.0：掰开 + 滚过去抽成了通用的 revealSetSection(节 id, DOM 锚点)，
    // 因为「数据异常」那行也要用同一套去「数据」那一节。云账号这条去处一个字没变
    const side = stripComments(nl(read("src/components/Sidebar.tsx")));
    expect(side).toContain('revealSetSection("cloud", "set-cloud")');
    expect(side).toContain('forceFoldOpen(key, "acorn-set-")');
  });
});

describe("⑤ 「通用」里放的是通用的东西，别的没混进来", () => {
  const body = sectionBody("general");

  it("快捷用语指南 / 周末指的是 / 全局快捷键 / 开机自启 都在这儿", () => {
    for (const s of ["快捷用语指南", "周末指的是", "全局快捷键", "开机自启"]) {
      expect(body, `「${s}」应该在通用里`).toContain(s);
    }
  });

  it("主题、账号、备份、导出这些各回各家，没被顺手塞进来", () => {
    for (const s of ["深浅模式", "AccountPanel", "每日备份", "导出 CSV", "UpdatePanel"]) {
      expect(body, `「${s}」不该出现在通用里`).not.toContain(s);
    }
  });

  it("手机上也不会剩个空壳：指南和「周末指的是」两端都渲染，不吃 hasDesktopFeatures", () => {
    const guideRow = body.slice(body.indexOf("快捷用语指南"), body.indexOf("周末指的是"));
    // 这一段里 hasDesktopFeatures 只用来挑措辞（三元），不能整行判掉（&&）
    expect(guideRow).not.toContain("hasDesktopFeatures && (");
  });
});

// ---------------------------------------------------------------------------
// ⑥ v1.15.0 网页版：这一页上「按了要真管用」的几行，判据得换人。
//
// 以前只有 hasDesktopFeatures 一个开关（= !isMobile），于是**电脑上的浏览器**一开
// 就被当成装好的桌面 App：摆一个按了没反应的全局快捷键、一颗点下去当场报「导出失败」的导出。
// 现在拆成两件事，这一组逐行认定的就是「网页上到底该显示什么」：
//   · 讲长相的（侧栏在哪、点哪儿记一条）留 hasDesktopFeatures —— 电脑浏览器仍是桌面那副样子
//   · 讲本事的（系统热键、开机自启、换数据文件夹、开独立窗口）换 isDesktopShell
//   · 讲「能不能把文件交到用户手上」的换 canSaveFile —— 浏览器走下载，只有安卓 App 给不了
// ---------------------------------------------------------------------------
describe("⑥ 网页上该显示什么：按了不管用的，一律不显示", () => {
  it("🔴 全局快捷键只给装在电脑上的橡果：浏览器里注册不了系统级热键", () => {
    const body = sectionBody("general");
    // lastIndexOf：这一节的摘要里也提了一句「全局快捷键」，要的是底下那一行真正的开关
    const row = body.slice(body.lastIndexOf("全局快捷键"));
    // 整行判掉，而且判的是 isDesktopShell
    expect(body).toContain("{isDesktopShell && (");
    expect(row).not.toContain("hasDesktopFeatures");
  });

  it("开机自启 / 更换文件夹同理，而且不必再写 inTauri &&（isDesktopShell 已经含着它）", () => {
    expect(code).toContain("开机自启");
    expect(code).not.toContain("{inTauri && hasDesktopFeatures && (");
  });

  it("「打开用法」那句认 isDesktopShell：浏览器里开不了独立窗口，跟手机一样退成应用内那张纸", () => {
    const body = sectionBody("general");
    const guideRow = body.slice(body.indexOf("快捷用语指南"), body.indexOf("周末指的是"));
    expect(guideRow).toContain("{isDesktopShell");
    expect(guideRow).toContain("会开一个单独的窗口");
  });

  it("但「点侧栏的＋记一条」这句仍认 hasDesktopFeatures：那是长相，电脑浏览器也有侧栏", () => {
    const body = sectionBody("general");
    const guideRow = body.slice(body.indexOf("快捷用语指南"), body.indexOf("周末指的是"));
    expect(guideRow).toContain('{hasDesktopFeatures ? "也可以点侧栏的「＋ 记一条」，"');
  });

  it("🔴 导出与导入认 canSaveFile：网页上要有，只有安卓 App 那一档说「请登录账号迁移」", () => {
    const io_ = sectionBody("io");
    expect(io_).toContain("{canSaveFile ? (");
    expect(io_).toContain('summary={canSaveFile ? "JSON · CSV · Markdown" : "手机上请登录账号迁移"}');
    expect(io_).toContain("手机上不提供文件导出");
  });

  it("🔴 浏览器那条路是真接上了的：导出走下载、导入走选文件，不是摆着好看", () => {
    // 这两句要是没了，网页上点导出就又回到「导出失败」那一幕
    expect(code).toContain("downloadTextFile(");
    expect(code).toContain("pickTextFile()");
    // 而且是在「不在 Tauri 里」那一支上，不是把桌面那条顶掉
    const exp = code.slice(code.indexOf("async function exportAs"), code.indexOf("async function importJson"));
    expect(exp).toContain("if (!inTauri) {");
    expect(exp).toContain("@tauri-apps/plugin-dialog");
  });

  it("🔴 导入前留底那句话，两端说的都得是各自真会发生的事", () => {
    // 浏览器里没有 backups 文件夹，说「自动留一份恢复备份」就是骗人——那儿是下载给他
    expect(code).toContain('"导入前会自动留一份恢复备份"');
    expect(code).toContain('"导入前会先把现在这份下载下来留底"');
    const imp = code.slice(code.indexOf("async function importJson"));
    expect(imp).toContain("pre-import-");
    expect(imp).toContain("acorn-导入前-");
  });
});
