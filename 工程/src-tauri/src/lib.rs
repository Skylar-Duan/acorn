// Rust 侧职责：数据文件的安全读写（原子替换 + 崩溃恢复）、每日备份轮换、
// 托盘常驻、单实例。业务逻辑全部在前端，这里只做「不能丢数据」的底座。
//
// 安卓：托盘 / 单实例 / 全局快捷键 / 开机自启这些是桌面独有的，全部关在 #[cfg(desktop)] 里；
// 手机上只留数据读写与通知。窗口配置走 tauri.android.conf.json（手机只有一个窗口）。

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

const APP_ID: &str = "com.cdpandas.acorn";
const BACKUP_KEEP: usize = 30;

/// 橡果会写进 `backups/` 的文件名前缀，一共就这三种：
/// 每日轮换 `data-YYYYMMDD.json`、覆盖前 `pre-restore-*.json`、导入前 `pre-import-*.json`。
///
/// **「清空本机」按这一组删**（见 is_acorn_backup_name）：那个目录不归橡果独占，
/// 不能整个递归删掉。所以**再加一种备份就必须加进这里**，否则清空之后它会留在盘上。
const BACKUP_PREFIXES: [&str; 3] = ["data", "pre-restore", "pre-import"];

struct DataDir(Mutex<PathBuf>);

/// 安卓：App 自己那个 InstallPlugin.kt 的句柄，install_apk 命令靠它把 APK 交给系统安装器。
/// Err(原话) = 启动时没注册上（类没编进这个包）。**存下来而不是抛掉**：注册失败要是在 Builder 里
/// 一抛，整个 App 启动即崩、连界面都出不来；留着让 install_apk 把原因交给界面那行小字。
#[cfg(target_os = "android")]
struct InstallHandle<R: tauri::Runtime>(Result<tauri::plugin::PluginHandle<R>, String>);

/// 编译期钉住：InstallPlugin.kt 必须在盘上。gen/android/ 是可再生目录（不入库），文件不在时
/// 宁可这里编不过，也不能出一个「装得上、点安装才发现少组件」的包。
/// （只读一下、不用它：匿名 const 不进二进制，只让 rustc 检查文件存在。）
#[cfg(target_os = "android")]
const _: &[u8] = include_bytes!("../gen/android/app/src/main/java/com/cdpandas/acorn/InstallPlugin.kt");

// ---------- 配置（数据目录指针存在本机 AppData，数据本体在指针指向的地方） ----------

/// 默认数据目录：本机应用数据区 `%APPDATA%\com.cdpandas.acorn\userdata`。
/// 想让数据随移动硬盘 / 网盘走，去设置里换文件夹——指针写进 config.json，优先级高于此处。
#[cfg(not(target_os = "android"))]
fn default_data_dir() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        return PathBuf::from(appdata).join(APP_ID).join("userdata");
    }
    // 没有 APPDATA 的极端环境：退到可执行文件旁边，保证一定有个能写的地方
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("userdata")))
        .unwrap_or_else(|| PathBuf::from("userdata"))
}

/// 安卓的数据目录：应用私有目录，只有本应用能读写，卸载即清。
///
/// **不能走上面那套**：安卓没有 APPDATA 环境变量，`current_exe()` 拿到的是
/// `/system/bin/app_process64`，往它旁边写必然失败——App 一启动就是「数据打不开」。
/// `/data/data/<包名>/files` 是安卓的标准位置，现代安卓上它等价于 `/data/user/0/<包名>/files`；
/// 真实路径在 setup 里还会用 Tauri 的 app_data_dir() 再校准一次（多用户 / 工作资料场景）。
#[cfg(target_os = "android")]
fn default_data_dir() -> PathBuf {
    PathBuf::from(format!("/data/data/{APP_ID}/files/userdata"))
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("config.json"))
}

/// 读一份 JSON 配置。**必须容忍 BOM**——记事本、PowerShell 的 `-Encoding utf8`
/// 写出来的文件都带 BOM，serde 直接解析失败，指路条就这么「人间蒸发」过一次。
fn read_json_file(path: &Path) -> Option<serde_json::Value> {
    parse_json(&fs::read_to_string(path).ok()?)
}

