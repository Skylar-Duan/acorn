import type { TaskImage } from "./model";
import { imageHeaderSize } from "./imageCompression";
import { IMAGE_MAX_BYTES, IMAGE_MAX_EDGE } from "./taskImages";

/** 同一张图的结论只取决于dataUrl。子任务行每敲一个字都会重绘，
 *  不缓存的话每张图每一键都要整段解码一遍，长卡片打字就卡。 */
const verdicts = new Map<string, boolean>();
const VERDICT_CAP = 512;

function renderableDataUrl(dataUrl: string): boolean {
  const known = verdicts.get(dataUrl);
  if (known !== undefined) return known;
  const ok = checkDataUrl(dataUrl);
  if (verdicts.size >= VERDICT_CAP) verdicts.delete(verdicts.keys().next().value!);
  verdicts.set(dataUrl, ok);
  return ok;
}

function checkDataUrl(dataUrl: string): boolean {
  if (dataUrl.length > Math.ceil(IMAGE_MAX_BYTES / 3) * 4 + 40) return false;
  const match = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[1].length % 4) return false;
  try {
    const binary = atob(match[1]);
    if (!binary.length || binary.length > IMAGE_MAX_BYTES) return false;
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const size = imageHeaderSize(bytes);
    return !!size && size.width > 0 && size.height > 0 && size.width <= IMAGE_MAX_EDGE && size.height <= IMAGE_MAX_EDGE;
  } catch { return false; }
}

/** 不信导入记录的URL与尺寸声明：绝不隐式访问网络，也不解码大图。过滤仅用于显示。 */
export function renderableTaskImages(images: TaskImage[]): TaskImage[] {
  return images.filter((image) => {
    if (!image || typeof image.id !== "string" || typeof image.name !== "string" || typeof image.dataUrl !== "string") return false;
    return renderableDataUrl(image.dataUrl);
  });
}
