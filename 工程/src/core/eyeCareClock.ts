/** 护眼计时只放内存：重启、睡眠唤醒均重新等一个完整周期。 */
export const EYE_CARE_INTERVAL = 20 * 60 * 1000;
export const EYE_CARE_PREPARE = 10 * 1000;
export const EYE_CARE_REST = 20 * 1000;
// 原生每秒一次tick；超过5秒没收到就保守当作睡眠/系统繁忙，重新等完整周期。
export const EYE_CARE_SUSPEND_GAP = 5 * 1000;
export type EyeCarePhase = "off" | "waiting" | "prepare" | "rest";

export class EyeCareClock {
  enabled = false;
  phase: EyeCarePhase = "off";
  deadline = 0;
  private lastTick: number;

  constructor(now: number) { this.lastTick = now; }
  get active(): boolean { return this.phase === "prepare" || this.phase === "rest"; }
  remaining(now: number): number { return this.active ? Math.max(0, Math.ceil((this.deadline - now) / 1000)) : 0; }

  configure(enabled: boolean, now: number): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.reset(now);
  }
  reset(now: number): void {
    this.phase = this.enabled ? "waiting" : "off";
    this.deadline = this.enabled ? now + EYE_CARE_INTERVAL : 0;
    this.lastTick = now;
  }
  preview(now: number): void {
    this.phase = "prepare";
    this.deadline = now + EYE_CARE_PREPARE;
    this.lastTick = now;
  }
  tick(now: number): void {
    if (now < this.lastTick || now - this.lastTick > EYE_CARE_SUSPEND_GAP) {
      this.reset(now);
      return;
    }
    this.lastTick = now;
    if (!this.deadline || now < this.deadline) return;
    if (this.phase === "waiting") {
      this.phase = "prepare";
      this.deadline = now + EYE_CARE_PREPARE;
    } else if (this.phase === "prepare") {
      this.phase = "rest";
      this.deadline = now + EYE_CARE_REST;
    } else if (this.phase === "rest") this.reset(now);
  }
}