fn parse_json(s: &str) -> Option<serde_json::Value> {
    serde_json::from_str(s.trim_start_matches('\u{feff}').trim()).ok()
}

/// 从配置内容里取 dataDir 指针（纯函数，好测）
fn parse_pointer(s: &str) -> Option<PathBuf> {
    let d = parse_json(s)?.get("dataDir")?.as_str()?.to_string();
    if d.trim().is_empty() { None } else { Some(PathBuf::from(d)) }
}

/// 从一份 config.json 里读出 dataDir 指针
fn read_pointer(config: &Path) -> Option<PathBuf> {
    parse_pointer(&fs::read_to_string(config).ok()?)
}

/// 不依赖 AppHandle 的配置读取：状态必须在任何窗口创建前就绪
/// （webview 的 JS 可能抢在 setup 钩子前发起 invoke，见 v1.0 竞态修复）。
/// 路径与 app_config_dir 一致：%APPDATA%\com.cdpandas.acorn\config.json
fn read_configured_dir_early() -> PathBuf {
    // 安卓没有「换数据文件夹」这回事（设置里已经藏掉了），也没有 APPDATA，直接用私有目录
    #[cfg(not(target_os = "android"))]
    if let Ok(appdata) = std::env::var("APPDATA") {
        if let Some(d) = read_pointer(&PathBuf::from(appdata).join(APP_ID).join("config.json")) {
            return d;
        }
    }
    default_data_dir()
}

// ---------- 找回数据：指针丢了也不能让用户以为数据没了 ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataCandidate {
    dir: String,
    /// 未删除的任务条数
    tasks: usize,
    lists: usize,
    /// 'YYYY-MM-DD HH:MM'
    modified: String,
}

/// 所有「数据可能待着」的地方。顺序不重要，前端按任务数与时间给用户挑。
/// 这里要尽量宽：指针文件可能被装机工具写进了某个应用沙箱的镜像目录（真实发生过），
/// 用户也可能自己把数据放在了移动硬盘上再换机器。
fn candidate_dirs(current: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = vec![current.to_path_buf(), default_data_dir()];

    if let Ok(appdata) = std::env::var("APPDATA") {
        let base = PathBuf::from(&appdata).join(APP_ID);
        out.push(base.join("userdata"));
        // 曾经用过的目录（每次换文件夹都会记一笔）
        if let Some(v) = read_json_file(&base.join("config.json")) {
            if let Some(arr) = v.get("recentDirs").and_then(|x| x.as_array()) {
                out.extend(arr.iter().filter_map(|x| x.as_str()).map(PathBuf::from));
            }
        }
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        out.push(PathBuf::from(&local).join(APP_ID).join("userdata"));
        // 沙箱化进程（MSIX 应用容器）写出来的镜像：指针和数据都可能只存在于这里
        if let Ok(rd) = fs::read_dir(PathBuf::from(&local).join("Packages")) {
            for e in rd.flatten().take(400) {
                let base = e.path().join("LocalCache").join("Roaming").join(APP_ID);
                if let Some(d) = read_pointer(&base.join("config.json")) {
                    out.push(d);
                }
                out.push(base.join("userdata"));
            }
        }
    }
    // 便携用法：数据放在 exe 旁边
    if let Ok(exe) = std::env::current_exe() {
        if let Some(p) = exe.parent() {
            out.push(p.join("userdata"));
        }
    }
    out
}

