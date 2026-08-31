// 设置：外观 / 云账号 / 数据 / 导出导入 / 行为 / 回收站 / 关于。分节卡片，一屏调完。
import { useEffect, useState } from "react";
import type { AppData, Priority, Settings as AppSettings, Task, ThemeName } from "../core/model";
import { APP_VERSION, DATA_VERSION } from "../core/model";
import { toJsonFile, unpack } from "../core/transfer";
import { pad2, todayYMD, toYMD } from "../core/dates";
import { aliveTasks, navigate, showToast, updateSettings, useApp } from "../core/store";
import {
  dataStatus, getDataDir, inTauri, listBackups, readTextFile, restoreBackup,
  saveData, setDataDir, writeTextFile,
} from "../core/persist";
import type { BackupInfo, DataStatus } from "../core/persist";
import { applyQuickAddShortcut } from "../core/shortcutCtl";
import { hasDesktopFeatures } from "../core/platform";
import { FOCUS_ENABLED } from "../core/features";
import ThemeScene from "../components/ThemeScene";
import AccountPanel from "../components/AccountPanel";
import { useGuideEntry } from "../components/GuideSheet";
import UpdatePanel from "../components/UpdatePanel";
import { updaterSupported } from "../core/updater";
import "../styles/settings.css";

const THEMES: { id: ThemeName; name: string; note: string }[] = [
  { id: "forest", name: "森林", note: "晨雾里的针叶林" },
  { id: "ocean", name: "海洋", note: "退潮后的浅滩" },
  { id: "night", name: "星空", note: "暮色与远光" },
  { id: "desert", name: "沙漠", note: "落日下的沙丘" },
  { id: "snow", name: "雪山", note: "清晨的冰川" },
  { id: "polar", name: "南极", note: "极昼的冰面" },
];

const MODES: { id: AppSettings["mode"]; name: string }[] = [
  { id: "light", name: "浅色" },
  { id: "dark", name: "深色" },
  { id: "system", name: "跟随系统" },
];

const FOCUS_CHOICES = [15, 25, 45, 60];

const PRIORITY_LABEL: Record<Priority, string> = { 0: "无", 1: "低", 2: "中", 3: "高" };

// ---------- 导出内容拼装 ----------

