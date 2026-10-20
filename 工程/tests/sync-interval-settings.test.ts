import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/core/platform", async original => ({ ...await original<typeof import("../src/core/platform")>(), isDesktopShell: true, isMobile: false }));
import Settings from "../src/views/Settings";
import { defaultData, migrate } from "../src/core/model";
import { appStore, flushSave } from "../src/core/store";
import { loadData } from "../src/core/persist";
import { syncStore } from "../src/core/syncCtl";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(async () => {
  await flushSave(); localStorage.clear();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("synthetic external requests blocked"))));
  appStore.setState({ data: defaultData(), loaded: true, loadError: null, rescue: null, wiped: false }); syncStore.setState({ session: null });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { act(() => root.unmount()); host.remove(); await flushSave(); vi.unstubAllGlobals(); });

describe("settings cloud interval control", () => {
  it("offers exactly four choices, defaults to five minutes, persists a selection and renders it after reload", async () => {
    await act(async () => root.render(createElement(Settings)));
    const group = host.querySelector('[role="group"][aria-label="自动同步间隔"]')!;
    const buttons = Array.from(group.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons.map(button => button.textContent)).toEqual(["5分钟", "1小时", "6小时", "1天"]);
    expect(buttons.map(button => button.getAttribute("aria-pressed"))).toEqual(["true", "false", "false", "false"]);
    expect(group.closest(".set-section")?.querySelector("h2")?.textContent).toBe("账号");
    expect(group.closest(".set-row")?.textContent).toContain("检查云端更新的间隔；本机修改仍自动上传");
    act(() => buttons[2].click()); expect(appStore.getState().data.settings.syncIntervalMinutes).toBe(360);
    await flushSave(); const saved = await loadData();
    act(() => { root.unmount(); appStore.setState({ data: migrate(saved.data) }); }); root = createRoot(host);
    await act(async () => root.render(createElement(Settings)));
    expect(host.querySelector('[aria-label="自动同步间隔"] button[aria-pressed="true"]')?.textContent).toBe("6小时");
  });
});