/// 扫一遍候选目录，返回「确实有内容」的那些（当前目录也在内，前端好做对比）
#[tauri::command]
fn find_data_candidates(state: State<DataDir>) -> Vec<DataCandidate> {
    let current = state.0.lock().unwrap().clone();
    let mut seen: Vec<PathBuf> = vec![];
    let mut out: Vec<DataCandidate> = vec![];

    for dir in candidate_dirs(&current) {
        let canon = dir.canonicalize().unwrap_or_else(|_| dir.clone());
        if seen.contains(&canon) {
            continue;
        }
        seen.push(canon);

        let file = data_file(&dir);
        let Ok(s) = fs::read_to_string(&file) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) else { continue };
        let tasks = v
            .get("tasks")
            .and_then(|x| x.as_array())
            .map(|a| a.iter().filter(|t| t.get("deletedAt").map_or(true, |d| d.is_null())).count())
            .unwrap_or(0);
        if tasks == 0 {
            continue; // 空库不值得推荐
        }
        let lists = v.get("lists").and_then(|x| x.as_array()).map(|a| a.len()).unwrap_or(0);
        let modified = fs::metadata(&file)
            .and_then(|m| m.modified())
            .map(|t| {
                let dt: chrono::DateTime<chrono::Local> = t.into();
                dt.format("%Y-%m-%d %H:%M").to_string()
            })
            .unwrap_or_default();
        out.push(DataCandidate { dir: dir.to_string_lossy().to_string(), tasks, lists, modified });
    }
    out.sort_by(|a, b| b.tasks.cmp(&a.tasks));
    out
}