/** ISO 完成时刻 -> 本地 'YYYY-MM-DD HH:mm' */
function localDT(iso: string): string {
  const d = new Date(iso);
  return `${toYMD(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 含逗号/引号/换行的单元格用引号包裹，内部引号加倍 */
function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function buildCsv(d: AppData): string {
  const listName = (id: string | null) =>
    id ? d.lists.find((l) => l.id === id)?.name ?? "" : "随手记";
  const head = "标题,清单,需求方,标签,优先级,日期,时间,状态,完成时刻";
  const rows = aliveTasks(d).map((t) =>
    [
      t.title,
      listName(t.listId),
      t.who.join(" "),
      t.tags.join(" "),
      PRIORITY_LABEL[t.priority],
      t.due ?? "",
      t.dueTime ?? "",
      t.done ? "已完成" : "未完成",
      t.doneAt ? localDT(t.doneAt) : "",
    ]
      .map(csvCell)
      .join(","),
  );
  // 前置 BOM 让 Excel 认出 UTF-8
  return "\uFEFF" + [head, ...rows].join("\r\n");
}

function buildMarkdown(d: AppData): string {
  const alive = aliveTasks(d);
  const groups: { name: string; items: Task[] }[] = [];
  const inbox = alive.filter((t) => !t.listId);
  if (inbox.length) groups.push({ name: "随手记", items: inbox });
  for (const l of [...d.lists].sort((a, b) => a.order - b.order)) {
    const items = alive.filter((t) => t.listId === l.id);
    if (items.length) groups.push({ name: l.name, items });
  }
  const lines = [`# 橡果任务清单（${todayYMD()}）`, ""];
  for (const g of groups) {
    lines.push(`## ${g.name}`, "");
    for (const t of g.items) {
      const meta = [
        t.due ? `${t.due}${t.dueTime ? " " + t.dueTime : ""}` : "",
        // 需求方可能有好几个，一人一个 @；一个都没有时这里必须是空串
        // （空数组是真值，写成 t.who ? ... 会导出出一个光杆「@」）
        ...t.who.map((w) => `@${w}`),
        ...t.tags.map((x) => `#${x}`),
      ]
        .filter(Boolean)
        .join(" · ");
      lines.push(`- [${t.done ? "x" : " "}] ${t.title}${meta ? `（${meta}）` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---------- 视图 ----------

export default function Settings() {
  const data = useApp((s) => s.data);
  const settings = data.settings;

  const [status, setStatus] = useState<DataStatus | null>(null);
  /** null = 备份列表收起 */
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [shortcut, setShortcut] = useState(settings.quickAddShortcut);
  const [autoOn, setAutoOn] = useState(settings.autostart);
  const guide = useGuideEntry();

  useEffect(() => {
    void dataStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  // 开机自启以系统实际状态为准（设置文件可能与系统脱节）
  useEffect(() => {
    if (!inTauri) return;
    void import("@tauri-apps/plugin-autostart")
      .then((m) => m.isEnabled())
      .then(setAutoOn)
      .catch(() => {});
  }, []);

  useEffect(() => setShortcut(settings.quickAddShortcut), [settings.quickAddShortcut]);

  // 色卡按当前深浅模式展示对应主题的那一面
  const swatchMode: "light" | "dark" =
    settings.mode === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : settings.mode;

  function commitShortcut() {
    const v = shortcut.trim();
    if (!v) {
      setShortcut(settings.quickAddShortcut);
      return;
    }
    if (v === settings.quickAddShortcut) return;
    updateSettings({ quickAddShortcut: v });
    void applyQuickAddShortcut(v);
  }

  async function toggleAutostart() {
    const next = !autoOn;
    try {
      const m = await import("@tauri-apps/plugin-autostart");
      if (next) await m.enable();
      else await m.disable();
      setAutoOn(next);
      updateSettings({ autostart: next });
    } catch (e) {
      showToast(`开机自启设置失败：${String(e)}`, false);
    }
  }

  async function changeDir() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true });
      if (typeof dir !== "string") return;
      await setDataDir(dir);
      location.reload();
    } catch (e) {
      showToast(`更换失败：${String(e)}`, false);
    }
  }

  async function toggleBackups() {
    if (backups) {
      setBackups(null);
      return;
    }
    try {
      setBackups(await listBackups());
    } catch (e) {
      showToast(`读取备份失败：${String(e)}`, false);
    }
  }

  async function restoreOne(name: string) {
    try {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      const ok = await ask(
        `恢复前会先把当前数据另存一份，再用「${name}」覆盖。确定继续吗？`,
        { title: "恢复备份", kind: "warning" },
      );
      if (!ok) return;
      await restoreBackup(name);
      location.reload();
    } catch (e) {
      showToast(`恢复失败：${String(e)}`, false);
    }
  }

  async function exportAs(kind: "json" | "csv" | "md") {
    try {
      const meta = {
        json: { name: "JSON", ext: "json", make: () => toJsonFile(data, APP_VERSION) },
        csv: { name: "CSV", ext: "csv", make: () => buildCsv(data) },
        md: { name: "Markdown", ext: "md", make: () => buildMarkdown(data) },
      }[kind];
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: `acorn-${todayYMD()}.${meta.ext}`,
        filters: [{ name: meta.name, extensions: [meta.ext] }],
      });
      if (!path) return;
      await writeTextFile(path, meta.make());
      showToast("已导出", false);
    } catch (e) {
      showToast(`导出失败：${String(e)}`, false);
    }
  }

  async function importJson() {
    try {
      const dlg = await import("@tauri-apps/plugin-dialog");
      const path = await dlg.open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (typeof path !== "string") return;
      const raw = await readTextFile(path);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        showToast("这个文件不是有效的 JSON", false);
        return;
      }
      // 统一口径解包（新式信封 / 老式裸数据都认），防止随手选错文件整库清空
      const res = unpack(parsed);
      if (!res.ok) {
        showToast(`${res.error}，已取消`, false);
        return;
      }
      const from = res.appVersion ? `由 v${res.appVersion} 导出` : "旧版格式";
      // 文件比本机新：这台橡果读不全它。**不能装作看懂**——照老格式填进来，
      // 新版本才有的东西（比如习惯的打卡记录）会被悄悄抹掉。把代价说清楚，由用户拍板
      const warn = res.tooNew
        ? `\n\n⚠️ 这份文件是更新版本的橡果导出的（数据版本 ${res.schema}，这台设备只认到 ${DATA_VERSION}）。` +
          `导进来的话，新版本才有的东西会丢。建议先把这台设备上的橡果升级再导。`
        : "";
      const ok = await dlg.ask(
        `导入将覆盖当前全部数据（导入前会自动留一份恢复备份）。\n该文件${from}，含 ${res.data.tasks.length} 条任务。${warn}\n\n确定继续吗？`,
        { title: "导入数据", kind: "warning" },
      );
      if (!ok) return;
      // 冲掉在途的防抖写入，再把当前数据留一份 pre-import 备份，最后写入导入内容
      const { flushSave, appStore } = await import("../core/store");
      await flushSave();
      const dir = await getDataDir();
      const now = new Date();
      const stamp = `${toYMD(now).replace(/-/g, "")}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
      await writeTextFile(`${dir}\\backups\\pre-import-${stamp}.json`, JSON.stringify(appStore.getState().data)).catch(() => {});
      await saveData(res.data);
      location.reload();
    } catch (e) {
      showToast(`导入失败：${String(e)}`, false);
    }
  }

  return (
    <section className="main">
      <div className="view-head">
        <h1>设置</h1>
        <span className="sub">外观、账号、数据与行为</span>
      </div>
      <div className="view-body set-body">
        {/* ---------- 外观 ---------- */}
        <div className="set-section">
          <h2>外观</h2>
          <div className="set-desc">六款主题，每款配一幅背景画，淡淡地垫在任务下面。</div>
          <div className="set-themes">
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={`set-theme-card${settings.theme === t.id ? " on" : ""}`}
                onClick={() => updateSettings({ theme: t.id })}
              >
                <span className="set-swatch" data-theme={t.id} data-mode={swatchMode}>
                  <ThemeScene theme={t.id} variant="card" />
                  <span className="set-sw-accent" />
                </span>
                <span className="set-theme-name">{t.name}</span>
                <span className="set-theme-note">{t.note}</span>
              </button>
            ))}
          </div>
          <div className="set-row">
            <div className="set-row-label">深浅模式</div>
            <div className="set-ctl">
              <div className="set-seg">
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    className={settings.mode === m.id ? "on" : undefined}
                    onClick={() => updateSettings({ mode: m.id })}
                  >
                    {m.name}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* ---------- 云账号 ---------- */}
        <div className="set-section">
          <h2>云账号</h2>
          <div className="set-desc">
            登录后手机和电脑使用同一份数据。同一件事在两端都改过时，以较晚的一次为准。
          </div>
          <AccountPanel />
        </div>

        {/* ---------- 版本更新（手机和桌面都有） ---------- */}
        {updaterSupported && (
          <div className="set-section">
            <h2>版本更新</h2>
            <div className="set-desc">
              每次启动会自动检查一次，有新版本会提示；这里也可以手动检查。新版本在应用内下载安装。
              {hasDesktopFeatures && "电脑上安装前橡果会先退出，否则新版本装不进来。"}
            </div>
            <UpdatePanel />
          </div>
        )}

        {/* ---------- 数据 ---------- */}
        <div className="set-section">
          <h2>数据</h2>
          <div className="set-desc">每天首次保存时自动留一份备份，保留 30 份。</div>
          <div className="set-row">
            <span
              className={`set-dot${status ? (status.dirOk ? " ok" : " bad") : ""}`}
              title={status ? (status.dirOk ? "文件夹正常" : "文件夹不可用") : "正在检查"}
            />
            <span className="set-path">{status ? status.dir : "正在检查…"}</span>
            {inTauri && hasDesktopFeatures && (
              <div className="set-ctl">
                <button className="btn" onClick={() => void changeDir()}>更换文件夹</button>
              </div>
            )}
          </div>
          {inTauri && (
            <div className="set-row">
              <div className="set-row-label">每日备份</div>
              <div className="set-ctl">
                <button className="btn ghost" onClick={() => void toggleBackups()}>
                  {backups ? "收起备份列表" : "打开备份列表"}
                </button>
              </div>
            </div>
          )}
          {backups &&
            (backups.length === 0 ? (
              <div className="set-empty">还没有备份。每天首次保存时会自动留一份。</div>
            ) : (
              <div className="set-backups">
                {backups.map((b) => (
                  <div key={b.name} className="set-backup-row">
                    <span className="set-backup-name">{b.name}</span>
                    <span className="set-backup-size">{Math.max(1, Math.round(b.size / 1024))} KB</span>
                    <button className="btn ghost" onClick={() => void restoreOne(b.name)}>恢复</button>
                  </div>
                ))}
              </div>
            ))}
        </div>

        {/* ---------- 导出与导入 ---------- */}
        <div className="set-section">
          <h2>导出与导入</h2>
          {hasDesktopFeatures ? (
            <>
          <div className="set-desc">导出为通用格式；导入会整体替换现有数据。</div>
          <div className="set-actions">
            <button className="btn" onClick={() => void exportAs("json")}>导出 JSON</button>
            <button className="btn" onClick={() => void exportAs("csv")}>导出 CSV</button>
            <button className="btn" onClick={() => void exportAs("md")}>导出 Markdown</button>
            <span className="set-flex" />
            <button className="btn" onClick={() => void importJson()}>导入 JSON…</button>
          </div>
            </>
          ) : (
            <div className="set-desc">
              手机上不提供文件导出。迁移数据请用上面的「云账号」：两端登录同一个账号，
              使用的就是同一份数据。
            </div>
          )}
        </div>

        {/* ---------- 行为 ---------- */}
        {/* 整节一起判空：手机上前两行本来就被 hasDesktopFeatures 挡掉，
            专注那行再收起来（core/features.ts）就只剩一个空壳卡片 */}
        {(hasDesktopFeatures || FOCUS_ENABLED) && (
        <div className="set-section">
          <h2>行为</h2>
          {hasDesktopFeatures && (
          <div className="set-row">
            <div className="set-row-label">
              全局快捷键
              <span className="set-hint">唤起「随手记一条」小窗 · 如 Alt+Space、Ctrl+Shift+A</span>
            </div>
            <div className="set-ctl">
              <input
                className="input set-shortcut"
                value={shortcut}
                onChange={(e) => setShortcut(e.target.value)}
                onBlur={commitShortcut}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
              />
            </div>
          </div>
          )}
          {inTauri && hasDesktopFeatures && (
            <div className="set-row">
              <div className="set-row-label">
                开机自启
                <span className="set-hint">开机后在托盘中启动</span>
              </div>
              <div className="set-ctl">
                <button
                  className={`set-switch${autoOn ? " on" : ""}`}
                  role="switch"
                  aria-checked={autoOn}
                  title={autoOn ? "点击关闭" : "点击开启"}
                  onClick={() => void toggleAutostart()}
                />
              </div>
            </div>
          )}
          {FOCUS_ENABLED && (
          <div className="set-row">
            <div className="set-row-label">默认专注时长</div>
            <div className="set-ctl">
              <div className="set-seg">
                {FOCUS_CHOICES.map((n) => (
                  <button
                    key={n}
                    className={settings.focusMinutesDefault === n ? "on" : undefined}
                    onClick={() => updateSettings({ focusMinutesDefault: n })}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <span className="set-suffix">分钟</span>
            </div>
          </div>
          )}
        </div>
        )}

        {/* ---------- 一句话记事 ---------- */}
        <div className="set-section">
          <h2>一句话记事</h2>
          <div className="set-desc">
            日期、清单、需求方、重要性、循环，可以写在同一句里；也可以用随手记下面那排按钮点选。
          </div>
          <div className="set-row">
            <div className="set-row-label">
              写法说明
              <span className="set-hint">在单独的窗口里打开，一组可以照着抄的例子</span>
            </div>
            <div className="set-ctl">
              <button className="btn" onClick={guide.open}>打开用法</button>
            </div>
          </div>
        </div>
        {guide.sheet}

        {/* ---------- 回收站 ---------- */}
        <div className="set-section">
          <h2>回收站</h2>
          <div className="set-row">
            <div className="set-row-label">
              已删除的任务
              <span className="set-hint">保留 30 天，之后自动清理</span>
            </div>
            <div className="set-ctl">
              <button className="btn" onClick={() => navigate("trash")}>打开回收站</button>
            </div>
          </div>
        </div>

        {/* ---------- 关于 ---------- */}
        <div className="set-section set-about">
          <span className="set-about-brand">橡果 Acorn</span>
          <span className="set-about-line">v{APP_VERSION} · 本地优先的待办工具 · 数据保存在你自己的磁盘上。</span>
        </div>
      </div>
    </section>
  );
}
