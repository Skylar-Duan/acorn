// v1.15.1 · 桌面右上角那颗头像 + 账号小面板；设置页账号那一节挪到最上面、每次进来都摊开。
//
// 用户原话：
//   「电脑版：头像显示在右上角，头像账号页面没有做出来（手机版设置了名称、头像，电脑版没有地方显示）」
//   「三端：设置中，账号卡片默认张开，并且移到最上面」
//
// 这一份钉四样：
//   ① **挂在哪**：App 这一层、桌面那一段挂一次，各页不各写；手机不挂（手机的在「今天」顶栏里）
//   ② **那条不许走错的路**：面板上的「退出登录」只接 signOut；清空本机、注销继续只在设置页
//   ③ **真渲染一遍**：没登录点了直接去登录；登录着点开是面板，点外面 / Esc 关；图 > 首字 > 人形
//   ④ **设置页每次进来都摊开账号**（useFold.preferFoldOpen），但别处点名要开别的节时让位
//
// 样式只能用 node:fs 读：vitest 不处理 CSS，`import x from "a.css?raw"` 读回来是空串。
import { act, createElement, Fragment, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import AccountCorner from "../src/components/AccountPopover";
import { forceFoldOpen, preferFoldOpen, useFold } from "../src/core/useFold";
import { syncStore } from "../src/core/syncCtl";
import { setProfiles } from "../src/core/store";
import { loginStore } from "../src/mobile/sheetStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const read = (p: string) => readFileSync(p, "utf8");
const nl = (s: string) => s.replace(/\r\n/g, "\n");
/** 注释里写了什么都不算数，看真代码 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/.*$/gm, "");

// 这一份不能套 stripComments：里面有 accept="image/*"，那个「/*」会被当成注释开头一路吃到下一个「*/」。
// 它的注释只有两种写法（整行 // 和 JSX 里的 {/* */}），按这两种剥
const popSrc = nl(read("src/components/AccountPopover.tsx"))
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");
const appSrc = stripComments(nl(read("src/App.tsx")));
const appCss = nl(read("src/styles/app.css"));
const popCss = nl(read("src/styles/account-pop.css"));

// ---------------------------------------------------------------- ① 挂在哪

describe("① 头像挂在 App 这一层，桌面一颗、各页共用", () => {
  it("App 在 !isMobile 那一处挂 AccountCorner，只挂一次", () => {
    expect(appSrc).toContain('import AccountCorner from "./components/AccountPopover";');
    expect(appSrc).toContain("{!isMobile && <AccountCorner />}");
    expect(appSrc.split("<AccountCorner").length - 1).toBe(1);
  });

  it("各页自己不挂：views 底下没有一处引它", () => {
    for (const v of ["Today", "Calendar", "Done", "Plan", "Settings", "ListView", "Habits", "StatsView", "FocusView"]) {
      expect(read(`src/views/${v}.tsx`), `${v} 不该自己挂头像`).not.toContain("AccountPopover");
    }
  });

  it("标题行给它让位：桌面那套 .view-head 右边留出位置，窄屏抽屉模式也留（跟左边给 ☰ 的一样宽）", () => {
    expect(appCss).toContain(".shell:not(.mobile) .view-head { padding-right: 44px; }");
    const narrow = appCss.slice(appCss.indexOf("@media (max-width: 760px)"));
    expect(narrow).toContain(".shell:not(.mobile) .view-head { padding-right: 46px; }");
  });

  it("不压住网页版顶上那条提示：web-note-on 时跟着往下让", () => {
    expect(popCss).toContain(".shell.web-note-on .acct-corner { top: calc(var(--web-note-h)");
  });

  it("层级比抽屉遮罩（89）、弹层（100）、写盘停手红条（300）都低", () => {
    const z = Number(/\.acct-corner \{[^}]*z-index: (\d+)/.exec(popCss)?.[1]);
    expect(z).toBeGreaterThan(0);
    expect(z).toBeLessThan(89);
  });
});

// ---------------------------------------------------------------- ② 不许走错的路

describe("② 面板上的「退出登录」只断登录态，清空本机和注销只在设置页", () => {
  it("接的是 syncCtl.signOut", () => {
    expect(popSrc).toContain('import { applyAutoLogin, autoLoginOn, signOut, syncNow, useSync } from "../core/syncCtl";');
    expect(popSrc).toContain("void signOut().then(");
  });

  it("wipeLocalData / checkWipeGate / 注销 / 从云端覆盖 一个都不许出现", () => {
    for (const gone of ["wipeLocalData", "checkWipeGate", "deleteAccount", "restoreFromCloud", "core/wipe", "清空本机"]) {
      expect(popSrc, `面板里不该有 ${gone}`).not.toContain(gone);
    }
  });

  it("名字和头像只经 core/profile 读写，首字口径不另写一份", () => {
    expect(popSrc).toContain('from "../core/profile"');
    expect(popSrc).not.toContain("function avatarInitial(");
    expect(popSrc).toContain("setProfileAvatar(email, await shrinkToAvatar(file))");
    expect(popSrc).toContain("setProfileName(email, v)");
    expect(popSrc).toContain('type="file"');
  });

  it("自动登录复用 autoLogin + applyAutoLogin，不自己另记一份", () => {
    expect(popSrc).toContain("updateSettings({ autoLogin: next })");
    expect(popSrc).toContain("void applyAutoLogin(next)");
  });

  it("「更多账号设置」跳设置页并掰开账号那一节", () => {
    const more = popSrc.slice(popSrc.indexOf('className="acct-pop-more"'));
    expect(more).toContain('forceFoldOpen("cloud", "acorn-set-")');
    expect(more).toContain('navigate("settings")');
  });

  it("界面上不写端名（「这台电脑」是说这台机器，不是端名）", () => {
    for (const w of ["桌面版", "电脑版", "网页版", "手机版", "Windows"]) expect(popSrc).not.toContain(w);
  });
});

// ---------------------------------------------------------------- ③ 真渲染

const roots: Root[] = [];
function render(): HTMLDivElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(AccountCorner)));
  roots.push(root);
  return host;
}

