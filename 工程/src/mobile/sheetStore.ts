// 手机端「抽屉」与「登录页」的开关状态（v1.11.0，手机端按体验重做）。
//
// 为什么单独一个小 store 而不塞进 core/store：这些是**手机壳子**的界面状态（哪张纸正抽出来、
// 登录页开没开），跟数据、跟桌面端一点关系都没有；放进 UIState 会让 dropped/store 那批测试
// 的 UIState 字面量又多几项要补，而且桌面永远用不到。
//
// 抽屉是一个**栈**：长按一行 → 动作单；动作单里点「安排日期」→ 日期选择叠在上面；
// 关掉最上面那张，下面那张还在。栈最多两层就够用，别在这上面堆复杂的路由。

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

export type SheetKind =
  /** 任务详情：从列表里拉出的那张纸（画板 ④） */
  | { kind: "task"; taskId: string }
  /** 记一条：贴着键盘的那张纸（画板 ③）。listId 是从清单页点 ＋ 时预填的归属 */
  | { kind: "quickAdd"; listId?: string | null }
  /** 长按一行弹的动作单（画板 ②）。subId 有值 = 长按的是某条子任务行 */
  | { kind: "actions"; taskId: string; subId?: string }
  /** 清单页「···」点开的清单设置（画板 ⑤） */
  | { kind: "listSettings"; listId: string }
  /** 加一个习惯 / 改一个习惯（v1.11.2）。没有 id 是新建，有 id 是编辑那一个。
   *  习惯页的 ＋ 开的是这张纸：从 ＋ 加出来的是任务，从习惯页加出来的得是习惯 */
  | { kind: "habit"; id?: string };

interface SheetState {
  stack: SheetKind[];
}

export const sheetStore = createStore<SheetState>(() => ({ stack: [] }));

export function useSheet<T>(selector: (s: SheetState) => T): T {
  return useStore(sheetStore, selector);
}

/** 顶上再抽一张。同一种抽屉不叠两张（连点两下 ＋ 只开一张） */
export function openSheet(sheet: SheetKind): void {
  sheetStore.setState((s) => {
    const top = s.stack[s.stack.length - 1];
    if (top && top.kind === sheet.kind && JSON.stringify(top) === JSON.stringify(sheet)) return s;
    return { stack: [...s.stack, sheet] };
  });
}

/** 收掉最上面那张 */
export function closeSheet(): void {
  sheetStore.setState((s) => ({ stack: s.stack.slice(0, -1) }));
}

/** 全收掉（切视图、登出、数据整份换掉时用） */
export function closeAllSheets(): void {
  sheetStore.setState({ stack: [] });
}

/** 最上面那张是不是某一种。组件用它决定自己开不开 */
export function topSheet(stack: SheetKind[]): SheetKind | null {
  return stack.length ? stack[stack.length - 1] : null;
}

// ---------- 登录页（不是抽屉：独立一页 / 桌面居中弹窗，画板 ⑦ ⑦b） ----------

/** 打开登录页的缘由：first-run = 全新安装第一次打开自动弹的；manual = 用户自己点的 */
export type LoginReason = "first-run" | "manual";

interface LoginState {
  open: boolean;
  reason: LoginReason;
}

export const loginStore = createStore<LoginState>(() => ({ open: false, reason: "manual" }));

export function useLogin<T>(selector: (s: LoginState) => T): T {
  return useStore(loginStore, selector);
}

export function openLogin(reason: LoginReason = "manual"): void {
  loginStore.setState({ open: true, reason });
}

export function closeLogin(): void {
  loginStore.setState({ open: false });
}
