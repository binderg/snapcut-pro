// Desktop shell for the ve editor. The UI talks to the engine over the
// daemon's WebSocket; this side only finds (or starts) that daemon by
// running the `ve` CLI, and creates new project folders.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::Command;

const EXE: &str = if cfg!(windows) { "ve.exe" } else { "ve" };

/// The `ve` to run: the path the user set, else `VE_BIN`, else `ve` on PATH,
/// else a local build in `%LOCALAPPDATA%\ve-target` (where this repo builds).
fn find_ve(bin: &str) -> Result<PathBuf, String> {
    let bin = bin.trim();
    if !bin.is_empty() {
        let p = PathBuf::from(bin);
        return if p.is_file() { Ok(p) } else { Err(format!("no ve binary at {bin}")) };
    }
    if let Some(p) = std::env::var_os("VE_BIN").map(PathBuf::from).filter(|p| p.is_file()) {
        return Ok(p);
    }
    let on_path = std::env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
        .map(|dir| dir.join(EXE))
        .find(|p| p.is_file());
    if let Some(p) = on_path {
        return Ok(p);
    }
    let mut tried = vec![];
    for base in [std::env::var_os("CARGO_TARGET_DIR").map(PathBuf::from), std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("ve-target"))].into_iter().flatten() {
        for profile in ["release", "debug"] {
            let p = base.join(profile).join(EXE);
            if p.is_file() {
                return Ok(p);
            }
            tried.push(p.display().to_string());
        }
    }
    Err(format!(
        "could not find the ve engine. Put ve on PATH, set VE_BIN, or set its path under \"Engine binary\". Looked on PATH and in:\n{}",
        tried.join("\n")
    ))
}

fn ve(bin: &str) -> Result<Command, String> {
    let mut cmd = Command::new(find_ve(bin)?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(cmd)
}

fn run(mut cmd: Command) -> Result<String, String> {
    let out = cmd.output().map_err(|e| format!("could not run ve: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { format!("ve exited with {}", out.status) } else { err })
    }
}

/// Effect packs the editor ships (bundled resources), installed for the user
/// on start so the engine's `fx.list` has them.
const PACKS: &[&str] = &["gl-transitions"];

/// Where a bundled pack is: the app's resources, or in a dev build the
/// engine repository this editor sits in.
fn bundled_pack(app: &tauri::AppHandle, id: &str) -> Option<PathBuf> {
    use tauri::Manager;
    let res = app.path().resource_dir().ok().map(|d| d.join("plugins").join(id));
    let dev = cfg!(debug_assertions).then(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../plugins").join(id));
    [res, dev].into_iter().flatten().find(|p| p.join("plugin.json").is_file())
}

fn pack_version(dir: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("plugin.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v["version"].as_str().map(str::to_owned)
}

/// Install each bundled pack with `ve plugin install` unless the user's
/// plugin folder already has that version. Asks `ve` (not a path of our own)
/// where plugins live, so the editor and engine always agree.
fn ensure_packs(app: &tauri::AppHandle, ve_bin: &str) -> Result<(), String> {
    let mut list = ve(ve_bin)?;
    // Outside any project, so only user plugins are listed.
    list.current_dir(std::env::temp_dir()).args(["--json", "plugin", "list"]);
    let installed: serde_json::Value = serde_json::from_str(&run(list)?).map_err(|e| format!("unexpected ve output: {e}"))?;
    for id in PACKS {
        let Some(dir) = bundled_pack(app, id) else { continue };
        let have = installed["plugins"]
            .as_array()
            .and_then(|ps| ps.iter().find(|p| p["id"] == *id && p["source"] == "user"))
            .and_then(|p| p["version"].as_str());
        if have.is_some() && have == pack_version(&dir).as_deref() {
            continue;
        }
        let mut install = ve(ve_bin)?;
        install.args(["--json", "plugin", "install"]).arg(&dir);
        run(install)?;
    }
    Ok(())
}

/// Start the project's daemon if needed and return its WebSocket URL.
#[tauri::command]
async fn daemon_url(app: tauri::AppHandle, ve_bin: String, project: String) -> Result<String, String> {
    static PACKS_DONE: std::sync::Once = std::sync::Once::new();
    PACKS_DONE.call_once(|| {
        if let Err(e) = ensure_packs(&app, &ve_bin) {
            eprintln!("could not install the bundled effect packs: {e}");
        }
    });
    let mut cmd = ve(&ve_bin)?;
    cmd.args(["--json", "--project", &project, "daemon", "start"]);
    let text = run(cmd)?;
    let info: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("unexpected ve output: {e}"))?;
    info["websocket"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "ve did not report a WebSocket URL".into())
}

/// `ve init <path> --fps <fps> --size <WxH>`.
#[tauri::command]
async fn init_project(ve_bin: String, path: String, fps: String, size: String) -> Result<String, String> {
    let mut cmd = ve(&ve_bin)?;
    cmd.args(["init", &path, "--fps", &fps, "--size", &size]);
    run(cmd)
}

/// Let the webview load one imported media file (for previewing a source
/// clip). Only that exact file is allowed, never a folder.
#[tauri::command]
fn allow_media(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri::Manager;
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("no file at {path}"));
    }
    app.asset_protocol_scope().allow_file(&p).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![daemon_url, init_project, allow_media])
        .run(tauri::generate_context!())
        .expect("error while running the ve editor");
}
