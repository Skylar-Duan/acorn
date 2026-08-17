// Rust 侧职责：数据文件的安全读写（原子替换 + 崩溃恢复）、每日备份轮换、
// 托盘常驻、单实例。业务逻辑全部在前端，这里只做「不能丢数据」的底座。

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State,
};

const DEFAULT_DATA_DIR: &str = r"S:\AI\Claude Code\project code\02-Gadgets\acorn\userdata";
const BACKUP_KEEP: usize = 30;

struct DataDir(Mutex<PathBuf>);

// ---------- 配置（数据目录指针存在本机 AppData，数据本体在 S 盘） ----------

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("config.json"))
}

fn read_configured_dir(app: &AppHandle) -> PathBuf {
    if let Some(p) = config_path(app) {
        if let Ok(s) = fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                if let Some(d) = v.get("dataDir").and_then(|x| x.as_str()) {
                    if !d.is_empty() {
                        return PathBuf::from(d);
                    }
                }
            }
        }
    }
    PathBuf::from(DEFAULT_DATA_DIR)
}

fn persist_configured_dir(app: &AppHandle, dir: &Path) -> Result<(), String> {
    let p = config_path(app).ok_or("no config dir")?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::json!({ "dataDir": dir.to_string_lossy() });
    fs::write(&p, json.to_string()).map_err(|e| e.to_string())
}

// ---------- 数据文件 ----------

fn data_file(dir: &Path) -> PathBuf {
    dir.join("data.json")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DataStatus {
    dir: String,
    dir_ok: bool,
    has_file: bool,
}

#[tauri::command]
fn get_data_dir(state: State<DataDir>) -> String {
    state.0.lock().unwrap().to_string_lossy().to_string()
}

#[tauri::command]
fn set_data_dir(app: AppHandle, state: State<DataDir>, dir: String) -> Result<(), String> {
    let p = PathBuf::from(&dir);
    fs::create_dir_all(&p).map_err(|e| format!("无法创建目录：{e}"))?;
    // 新目录还没有数据而旧目录有 → 把数据带过去（不带走旧备份，旧目录原样保留当兜底）
    let old = state.0.lock().unwrap().clone();
    let old_file = data_file(&old);
    let new_file = data_file(&p);
    if old_file.exists() && !new_file.exists() && old != p {
        fs::copy(&old_file, &new_file).map_err(|e| format!("迁移数据失败：{e}"))?;
    }
    persist_configured_dir(&app, &p)?;
    *state.0.lock().unwrap() = p;
    Ok(())
}

#[tauri::command]
fn data_status(state: State<DataDir>) -> DataStatus {
    let dir = state.0.lock().unwrap().clone();
    // 可写性用真实写入探测：目录能建出来且能写临时文件才算 ok
    let dir_ok = fs::create_dir_all(&dir).is_ok() && {
        let probe = dir.join(".acorn-probe");
        let ok = fs::write(&probe, b"ok").is_ok();
        let _ = fs::remove_file(&probe);
        ok
    };
    DataStatus {
        dir: dir.to_string_lossy().to_string(),
        dir_ok,
        has_file: data_file(&dir).exists(),
    }
}

#[tauri::command]
fn load_data(state: State<DataDir>) -> Result<Option<String>, String> {
    let dir = state.0.lock().unwrap().clone();
    let file = data_file(&dir);
    let tmp = dir.join("data.json.tmp");
    let old = dir.join("data.json.old");

    // 崩溃恢复：正文丢了但替换过程的中间文件还在
    if !file.exists() {
        if tmp.exists() && fs::read_to_string(&tmp).map(|s| valid_json(&s)).unwrap_or(false) {
            fs::rename(&tmp, &file).map_err(|e| e.to_string())?;
        } else if old.exists() {
            fs::rename(&old, &file).map_err(|e| e.to_string())?;
        }
    }

    match fs::read_to_string(&file) {
        Ok(s) if valid_json(&s) => Ok(Some(s)),
        Ok(_) => {
            // 正文损坏：把坏文件改名留证，依次尝试 .old → 最新备份
            let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
            let _ = fs::rename(&file, dir.join(format!("data.json.corrupt-{stamp}")));
            if old.exists() && fs::read_to_string(&old).map(|s| valid_json(&s)).unwrap_or(false) {
                fs::rename(&old, &file).map_err(|e| e.to_string())?;
                return fs::read_to_string(&file).map(Some).map_err(|e| e.to_string());
            }
            let newest = list_backups(state);
            if let Some(b) = newest.first() {
                let content = fs::read_to_string(dir.join("backups").join(&b.name))
                    .map_err(|e| e.to_string())?;
                if valid_json(&content) {
                    fs::write(&file, &content).map_err(|e| e.to_string())?;
                    return Ok(Some(content));
                }
            }
            Err("数据文件已损坏，且没有可用的恢复副本（损坏文件已改名保留在数据目录）".into())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("读取数据失败：{e}")),
    }
}

fn valid_json(s: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(s).is_ok()
}

/// 原子替换：先落临时文件并校验，再把旧文件挪开、临时转正。
/// 任何一步崩溃，load_data 的恢复逻辑都能找回一份完整数据。
#[tauri::command]
fn save_data(state: State<DataDir>, json: String) -> Result<(), String> {
    if !valid_json(&json) {
        return Err("拒绝写入：内容不是合法 JSON".into());
    }
    let dir = state.0.lock().unwrap().clone();
    fs::create_dir_all(&dir).map_err(|e| format!("数据目录不可用：{e}"))?;
    let file = data_file(&dir);
    let tmp = dir.join("data.json.tmp");
    let old = dir.join("data.json.old");

    {
        use std::io::Write;
        let mut f = fs::File::create(&tmp).map_err(|e| format!("写入失败：{e}"))?;
        f.write_all(json.as_bytes()).map_err(|e| format!("写入失败：{e}"))?;
        // fsync：确保字节真的落到盘上（尤其是可随时拔走的移动硬盘）再动正文
        f.sync_all().map_err(|e| format!("落盘失败：{e}"))?;
    }
    let back = fs::read_to_string(&tmp).map_err(|e| e.to_string())?;
    if back != json {
        return Err("写入校验失败".into());
    }
    if file.exists() {
        let _ = fs::remove_file(&old);
        fs::rename(&file, &old).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &file).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&old);
    Ok(())
}

