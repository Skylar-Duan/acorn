import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TaskImage } from "../core/model";
import { IS_ULTRA } from "../core/version";
import { isMobile } from "../core/platform";
import { compressTaskImage } from "../core/imageCompression";
import { imageEditContext, type ImageOperation } from "../core/imageEditContext";
import { appStore } from "../core/store";
import { syncStore } from "../core/syncCtl";
import { IMAGE_MAX_COUNT, imageListUpdateError, imageUrlLength, ledgerImageBytes } from "../core/taskImages";
import { renderableTaskImages } from "../core/imageDisplay";
import "../styles/task-images.css";

export interface ImageAttachmentsProps {
  images?: TaskImage[];
  onChange: (images: TaskImage[]) => void;
  onBusyChange?: (busy: boolean) => void;
  label?: string;
  canEdit?: () => boolean;
  /** 独立浮窗只收到上下文，不读取账本。 */
  createContext?: () => ImageOperation;
  usedBytes?: () => number;
  /** 创建草稿未计入账本总量；已存图片已计入。 */
  draft?: boolean;
}

export default function ImageAttachments(props: ImageAttachmentsProps) {
  const { images = [], onChange, label = "图片", canEdit, createContext, usedBytes, draft } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [viewing, setViewing] = useState<TaskImage | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const current = useRef(props);
  current.current = props;
  const operation = useRef<{ cancel: boolean; context: ImageOperation } | null>(null);
  useEffect(() => () => { if (operation.current) { operation.current.cancel = true; operation.current.context.dispose(); operation.current = null; current.current.onBusyChange?.(false); } }, []);
  useEffect(() => {
    if (!IS_ULTRA || !draft) return;
    const key = () => { const s = syncStore.getState().session; return s ? `${s.email}\n${s.token}` : ""; };
    let previous = key();
    const clear = () => { if (operation.current) operation.current.cancel = true; current.current.onChange([]); };
    const offSession = syncStore.subscribe(() => { const next = key(); if (next !== previous) { previous = next; clear(); } });
    const offData = appStore.subscribe((s) => { if (!s.loaded || s.loadError || s.wiped) clear(); });
    return () => { offSession(); offData(); };
  }, [draft]);
  useEffect(() => {
    if (!viewing) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setViewing(null); } };
    document.addEventListener("keydown", close, true);
    return () => document.removeEventListener("keydown", close, true);
  }, [viewing]);

  if (!IS_ULTRA || isMobile) return null;
  const visible = renderableTaskImages(images);

  async function choose(files: File[]) {
    if (!files.length || busy || operation.current) return;
    const context = createContext?.() ?? imageEditContext(canEdit);
    const job = { cancel: false, context };
    operation.current = job;
    const valid = () => operation.current === job && !job.cancel && context.valid();
    setBusy(true); current.current.onBusyChange?.(true); setError("");
    try {
      const original = current.current.images ?? [];
      if (original.length + files.length > IMAGE_MAX_COUNT) throw new Error("每件任务或子任务最多放 8 张图片");
      const added: TaskImage[] = [];
      for (const file of files) {
        if (!valid()) return;
        added.push(await compressTaskImage(file, valid));
      }
      if (!valid()) return;
      // 压缩期间可能有同步或其它改动，提交前以最新值与最新账本容量再查一次。
      const latest = current.current.images ?? [];
      const next = [...latest, ...added];
      const data = appStore.getState().data;
      const used = usedBytes?.() ?? ledgerImageBytes(data);
      const capacity = imageListUpdateError(data, latest, next, used + (draft ? latest.reduce((n, i) => n + imageUrlLength(i), 0) : 0));
      if (capacity) throw new Error(capacity);
      current.current.onChange(next);
    } catch (caught) {
      if (valid()) setError(caught instanceof Error ? caught.message : "这张图片没能添加，请重试");
    } finally {
      context.dispose();
      if (operation.current === job) { operation.current = null; setBusy(false); current.current.onBusyChange?.(false); }
    }
  }

  return <div className="task-images" data-task-images onMouseDown={(e) => e.stopPropagation()}>
    <div className="task-images-head">
      <span>{label}{visible.length ? ` · ${visible.length}/${IMAGE_MAX_COUNT}` : ""}</span>
      <button type="button" className="image-add" disabled={busy || images.length >= IMAGE_MAX_COUNT} onClick={() => input.current?.click()}>＋ 插图</button>
      {busy && <><span role="status">正在处理图片…</span><button type="button" onClick={() => { if (operation.current) operation.current.cancel = true; }}>取消</button></>}
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ""; void choose(files); }} />
    </div>
    {visible.length > 0 && <div className="task-image-list">
      {visible.map((image) => <div className="task-image-thumb" key={image.id}>
        <button type="button" className="image-open" title={image.name} aria-label={`放大图片 ${image.name}`} onClick={() => setViewing(image)}><img src={image.dataUrl} alt={image.name} loading="lazy" /></button>
        <button type="button" className="image-remove" aria-label={`删除图片 ${image.name}`} onClick={() => { if (!canEdit || canEdit()) onChange(images.filter((i) => i?.id !== image.id)); }}>×</button>
      </div>)}
    </div>}
    {error && <p className="task-image-error" role="alert">{error}</p>}
    {viewing && createPortal(<div className="image-lightbox" role="dialog" aria-modal="true" aria-label="图片预览" data-image-dialog onMouseDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) setViewing(null); }}>
      <button type="button" className="image-lightbox-close" aria-label="关闭图片预览" onClick={() => setViewing(null)}>×</button>
      <img src={viewing.dataUrl} alt={viewing.name} /><span>{viewing.name}</span>
    </div>, document.body)}
  </div>;
}
