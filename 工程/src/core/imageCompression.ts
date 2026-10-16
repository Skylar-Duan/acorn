import { newId, type TaskImage } from "./model";
import { IMAGE_MAX_BYTES, imageDataBytes, imageSourceError, imageTargetSize } from "./taskImages";

/** 先读文件头看尺寸，再交给浏览器解码，避免极端大图先占满内存。仅接受JPEG/PNG/WebP。 */
export function imageHeaderSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return { width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216) {
    let i = 2;
    while (i + 8 < bytes.length) {
      if (bytes[i++] !== 255) return null;
      while (bytes[i] === 255) i++;
      const marker = bytes[i++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (i + 2 > bytes.length) return null;
      const length = view.getUint16(i);
      if (length < 2 || i + length > bytes.length) return null;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) return { width: view.getUint16(i + 5), height: view.getUint16(i + 3) };
      i += length;
    }
  }
  if (bytes.length >= 30 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") {
    const kind = String.fromCharCode(...bytes.slice(12, 16));
    if (kind === "VP8X") return { width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16) };
    if (kind === "VP8 " && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) return { width: view.getUint16(26, true) & 16383, height: view.getUint16(28, true) & 16383 };
    if (kind === "VP8L" && bytes[20] === 47) return { width: 1 + (bytes[21] | ((bytes[22] & 63) << 8)), height: 1 + ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 15) << 10)) };
  }
  return null;
}

/** 编码可注入，尺寸和体积决策可直接单测；多次降质量仍超限时才继续缩小。 */
export async function fitJpeg(width: number, height: number, encode: (width: number, height: number, quality: number) => Promise<string>, valid: () => boolean = () => true): Promise<{ dataUrl: string; width: number; height: number; bytes: number }> {
  let size = imageTargetSize(width, height);
  for (let round = 0; round < 8; round++) {
    for (const quality of [0.86, 0.72, 0.58, 0.44]) {
      if (!valid()) throw new Error("已取消图片处理");
      const dataUrl = await encode(size.width, size.height, quality);
      const bytes = imageDataBytes(dataUrl);
      if (bytes <= IMAGE_MAX_BYTES && dataUrl.startsWith("data:image/jpeg;base64,")) return { ...size, dataUrl, bytes };
    }
    size = imageTargetSize(size.width, size.height, Math.max(1, Math.floor(Math.max(size.width, size.height) * 0.75)));
  }
  throw new Error("图片压缩后仍过大，请先缩小原图");
}

export async function compressTaskImage(file: File, valid: () => boolean = () => true): Promise<TaskImage> {
  const sourceError = imageSourceError(file.size);
  if (sourceError) throw new Error(sourceError);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!valid()) throw new Error("已取消图片处理");
  const header = imageHeaderSize(bytes);
  if (!header) throw new Error("仅支持 JPG、PNG 或 WebP 图片");
  const sizeError = imageSourceError(file.size, header.width, header.height);
  if (sizeError) throw new Error(sizeError);
  const bitmap = await createImageBitmap(file);
  try {
    const decodedError = imageSourceError(file.size, bitmap.width, bitmap.height);
    if (decodedError) throw new Error(decodedError);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("这张图片暂时无法处理");
    const fitted = await fitJpeg(bitmap.width, bitmap.height, async (width, height, quality) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      canvas.width = width; canvas.height = height;
      context.fillStyle = "#ffffff"; context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      return canvas.toDataURL("image/jpeg", quality);
    }, valid);
    if (!valid()) throw new Error("已取消图片处理");
    return { id: newId(), name: file.name, ...fitted };
  } finally { bitmap.close(); }
}
