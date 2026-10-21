import { create } from "zustand";
import { addList, allWho, appStore, updateSettings } from "./store";
import { CATEGORY_ICONS, type CategoryKind } from "./categoryIcons";
import { LIST_COLORS } from "./model";
import { syncStore } from "./syncCtl";
import { sameName } from "./syntaxCompletion";

export interface CategoryDraft { kind: CategoryKind; name: string; color: string; icon: string }
interface CreationRequest { draft: CategoryDraft; resolve: (draft: CategoryDraft | null) => void }
export const useCategoryCreation = create<{ pending: CreationRequest | null }>(() => ({ pending: null }));

export function isTaskCategoryDialogOpen(): boolean { return !!useCategoryCreation.getState().pending; }

/** 确认期间登出、切账号或账本被清空后，即使又载入成功也不续写旧操作。 */
function creationContext(canCommit: () => boolean = () => true) {
  const sessionKey = () => {
    const session = syncStore.getState().session;
    return session ? `${session.email}\n${session.token}` : "";
  };
  const original = sessionKey();
  let invalid = false;
  const offSession = syncStore.subscribe(() => { if (sessionKey() !== original) invalid = true; });
  const offData = appStore.subscribe((s) => { if (!s.loaded || s.loadError || s.wiped) invalid = true; });
  return {
    valid: () => {
      const s = appStore.getState();
      return !invalid && sessionKey() === original && s.loaded && !s.loadError && !s.wiped && canCommit();
    },
    dispose: () => { offSession(); offData(); },
  };
}

/** 只有用户确认所有新名字以后才写数据。上一步确认、下一步取消不会留下半份分类。 */
function requestDraft(kind: CategoryKind, name = ""): Promise<CategoryDraft | null> {
  if (isTaskCategoryDialogOpen()) return Promise.resolve(null);
  const data = appStore.getState().data;
  return new Promise((resolve) => useCategoryCreation.setState({ pending: {
    draft: { kind, name, color: LIST_COLORS[(kind === "list" ? data.lists.length : allWho(data).length) % LIST_COLORS.length], icon: CATEGORY_ICONS[kind][0].id },
    resolve,
  } }));
}

export function finishCategoryDraft(draft: CategoryDraft | null): void {
  const request = useCategoryCreation.getState().pending;
  if (!request) return;
  useCategoryCreation.setState({ pending: null });
  request.resolve(draft);
}

export function existingCategoryList(name?: string | null, preferredListId?: string | null) {
  const lists = appStore.getState().data.lists;
  if (!name) return null;
  return lists.find((l) => l.id === preferredListId && sameName(l.name, name))
    ?? lists.find((l) => sameName(l.name, name)) ?? lists.find((l) => l.name.toLocaleLowerCase().startsWith(name.toLocaleLowerCase())) ?? null;
}

export function taskCategoriesNeedConfirmation(listName: string | null | undefined, who: string[], preferredListId?: string | null): boolean {
  const names = new Set(allWho(appStore.getState().data).map((w) => w.who));
  return (!!listName && !existingCategoryList(listName, preferredListId)) || who.some((w) => w.trim() && ![...names].some((name) => sameName(name, w.trim())));
}

/** 无需弹窗的快捷保存同样必须回用现有拼写，不能另存 alice / Alice 两个人。 */
export function canonicalTaskWho(who: string[]): string[] {
  const names = allWho(appStore.getState().data).map((entry) => entry.who);
  return [...new Set(who.map((name) => names.find((existing) => sameName(existing, name.trim())) ?? name.trim()).filter(Boolean))];
}

function saveWhoDrafts(drafts: CategoryDraft[]): void {
  const people = drafts.filter((d) => d.kind === "who");
  if (!people.length) return;
  const settings = appStore.getState().data.settings;
  let whoAppearance = { ...settings.whoAppearance };
  for (const draft of people) whoAppearance = { ...whoAppearance, [draft.name]: { ...whoAppearance[draft.name], color: draft.color, icon: draft.icon } };
  updateSettings({ whoAppearance });
}

export interface PreparedTaskCategories { listId: string | null; who: string[] }
async function prepareCategorySet(listNames: string[], who: string[], preferredListId?: string | null, canCommit?: () => boolean): Promise<{ listIds: string[]; who: string[] } | null> {
  const context = creationContext(canCommit);
  try {
    const drafts: CategoryDraft[] = [];
    const requestedLists: { name: string; draft?: CategoryDraft }[] = [];
    for (const name of [...new Set(listNames.map((n) => n.trim()).filter(Boolean))]) {
      if (existingCategoryList(name, preferredListId)) requestedLists.push({ name });
      else {
        const draft = await requestDraft("list", name);
        if (!draft) return null;
        drafts.push(draft);
        requestedLists.push({ name: draft.name, draft });
      }
    }
    const names = new Set(allWho(appStore.getState().data).map((w) => w.who));
    const nextWho: string[] = [];
    for (const name of [...new Set(who.map((w) => w.trim()).filter(Boolean))]) {
      const existing = [...names].find((entry) => sameName(entry, name));
      if (existing) nextWho.push(existing);
      else {
        const draft = await requestDraft("who", name);
        if (!draft) return null;
        const confirmedExisting = [...names].find((entry) => sameName(entry, draft.name));
        if (!confirmedExisting) { drafts.push(draft); names.add(draft.name); }
        nextWho.push(confirmedExisting ?? draft.name);
      }
    }
    // 弹窗期间云同步可能已经带来同名记录；最后再认一次，避免重复创建。
    if (!context.valid()) return null;
    const listIds = requestedLists.flatMap(({ name, draft }) => {
      const existing = existingCategoryList(name, preferredListId);
      if (existing) return [existing.id];
      return draft ? [addList(draft.name, draft.color, draft.icon)] : [];
    });
    const currentNames = allWho(appStore.getState().data).map((entry) => entry.who);
    saveWhoDrafts(drafts.filter((draft) => draft.kind !== "who" || !currentNames.some((name) => sameName(name, draft.name))));
    return { listIds: [...new Set(listIds)], who: [...new Set(nextWho.map((name) => currentNames.find((existing) => sameName(existing, name)) ?? name))] };
  } finally { context.dispose(); }
}

export async function prepareTaskCategories(listName: string | null | undefined, who: string[], preferredListId?: string | null, canCommit?: () => boolean): Promise<PreparedTaskCategories | null> {
  const prepared = await prepareCategorySet(listName ? [listName] : [], who, preferredListId, canCommit);
  return prepared ? { listId: prepared.listIds[0] ?? null, who: prepared.who } : null;
}

export async function prepareSubtaskCategories(listNames: string[], who: string[], canCommit?: () => boolean): Promise<{ listIds: string[]; who: string[] } | null> {
  return prepareCategorySet(listNames, who, undefined, canCommit);
}

export async function createCategory(kind: CategoryKind, name = ""): Promise<string | null> {
  const context = creationContext();
  try {
    const draft = await requestDraft(kind, name);
    if (!draft) return null;
    if (!context.valid()) return null;
    const current = appStore.getState();
    if (kind === "list") return current.data.lists.find((l) => sameName(l.name, draft.name))?.id ?? addList(draft.name, draft.color, draft.icon);
    const existing = allWho(current.data).find((entry) => sameName(entry.who, draft.name));
    if (existing) return existing.who;
    saveWhoDrafts([draft]);
    return draft.name;
  } finally { context.dispose(); }
}