/// 写指针，并把用过的目录记进 recentDirs（最多 8 条）——指针万一丢了还能靠它找回来
fn persist_configured_dir(app: &AppHandle, dir: &Path) -> Result<(), String> {
    let p = config_path(app).ok_or("no config dir")?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let here = dir.to_string_lossy().to_string();
    let mut recent: Vec<String> = read_json_file(&p)
        .and_then(|v| {
            v.get("recentDirs")
                .and_then(|x| x.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        })
        .unwrap_or_default();
    recent.retain(|d| d != &here);
    recent.insert(0, here.clone());
    recent.truncate(8);

    let json = serde_json::json!({ "dataDir": here, "recentDirs": recent });
    fs::write(&p, json.to_string()).map_err(|e| e.to_string())?;
    write_datadir_hint(app, dir);
    Ok(())
}

/// 给 NSIS 卸载钩子留的纯文本数据目录路径（`%APPDATA%\com.cdpandas.acorn\datadir.txt`）。
///
/// 为什么不让钩子直接读 config.json：**NSIS 没有 JSON 解析器**。
/// 用户把数据文件夹换到别的盘之后，卸载时那份数据就在模板自带的
/// `$APPDATA\${BUNDLEID}` / `$LOCALAPPDATA\${BUNDLEID}` 之外，钩子得知道它在哪。
/// 不写换行——钩子那边 FileRead 一次读到底，少一道去尾的功夫。
fn write_datadir_hint(app: &AppHandle, dir: &Path) {
    let Some(p) = config_path(app) else { return };
    let Some(parent) = p.parent() else { return };
    let _ = fs::create_dir_all(parent);
    let _ = fs::write(parent.join("datadir.txt"), dir.to_string_lossy().as_bytes());
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

/// 把当前数据另存一份带前缀的备份，返回文件名。
/// 覆盖类操作（从云端覆盖本机 / 导入）动手之前先留条退路。
///
/// **「没什么可备份的」不是错误**：本机还没有 data.json（刚清空过、换新机器、
/// 或者登录后那一轮同步没成）时返回 Ok(None)。调用方要拿它跟「写失败」分开——
/// 没有旧数据就没有退路可言，把这种情况报成写盘失败，会把「从云端拿回来」
/// 这条唯一的恢复路径堵死，而且报的原因还是错的（用户的盘既没满也没只读）。
#[tauri::command]
fn snapshot_backup(state: State<DataDir>, prefix: String) -> Result<Option<String>, String> {
    // 前缀要拼进文件名：只收登记过的那几个。既挡住路径穿越，也保证
    // 「清空本机」那边按 BACKUP_PREFIXES 删的时候一定删得掉
    if !BACKUP_PREFIXES.contains(&prefix.as_str()) {
        return Err("未登记的备份前缀".into());
    }
    let dir = state.0.lock().unwrap().clone();
    let file = data_file(&dir);
    if !file.exists() {
        return Ok(None);
    }
    let bdir = dir.join("backups");
    fs::create_dir_all(&bdir).map_err(|e| e.to_string())?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let name = format!("{prefix}-{stamp}.json");
    fs::copy(&file, bdir.join(&name)).map_err(|e| e.to_string())?;
    Ok(Some(name))
}

// ---------- 清空本机（登出时的隐私路径） ----------

/// 把这台设备上的橡果数据删干净。**调用方必须先确认本地那份已经在云端**，
/// 这里只负责删得彻底。
///
/// 唯一的自保闸门：没有 auth.json（这台设备从没登过账号）就直接拒绝。
/// 不能让「我只是想清个缓存」的调用，把从来没上过云的数据删掉——那是删了就没了。
///
/// **清的范围必须跟「找回数据」扫的范围一样宽**：candidate_dirs() 除了当前目录和
/// recentDirs，还无条件扫默认位置、%APPDATA% / %LOCALAPPDATA% 下的 userdata、
/// exe 旁边、沙箱镜像。只清当前目录的话，换过数据文件夹的用户在默认位置还躺着一整份
/// 旧账本（set_data_dir 是复制过去、旧的原样留着当兜底），清完 reload 立刻被
/// 「找到了以前的数据」原样端回来——白清一场，而且这本来是条隐私功能。
///
/// 范围宽就得有护栏，两道都在 purge_targets 与 purge_data_files 里：
/// 只碰真有 data.json 的目录、只按文件名删橡果自己写出来的东西。
/// 返回真正清过的目录，前端拿它跟确认框里列过的名单对得上。
#[tauri::command]
fn purge_local_data(app: AppHandle, state: State<DataDir>) -> Result<Vec<String>, String> {
    let auth = auth_path(&app).ok_or("找不到配置目录")?;
    if !auth.exists() {
        return Err("这台设备没有登录过云账号，不清空本地数据".into());
    }
    let dir = state.0.lock().unwrap().clone();

    // recentDirs 待会儿要被清掉，所以候选目录必须**在那之前**取一次，否则扫不全
    let mut cleaned: Vec<String> = vec![];
    for d in purge_targets(&dir) {
        purge_data_files(&d);
        cleaned.push(d.to_string_lossy().to_string());
    }

    // 登录令牌（连写一半留下的临时文件一起）
    let _ = fs::remove_file(&auth);
    let _ = fs::remove_file(auth.with_extension("json.tmp"));

    // recentDirs 必须一起清。不清的话下次启动 initStore 发现任务为 0，
    // 会扫 recentDirs 把刚删掉的目录当「找回来的数据」推荐回来——白删一场还吓人一跳。
    // freshStart 是给下一次启动的一次性标记：别再建那本带「工作」「生活」的默认账本，
    // 否则用户一登录就把两条新 id 的清单推上云，别的设备上各多出一对，得手工删。
    // 标记只能放这儿，不能放 localStorage——清空的最后一步 clearLocalPrefs 会扫掉它
    if let Some(p) = config_path(&app) {
        let json = serde_json::json!({
            "dataDir": dir.to_string_lossy().to_string(),
            "recentDirs": Vec::<String>::new(),
            "freshStart": true,
        });
        let _ = fs::write(&p, json.to_string());
    }
    Ok(cleaned)
}

/// 这一次「清空本机」会动到哪些目录。**清和确认框用的必须是同一份名单**——
/// 用户得在按下确定之前，看得见 `D:\我的文档` 这种自己的通用文件夹也在里面。
///
/// 当前数据目录一定在内：那就是橡果正用着的那份。其余候选目录**只挑真有 data.json 的**——
/// candidate_dirs 为了「找回数据」故意扫得很宽（recentDirs 里 8 个用户自选文件夹、
/// 沙箱镜像里指针指向的任意路径），里面绝大多数根本没有橡果的东西，
/// 少了这道护栏，「清空本机」就成了「对一堆用户自己的文件夹逐个动手」。
fn purge_targets(current: &Path) -> Vec<PathBuf> {
    let mut seen: Vec<PathBuf> = vec![];
    let mut out: Vec<PathBuf> = vec![];
    for d in candidate_dirs(current) {
        let canon = d.canonicalize().unwrap_or_else(|_| d.clone());
        if seen.contains(&canon) {
            continue;
        }
        seen.push(canon);
        if d == current || data_file(&d).exists() {
            out.push(d);
        }
    }
    out
}

/// 确认框要逐条列出的路径。前端在弹确认之前调一次，让用户先看见名单再决定。
#[tauri::command]
fn list_purge_targets(state: State<DataDir>) -> Vec<String> {
    let dir = state.0.lock().unwrap().clone();
    purge_targets(&dir).iter().map(|p| p.to_string_lossy().to_string()).collect()
}

/// 这个文件名是不是橡果自己写进 backups/ 的（见 BACKUP_PREFIXES）。
/// 清空本机时按它逐个删文件，**不递归删目录**。
fn is_acorn_backup_name(name: &str) -> bool {
    name.ends_with(".json") && BACKUP_PREFIXES.iter().any(|p| name.starts_with(&format!("{p}-")))
}

/// 删掉某个目录里「橡果自己写出来的」那些文件。
///
/// **只按文件名删，绝不 RMDir 目录本身**：数据文件夹是用户拿系统文件夹选择器随便挑的
/// 一个已有目录（set_data_dir 不追加子目录），橡果并不独占它——递归删下去会把用户
/// 放在同一个文件夹里的其它东西一起删光。
fn purge_data_files(dir: &Path) {
    // 数据本体与原子写留下的中间态
    let _ = fs::remove_file(data_file(dir));
    let _ = fs::remove_file(dir.join("data.json.tmp"));
    let _ = fs::remove_file(dir.join("data.json.old"));
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            if e.file_name().to_string_lossy().starts_with("data.json.corrupt-") {
                let _ = fs::remove_file(e.path());
            }
        }
    }
    // 每日备份 30 份 + pre-restore / pre-import：只在本地，云端一份都没有。
    // **同样只按文件名删**：数据文件夹是用户随便挑的一个已有目录，backups 是个
    // 再常见不过的目录名，remove_dir_all 下去会把用户自己放在里面的东西一起删光
    let bdir = dir.join("backups");
    if let Ok(rd) = fs::read_dir(&bdir) {
        for e in rd.flatten() {
            if is_acorn_backup_name(&e.file_name().to_string_lossy()) {
                let _ = fs::remove_file(e.path());
            }
        }
    }
    let _ = fs::remove_dir(&bdir); // 不带 _all：还剩别人的文件就删不掉，正好该留着
    let _ = fs::remove_file(dir.join("smoke-report.json"));
    let _ = fs::remove_file(dir.join(".acorn-probe"));
}

