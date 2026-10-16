/** 只处理本地剪贴板/拖入文件，不抓取HTML里的外网图片。 */
function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || /\.(?:jpe?g|png|webp|gif|bmp|avif|heic)$/i.test(file.name);
}

export function transferredImages(transfer: DataTransfer | null): File[] {
  if (!transfer) return [];
  // 截图剪贴板通常只给items；文件管理器常同时给files，不能重复计入。
  const files = Array.from(transfer.files ?? []).filter(isImageFile);
  if (files.length) return files;
  return Array.from(transfer.items ?? []).filter((item) => item.kind === "file")
    .map((item) => item.getAsFile()).filter((file): file is File => !!file && isImageFile(file));
}

export function hasImageTransfer(transfer: DataTransfer | null): boolean {
  return !!transfer && (Array.from(transfer.items ?? []).some((item) => item.kind === "file" && (!item.type || item.type.startsWith("image/")))
    || Array.from(transfer.files ?? []).some(isImageFile));
}

/** 只绑定真正的文字输入，父/子目标分开，不干扰任务排序拖动。 */
export function bindImageInput(inputs: readonly (HTMLElement | null | undefined)[], receive: (files: File[]) => void): () => void {
  const targets = [...new Set(inputs.filter((input): input is HTMLElement => !!input))];
  const paste = (event: ClipboardEvent) => {
    if (event.defaultPrevented) return;
    const files = transferredImages(event.clipboardData);
    if (!files.length) return;
    // 混合剪贴板保留原生文字粘贴、选区和IME行为；纯图不插文件名。
    if (!event.clipboardData?.getData("text/plain")) event.preventDefault();
    receive(files);
  };
  const dragover = (event: DragEvent) => {
    if (!hasImageTransfer(event.dataTransfer)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  };
  const drop = (event: DragEvent) => {
    const files = transferredImages(event.dataTransfer);
    if (!files.length) return;
    event.preventDefault(); event.stopPropagation();
    receive(files);
  };
  for (const target of targets) {
    target.addEventListener("paste", paste);
    target.addEventListener("dragover", dragover);
    target.addEventListener("drop", drop);
  }
  return () => { for (const target of targets) {
    target.removeEventListener("paste", paste);
    target.removeEventListener("dragover", dragover);
    target.removeEventListener("drop", drop);
  } };
}
