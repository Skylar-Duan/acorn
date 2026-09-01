// 长按排序的手势状态机。手机上一根手指要同时表达「点开 / 滚动 / 换位置」三件事，
// 这里逐条钉死三者的分界——这些分界靠在真手机上反复戳是试不全的。
import { describe, expect, it } from "vitest";
import {
  IDLE, LONG_PRESS_MS, SLOP_PX, cancel, down, hold, move, up,
  type SortState,
} from "../src/core/touchSort";

/** 落点探测：写死一张「坐标 → 是谁」的表，不碰 DOM */
const at = (map: Record<string, string>) => (x: number, y: number) => map[`${x},${y}`] ?? null;
const none = () => null;

/** 按住 → 计时到点，走到「排序中」 */
function sorting(self = "a", x = 0, y = 0): SortState {
  return hold(down(IDLE, self, x, y));
}

describe("常数", () => {
  it("长按门槛落在「不跟滚动抢手、又不让人以为没反应」的区间", () => {
    expect(LONG_PRESS_MS).toBeGreaterThanOrEqual(300);
    expect(LONG_PRESS_MS).toBeLessThanOrEqual(700);
  });

  it("滑动容差要容得下手指的自然抖动", () => {
    expect(SLOP_PX).toBeGreaterThanOrEqual(6);
  });
});

describe("按下", () => {
  it("从静止按下进入等待", () => {
    const s = down(IDLE, "a", 10, 20);
    expect(s.phase).toBe("waiting");
    expect(s.self).toBe("a");
    expect({ x: s.x, y: s.y }).toEqual({ x: 10, y: 20 });
  });

  it("已经在等待/排序时再按下不理会——多指同时按只认第一根", () => {
    const w = down(IDLE, "a", 0, 0);
    expect(down(w, "b", 5, 5)).toBe(w);
    const s = sorting();
    expect(down(s, "b", 5, 5)).toBe(s);
  });
});

describe("等待期间移动：这是在滚动，不是在排序", () => {
  it("挪得超过容差就整个作废", () => {
    const w = down(IDLE, "a", 0, 0);
    expect(move(w, 0, SLOP_PX + 1, none)).toEqual(IDLE);
    expect(move(w, SLOP_PX + 1, 0, none)).toEqual(IDLE);
  });

  it("反方向滑一样作废（往回滚也是滚）", () => {
    const w = down(IDLE, "a", 100, 100);
    expect(move(w, 100, 100 - SLOP_PX - 1, none)).toEqual(IDLE);
  });

  it("容差之内的抖动不作废", () => {
    const w = down(IDLE, "a", 0, 0);
    expect(move(w, 3, 4, none)).toBe(w);
    expect(move(w, SLOP_PX, SLOP_PX, none)).toBe(w);
  });

  it("作废之后计时器到点也不会补进排序模式", () => {
    const w = down(IDLE, "a", 0, 0);
    const dead = move(w, 0, SLOP_PX + 1, none);
    expect(hold(dead)).toEqual(IDLE);
  });
});

describe("排序中移动：定落点", () => {
  it("手指下面是谁就落到谁上面", () => {
    const s = move(sorting("a"), 5, 5, at({ "5,5": "b" }));
    expect(s.over).toBe("b");
    expect(s.phase).toBe("sorting");
  });

  it("落回自己身上等于没落点", () => {
    const s = move(sorting("a"), 5, 5, at({ "5,5": "a" }));
    expect(s.over).toBeNull();
  });

  it("手指滑出列表，落点要跟着清掉——不能停在上一个高亮上", () => {
    const on = move(sorting("a"), 5, 5, at({ "5,5": "b" }));
    expect(move(on, 9, 9, none).over).toBeNull();
  });

  it("落点没变时原样返回，省掉一次无谓重绘", () => {
    const on = move(sorting("a"), 5, 5, at({ "5,5": "b", "6,6": "b" }));
    expect(move(on, 6, 6, at({ "5,5": "b", "6,6": "b" }))).toBe(on);
  });
});

describe("抬手", () => {
  it("有落点就换位置", () => {
    const r = up(move(sorting("a"), 5, 5, at({ "5,5": "b" })));
    expect(r.drop).toEqual({ from: "a", to: "b" });
    expect(r.next).toEqual(IDLE);
  });

  it("排序中但没落点：什么都不做，也不该报错", () => {
    const r = up(sorting("a"));
    expect(r.drop).toBeNull();
    expect(r.next).toEqual(IDLE);
  });

  it("长按还没到就抬手 = 普通点击，不换位置也不吞点击", () => {
    const r = up(down(IDLE, "a", 0, 0));
    expect(r.drop).toBeNull();
    expect(r.sorted).toBe(false);
  });

  it("排完序那一下的点击要吞掉，否则松手就跳进这张清单", () => {
    expect(up(move(sorting("a"), 5, 5, at({ "5,5": "b" }))).sorted).toBe(true);
    // 空拖也算排过序：手指确实拖过，那一下点击同样不该当成「点开」
    expect(up(sorting("a")).sorted).toBe(true);
  });
});

describe("被打断", () => {
  it("来电 / 手势导航 / 多指打断，状态清干净不留半截", () => {
    expect(cancel()).toEqual(IDLE);
  });

  it("打断之后抬手不会补一次换位置", () => {
    const on = move(sorting("a"), 5, 5, at({ "5,5": "b" }));
    expect(up(cancel()).drop).toBeNull();
    expect(on.over).toBe("b"); // 原状态没被就地改坏
  });
});