/// 清空之后那一次启动的一次性标记：读到就地清掉，返回 true。
///
/// 前端据此用一本空账本开局（lists / tasks 全空）并跳过落盘，等用户重新登录后
/// 由云端那份填回来。放在 Rust 侧的 config.json 而不是 localStorage——
/// 清空的最后一步 clearLocalPrefs() 会把 `acorn-` 开头的 key 全扫掉。
#[tauri::command]
fn take_fresh_start(app: AppHandle) -> bool {
    let Some(p) = config_path(&app) else { return false };
    let Some(mut v) = read_json_file(&p) else { return false };
    if v.get("freshStart").and_then(|x| x.as_bool()) != Some(true) {
        return false;
    }
    if let Some(m) = v.as_object_mut() {
        m.remove("freshStart");
    }
    let _ = fs::write(&p, v.to_string());
    true
}

// ---------- 云账号凭据 ----------
//
// 登录令牌**不能**放进 data.json：那份是要整份传上云、也会被导出成文件给人看的。
// 单独放 auth.json，跟 config.json 一样待在本机配置目录，永远不参与同步、不参与导出。

fn auth_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("auth.json"))
}

#[tauri::command]
fn load_auth(app: AppHandle) -> Option<String> {
    let p = auth_path(&app)?;
    fs::read_to_string(p).ok()
}

