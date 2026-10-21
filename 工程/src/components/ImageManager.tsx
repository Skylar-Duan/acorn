import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TaskImage } from "../core/model";
import { cloudImageBytes, filterLedgerImages, listLedgerImages, type ImageFilter } from "../core/imageLibrary";
import { IMAGE_LEDGER_MAX_BYTES } from "../core/taskImages";
import { deleteManagedImages, setManagedImageSync, showToast, useApp } from "../core/store";
import { plusEnabled } from "../core/plus";
import { renderableTaskImages } from "../core/imageDisplay";
import { syncStore } from "../core/syncCtl";
import Icon from "./Icon";
import "../styles/task-images.css";
import "../styles/image-manager.css";

const sessionKey = () => { const s = syncStore.getState().session; return s ? `${s.email}\n${s.token}` : ""; };

function ManagedPicture({ image, onOpen }: { image: TaskImage; onOpen: () => void }) {
  const safe = useMemo(() => renderableTaskImages([image]).length > 0, [image]);
  return <button className="image-manager-preview" type="button" title={image.name} disabled={!safe} aria-label={`预览图片 ${image.name}`} onClick={onOpen}>
    {safe ? <img src={image.dataUrl} alt={image.name} loading="lazy" /> : <Icon name="image" size={28} />}
  </button>;
}

