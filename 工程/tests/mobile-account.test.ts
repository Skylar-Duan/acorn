// 手机端账号那一套（v1.15.0）：右上角那颗头像、点开的账号纸、自动登录、头像与名字。
//
// 账本原话：「手机：自动登录可选，自动启动可选，登陆头像可上传，名称设置，主页面。右上角。
// 方便一键登入登出。」
//
// 这一份钉四样：
//   ① **数据模型**：三个新设置都是可选字段，DATA_VERSION 一个字不许动（动了会把没升级的
//      桌面端挡在 409 外面），老数据读进来自动补齐、已经有值的一个不改。
//   ② **判据**：autoLoginOn（缺字段 = 开着）、applyAutoLogin（关掉当场删本机令牌，
//      内存里的登录态不动）、头像首字的取法。
//   ③ **那条不许走错的路**：账号纸上那颗「退出登录」只接 signOut，
//      「退出并清空本机」必须继续待在设置页、继续先过 checkWipeGate 那道闸。
//   ④ **纪律**：头像必须压过再存；头像钮只有「今天」摆一颗；手机样式锁在 .mshell 底下。
//
// 样式只能用 node:fs 读：vitest 默认不处理 CSS，`import x from "a.css?raw"` 读回来是空串。
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DATA_VERSION, defaultSettings, migrate } from "../src/core/model";
import { applyAutoLogin, autoLoginOn, syncStore } from "../src/core/syncCtl";
import { avatarInitial } from "../src/mobile/MobileHead";
import { AVATAR_PX, AVATAR_QUALITY, accountInitial } from "../src/mobile/AccountSheet";

const read = (p: string) => readFileSync(p, "utf8");
const shellCss = read("src/styles/mobile-shell.css");
const sheetCss = read("src/styles/mobile-sheet.css");
const accountSheetSource = read("src/mobile/AccountSheet.tsx");
const headSource = read("src/mobile/MobileHead.tsx");
const sheetStoreSource = read("src/mobile/sheetStore.ts");
const appSource = read("src/App.tsx");
const syncCtlSource = read("src/core/syncCtl.ts");
const accountPanelSource = read("src/components/AccountPanel.tsx");

/** 本机令牌存在 localStorage 的哪个键（cloud.ts 里那个不对外的 AUTH_LS_KEY）。
 *  这里写字面量是故意的：它是一个**已经发出去的存储格式**，改名等于让所有网页版用户被登出，
 *  真要改的那天，这条断言就是那个提醒 */
const AUTH_LS_KEY = "acorn-auth";

// ---------------------------------------------------------------- ① 数据模型

describe("三个新设置：可选字段，版本号一个字不动", () => {
  it("DATA_VERSION 仍是 8", () => {
    // 加可选字段不需要升版本。升了版本，还没升级的桌面端推数据会被服务端 409 挡回来
    expect(DATA_VERSION).toBe(8);
  });

  it("默认：自动登录开着，名字和头像空着", () => {
    const s = defaultSettings();
    expect(s.autoLogin).toBe(true);
    expect(s.profileName).toBe("");
    expect(s.profileAvatar).toBe("");
  });

  it("老数据读进来自动补齐，别的设置一个不动", () => {
    const d = migrate({
      version: 4,
      settings: { theme: "ocean", weekendDay: "sat" },
      tasks: [], lists: [], sessions: [], graveyard: [],
    } as never);
    expect(d.settings.autoLogin).toBe(true);
    expect(d.settings.theme).toBe("ocean");
    expect(d.settings.weekendDay).toBe("sat");
  });

  it("已经关掉自动登录的那台设备，读一遍不会被默认值改回开", () => {
    const d = migrate({
      version: DATA_VERSION,
      settings: { autoLogin: false, profileName: "阿杜", profileAvatar: "data:image/jpeg;base64,xx" },
      tasks: [], lists: [], sessions: [], graveyard: [],
    } as never);
    expect(d.settings.autoLogin).toBe(false);
    expect(d.settings.profileName).toBe("阿杜");
    expect(d.settings.profileAvatar).toBe("data:image/jpeg;base64,xx");
  });

  it("这三样都只是这台设备的事：设置本来就不参与云同步", () => {
    // merge.ts 那句 `settings: local.settings` 是这条约定的真源。手机上换个名字、
    // 关掉自动登录，都不该跟着同步跑到电脑上去
    expect(read("src/core/merge.ts")).toContain("settings: local.settings");
  });
});

// ---------------------------------------------------------------- ② 判据

