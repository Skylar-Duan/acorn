import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TaskImage } from "../core/model";
import { plusEnabled, plusStore, usePlus } from "../core/plus";
import { compressTaskImage } from "../core/imageCompression";
import { imageEditContext, type ImageOperation } from "../core/imageEditContext";
import { appStore, showToast } from "../core/store";
import { syncStore } from "../core/syncCtl";
import { imageListUpdateError } from "../core/taskImages";
import { cloudImageBytes, prepareImageAdditions } from "../core/imageLibrary";
import { renderableTaskImages } from "../core/imageDisplay";
import { bindImageInput } from "../core/imageInput";
import Icon from "./Icon";
import TaskPropertyPopover from "./TaskPropertyPopover";
import { useLeaving } from "./motion";
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
  /** 只有这些文字输入接收粘贴/拖入。 */
  inputTargets?: () => readonly (HTMLElement | null | undefined)[];
  /** 组件被复用于另一目标时，旧压缩结果不得写到新目标。 */
  targetKey?: string;
  /** 子任务行的小加号；选图、粘贴和拖入共用同一条处理路径。 */
  pickerLabel?: string;
  /** 已保存的图片收成右侧一张缩略图，点开再看完整图片。 */
  compact?: boolean;
  /** 子任务直接在正文下展开图片，不另开完整集合浮层。 */
  inlineExpanded?: boolean;
  onExpand?: () => void;
}

