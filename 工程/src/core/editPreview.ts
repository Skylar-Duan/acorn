// 标题草稿的即时显示投影：复用真正保存时的解析与补丁，只读且不创建分类。
import type { List, Subtask, Task } from "./model";
import type { ParseOpts, ParseResult } from "./parse";
import { appendedSubCategories, editedCategoryPatch, editedTitlePatch, parseEditedTitle } from "./editSyntax";

export interface EditPreviewContext {
  lists: readonly Pick<List, "id" | "name">[];
  now: Date;
  weekendDay?: ParseOpts["weekendDay"];
}

function parsedDraft(currentTitle: string, draft: string | null | undefined, context: EditPreviewContext, subtask = false): ParseResult | null {
  // 跟提交入口相同：清空输入不清除旧标题，未编辑的旧标题也不重新解释。
  if (draft == null || draft === currentTitle || !draft.trim()) return null;
  return parseEditedTitle(draft, {
    now: context.now,
    listNames: context.lists.map((list) => list.name),
    weekendDay: context.weekendDay,
    ...(subtask ? { keepNewlines: true, skip: ["tag"] as const } : {}),
  });
}

/** task 仅供显示；未知清单尚无 id，用 listName 展示，等确认时再走分类创建。 */
export function taskTitlePreview(current: Task, draft: string | null | undefined, context: EditPreviewContext): {
  task: Task;
  parsed: ParseResult | null;
  listName: string | null;
  unresolvedListNames: string[];
} {
  const parsed = parsedDraft(current.title, draft, context);
  const currentList = context.lists.find((list) => list.id === current.listId);
  if (!parsed) return { task: current, parsed, listName: currentList?.name ?? null, unresolvedListNames: [] };
  const requestedList = parsed.chips.some((chip) => chip.kind === "list") ? parsed.listName : null;
  const nextList = requestedList
    ? context.lists.find((list) => list.id === current.listId && list.name === requestedList)
      ?? context.lists.find((list) => list.name === requestedList)
    : currentList;
  return {
    task: {
      ...current,
      ...editedTitlePatch(current, parsed),
      ...editedCategoryPatch(current, parsed, nextList?.id ?? current.listId),
    },
    parsed,
    listName: requestedList ?? currentList?.name ?? null,
    unresolvedListNames: requestedList && !nextList ? [requestedList] : [],
  };
}

/** 子任务归类只追加到本步；继承的日期/重要性仍由调用方按投影字段显示。 */
export function subtaskTitlePreview(current: Subtask, draft: string | null | undefined, context: EditPreviewContext): {
  subtask: Subtask;
  parsed: ParseResult | null;
  listNames: string[];
  unresolvedListNames: string[];
} {
  const parsed = parsedDraft(current.title, draft, context, true);
  const currentListNames = (current.listIds ?? []).flatMap((id) => {
    const list = context.lists.find((entry) => entry.id === id);
    return list ? [list.name] : [];
  });
  if (!parsed) return { subtask: current, parsed, listNames: currentListNames, unresolvedListNames: [] };
  const requestedLists = [...new Set(parsed.chips.filter((chip) => chip.kind === "list").map((chip) => chip.text))];
  const knownLists = requestedLists.flatMap((name) => {
    const list = context.lists.find((entry) => entry.name === name);
    return list ? [list.id] : [];
  });
  return {
    subtask: {
      ...current,
      ...editedTitlePatch(current, parsed),
      ...appendedSubCategories(current, parsed.who, knownLists),
    },
    parsed,
    listNames: [...new Set([...currentListNames, ...requestedLists])],
    unresolvedListNames: requestedLists.filter((name) => !context.lists.some((list) => list.name === name)),
  };
}