// ---------- 备份 ----------

#[derive(Serialize)]
struct BackupInfo {
    name: String,
    size: u64,
}

#[tauri::command]
fn ensure_daily_backup(state: State<DataDir>) -> Result<bool, String> {
    let dir = state.0.lock().unwrap().clone();
    let file = data_file(&dir);
    if !file.exists() {
        return Ok(false);
    }
    let bdir = dir.join("backups");
    fs::create_dir_all(&bdir).map_err(|e| e.to_string())?;
    let today = chrono::Local::now().format("%Y%m%d").to_string();
    let target = bdir.join(format!("data-{today}.json"));
    if target.exists() {
        return Ok(false);
    }
    fs::copy(&file, &target).map_err(|e| e.to_string())?;
    prune_backups(&bdir);
    Ok(true)
}

fn prune_backups(bdir: &Path) {
    let mut names: Vec<String> = match fs::read_dir(bdir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.starts_with("data-") && n.ends_with(".json"))
            .collect(),
        Err(_) => return,
    };
    names.sort(); // 文件名含日期，字典序即时间序
    while names.len() > BACKUP_KEEP {
        let victim = names.remove(0);
        let _ = fs::remove_file(bdir.join(victim));
    }
}

#[tauri::command]
fn list_backups(state: State<DataDir>) -> Vec<BackupInfo> {
    let dir = state.0.lock().unwrap().clone();
    let bdir = dir.join("backups");
    let mut out: Vec<BackupInfo> = match fs::read_dir(&bdir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter(|e| {
                let n = e.file_name().to_string_lossy().to_string();
                n.ends_with(".json")
            })
            .map(|e| BackupInfo {
                name: e.file_name().to_string_lossy().to_string(),
                size: e.metadata().map(|m| m.len()).unwrap_or(0),
            })
            .collect(),
        Err(_) => vec![],
    };
    out.sort_by(|a, b| b.name.cmp(&a.name));
    out
}

#[tauri::command]
fn restore_backup(state: State<DataDir>, name: String) -> Result<(), String> {
    // 防路径穿越：只接受纯文件名
    if name.contains('/') || name.contains('\\') || name.contains("..") || !name.ends_with(".json") {
        return Err("非法备份名".into());
    }
    let dir = state.0.lock().unwrap().clone();
    let bdir = dir.join("backups");
    let src = bdir.join(&name);
    if !src.exists() {
        return Err("备份不存在".into());
    }
    let content = fs::read_to_string(&src).map_err(|e| e.to_string())?;
    if !valid_json(&content) {
        return Err("该备份已损坏，拒绝恢复".into());
    }
    let file = data_file(&dir);
    if file.exists() {
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
        let keep = bdir.join(format!("pre-restore-{stamp}.json"));
        fs::copy(&file, &keep).map_err(|e| e.to_string())?;
    }
    fs::copy(&src, &file).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- 冒烟自检 ----------

#[tauri::command]
fn is_smoke() -> bool {
    std::env::var("ACORN_SMOKE").is_ok()
}

#[tauri::command]
fn write_smoke_report(state: State<DataDir>, json: String) -> Result<(), String> {
    let dir = state.0.lock().unwrap().clone();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("smoke-report.json"), json).map_err(|e| e.to_string())
}

#[tauri::command]
fn exit_app(app: AppHandle) {
    app.exit(0);
}

// 导出/导入：路径来自系统保存/打开对话框（用户亲自选的），只做纯文本读写
#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

// ---------- 窗口与托盘 ----------

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn show_quickadd(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("quickadd") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = app.emit_to("quickadd", "quickadd:show", ());
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let dir = read_configured_dir(app.handle());
            app.manage(DataDir(Mutex::new(dir)));

            let show = MenuItem::with_id(app, "show", "打开橡果", true, None::<&str>)?;
            let quick = MenuItem::with_id(app, "quick", "随手记一条", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quick, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("橡果 Acorn")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "show" => show_main(app),
                    "quick" => show_quickadd(app),
                    "quit" => {
                        // 让前端先把没落盘的数据冲掉；1.5 秒兜底强退
                        let _ = app.emit_to("main", "app:quit", ());
                        let h = app.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(1500));
                            h.exit(0);
                        });
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = ev
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关主窗 = 收进托盘；真正退出走托盘菜单
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            // 快速添加窗失焦即隐藏（用完即走）
            if window.label() == "quickadd" {
                if let tauri::WindowEvent::Focused(false) = event {
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_data_dir,
            set_data_dir,
            data_status,
            load_data,
            save_data,
            ensure_daily_backup,
            list_backups,
            restore_backup,
            is_smoke,
            write_smoke_report,
            exit_app,
            write_text_file,
            read_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running acorn");
}
