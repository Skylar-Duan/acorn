import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appStore, applyRemoteData, clearUndo, completeTask, deleteManagedImages, flushSave, logFocus, redo, setManagedImageSync, undo, updateSettings, updateTask } from "../src/core/store";
import { defaultData, newTask, type AppData, type TaskImage } from "../src/core/model";
import { imageCloudEnabled } from "../src/core/imageLibrary";
import { historyShortcut } from "../src/core/historyShortcut";

const old = "2026-10-01T00:00:00.000Z";
const image: TaskImage = { id: "photo", name: "photo.jpg", dataUrl: "data:image/jpeg;base64,/9j/2Q==", width: 1, height: 1, bytes: 4 };
const current = () => appStore.getState().data;
const task = () => current().tasks[0];

beforeEach(() => {
  clearUndo();
  appStore.setState({ data: { ...defaultData(), tasks: [newTask({ id: "task", title: "原名", images: [image], updatedAt: old })] }, loaded: false, wiped: false, saveError: null });
});
afterEach(async () => { await flushSave(); clearUndo(); vi.restoreAllMocks(); });

describe("任务撤销与重做", () => {
  it("按相反顺序撤销、按原顺序重做，每步仍可再撤销", () => {
    updateTask("task", { title: "新名" });
    completeTask("task");
    undo(); expect(task().done).toBe(false); expect(task().title).toBe("新名");
    undo(); expect(task().title).toBe("原名");
    redo(); expect(task().title).toBe("新名"); expect(task().done).toBe(false);
    redo(); expect(task().done).toBe(true); expect(appStore.getState().undoDepth).toBe(2);
    undo(); expect(task().done).toBe(false);
    expect(task().images?.[0]).toBe(image);
  });

  it("撤销后改写使旧重做失效，连续文字仍合为一组", () => {
    updateTask("task", { title: "改一" });
    updateTask("task", { title: "改二" });
    expect(appStore.getState().undoDepth).toBe(1);
    undo(); expect(task().title).toBe("原名");
    updateTask("task", { title: "新分支" });
    redo(); expect(task().title).toBe("新分支");
    undo(); expect(task().title).toBe("原名");
  });

  it("空操作不打断重做；偏好、专注和未知字段在来回历史中保留", () => {
    Object.assign(task(), { futureTask: { keep: true } });
    Object.assign(current(), { futureRoot: { keep: true } });
    updateTask("task", { title: "改名" });
    undo();
    const afterUndo = current();
    updateTask("task", { title: "原名" });
    expect(current()).toBe(afterUndo);
    updateSettings({ mode: "dark" });
    logFocus("task", 5);
    redo();
    expect(task().title).toBe("改名"); expect(task().focusMinutes).toBe(5);
    expect(current().settings.mode).toBe("dark"); expect(current().sessions).toHaveLength(1);
    expect(task()).toHaveProperty("futureTask", { keep: true }); expect(current()).toHaveProperty("futureRoot", { keep: true });
    undo(); expect(task().focusMinutes).toBe(5); expect(current().sessions).toHaveLength(1);
  });

  it("撤销重做都不复活已消费的过期提醒", () => {
    const original = newTask({ id: "task", title: "原名", reminder: "2000-01-01T09:00" });
    appStore.setState({ data: { ...current(), tasks: [original] } });
    updateTask("task", { title: "改名" });
    appStore.setState({ data: { ...current(), tasks: [{ ...task(), reminder: null }] } });
    undo(); expect(task().reminder).toBeNull();
    redo(); expect(task().reminder).toBeNull();
  });

  it("新恢复时刻用于同步，并保留未更改任务的身份和时刻", () => {
    const other = newTask({ id: "other", title: "其他", updatedAt: old });
    appStore.setState({ data: { ...current(), tasks: [...current().tasks, other] } });
    vi.useFakeTimers();
    try {
      vi.setSystemTime("2026-10-28T03:00:00Z"); updateTask("task", { title: "改名" });
      const edited = task().updatedAt;
      vi.advanceTimersByTime(1); undo(); const undone = task().updatedAt;
      vi.advanceTimersByTime(1); redo();
      expect(undone > edited).toBe(true); expect(task().updatedAt > undone).toBe(true);
      expect(current().tasks[1]).toBe(other); expect(other.updatedAt).toBe(old);
    } finally { vi.useRealTimers(); }
  });

  it("删除图片及关闭同步可以重做，图片操作戳继续向前", () => {
    setManagedImageSync(["photo"], false); undo(); redo();
    expect(imageCloudEnabled(current(), task().images![0])).toBe(false);
    deleteManagedImages(["photo"]); undo();
    const restoredAt = current().imageSync!.photo.updatedAt;
    expect(task().images).toHaveLength(1);
    redo(); expect(task().images).toHaveLength(0); expect(current().imageSync!.photo.deletedAt).toBeTruthy();
    expect(current().imageSync!.photo.updatedAt > restoredAt).toBe(true);
  });

  it("换数据源或清历史后不能重做回旧账本", () => {
    updateTask("task", { title: "改名" }); undo();
    const remote: AppData = { ...defaultData(), tasks: [newTask({ id: "remote", title: "云端" })] };
    applyRemoteData(remote); redo(); expect(current()).toBe(remote);
    updateTask("remote", { title: "云端修改" }); undo(); clearUndo(); redo();
    expect(task().title).toBe("云端");
  });
});

describe("历史快捷键", () => {
  const key = (value: string, options: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key: value, ctrlKey: true, ...options });
  it("框外Ctrl+Z撤销，Ctrl+Y及Ctrl+Shift+Z重做", () => {
    expect(historyShortcut(key("z"), false)).toBe("undo");
    expect(historyShortcut(key("y"), false)).toBe("redo");
    expect(historyShortcut(key("Z", { shiftKey: true }), false)).toBe("redo");
    expect(historyShortcut(key("z", { ctrlKey: false, metaKey: true }), false)).toBe("undo");
  });
  it("输入框和输入法组合保持原生处理，不抢Alt组合或普通字符", () => {
    for (const value of ["z", "y"]) expect(historyShortcut(key(value), true)).toBeNull();
    expect(historyShortcut(key("z", { isComposing: true }), false)).toBeNull();
    expect(historyShortcut(key("z", { altKey: true }), false)).toBeNull();
    expect(historyShortcut(key("z", { ctrlKey: false }), false)).toBeNull();
  });
});