describe("自动登录这个开关（autoLoginOn / applyAutoLogin）", () => {
  beforeEach(() => {
    localStorage.clear();
    syncStore.setState({ session: null });
  });

  it("缺这个字段一律当开着——老数据和桌面端都是「打开就是登录着的」", () => {
    expect(autoLoginOn({})).toBe(true);
    expect(autoLoginOn({ autoLogin: undefined })).toBe(true);
    expect(autoLoginOn({ autoLogin: true })).toBe(true);
    expect(autoLoginOn({ autoLogin: false })).toBe(false);
  });

  it("关掉：当场把本机那份令牌删掉", async () => {
    localStorage.setItem(AUTH_LS_KEY, JSON.stringify({ token: "t", email: "a@b.co", rev: 1, syncedAt: null }));
    await applyAutoLogin(false);
    expect(localStorage.getItem(AUTH_LS_KEY)).toBeNull();
  });

  it("关掉不等于登出：内存里的登录态一个字不动，这次照常同步", async () => {
    // 顺手 signOut 的话，他关掉开关之后记的几条会停在本机，自己还以为传上去了
    syncStore.setState({ session: { token: "t", email: "a@b.co", rev: 1, syncedAt: null } });
    await applyAutoLogin(false);
    expect(syncStore.getState().session?.email).toBe("a@b.co");
  });

  it("再打开：把现在这份登录态写回去（不然开关拨回来了、下次打开还得重输）", async () => {
    syncStore.setState({ session: { token: "t", email: "a@b.co", rev: 3, syncedAt: null } });
    await applyAutoLogin(true);
    expect(JSON.parse(localStorage.getItem(AUTH_LS_KEY)!).token).toBe("t");
  });

  it("没登录的时候打开开关：什么都不写（没有登录态可记）", async () => {
    await applyAutoLogin(true);
    expect(localStorage.getItem(AUTH_LS_KEY)).toBeNull();
  });

  it("开机那一轮也守这道闸：关着就不恢复登录态，顺手再删一次令牌", () => {
    const init = syncCtlSource.slice(syncCtlSource.indexOf("export async function initSync"));
    expect(init).toContain("if (!autoLoginOn()) {");
    expect(init).toContain("await cloud.saveSession(null);");
  });
});

describe("头像上显示哪个字", () => {
  it("名字优先于邮箱——用户自己起的名字才是他认得的自己", () => {
    expect(avatarInitial("阿杜", "bower@example.com")).toBe("阿");
    expect(avatarInitial("", "bower@example.com")).toBe("B");
    expect(avatarInitial("  ", "bower@example.com")).toBe("B");
  });

  it("两边都空着（还没登录）返回空串，由界面画个人形轮廓", () => {
    expect(avatarInitial(undefined, undefined)).toBe("");
    expect(avatarInitial("", "")).toBe("");
  });

  it("账号纸和顶栏那颗圆钮用的是同一份口径", () => {
    for (const [name, mail] of [["阿杜", "b@c.co"], ["", "zoe@x.cn"], ["", ""]] as const) {
      expect(accountInitial(name, mail)).toBe(avatarInitial(name, mail));
    }
  });
});

// ---------------------------------------------------------------- ③ 那条不许走错的路

describe("账号纸上那颗「退出登录」只断登录态，绝不清本机", () => {
  it("接的是 syncCtl.signOut，跟设置页那条「只退出登录，保留本机」同一句回执", () => {
    expect(accountSheetSource).toContain("signOut()");
    expect(accountSheetSource).toContain("已退出登录。这台设备上的数据原样留着，一条都没清");
    expect(accountPanelSource).toContain("已退出登录。这台设备上的数据原样留着，一条都没清");
  });

  it("清空本机那条路一句代码都不在这张纸上（头注释里写着为什么，那不算）", () => {
    for (const gone of [
      'from "../core/wipe"', "wipeLocalData(", "checkWipeGate(", "退出登录并清空本机", "注销账号",
    ]) {
      expect(accountSheetSource).not.toContain(gone);
    }
  });

  it("清空本机继续留在设置页，也继续先过那道闸", () => {
    expect(accountPanelSource).toContain("退出登录并清空本机");
    expect(accountPanelSource).toContain("const gate = await checkWipeGate();");
  });

  it("两处说的是同一件事：设置页那段明说手机上那颗头像做的是「保留本机」这一条", () => {
    expect(accountPanelSource).toContain("做的是「保留本机」这一条");
  });
});

// ---------------------------------------------------------------- ④ 纪律

describe("头像：必须压过再存", () => {
  it("128 见方、存成 JPEG", () => {
    // 整份数据每次同步都会连头像一起传，服务端单账号只给 5MB。
    // 原图直接存进去，一张手机相册里的照片就能把同步撑爆
    expect(AVATAR_PX).toBe(128);
    expect(AVATAR_QUALITY).toBeGreaterThan(0.5);
    expect(AVATAR_QUALITY).toBeLessThan(1);
    expect(accountSheetSource).toContain('canvas.toDataURL("image/jpeg", AVATAR_QUALITY)');
  });

  it("走的是 WebView 自带的选择器，不引任何插件（安卓端至今一处文件读写都没有）", () => {
    expect(accountSheetSource).toContain('type="file"');
    expect(accountSheetSource).toContain("new FileReader()");
    expect(accountSheetSource).not.toContain("plugin-dialog");
    expect(accountSheetSource).not.toContain("plugin-fs");
  });

  it("居中裁成正方形再缩（直接缩会把竖着拍的人像压扁）", () => {
    expect(accountSheetSource).toContain("Math.min(img.width, img.height)");
  });
});

