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

describe("① 「行为」改叫「通用」，并且排在第一位", () => {
  it("没有一节还叫「行为」了", () => {
    expect(code).not.toContain('title="行为"');
    expect(code).not.toContain('id="behavior"');
  });

  it("第一节就是「通用」", () => {
    const first = sections()[0];
    expect(first.id).toBe("general");
    expect(first.title).toBe("通用");
  });

  it("只有「通用」是一进来就摊开的那一节", () => {
    const withDefault = sections().filter((s) => sectionBody(s.id).includes("defaultOpen"));
    expect(withDefault.map((s) => s.id)).toEqual(["general"]);
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
  it("通用 → 外观 → 云账号 → 数据 → 导出与导入 → 版本更新", () => {
    expect(sections().map((s) => s.id)).toEqual([
      "general", "look", "cloud", "data", "io", "update",
    ]);
    expect(sections().map((s) => s.title)).toEqual([
      "通用", "外观", "云账号", "数据", "导出与导入", "版本更新",
    ]);
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
    expect(stripComments(nl(read("src/components/Sidebar.tsx"))))
      .toContain('forceFoldOpen("cloud", "acorn-set-")');
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