#[tauri::command]
fn save_auth(app: AppHandle, json: Option<String>) -> Result<(), String> {
    let p = auth_path(&app).ok_or("找不到配置目录")?;
    match json {
        // 退出登录：把文件删掉，不留半份
        None => {
            if p.exists() {
                fs::remove_file(&p).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        Some(text) => {
            if let Some(dir) = p.parent() {
                fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            // 先写临时文件再改名：写一半断电也不会留下半个坏令牌
            let tmp = p.with_extension("json.tmp");
            fs::write(&tmp, text.as_bytes()).map_err(|e| e.to_string())?;
            fs::rename(&tmp, &p).map_err(|e| e.to_string())
        }
    }
}

// ---------- 下载的安装包 ----------

/// 把下下来的安装包写进应用缓存目录，返回落地路径。
///
/// 为什么是**缓存**目录而不是数据目录：Tauri 生成的安卓工程里已经声明了 FileProvider，
/// 它的 file_paths.xml 覆盖 cache-path，所以放这儿才能把 content:// 交给系统安装器；
/// 而且装完这个文件就没用了，本来就该待在能被系统随时回收的地方。
fn write_to_cache(app: &AppHandle, name: &str, bytes: &[u8]) -> Result<String, String> {
    // 只收纯文件名，不许带路径分隔符——否则可以写到目录外面去
    if name.is_empty() || name.contains(['/', '\\', ':']) || name.contains("..") {
        return Err("文件名不合法".into());
    }
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(name);
    // 先写临时文件再改名：下到一半断电，不会留下一个「看起来完整」的坏包
    let tmp = path.with_extension("part");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// 安卓走这条：字节按 JSON 数字数组传过来。
///
/// 安卓的 webview 读不了自定义协议的请求体（Tauri 自己在 ipc-protocol.js 里就是这么判的），
/// 所以手机上只能走 JSON 这条。APK 33MB 实测能过。
#[tauri::command]
fn save_download(app: AppHandle, name: String, bytes: Vec<u8>) -> Result<String, String> {
    write_to_cache(&app, &name, &bytes)
}

/// 桌面走这条：字节走原始 IPC（application/octet-stream），文件名放在请求头里。
///
/// 为什么另开一条：桌面安装包接近 30MB，按 JSON 数字数组序列化会膨胀成 80-100MB 的字符串，
/// WebView2 上光是拼这个串就能把内存顶爆。原始 IPC 是等长传输，不做任何编码。
/// 这条路在安卓上不可用（见 save_download 的说明），所以两条都得留着。
#[tauri::command]
fn save_download_raw(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let name = request
        .headers()
        .get("acorn-file-name")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => write_to_cache(&app, name, bytes),
        _ => Err("这条命令只收原始字节".into()),
    }
}

/// 拉起下好的安装器，**必须带 `/UPDATE`**。
///
/// 为什么不能用 opener 插件的 openPath：它只是让系统「打开」这个文件，递不进命令行参数，
/// 于是新安装器的 `$UpdateMode = 0`，会照常去调旧版的 uninstaller；
/// 卸载钩子（nsis-hooks.nsh）那一段就跑了，auth.json 被删——
/// **每一次 App 内升级都把用户静默登出，云同步从此停摆**。
///
/// 带上 /UPDATE 之后，安装器在 PageLeaveReinstall 里直接走「不卸载、原地覆盖」那一支，
/// 旧 uninstaller 压根不会启动，钩子一次都不执行。装完还登录着，同步照常。
///
/// 不加 `#[cfg(desktop)]`：invoke_handler 那张表是两端共用的一张。手机上装 APK 走的是
/// 下面的 install_apk（App 自己的安卓插件），这条命令在安卓上永远不会被调到。
#[tauri::command]
fn run_installer(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err("安装包不见了，请重新下载".into());
    }
    std::process::Command::new(&p)
        .arg("/UPDATE")
        .spawn()
        .map_err(|e| format!("无法启动安装程序：{e}"))?;
    Ok(())
}

/// 安卓：把下好的 APK 交给系统安装器（App 自己的安卓插件 InstallPlugin.kt）。
///
/// 为什么不能用 opener 插件的 openPath：它的安卓实现只有一个 `open(url)`，拿到缓存目录里的
/// 裸文件路径就直接 `Intent(ACTION_VIEW, path.toUri())`——既没有 content:// 也没有 mime，
/// 系统找不到能开它的 Activity，每一台手机都失败（v1.12.0 之前 App 内安装从来没成功过，就是这个原因）。
/// InstallPlugin 走 FileProvider 出 content:// URI、带上 APK 的 mime 再拉起安装界面；
/// 系统还没允许橡果装应用时，先把用户送到那个开关，回 `{ "launched": false, "reason": "permission" }`。
///
/// 递过去的包不在缓存里了（复用上次下好的包、但系统清过缓存）回 `{ "launched": false, "reason": "missing" }`，
/// 前端据此当场重新下载，不算失败。
///
/// 回话原样透给前端：`{ "launched": true }` 或上面那两个。插件里任何异常都以 Err(字符串) 回来，
/// 启动时插件压根没注册上（类没编进包）也是 Err(字符串)、原话里带注册失败的原因——
/// 前端把它画成小字，用户能把真实原因原样念给我们，不用再猜是哪台手机的问题。
///
/// 不加 `#[cfg(target_os = "android")]`：invoke_handler 那张表两端共用。桌面上前端不会调它，真调到只报错。
/// 写成 async：run_mobile_plugin 要阻塞等安卓那边回话，别占着主线程。
#[tauri::command]
async fn install_apk(app: AppHandle, path: String) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        let h = app.state::<InstallHandle<tauri::Wry>>();
        return match &h.0 {
            Ok(plugin) => plugin
                .run_mobile_plugin::<serde_json::Value>("install", serde_json::json!({ "path": path }))
                .map_err(|e| e.to_string()),
            // 启动时就没注册上：这个包里没带安装组件。说清楚让人改用浏览器下载，别让他在这儿猜
            Err(why) => Err(format!("这个安装包里没带安卓的安装组件，装不了（{why}）")),
        };
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, path);
        Err("只有安卓才走这条".into())
    }
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

