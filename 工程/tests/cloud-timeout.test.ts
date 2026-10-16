import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, login, pullOnly, VAULT_TRANSFER_TIMEOUT_MS, type Session } from "../src/core/cloud";

const session: Session = { token: "synthetic-token", email: "demo@example.test", rev: 0, syncedAt: null };
const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllTimers(); vi.useRealTimers(); });

function pendingBody() {
  fetchMock.mockImplementationOnce(async (_url, opts) => ({
    ok: true, status: 200,
    text: () => new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  }));
}

describe("大账本整段传输超时", () => {
  it("响应头已经收到但正文挂住，120秒仍会中止并保留本地说明", async () => {
    pendingBody();
    let settled = false;
    const result = pullOnly(session).then(() => null, (e: unknown) => { settled = true; return e; });
    await vi.advanceTimersByTimeAsync(VAULT_TRANSFER_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await result;
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).message).toContain("本机数据已保留");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("大账本可在20秒之后正常收完，不套用账号接口较短超时", async () => {
    fetchMock.mockImplementationOnce(async () => ({
      ok: true, status: 200,
      text: () => new Promise((resolve) => setTimeout(() => resolve(JSON.stringify({ rev: 2, data: null, updatedAt: null })), 25_000)),
    }));
    const result = pullOnly(session);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await result).toEqual({ rev: 2, data: null, updatedAt: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("登录仍在20秒中止完整响应等待，不跟大账本一起延长", async () => {
    pendingBody();
    const result = login("demo@example.test", "synthetic-password").then(() => null, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await result as ApiError).message).toBe("连接超时，稍后再试");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("413与401保留服务端业务错误，不改写成网络错误", async () => {
    for (const [status, slug] of [[413, "too_big"], [401, "bad_token"]] as const) {
      fetchMock.mockResolvedValueOnce({ ok: false, status, text: async () => JSON.stringify({ error: slug, message: "合成业务提示" }) });
      const error = await pullOnly(session).then(() => null, (e: unknown) => e);
      expect(error).toMatchObject({ status, slug, message: "合成业务提示" });
      expect((error as ApiError).needsLogin).toBe(status === 401);
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
