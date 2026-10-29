import { describe, expect, it } from "vitest";
import type { TaskImage } from "../src/core/model";
import { renderableTaskImages } from "../src/core/imageDisplay";

// 长子任务打字卡顿（10-28）：每敲一键所有子行重绘，每张图都整段解码。结论按dataUrl记住后重绘只剩查表。
function png(id: string, edge: number, padding: number): TaskImage {
  const bytes = new Uint8Array(24 + padding); bytes.set([137, 80, 78, 71]);
  const view = new DataView(bytes.buffer); view.setUint32(16, edge); view.setUint32(20, edge);
  for (let i = 24; i < bytes.length; i++) bytes[i] = (i * 31 + id.length) & 255;
  let binary = ""; for (const b of bytes) binary += String.fromCharCode(b);
  return { id, name: `${id}.png`, dataUrl: `data:image/png;base64,${btoa(binary)}`, width: edge, height: edge, bytes: bytes.length };
}

describe("图片显示过滤的缓存", () => {
  it("同一图片重复判断结果不变，坏图仍被拒", () => {
    const good = png("good", 640, 1000);
    const bomb = png("bomb", 50000, 1000);
    for (let i = 0; i < 3; i++) expect(renderableTaskImages([good, bomb])).toEqual([good]);
    // 结论只看dataUrl：同一张图换了id/名字也一样能显示；字段不对的照样拒
    const renamed = { ...good, id: "other", name: "改名.png" };
    expect(renderableTaskImages([renamed])).toEqual([renamed]);
    expect(renderableTaskImages([{ ...good, name: 3 } as unknown as TaskImage])).toEqual([]);
  });

  it("40张约180KB的图，重复60次判断远快于首轮", () => {
    const images = Array.from({ length: 40 }, (_, i) => png(`img-${i}`, 800, 180_000 + i));
    const first = performance.now();
    expect(renderableTaskImages(images)).toHaveLength(40);
    const firstMs = performance.now() - first;
    const start = performance.now();
    for (let i = 0; i < 60; i++) renderableTaskImages(images);
    const repeatMs = (performance.now() - start) / 60;
    console.info(`首轮 ${firstMs.toFixed(1)}ms，此后每轮 ${repeatMs.toFixed(3)}ms`);
    expect(repeatMs).toBeLessThan(firstMs / 20);
  });
});
