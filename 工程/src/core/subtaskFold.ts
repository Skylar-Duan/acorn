const KEY = "acorn-card-subtasks-folded";

function foldedIds(): string[] {
  try { const value = JSON.parse(localStorage.getItem(KEY) ?? "[]"); return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []; }
  catch { return []; }
}
export function taskSubtasksFolded(taskId: string): boolean { return foldedIds().includes(taskId); }
export function rememberTaskSubtasksFolded(taskId: string, folded: boolean): void {
  const ids = foldedIds().filter((id) => id !== taskId);
  if (folded) ids.push(taskId);
  try { localStorage.setItem(KEY, JSON.stringify(ids.slice(-2000))); } catch { /* 本机偏好存不下时，当次开关仍可用。 */ }
}