describe("那颗头像钮只在「今天」摆一颗", () => {
  it("MobileHead 认 account 这个开关", () => {
    expect(headSource).toContain("account?: boolean;");
    expect(headSource).toContain("{account && <AccountButton />}");
  });

  it("只有 Today 传 account——每一页都摆一颗，等于把「你还没登录」重说五遍", () => {
    const views = ["Today", "Plan", "Done", "ListView", "Habits", "Calendar", "MobileMore", "Quadrant"];
    const passing = views.filter((v) => {
      const src = (() => {
        try {
          return read(`src/views/${v}.tsx`);
        } catch {
          return "";
        }
      })();
      return /^\s+account$/m.test(src);
    });
    expect(passing).toEqual(["Today"]);
  });

  it("点了开的是账号纸，不是跳设置页（用户要的是「一键」）", () => {
    expect(headSource).toContain('openSheet({ kind: "account" })');
  });
});

describe("抽屉栈与挂载", () => {
  it("sheetStore 多了 account 这一种，habit 那行照旧收尾", () => {
    expect(sheetStoreSource).toContain('| { kind: "account" }');
    expect(sheetStoreSource).toContain('| { kind: "habit"; id?: string };');
  });

  it("只认栈顶，关掉调 closeSheet（跟别的纸同一套）", () => {
    expect(accountSheetSource).toContain('const open = top?.kind === "account";');
    expect(accountSheetSource).toContain("onClose={closeSheet}");
  });

  it("App 只在手机那一段挂 AccountSheetHost", () => {
    expect(appSource).toContain('import { AccountSheetHost } from "./mobile/AccountSheet";');
    const hosts = appSource.slice(appSource.indexOf("{isMobile && ("), appSource.indexOf("<LoginPageHost />"));
    expect(hosts).toContain("<AccountSheetHost />");
    expect(hosts).toContain("<GuideSheetHost />");
  });

  it("没登录时整张纸就一颗按钮，直通登录页", () => {
    expect(accountSheetSource).toContain('openLogin("manual")');
    expect(accountSheetSource).toContain("登录 / 注册");
  });
});

describe("自启动：这一版只说实话，不做按了没反应的按钮", () => {
  it("那一行是说明不是按钮（跟清单设置里「调整清单顺序」同一个做法）", () => {
    expect(accountSheetSource).toContain('<div className="msh-acct-row dim">');
    expect(accountSheetSource).toContain("橡果没开着的时候提醒不会响");
  });

  it("没有偷偷去唤一个唤不起来的系统页", () => {
    // 真的跳过去要给安卓加 intent + 改 Tauri 的 opener 白名单（现在只放行 https 两条），
    // 那是另一晚的活。在那之前，一颗点了什么都不发生的按钮比一句实话更糟
    expect(accountSheetSource).not.toContain("openUrl");
    expect(accountSheetSource).not.toContain("intent://");
  });
});

describe("样式：手机的东西锁在 .mshell 底下，颜色只用 token", () => {
  it("顶栏那颗头像有自己的长相，图填满并裁圆", () => {
    expect(shellCss).toContain(".mhead-avatar {");
    expect(shellCss).toContain(".mhead-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }");
  });

  it("按下去的反馈成对写（老 WebView 认不得 color-mix，吃前一条），且锁在 .mshell 底下", () => {
    expect(shellCss).toContain(".mshell .mhead-avatar:active { background: var(--accent); color: var(--on-accent); }");
    expect(shellCss).toContain(
      ".mshell .mhead-avatar:active { background: color-mix(in srgb, var(--accent) 30%, var(--accent-soft)); color: var(--accent); }",
    );
    // 裸奔到 .mshell 外面的 .mhead* :active 一条都不许有（电脑端会跟着变）
    const naked = shellCss
      .split("\n")
      .filter((l) => /^\.m(nav|more|head)[\w-]*[.:]/.test(l.trim()) && l.includes(":active"));
    expect(naked).toEqual([]);
  });

  it("一行事那颗 transform 的老规矩仍然守着：头像钮不加缩放", () => {
    const block = shellCss.slice(shellCss.indexOf(".mshell .mhead-avatar:active"));
    expect(block).not.toContain("transform");
  });

  it("账号纸里除了那抹危险红，一个写死的色值都没有", () => {
    const acct = sheetCss.slice(sheetCss.indexOf("账号那张纸"));
    expect((acct.match(/#[0-9A-Fa-f]{3,8}\b/g) ?? []).filter((c) => c !== "#C0564A")).toEqual([]);
  });

  it("有过渡的地方只用 --dur-* 和 --ease，不写字面时长", () => {
    const acct = sheetCss.slice(sheetCss.indexOf("账号那张纸"));
    for (const line of acct.split("\n").filter((l) => l.includes("transition:"))) {
      expect(line).toMatch(/var\(--dur-[12]\)/);
      expect(line).toContain("var(--ease)");
    }
  });

  it("开关自己画在这张纸里，不去引桌面设置页的 settings.css", () => {
    expect(sheetCss).toContain(".msh-switch {");
    expect(accountSheetSource).not.toContain("settings.css");
  });
});
