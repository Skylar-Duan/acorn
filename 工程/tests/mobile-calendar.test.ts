// v1.12.1 · 手机端的日历页重排 + 同一轮 PM 真机反馈里的两件小事（顶部留白、左下角那条横条）。
//
// PM 在 v1.12.0 真机上的原话：
//   · 「整体手机界面上，顶部留白还是太少了，不符合现代 APP 审美」
//   · 图4 日历：「留白太多，正好那个背景还卡在日期中间，这个拥挤度、下面的留白不符合审美」
//   · 「我选了差异化合并之后一段时间内左下角出现了个横条」（那是 toast 被推出屏幕外了）
//
// 跟 mobile-shell.test.ts 一个路数：像素在 jsdom 里量不出来（没有布局引擎、没有媒体查询），
// 这里钉的是「改法还在不在源码里」，真的像素在 Playwright 那一轮量过（scratchpad/wfE）。
// 唯一能真跑的是 dayDots 那个纯函数——格子里画哪几颗点的规则。
// 样式只能用 node:fs 读：vitest 默认不处理 CSS，`import x from "a.css?raw"` 读回来是空串。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dayDots } from "../src/views/Calendar";
import calendarSource from "../src/views/Calendar.tsx?raw";
import headSource from "../src/mobile/MobileHead.tsx?raw";

const read = (p: string) => readFileSync(p, "utf8");
const shellCss = read("src/styles/mobile-shell.css");
const calendarCss = read("src/styles/calendar.css");
/** calendar.css 末尾那一节手机端规则 */
const mshellPart = calendarCss.slice(calendarCss.indexOf("---------- 手机端（.mshell"));