#[cfg(desktop)]
fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg(desktop)]
fn show_quickadd(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("quickadd") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = app.emit_to("quickadd", "quickadd:show", ());
    }
}

/// 托盘常驻：关窗收进托盘、右键菜单三件事。桌面独有。
#[cfg(desktop)]
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
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
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        // 状态注册必须在 Builder 层：配置里声明的窗口先于 setup 钩子加载 JS，
        // 首个 invoke 到达时 setup 可能还没跑完
        .manage(DataDir(Mutex::new(read_configured_dir_early())))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        // 「用系统方式打开」。现在只有「改用浏览器下载」在用它开链接；
        // 安卓装 APK **不走它**（见 install_apk：它的安卓实现递不出 content:// URI）
        .plugin(tauri_plugin_opener::init());

    // 单实例 / 全局快捷键 / 开机自启：手机上没有这些概念，装了也起不来
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));

    // 安卓：把 APK 交给系统安装器的那个 Kotlin 插件（gen/android/.../com/cdpandas/acorn/InstallPlugin.kt），
    // 前端走 install_apk 命令。类是按「包名 + 类名」反射加载的，文件位置和类名一字都不能差。
    //
    // 注册失败**不许用 ? 抛**：Builder 里任何一个插件 setup 报错，整个 App 启动即崩、连界面都出不来
    // （类没编进包时就是 ClassNotFoundException——gen/ 是可再生目录，.kt 没跟着回来就会这样）。
    // 把原话存进句柄，让 install_apk 在人点「下载并安装」时把它交给界面那行小字。
    #[cfg(target_os = "android")]
    let builder = builder.plugin(
        tauri::plugin::Builder::<tauri::Wry>::new("acorn-install")
            .setup(|app, api| {
                let h = api
                    .register_android_plugin("com.cdpandas.acorn", "InstallPlugin")
                    .map_err(|e| e.to_string());
                app.manage(InstallHandle(h));
                Ok(())
            })
            .build(),
    );

    builder
        .setup(|_app| {
            // 托盘只在桌面建
            #[cfg(desktop)]
            setup_tray(_app.handle())?;
            // 每次启动刷一遍给卸载钩子看的数据目录路径。
            // 只写文件、不碰窗口 API（在 setup 里调窗口 API 会卡死事件循环）
            #[cfg(desktop)]
            {
                let state: State<DataDir> = _app.state();
                let dir = state.0.lock().unwrap().clone();
                write_datadir_hint(_app.handle(), &dir);
            }
            // 安卓：拿 Tauri 算出来的真实私有目录校准一次。
            // 上面用的是标准路径 /data/data/<包名>/files，绝大多数机器就是它；
            // 多用户 / 工作资料的机器上真实路径是 /data/user/<N>/<包名>/files，这里纠正过来
            #[cfg(target_os = "android")]
            if let Ok(dir) = _app.path().app_data_dir() {
                let real = dir.join("userdata");
                let state: State<DataDir> = _app.state();
                let mut cur = state.0.lock().unwrap();
                if *cur != real {
                    *cur = real;
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // 手机上没有托盘也没有第二个窗口，这段整体跳过
            #[cfg(mobile)]
            {
                let _ = (window, event);
                return;
            }
            #[cfg(desktop)]
            {
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
            // 说明窗有标题栏，点 × 只隐藏不销毁——真销毁了 getByLabel 就返回 null，
            // 再点「打开用法」不会有任何反应
            if window.label() == "guide" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_data_dir,
            set_data_dir,
            find_data_candidates,
            data_status,
            load_data,
            save_data,
            ensure_daily_backup,
            list_backups,
            restore_backup,
            snapshot_backup,
            purge_local_data,
            list_purge_targets,
            take_fresh_start,
            load_auth,
            save_auth,
            save_download,
            save_download_raw,
            run_installer,
            install_apk,
            is_smoke,
            write_smoke_report,
            exit_app,
            write_text_file,
            read_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running acorn");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pointer_tolerates_bom_and_junk() {
        let want = PathBuf::from("D:/acorn/userdata");
        let plain = r#"{"dataDir":"D:/acorn/userdata"}"#;
        assert_eq!(parse_pointer(plain), Some(want.clone()));
        // 记事本 / PowerShell -Encoding utf8 写出来的带 BOM 版本，必须照样能读
        assert_eq!(parse_pointer(&format!("\u{feff}{plain}")), Some(want.clone()));
        assert_eq!(parse_pointer(&format!("  \n{plain}\n ")), Some(want));
        assert_eq!(parse_pointer(r#"{"dataDir":""}"#), None);
        assert_eq!(parse_pointer(r#"{"other":1}"#), None);
        assert_eq!(parse_pointer("不是 JSON"), None);
    }

    /// 清空本机时 backups/ 是**按文件名逐个删**的（那个目录不归橡果独占，不能递归删）。
    /// 所以「实际写出去的每一种名字」都必须落在 BACKUP_PREFIXES 里，
    /// 否则清完还留在盘上——这条隐私功能就白做了。加一种新备份时这里会先红。
    #[test]
    fn backup_names_are_all_purgeable() {
        let day = chrono::Local::now().format("%Y%m%d").to_string();
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        // ensure_daily_backup 写的每日轮换
        assert!(is_acorn_backup_name(&format!("data-{day}.json")));
        // restore_backup 恢复前留的那一份
        assert!(is_acorn_backup_name(&format!("pre-restore-{stamp}.json")));
        // snapshot_backup 写的：前缀由前端传，而它只收 BACKUP_PREFIXES 里登记过的
        for prefix in BACKUP_PREFIXES {
            assert!(is_acorn_backup_name(&format!("{prefix}-{stamp}.json")), "{prefix}");
        }
        // 别人放在同一个 backups 目录里的东西一个都不许碰
        assert!(!is_acorn_backup_name("我的照片.json"));
        assert!(!is_acorn_backup_name("data-2026.txt"));
        assert!(!is_acorn_backup_name("backup.json"));
    }

    #[test]
    fn default_dir_has_no_hardcoded_author_path() {
        let d = default_data_dir().to_string_lossy().to_string();
        assert!(d.ends_with("userdata"), "{d}");
        assert!(!d.contains("02-Gadgets"), "默认路径泄露了作者目录：{d}");
    }
}