export default function ImageAttachments(props: ImageAttachmentsProps) {
  const plus = usePlus();
  const { images = [], onChange, label = "图片", canEdit, createContext, usedBytes, draft } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [viewing, setViewing] = useState<TaskImage | null>(null);
  const [expanded, setExpanded] = useState(false);
  const panel = useLeaving(expanded ? true : null);
  const summaryButton = useRef<HTMLButtonElement>(null);
  const galleryElement = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  current.current = props;
  const operation = useRef<{ cancel: boolean; context: ImageOperation } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const picking = useRef<{ context: ImageOperation; targetKey?: string } | null>(null);
  function cancelPick() { picking.current?.context.dispose(); picking.current = null; }
  useEffect(() => () => { cancelPick(); if (operation.current) { operation.current.cancel = true; operation.current.context.dispose(); operation.current = null; current.current.onBusyChange?.(false); } }, []);
  useEffect(() => () => { cancelPick(); if (operation.current) operation.current.cancel = true; }, [props.targetKey]);
  useEffect(() => { setExpanded(false); setViewing(null); }, [props.targetKey]);
  useEffect(() => {
    if (viewing && !images.some((image) => image?.id === viewing.id && image.dataUrl === viewing.dataUrl)) setViewing(null);
    if (!images.length && !busy && !error) setExpanded(false);
  }, [images, busy, error, viewing]);
  useEffect(() => {
    if (!draft) return;
    const key = () => { const s = syncStore.getState().session; return s ? `${s.email}\n${s.token}` : ""; };
    let previous = key();
    const clear = () => { if (operation.current) operation.current.cancel = true; if (current.current.images?.length) current.current.onChange([]); };
    const offSession = syncStore.subscribe(() => { const next = key(); if (next !== previous) { previous = next; clear(); } });
    const offPlus = plusStore.subscribe((next, old) => { if (next.revision !== old.revision) clear(); });
    const offData = appStore.subscribe((s) => { if (!s.loaded || s.loadError || s.wiped) clear(); });
    return () => { offSession(); offPlus(); offData(); };
  }, [draft]);
  useEffect(() => {
    if (plus) return;
    cancelPick();
    if (operation.current) operation.current.cancel = true;
    setExpanded(false); setViewing(null);
  }, [plus]);
  useEffect(() => {
    if (!viewing) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setViewing(null); } };
    document.addEventListener("keydown", close, true);
    return () => document.removeEventListener("keydown", close, true);
  }, [viewing]);
  useEffect(() => {
    if (!expanded || viewing) return;
    const outside = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && (summaryButton.current?.contains(target) || galleryElement.current?.contains(target) || target.closest(".image-lightbox"))) return;
      setExpanded(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setExpanded(false); } };
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("mousedown", outside, true); document.removeEventListener("keydown", escape, true); };
  }, [expanded, viewing]);
  useEffect(() => {
    if (!plus) return;
    return bindImageInput(props.inputTargets?.() ?? [], (files) => { void attach(files); });
  });
  useEffect(() => {
    const input = fileInput.current;
    if (!input) return;
    input.addEventListener("cancel", cancelPick);
    return () => input.removeEventListener("cancel", cancelPick);
  });

  function openPicker() {
    if (!plusEnabled() || operation.current || !fileInput.current || current.current.canEdit?.() === false) return;
    cancelPick();
    const context = current.current.createContext?.() ?? imageEditContext(current.current.canEdit);
    picking.current = { context, targetKey: current.current.targetKey };
    fileInput.current.value = "";
    fileInput.current.click();
  }

  async function attach(files: File[], picked?: { context: ImageOperation; targetKey?: string }) {
    if (!plusEnabled() || !files.length || operation.current || picked && (picked.targetKey !== current.current.targetKey || !picked.context.valid())) { picked?.context.dispose(); return; }
    const context = picked?.context ?? createContext?.() ?? imageEditContext(canEdit);
    const targetKey = picked ? picked.targetKey : current.current.targetKey;
    const job = { cancel: false, context };
    operation.current = job;
    const valid = () => plusEnabled() && operation.current === job && !job.cancel && current.current.targetKey === targetKey && context.valid();
    setBusy(true); current.current.onBusyChange?.(true); setError("");
    try {
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
      const prepared = prepareImageAdditions(data, latest, next, { usedCloudBytes: usedBytes?.() ?? cloudImageBytes(data), currentInLedger: !draft });
      const capacity = imageListUpdateError(data, latest, prepared.images);
      if (capacity) throw new Error(capacity);
      current.current.onChange(prepared.images);
      if (prepared.message) { setError(prepared.message); showToast(prepared.message, false); }
    } catch (caught) {
      if (valid()) { setError(caught instanceof Error ? caught.message : "这张图片没能添加，请重试"); if (current.current.compact) { if (current.current.onExpand) current.current.onExpand(); else setExpanded(true); } }
    } finally {
      context.dispose();
      if (operation.current === job) { operation.current = null; setBusy(false); current.current.onBusyChange?.(false); }
    }
  }

  const inlinePanel = useLeaving(props.inlineExpanded ? true : null);
  const inline = props.inlineExpanded !== undefined;
  const compactGallery = props.compact && !inline;
  if (!plus) return null;
  const visible = renderableTaskImages(images);
  const showGallery = visible.length > 0 || busy || !!error;
  if (!showGallery && !props.pickerLabel) return null;

  const gallery = <div ref={galleryElement} className={`task-images${compactGallery ? " task-images-compact-gallery" : ""}${visible.length ? "" : " task-images-empty"}`}
    data-task-images data-image-dialog={compactGallery || undefined} role={compactGallery ? "dialog" : undefined} aria-label={`${label} · ${visible.length}张`}
    onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
    <div className="task-images-head">
      <span className="task-images-label">{label}{visible.length ? ` · ${visible.length}张` : ""}</span>
      {busy && <><span role="status">正在处理图片…</span><button type="button" onClick={() => { if (operation.current) operation.current.cancel = true; }}>取消</button></>}
      {compactGallery && <button type="button" className="image-collapse" aria-label="收起图片" onClick={() => setExpanded(false)}><Icon name="close" size={15} /></button>}
    </div>
    {visible.length > 0 && <div className="task-image-list">
      {visible.map((image) => <div className="task-image-thumb" key={image.id}>
        <button type="button" className="image-open" title={image.name} aria-label={`放大图片 ${image.name}`} onClick={() => setViewing(image)}><img src={image.dataUrl} alt={image.name} loading="lazy" /></button>
        <button type="button" className="image-remove" aria-label={`删除图片 ${image.name}`} onClick={() => { if (!canEdit || canEdit()) onChange(images.filter((i) => i?.id !== image.id)); }}>×</button>
      </div>)}
    </div>}
    {error && <p className="task-image-error" role="alert">{error}</p>}
  </div>;

  return <>
    {props.pickerLabel && <>
      <button type="button" className="sub-image-add" title="添加图片" aria-label={props.pickerLabel} disabled={busy}
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }} onClick={(e) => { e.stopPropagation(); openPicker(); }}><Icon name="plus" size={15} /></button>
      <input ref={fileInput} type="file" hidden multiple accept="image/jpeg,image/png,image/webp" data-image-picker
        onChange={(e) => { const selected = picking.current; picking.current = null; const files = Array.from(e.currentTarget.files ?? []); e.currentTarget.value = ""; if (selected) void attach(files, selected); }} />
    </>}
    {showGallery && (props.compact ? <>
      {!props.inlineExpanded && <button ref={summaryButton} type="button" className={`image-summary${visible.length > 1 ? " image-summary-stack" : ""}${error ? " image-summary-error" : ""}`}
        data-image-summary aria-expanded={expanded} aria-label={`展开${label} ${visible.length}张`} title={error || `${label} · ${visible.length}张`}
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }} onClick={(e) => { e.stopPropagation(); if (props.onExpand) props.onExpand(); else setExpanded(!expanded); }}>
        {visible[0] ? <img src={visible[0].dataUrl} alt="" loading="lazy" draggable={false} /> : <Icon name="image" size={17} />}
        {visible.length > 1 && <span className="image-summary-count">{visible.length}</span>}
        {busy && <span className="image-summary-busy" role="status" aria-label="正在处理图片" />}
      </button>}
      {inline ? inlinePanel.shown && <div className={`sub-images-motion${inlinePanel.leaving ? " leaving" : ""}`} aria-hidden={inlinePanel.leaving || undefined}
        ref={(el) => { if (el) el.inert = inlinePanel.leaving; }}><div>{gallery}</div></div>
        : panel.shown && <TaskPropertyPopover anchor={summaryButton.current} leaving={panel.leaving}>{gallery}</TaskPropertyPopover>}
    </> : gallery)}
    {viewing && createPortal(<div className="image-lightbox" role="dialog" aria-modal="true" aria-label="图片预览" data-image-dialog onMouseDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) setViewing(null); }}>
      <button type="button" className="image-lightbox-close" aria-label="关闭图片预览" onClick={() => setViewing(null)}><Icon name="close" size={24} /></button>
      <img src={viewing.dataUrl} alt={viewing.name} /><span>{viewing.name}</span>
    </div>, document.body)}
  </>;
}
