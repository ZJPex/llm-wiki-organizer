#![allow(dead_code)]
use std::sync::{Arc, Mutex};

// 用记录器替代桌面事件总线，保留全部真实文件系统重扫行为。
mod tauri {
    use super::*;
    #[derive(Clone, Default)]
    pub struct AppHandle(pub Arc<Mutex<Vec<serde_json::Value>>>);
    pub trait Emitter {
        fn emit<S: serde::Serialize + Clone>(&self, event: &str, payload: S) -> Result<(), String>;
    }
    impl Emitter for AppHandle {
        fn emit<S: serde::Serialize + Clone>(&self, event: &str, payload: S) -> Result<(), String> {
            self.0.lock().unwrap().push(serde_json::json!({"event":event,"payload":payload}));
            Ok(())
        }
    }
    pub struct State<'a, T>(pub &'a T);
    impl<'a, T> std::ops::Deref for State<'a, T> {
        type Target = T;
        fn deref(&self) -> &T { self.0 }
    }
}
mod panic_guard {
    pub fn run_guarded<T, F: FnOnce() -> Result<T, String>>(_label: &str, f: F) -> Result<T, String> {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(f))
            .map_err(|_| "上游重扫发生 panic".to_string())?
    }
}
mod core;
fn main() {
    if let Err(error) = run() { eprintln!("{error}"); std::process::exit(1); }
}
fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 || args[1] != "--validation-copy" {
        return Err("用法：organizer-upstream-rescan --validation-copy <验证副本绝对路径> <隔离项目ID> [监控配置JSON]".into());
    }
    let root = std::path::Path::new(&args[2]);
    if !root.is_absolute() || !root.is_dir() { return Err("验证副本必须是已存在的绝对目录".into()); }
    let config = match args.get(4) {
        Some(json) => Some(serde_json::from_str::<core::SourceWatchConfig>(json).map_err(|e| e.to_string())?),
        None => None,
    };
    let app = tauri::AppHandle::default();
    let result = core::rescan_project_files(app.clone(), args[3].clone(), args[2].clone(), config)?;
    let events = app.0.lock().unwrap().clone();
    println!("{}", serde_json::json!({"upstreamCommit":"e8082119649e6a8e1cf85eaf289adcabfdf39d4e","result":result,"events":events}));
    Ok(())
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    #[test]
    fn real_upstream_rescan_detects_changes_and_keeps_unchanged_copy_quiet() {
        let root = std::env::temp_dir().join(format!("organizer-rescan-proof-{}-{}", std::process::id(), chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        std::fs::create_dir_all(root.join("raw/sources")).unwrap();
        let source = root.join("raw/sources/sample.md");
        std::fs::write(&source, "initial material").unwrap();
        let run = || {
            let app = tauri::AppHandle::default();
            let result = core::rescan_project_files(app.clone(), "isolated-proof".into(), root.to_str().unwrap().into(), None).unwrap();
            let events = app.0.lock().unwrap().clone();
            (serde_json::to_value(result).unwrap(), events)
        };
        let (first, _) = run();
        assert_eq!(first["changedTasks"].as_array().unwrap().len(), 1);
        assert_eq!(first["changedTasks"][0]["kind"], "created");
        let (quiet, events) = run();
        assert_eq!(quiet["changedTasks"].as_array().unwrap().len(), 0);
        assert!(events.iter().all(|e| e["event"] != "file-sync://changed"));
        // 等长内容更改必须由真实 MD5 检出，不能只比较大小。
        std::fs::write(&source, "changed material").unwrap();
        let (changed, _) = run();
        assert_eq!(changed["changedTasks"][0]["kind"], "modified");
        std::fs::rename(&source, root.join("raw/sources/renamed.md")).unwrap();
        let (moved, _) = run();
        assert_eq!(moved["changedTasks"].as_array().unwrap().len(), 2);
        // 测试仅删除刚刚创建的独立临时目录。
        std::fs::remove_dir_all(root).unwrap();
    }
}

