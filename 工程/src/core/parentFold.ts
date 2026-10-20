// 桌面计划／今日任务的母子树偏好，与其他列表和手机原有子链折叠分开。
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

const KEY = "acorn-parent-fold";
export interface ParentFoldState { foldAll: boolean; foldExcept: string[] }
function initial(): ParentFoldState {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<ParentFoldState> | null;
    if (saved) return { foldAll: saved.foldAll !== false, foldExcept: Array.isArray(saved.foldExcept) ? saved.foldExcept.filter((id): id is string => typeof id === "string") : [] };
  } catch { /* 本机偏好损坏时从默认母行开始，账本不受影响。 */ }
  return { foldAll: true, foldExcept: [] };
}
export const parentFoldStore = createStore<ParentFoldState>(initial);
export function useParentFold<T>(selector: (state: ParentFoldState) => T): T { return useStore(parentFoldStore, selector); }
export function parentFolded(state: ParentFoldState, taskId: string): boolean { return state.foldExcept.includes(taskId) ? !state.foldAll : state.foldAll; }
function save(next: ParentFoldState) {
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* 仍保留本次会话的选择。 */ }
  parentFoldStore.setState(next);
}
export function setAllParentFolded(foldAll: boolean) { save({ foldAll, foldExcept: [] }); }
export function setParentFolded(taskId: string, folded: boolean) {
  const state = parentFoldStore.getState();
  if (parentFolded(state, taskId) === folded) return;
  const foldExcept = state.foldExcept.includes(taskId) ? state.foldExcept.filter((id) => id !== taskId) : [...state.foldExcept, taskId];
  save({ foldAll: state.foldAll, foldExcept });
}
export function toggleParentFolded(taskId: string) { setParentFolded(taskId, !parentFolded(parentFoldStore.getState(), taskId)); }