const signIn = (email = "bower@example.com") =>
  act(() => syncStore.setState({ session: { token: "t", email, rev: 1, syncedAt: null }, phase: "idle", message: "已同步" }));

describe("③ 真渲染一遍", () => {
  beforeEach(() => {
    syncStore.setState({ session: null, phase: "off", message: "" });
    loginStore.setState({ open: false, reason: "manual" });
    setProfiles({});
  });
  afterEach(() => {
    act(() => roots.splice(0).forEach((r) => r.unmount()));
    document.body.innerHTML = "";
  });

  it("没登录：画个人形，点了直接去登录，不开面板", () => {
    const host = render();
    const fab = host.querySelector<HTMLButtonElement>(".acct-fab")!;
    expect(fab.querySelector("svg")).not.toBeNull();
    expect(fab.getAttribute("aria-label")).toBe("登录");
    act(() => fab.click());
    expect(loginStore.getState().open).toBe(true);
    expect(host.querySelector(".acct-pop")).toBeNull();
  });

  it("登录着没设名字：显示邮箱首字；设了名字显示名字首字；有图显示图", () => {
    const host = render();
    signIn();
    const fab = () => host.querySelector<HTMLButtonElement>(".acct-fab")!;
    expect(fab().textContent).toBe("B");
    act(() => setProfiles({ "bower@example.com": { name: "阿杜", avatar: "", updatedAt: "2026-09-21T00:00:00.000Z" } }));
    expect(fab().textContent).toBe("阿");
    act(() =>
      setProfiles({ "bower@example.com": { name: "阿杜", avatar: "data:image/jpeg;base64,xx", updatedAt: "2026-09-21T00:00:01.000Z" } }),
    );
    expect(fab().querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,xx");
  });

  it("点开是面板：邮箱、立即同步、自动登录开关、退出登录、更多账号设置；没有清空本机", () => {
    const host = render();
    signIn();
    act(() => host.querySelector<HTMLButtonElement>(".acct-fab")!.click());
    const pop = host.querySelector(".acct-pop")!;
    expect(pop).not.toBeNull();
    const text = pop.textContent ?? "";
    for (const s of ["bower@example.com", "立即同步", "下次打开还认这台电脑", "退出登录", "更多账号设置"]) {
      expect(text).toContain(s);
    }
    expect(text).not.toContain("注销");
    expect(text).not.toContain("并清空本机");
    expect(pop.querySelector('input[type="file"]')).not.toBeNull();
  });

  it("点外面、按 Esc 都关；点面板里面不关", () => {
    const host = render();
    signIn();
    const fab = host.querySelector<HTMLButtonElement>(".acct-fab")!;
    act(() => fab.click());
    act(() => host.querySelector(".acct-pop")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(host.querySelector(".acct-pop")).not.toBeNull();

    act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(host.querySelector(".acct-pop")).toBeNull();

    act(() => fab.click());
    // 真按键是从焦点那儿（这里是 body）冒上来的，面板那条监听挂在 document 捕获阶段
    act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.querySelector(".acct-pop")).toBeNull();
  });

  it("别处退出登录了（设置页、令牌过期），面板跟着收，圆钮变回人形", () => {
    const host = render();
    signIn();
    act(() => host.querySelector<HTMLButtonElement>(".acct-fab")!.click());
    act(() => syncStore.setState({ session: null, phase: "off" }));
    expect(host.querySelector(".acct-pop")).toBeNull();
    expect(host.querySelector(".acct-fab svg")).not.toBeNull();
  });
});

// ---------------------------------------------------------------- ④ 设置页每次进来摊开账号

let seq = 0;
/** 每个用例一个自己的前缀：preferFoldOpen 是按前缀认「有没有别人点名」的，前缀不重就互不相干 */
const freshPrefix = () => `acorn-t${++seq}-`;

/** 模拟设置页：父组件先 preferFoldOpen("cloud")，再挂几节同组的折叠。
 *  frames 记下挂载那一帧每一节开没开——effect 里补救的话，用户是看得见那一下的 */
function mountSettings(prefix: string, names = ["cloud", "general", "look", "data"]) {
  const cells = new Map<string, [boolean, () => void]>();
  const frames: string[] = [];
  let firstPass = true;
  function Sec({ name }: { name: string }) {
    const cell = useFold(name, name === "cloud", prefix, "settings");
    if (firstPass && cell[0]) frames.push(name);
    cells.set(name, cell);
    return null;
  }
  function Page() {
    useState(() => preferFoldOpen("cloud", prefix));
    return createElement(Fragment, null, ...names.map((n) => createElement(Sec, { key: n, name: n })));
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Page)));
  firstPass = false;
  roots.push(root);
  return {
    firstFrame: () => [...new Set(frames)],
    open: (n: string) => cells.get(n)![0],
    toggle: (n: string) => act(() => cells.get(n)![1]()),
    unmount: () => act(() => root.unmount()),
  };
}