/** 写给后人的注释里出现什么都不算数，看的是真代码 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/.*$/gm, "");

describe("① 格子里画哪几颗点（dayDots）", () => {
  it("在场的每一类先各占一颗：逾期 → 计划 → 已完成", () => {
    expect(dayDots({ late: 1, plan: 1, ok: 1 }, 3)).toEqual(["late", "plan", "ok"]);
    expect(dayDots({ late: 0, plan: 2, ok: 1 }, 3)).toEqual(["plan", "plan", "ok"]);
  });

  it("剩下的位子按类补满，同色归拢在一起", () => {
    expect(dayDots({ late: 0, plan: 5, ok: 0 }, 3)).toEqual(["plan", "plan", "plan"]);
    expect(dayDots({ late: 0, plan: 3, ok: 2 }, 3)).toEqual(["plan", "plan", "ok"]);
    expect(dayDots({ late: 2, plan: 0, ok: 4 }, 3)).toEqual(["late", "late", "ok"]);
  });

  it("三类都在时每类至少一颗——哪怕计划的有十条，已完成那颗绿的也不许被挤掉", () => {
    expect(dayDots({ late: 1, plan: 10, ok: 1 }, 3)).toEqual(["late", "plan", "ok"]);
  });

  it("一颗都没有就一颗都不画；周视图给的上限更宽就多画", () => {
    expect(dayDots({ late: 0, plan: 0, ok: 0 }, 3)).toEqual([]);
    // 各类先各占一颗（late / plan / ok），剩下三个位子按 逾期 → 计划 → 已完成 的顺序补：计划还剩 3 条，全给它
    expect(dayDots({ late: 1, plan: 4, ok: 2 }, 6)).toEqual(["late", "plan", "plan", "plan", "plan", "ok"]);
    expect(dayDots({ late: 0, plan: 9, ok: 0 }, 6)).toHaveLength(6);
  });

  it("上限比在场的类还少时也不越界", () => {
    expect(dayDots({ late: 1, plan: 1, ok: 1 }, 2)).toEqual(["late", "plan"]);
  });
});

describe("② 日历的手机分支：一格只有日期和点，底下常驻「这一天」", () => {
  const mobileCell = calendarSource.slice(
    calendarSource.indexOf("if (isMobile) {"),
    calendarSource.indexOf("return (\n              <div\n                key={ymd}"),
  );

  it("手机格子走自己那条早返回：日期 + 周几 + 点，不画条目、不画补记框、不拖放", () => {
    expect(mobileCell).toContain('className="cal-dots"');
    expect(mobileCell).toContain("dayDots(");
    expect(mobileCell).toContain('<span className="cal-wd">');
    for (const s of ["cal-task", "cal-quick", "cal-head", "draggable", "onDragOver", "onDoubleClick"]) {
      expect(stripComments(mobileCell), s).not.toContain(s);
    }
  });

  it("逾期 = 这天已经过去还没做完；今天和以后的开着的事是「计划」", () => {
    expect(mobileCell).toContain("const late = cmpYMD(ymd, today) < 0;");
    expect(mobileCell).toContain("late: late ? open.length : 0, plan: late ? 0 : open.length, ok: done.length");
  });

  it("点一格 = 切到这一天（不是开关）；默认今天；「今天」那颗键也把列表带回今天", () => {
    expect(mobileCell).toContain("onClick={() => setPicked(ymd)}");
    expect(mobileCell).toContain("const shownDay = picked ?? today;");
    expect(calendarSource).toContain("if (isMobile) setPicked(null);");
    // 窄桌面那条「再点一次收起来」的老路原样还在
    expect(calendarSource).toContain("setPicked((cur) => (cur === ymd ? null : ymd))");
  });

  it("🔴 桌面那条路一个字没动：desktop 分支照旧画 .cal-head / .cal-task / 补记框 / 拖放", () => {
    const desk = calendarSource.slice(calendarSource.indexOf("return (\n              <div\n                key={ymd}"));
    for (const s of ['<div className="cal-head">', 'className="cal-task"', 'className="cal-quick"', "draggable", "onDrop={(e) => onDrop(e, ymd)}"]) {
      expect(desk, s).toContain(s);
    }
    // 老的那块点开清单只给窄桌面画，手机走常驻那块
    expect(calendarSource).toContain("{!isMobile && picked && (");
  });

  it("常驻列表：默认今天，行走 MobileRow（点一行拉任务详情那张纸），空的那天一句「这天没有安排」", () => {
    const list = calendarSource.slice(
      calendarSource.indexOf("{isMobile &&\n          (() => {"),
      calendarSource.indexOf("{!isMobile && picked && ("),
    );
    expect(list).toContain("const day = picked ?? today;");
    expect(list).toContain('<div className="cal-daylist">');
    expect(list).toContain('<div className="group-head split">');
    expect(list).toContain('<span className="group-label">');
    expect(list).toContain('<div className="mcard">');
    expect(list).toContain("<MobileRow key={t.id} task={t} />");
    expect(list).toContain("<MobileRow key={rowKey(r)} task={r.task} sub={r.sub} doneDate={rowDoneDay(r)} />");
    expect(list).toContain("这天没有安排");
    expect(calendarSource).toContain('import MobileRow from "../mobile/MobileRow";');
    // 筛选（全部 / 计划 / 已完成）在这块列表上照样生效
    expect(list).toContain('filter === "done" ? [] : slot?.open ?? []');
    expect(list).toContain('filter === "plan" ? [] : slot?.done ?? []');
  });

  it("界面文案里没有工程词，也没有那个已经退场的词", () => {
    const src = stripComments(calendarSource);
    expect(src).not.toContain("随手记");
  });
});

describe("③ 手机日历的样式：定高格子、纸、点的颜色全是 token", () => {
  it("月视图格子定高 56px（PM 定的 56–60 那一档），竖着排、居中", () => {
    expect(mshellPart).toContain(".mshell .cal-grid:not(.week) { grid-auto-rows: 56px; }");
    const cell = mshellPart.slice(mshellPart.indexOf(".mshell .cal-grid:not(.week) .cal-cell {"));
    expect(cell.slice(0, cell.indexOf("}"))).toContain("flex-flow: column nowrap;");
  });

  it("网格是一张纸：跟 .mcard 同一副长相（--m-radius / --m-card-shadow），不画格线", () => {
    const grid = mshellPart.slice(mshellPart.indexOf(".mshell .cal-grid {"));
    const body = grid.slice(0, grid.indexOf("}"));
    expect(body).toContain("gap: 0;");
    expect(body).toContain("border-radius: var(--m-radius);");
    expect(body).toContain("box-shadow: var(--m-card-shadow);");
    expect(body).toContain("background: var(--card);");
  });

  it("三种点：计划 accent / 逾期 warn / 已完成 ok；今天那格实心圆，点开的那格 accent-soft 圆", () => {
    expect(mshellPart).toContain(".mshell .cal-dot.plan { background: var(--accent); }");
    expect(mshellPart).toContain(".mshell .cal-dot.late { background: var(--warn); }");
    expect(mshellPart).toContain(".mshell .cal-dot.ok { background: var(--ok); }");
    expect(mshellPart).toContain(".mshell .cal-cell .cal-num.today { background: var(--accent); color: var(--on-accent); }");
    expect(mshellPart).toContain(".mshell .cal-cell.cal-picked .cal-num { background: var(--accent-soft); color: var(--accent); font-weight: 600; }");
    // 今天那条得写在 picked 之后：同一格既是今天又是点开的那格时它得赢
    expect(mshellPart.indexOf(".cal-num.today")).toBeGreaterThan(mshellPart.indexOf(".cal-picked .cal-num"));
  });

  it("顶栏第二行折行：三组控件 390 宽排不下，「已完成」不许再被切到屏幕外", () => {
    expect(mshellPart).toContain(".mshell .mhead-fit .mhead-extra { flex-wrap: wrap; overflow: visible; }");
    expect(mshellPart).toContain(".mshell .mhead-fit .cal-nav .all-sort { margin-right: auto; }");
  });

  it("常驻列表底下给底部导航让位（calendar.css 那 18px 是给桌面写的）", () => {
    // 跟四象限那条写在同一块里（那一页同病）
    expect(shellCss).toContain(
      ".mshell .view-body.quad-body,\n.mshell .view-body.cal-body {\n  padding-bottom: calc(var(--m-nav-h) + var(--m-safe-bottom) + 28px);\n}",
    );
    // 那块列表不再是一张自带边框的小卡，mobile-shell.css 里那两条纸的规则不该再点它的名
    expect(shellCss).not.toContain(".mshell .cal-daylist");
  });

  it("这一节里颜色全是 token、时长全是变量、每一条都挂在 .mshell 下面", () => {
    const code = stripComments(mshellPart);
    expect(code).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
    expect(code).not.toMatch(/\b(rgb|hsl)a?\(/);
    for (const line of code.split(/\r?\n/).filter((l: string) => /\b(transition|animation):/.test(l))) {
      expect(line, line.trim()).toMatch(/var\(--dur-[12]\)/);
    }
    for (const line of code.split(/\r?\n/).filter((l: string) => /^\./.test(l))) {
      expect(line, line.trim()).toMatch(/^\.mshell /);
    }
  });
});

describe("④ 顶栏后面那片风景：日历页跟顶栏等高，别的页还是 190", () => {
  it("MobileHead 有 sceneFit 开关，挂的是 .mhead-fit；只有日历传", () => {
    expect(headSource).toContain("sceneFit?: boolean;");
    expect(headSource).toContain('className={`view-head mhead${sceneFit ? " mhead-fit" : ""}`}');
    expect(calendarSource).toContain("sceneFit");
    for (const name of ["Today", "Plan", "Done", "ListView", "MobileMore", "Habits", "StatsView", "Settings", "Quadrant"]) {
      expect(read(`src/views/${name}.tsx`), name).not.toContain("sceneFit");
    }
  });

  it("风景高度跟随顶栏（100%）、下缘落在顶栏底；默认那条 190 一个字没动", () => {
    expect(shellCss).toContain(".mshell .mhead.mhead-fit .mhead-scene { height: 100%; }");
    expect(shellCss).toContain(".mshell .mhead.mhead-fit .mhead-scene::after {");
    expect(shellCss).toContain("height: var(--m-scene-h);");
    expect(read("src/styles/mobile.css")).toContain("--m-scene-h: 190px;");
  });
});

describe("⑤ 顶部留白：标题上沿离状态栏底约 34px", () => {
  it("安全区地板 12px 之上再让 22px（原来 6px）", () => {
    expect(shellCss).toContain("padding: calc(max(var(--m-safe-top), 12px) + 22px) 18px 0;");
    expect(shellCss).not.toContain("12px) + 6px)");
  });
});

describe("⑥ 左下角那条横条：toast 在手机上被推出了屏幕", () => {
  it("🔴 手机上 toast 贴边、transform 归零——base.css 那个 translateX(-50%) 不清掉整条就往左挪半个身位", () => {
    const toast = shellCss.slice(shellCss.indexOf("\n.shell.mobile .toast {"));
    const body = toast.slice(0, toast.indexOf("}"));
    expect(body).toContain("left: 12px;");
    // 右边给 ＋ 让位（v1.13.0）：toast 停留那几秒 ＋ 还得点得到
    expect(body).toContain("right: 84px;");
    expect(body).toContain("transform: none;");
    expect(body).toContain("max-width: none;");
    // 病根还在原处（桌面居中靠它），只在手机上盖
    expect(read("src/styles/base.css")).toContain("position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);");
  });

  it("进出场动画换成不带 -50% 的那套，时长照旧走 --dur-*", () => {
    expect(shellCss).toContain("animation: mtoast-in var(--dur-2) var(--ease);");
    expect(shellCss).toContain(".shell.mobile .toast.leaving { animation: mtoast-out var(--dur-1) var(--ease) forwards; }");
    expect(shellCss).toContain("@keyframes mtoast-in { from { opacity: 0; transform: translateY(8px); } }");
    expect(shellCss).toContain("@keyframes mtoast-out { to { opacity: 0; transform: translateY(8px); } }");
    // 注释里交代病根时提到了 -50%，那不算数；toast 这一节的真代码里一个都不许有
    // （打卡圈那个 44×44 命中区的 translate(-50%, -50%) 是另一回事，不在这一节里）
    const section = shellCss.slice(
      shellCss.indexOf("\n.shell.mobile .toast {"),
      shellCss.indexOf("/* ---------- 抽屉里的通用件"),
    );
    expect(section.length).toBeGreaterThan(0);
    expect(stripComments(section)).not.toContain("-50%");
  });

  it("仍然抬在底部导航之上", () => {
    expect(shellCss).toContain(".shell.mobile .toast,\n.shell.mobile .bulk-bar {\n  bottom: calc(var(--m-nav-h) + var(--m-safe-bottom) + 18px);");
  });
});
