// 标题编辑只覆盖这次明确写出的属性；解析器用于识别，没写出的默认值不能拿来清空旧记录。
import type { Subtask, Task } from "./model";
import { parseQuickAdd, type ParseOpts, type ParseResult } from "./parse";

export function parseEditedTitle(text: string, opts: ParseOpts): ParseResult {
  return parseQuickAdd(text, opts);
}

type Editable = Pick<Task, "title" | "due" | "dueTime" | "repeat" | "priority"> | Subtask;

/** 日期与钟点分开处理：只改日期保留原钟点；只改钟点保留原日期。
 *  原本没有日期时，显式钟点/循环才采用解析器算出的首个日期。 */
export function editedTitlePatch<T extends Editable>(current: T, parsed: ParseResult): Partial<T> {
  const kinds = new Set(parsed.chips.map((c) => c.kind));
  const patch: Record<string, unknown> = {};
  const title = parsed.title.trim();
  if (title && title !== current.title) patch.title = title;
  if (kinds.has("date") && parsed.due !== current.due) patch.due = parsed.due;
  if (kinds.has("time") && parsed.dueTime !== current.dueTime) patch.dueTime = parsed.dueTime;
  if (kinds.has("repeat") && JSON.stringify(parsed.repeat) !== JSON.stringify(current.repeat)) patch.repeat = parsed.repeat;
  if (!kinds.has("date") && !current.due && (kinds.has("time") || kinds.has("repeat")) && parsed.due) patch.due = parsed.due;
  if (kinds.has("priority") && parsed.priority !== current.priority) patch.priority = parsed.priority;
  return patch as Partial<T>;
}

/** 归类同样只认显式标记，@替换本次给出的人名，#替换本次给出的标签。 */
export function editedCategoryPatch(current: Task, parsed: ParseResult, listId: string | null): Partial<Task> {
  const kinds = new Set(parsed.chips.map((c) => c.kind));
  const patch: Partial<Task> = {};
  if (kinds.has("list") && listId !== current.listId) patch.listId = listId;
  if (kinds.has("who") && JSON.stringify(parsed.who) !== JSON.stringify(current.who)) patch.who = parsed.who;
  if (kinds.has("tag") && JSON.stringify(parsed.tags) !== JSON.stringify(current.tags)) patch.tags = parsed.tags;
  return patch;
}

export function appendedSubCategories(current: Subtask, who: string[], listIds: string[]): Partial<Subtask> {
  const patch: Partial<Subtask> = {};
  const nextWho = [...new Set([...(current.who ?? []), ...who])];
  const nextLists = [...new Set([...(current.listIds ?? []), ...listIds])];
  if (JSON.stringify(nextWho) !== JSON.stringify(current.who ?? [])) patch.who = nextWho;
  if (JSON.stringify(nextLists) !== JSON.stringify(current.listIds ?? [])) patch.listIds = nextLists;
  return patch;
}