/** 所有图片仍保存在原任务里；这里只管理引用，不建立第二套图片副本。 */
export default function ImageManager({ onClose }: { onClose: () => void }) {
  const data = useApp((s) => s.data);
  const entries = useMemo(() => listLedgerImages(data), [data]);
  const [selected, setSelected] = useState<string[]>([]);
  const [filters, setFilters] = useState<ImageFilter[]>([]);
  const [pendingDelete, setPendingDelete] = useState<{ key: string; dataUrl: string }[] | null>(null);
  const [viewing, setViewing] = useState<TaskImage | null>(null);
  const [error, setError] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const account = useRef(sessionKey());
  const close = useRef(onClose); close.current = onClose;
  const visible = filterLedgerImages(entries, filters);
  const chosen = selected.filter((key) => visible.some((entry) => entry.key === key));
  const allVisible = visible.length > 0 && visible.every((entry) => chosen.includes(entry.key));
  const cloudBytes = cloudImageBytes(data);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.querySelector<HTMLElement>("button")?.focus();
    const off = syncStore.subscribe(() => { if (sessionKey() !== account.current) close.current(); });
    return () => { off(); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    if (viewing && !entries.some((entry) => entry.image.id === viewing.id && entry.image.dataUrl === viewing.dataUrl)) setViewing(null);
  }, [entries, viewing]);
  useEffect(() => { if (pendingDelete) panel.current?.querySelector<HTMLElement>("[data-cancel-image-delete]")?.focus(); }, [pendingDelete]);

  function contextValid() {
    if (plusEnabled() && sessionKey() === account.current) return true;
    onClose(); return false;
  }
  function toggle(key: string) { setSelected((old) => old.includes(key) ? old.filter((id) => id !== key) : [...old, key]); }
  function requestDelete(keys: string[]) {
    if (!contextValid()) return;
    const targets = entries.filter((entry) => keys.includes(entry.key));
    if (!targets.length) return;
    setError(""); setPendingDelete(targets.map((entry) => ({ key: entry.key, dataUrl: entry.image.dataUrl })));
  }
  function confirmDelete() {
    if (!contextValid() || !pendingDelete) return;
    if (pendingDelete.some((target) => entries.some((entry) => entry.key === target.key && entry.image.dataUrl !== target.dataUrl))) {
      setError("图片已发生变化，请重新选择后删除"); setPendingDelete(null); return;
    }
    const failure = deleteManagedImages(pendingDelete.map((entry) => entry.key));
    if (failure) { setError(failure); setPendingDelete(null); return; }
    setSelected((old) => old.filter((id) => !pendingDelete.some((entry) => entry.key === id)));
    setPendingDelete(null); showToast("图片已从对应任务中删除", true);
  }
  function setCloud(keys: string[], sync: boolean) {
    if (!contextValid() || !keys.length) return;
    const failure = setManagedImageSync(keys, sync);
    setError(failure ?? "");
    if (!failure) showToast(sync ? "已开启所选图片的云端同步" : "所选图片仅存本机，云端副本将在同步后移除", true);
  }

  return createPortal(<div className="image-manager-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) { if (pendingDelete) setPendingDelete(null); else onClose(); } }}
    onKeyDownCapture={(event) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (viewing) setViewing(null); else if (pendingDelete) setPendingDelete(null); else onClose(); }
      if (event.key === "Tab") {
        const scope = viewing ? event.currentTarget.querySelector<HTMLElement>(".image-lightbox") : panel.current?.querySelector<HTMLElement>("[data-image-delete-confirm]") ?? panel.current;
        const controls = scope?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), [tabindex='0']");
        const first = controls?.[0], last = controls?.[controls.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }}>
    <div className="image-manager-panel" ref={panel} role="dialog" aria-modal="true" aria-label="管理图片">
      <header className="image-manager-head"><div><h2>图片</h2><p>云端 {(cloudBytes / 1048576).toFixed(1)} / 20 MB<span>本机 {entries.length} 张 · 无总量上限</span></p></div>
        <button type="button" className="image-manager-close" aria-label="关闭图片管理" onClick={onClose}><Icon name="close" /></button></header>
      <div className="image-manager-meter" role="progressbar" aria-label="云端图片空间" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(cloudBytes / IMAGE_LEDGER_MAX_BYTES * 100))}>
        <i style={{ width: `${Math.min(100, cloudBytes / IMAGE_LEDGER_MAX_BYTES * 100)}%` }} /></div>
      <div className="image-manager-tools"><div className="image-manager-filters" role="group" aria-label="图片范围">
        {([ ["local", "本地"], ["cloud", "云端"], ["completed", "已完成"], ["pending", "未完成"] ] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={filters.includes(key)} onClick={() => { setSelected([]); setPendingDelete(null); setFilters((current) => current.includes(key) ? current.filter((value) => value !== key) : [...current, key]); }}>{label}</button>)}
      </div><label className="image-manager-select"><input type="checkbox" aria-label="选择当前全部图片" checked={allVisible} disabled={!visible.length} onChange={() => setSelected((old) => allVisible ? old.filter((id) => !visible.some((entry) => entry.key === id)) : [...new Set([...old, ...visible.map((entry) => entry.key)])])} />全选</label></div>
      <p className="image-manager-filter-hint">可多选，未选时显示全部。本地指仅存本机；来源和完成状态可组合筛选。多处使用的图片全部完成才算已完成。</p>
      <div className="image-manager-grid">
        {!visible.length && <p className="image-manager-empty">{filters.length ? "这个分类还没有图片" : "还没有图片"}</p>}
        {visible.map((entry) => <article className={`image-manager-item${chosen.includes(entry.key) ? " selected" : ""}`} key={entry.key}>
          <div className="image-manager-picture"><ManagedPicture image={entry.image} onOpen={() => setViewing(entry.image)} />
            <input type="checkbox" aria-label={`选择图片 ${entry.image.name}`} checked={chosen.includes(entry.key)} onChange={() => toggle(entry.key)} />
            <button className="image-manager-remove" type="button" aria-label={`删除图片 ${entry.image.name}`} onClick={() => requestDelete([entry.key])}><Icon name="close" size={14} /></button></div>
          <p className="image-manager-owner" title={entry.references.map((reference) => reference.subId ? `${reference.taskTitle} › ${reference.ownerTitle}` : reference.ownerTitle).join("\n")}>{entry.ownerTitle}{entry.referenceCount > 1 && <span> · {entry.referenceCount}处</span>}</p>
          <label className="image-manager-sync"><input type="checkbox" aria-label={`云端同步图片 ${entry.image.name}`} checked={entry.cloud} onChange={(event) => setCloud([entry.key], event.target.checked)} /><Icon name={entry.cloud ? "cloud" : "devices"} size={13} />{entry.cloud ? "云端同步" : "仅本机"}</label>
          {entry.conflict && <span className="image-manager-conflict">同名图片内容不同，请回任务检查</span>}
        </article>)}
      </div>
      {error && <p className="image-manager-error" role="alert">{error}</p>}
      <footer className="image-manager-actions"><span>已选 {chosen.length} 张</span><button className="btn" type="button" disabled={!chosen.length} onClick={() => setCloud(chosen, true)}>同步到云端</button><button className="btn" type="button" disabled={!chosen.length} onClick={() => setCloud(chosen, false)}>仅存本机</button><button className="btn danger" type="button" disabled={!chosen.length} onClick={() => requestDelete(chosen)}><Icon name="trash" size={14} />删除</button></footer>
      {pendingDelete && <div className="image-manager-confirm-wrap"><div className="image-manager-confirm" role="alertdialog" aria-modal="true" aria-label="确认删除图片" data-image-delete-confirm>
        <h3>删除 {pendingDelete.length} 张图片？</h3><p>图片会从所有对应任务、子任务及历史记录中移除，云端副本也会在同步后删除。</p>
        <div><button type="button" className="btn" data-cancel-image-delete onClick={() => setPendingDelete(null)}>取消</button><button type="button" className="btn danger" onClick={confirmDelete}>删除图片</button></div>
      </div></div>}
    </div>
    {viewing && <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={`图片预览 ${viewing.name}`} onMouseDown={(event) => { if (event.target === event.currentTarget) setViewing(null); }}>
      <button className="image-lightbox-close" type="button" aria-label="关闭图片预览" onClick={() => setViewing(null)}><Icon name="close" /></button><img src={viewing.dataUrl} alt={viewing.name} /><span>{viewing.name}</span>
    </div>}
  </div>, document.body);
}