describe("④ 设置页每次进来都摊开账号那一节", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => act(() => roots.splice(0).forEach((r) => r.unmount())));

  it("老用户本机记着「通用」开着：进来第一帧就只有账号开着，记忆跟着改口", () => {
    const prefix = freshPrefix();
    localStorage.setItem(`${prefix}general`, "1");
    const p = mountSettings(prefix);
    expect(p.firstFrame()).toEqual(["cloud"]);
    expect(p.open("general")).toBe(false);
    expect(localStorage.getItem(`${prefix}general`)).toBe("0");
    expect(localStorage.getItem(`${prefix}cloud`)).toBe("1");
  });

  it("本机记着账号是收着的也照样摊开——这就是「每次进来」", () => {
    const prefix = freshPrefix();
    localStorage.setItem(`${prefix}cloud`, "0");
    localStorage.setItem(`${prefix}look`, "1");
    const p = mountSettings(prefix);
    expect(p.firstFrame()).toEqual(["cloud"]);
    expect(p.open("look")).toBe(false);
  });

  it("进来之后用户点开别的节，账号照常收起（手风琴不变）；下次再进来又是账号", () => {
    const prefix = freshPrefix();
    const p = mountSettings(prefix);
    p.toggle("look");
    expect([p.open("cloud"), p.open("look")]).toEqual([false, true]);
    p.unmount();

    const again = mountSettings(prefix);
    expect(again.firstFrame()).toEqual(["cloud"]);
    expect(again.open("look")).toBe(false);
  });

  it("🔴 侧栏「数据异常」刚点名要开「数据」：不抢，摊开的是数据那一节", () => {
    const prefix = freshPrefix();
    localStorage.setItem(`${prefix}general`, "1");
    forceFoldOpen("data", prefix); // 侧栏 revealSetSection("data", "set-data") 先喊，再 navigate
    const p = mountSettings(prefix);
    expect(p.firstFrame()).toEqual(["data"]);
    expect(p.open("cloud")).toBe(false);
  });

  it("点名要开的本来就是账号（侧栏同步指示、右上角「更多账号设置」）：照样是账号", () => {
    const prefix = freshPrefix();
    forceFoldOpen("cloud", prefix);
    const p = mountSettings(prefix);
    expect(p.firstFrame()).toEqual(["cloud"]);
  });

  it("preferFoldOpen 让位时返回 false，而且不写本机记忆", () => {
    const prefix = freshPrefix();
    forceFoldOpen("data", prefix);
    expect(preferFoldOpen("cloud", prefix)).toBe(false);
    expect(localStorage.getItem(`${prefix}cloud`)).toBeNull();
    const other = freshPrefix();
    expect(preferFoldOpen("cloud", other)).toBe(true);
    // 在渲染里喊的，不碰 localStorage——记忆等那一节挂载时再补
    expect(localStorage.getItem(`${other}cloud`)).toBeNull();
  });
});
