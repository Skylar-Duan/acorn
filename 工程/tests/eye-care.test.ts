import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EyeCareClock, EYE_CARE_INTERVAL } from "../src/core/eyeCareClock";
import { defaultSettings, migrate } from "../src/core/model";

describe("护眼真实计时", () => {
  let c: EyeCareClock;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    c = new EyeCareClock(Date.now());
    setInterval(() => c.tick(Date.now()), 1000);
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("默认关闭；旧设置补默认值且保留未知字段", () => {
    expect(defaultSettings().eyeCareEnabled).toBe(false);
    expect(defaultSettings().eyeCareMode).toBe("small");
    const d = migrate({ version: 8, settings: { futureField: "keep" } });
    expect(d.settings.eyeCareEnabled).toBe(false);
    expect((d.settings as unknown as { futureField: string }).futureField).toBe("keep");
    vi.advanceTimersByTime(3 * EYE_CARE_INTERVAL);
    expect(c.phase).toBe("off");
  });
  it("开启后20分钟准备10秒，再远眺20秒，结束重开20分钟", () => {
    c.configure(true, Date.now());
    vi.advanceTimersByTime(EYE_CARE_INTERVAL - 1);
    expect(c.phase).toBe("waiting");
    vi.advanceTimersByTime(1);
    expect(c.phase).toBe("prepare");
    expect(c.remaining(Date.now())).toBe(10);
    vi.advanceTimersByTime(9000);
    expect(c.remaining(Date.now())).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(c.phase).toBe("rest");
    expect(c.remaining(Date.now())).toBe(20);
    vi.advanceTimersByTime(20000);
    expect(c.phase).toBe("waiting");
    vi.advanceTimersByTime(EYE_CARE_INTERVAL);
    expect(c.phase).toBe("prepare");
  });
  it("准备和休息均可跳过，下一次重新等20分钟", () => {
    c.configure(true, Date.now());
    for (const phase of ["prepare", "rest"]) {
      c.preview(Date.now());
      if (phase === "rest") vi.advanceTimersByTime(10000);
      expect(c.phase).toBe(phase);
      c.reset(Date.now());
      expect(c.phase).toBe("waiting");
      vi.advanceTimersByTime(EYE_CARE_INTERVAL - 1000);
      expect(c.phase).toBe("waiting");
    }
  });
  it("关闭立即结束提醒；重开不沿用上次余时", () => {
    c.configure(true, Date.now());
    c.preview(Date.now());
    c.configure(false, Date.now());
    expect(c.active).toBe(false);
    vi.advanceTimersByTime(EYE_CARE_INTERVAL);
    expect(c.phase).toBe("off");
    c.configure(true, Date.now());
    expect(c.deadline).toBe(Date.now() + EYE_CARE_INTERVAL);
  });
  it("关着也可预览，走完整流程后仍关闭", () => {
    c.preview(Date.now());
    vi.advanceTimersByTime(30000);
    expect(c.phase).toBe("off");
    expect(c.enabled).toBe(false);
  });
  it("睡眠/系统时钟回拨重新计时，不补发积压提醒", () => {
    c.configure(true, Date.now());
    vi.setSystemTime(2 * 60 * 60 * 1000);
    c.tick(Date.now());
    expect(c.phase).toBe("waiting");
    expect(c.deadline).toBe(Date.now() + EYE_CARE_INTERVAL);
    c.preview(Date.now());
    vi.setSystemTime(Date.now() + 5 * 60 * 1000);
    c.tick(Date.now());
    expect(c.phase).toBe("waiting");
    vi.setSystemTime(Date.now() - 60000);
    c.tick(Date.now());
    expect(c.deadline).toBe(Date.now() + EYE_CARE_INTERVAL);
  });
  it("临近20分钟时短睡眠40秒，醒来仍重开周期", () => {
    c.configure(true, Date.now());
    vi.advanceTimersByTime(EYE_CARE_INTERVAL - 10000);
    vi.setSystemTime(Date.now() + 40000);
    c.tick(Date.now());
    expect(c.phase).toBe("waiting");
    expect(c.deadline).toBe(Date.now() + EYE_CARE_INTERVAL);
  });
  it("准备、休息与关闭状态下的预览遇到短睡眠均取消当前提醒", () => {
    for (const enabled of [false, true]) {
      for (const phase of ["prepare", "rest"]) {
        c.configure(enabled, Date.now());
        c.preview(Date.now());
        if (phase === "rest") vi.advanceTimersByTime(10000);
        expect(c.phase).toBe(phase);
        vi.setSystemTime(Date.now() + 40000);
        c.tick(Date.now());
        expect(c.phase).toBe(enabled ? "waiting" : "off");
        expect(c.active).toBe(false);
      }
    }
  });
  it("重启从完整周期开始；晚ready只读当前余时不会重新开准备阶段", () => {
    c.configure(true, Date.now());
    vi.advanceTimersByTime(EYE_CARE_INTERVAL + 7000);
    expect(c.remaining(Date.now())).toBe(3);
    const deadline = c.deadline;
    expect(c.remaining(Date.now())).toBe(3); // 子窗ready读取当前状态
    expect(c.deadline).toBe(deadline);
    const restarted = new EyeCareClock(Date.now());
    restarted.configure(true, Date.now());
    expect(restarted.phase).toBe("waiting");
    expect(restarted.deadline).toBe(Date.now() + EYE_CARE_INTERVAL);
  });
});
