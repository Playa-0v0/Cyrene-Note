//! WatcherService —— 外部修改检测。
//!
//! 事件 ≠ 修改（契约 §4.2）：notify 事件只是提示，hash 才是最终事实。
//! 流水线（全部在 Rust 侧完成，不跨 IPC 抖动）：
//!
//! notify events → 按 path 合并（200ms 窗口）→ 读盘算 hash
//!   → hash == known hash？ → 丢弃（伪事件 / 自保存回声）
//!   → hash != known → snapshot 新版本（external-change）→ 回调通知上层
//!
//! known hash 表由调用方（VaultService）在每次自己读写后更新。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use notify::Watcher as _; // .watch() 在 trait 上
use vault_core::path::{is_internal_dir_name, is_temp_file_name};
use vault_core::{ContentHash, HistorySource};

use crate::history::HistoryStore;

const COALESCE_WINDOW: Duration = Duration::from_millis(200);

/// watcher 检测到的真实外部变更（hash 已裁决，非伪事件）。
#[derive(Debug, Clone)]
pub struct ExternalChange {
    /// Vault 相对路径（`/` 分隔）
    pub path: String,
    pub disk_hash: String,
    /// 归一化后的内容；None = 文件被外部删除（或读取失败）
    pub content: Option<String>,
}

enum WatcherMsg {
    Event(PathBuf),
    Stop,
}

pub struct WatcherService {
    tx: mpsc::Sender<WatcherMsg>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl WatcherService {
    /// 启动 watcher。`on_change` 在裁决出真实外部变更时回调
    /// （在 watcher 线程上执行，不要在里面做重活）。
    pub fn start<F>(
        vault_root: PathBuf,
        known: std::sync::Arc<KnownVersions>,
        history: std::sync::Arc<HistoryStore>,
        on_change: F,
    ) -> std::io::Result<Self>
    where
        F: Fn(ExternalChange) + Send + 'static,
    {
        let (tx, rx) = mpsc::channel::<WatcherMsg>();

        // notify 回调只做一件事：把路径丢进合并线程的队列
        let event_tx = tx.clone();
        let mut watcher = notify::recommended_watcher(
            move |res: Result<notify::Event, notify::Error>| {
                if let Ok(ev) = res {
                    for p in ev.paths {
                        let _ = event_tx.send(WatcherMsg::Event(p));
                    }
                }
            },
        )
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;

        watcher
            .watch(&vault_root, notify::RecursiveMode::Recursive)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;

        let root = vault_root.clone();
        let handle = std::thread::spawn(move || {
            let _watcher = watcher; // 移进来保活：线程结束时自动 unwatch
            let mut pending: HashMap<PathBuf, Instant> = HashMap::new();

            loop {
                // 等待：有 pending 就等到最早到期，否则整窗等待
                let timeout = pending
                    .values()
                    .map(|t| t.saturating_duration_since(Instant::now()))
                    .min()
                    .unwrap_or(COALESCE_WINDOW);

                match rx.recv_timeout(timeout) {
                    Ok(WatcherMsg::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Ok(WatcherMsg::Event(p)) => {
                        if !should_ignore(&root, &p) {
                            pending.insert(p, Instant::now() + COALESCE_WINDOW);
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }

                // 到期事件 → 裁决
                let due: Vec<PathBuf> = pending
                    .iter()
                    .filter(|(_, deadline)| **deadline <= Instant::now())
                    .map(|(p, _)| p.clone())
                    .collect();
                for p in due {
                    pending.remove(&p);
                    if let Some(change) = adjudicate(&root, &known, &history, &p) {
                        on_change(change);
                    }
                }
            }
        });

        Ok(Self { tx, handle: Some(handle) })
    }

    pub fn stop(&mut self) {
        let _ = self.tx.send(WatcherMsg::Stop);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

impl Drop for WatcherService {
    fn drop(&mut self) {
        self.stop();
    }
}

/// 已知版本表：path → 最后一次见到的磁盘 hash。
/// VaultService 在 open/read/save/create 时写入，watcher 只读。
#[derive(Default)]
pub struct KnownVersions(std::sync::Mutex<HashMap<String, String>>);

impl KnownVersions {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn set(&self, path: &str, hash: &str) {
        self.0
            .lock()
            .unwrap()
            .insert(path.to_string(), hash.to_string());
    }
    pub fn get(&self, path: &str) -> Option<String> {
        self.0.lock().unwrap().get(path).cloned()
    }
}

fn should_ignore(root: &Path, p: &Path) -> bool {
    // 只关心 vault 内的笔记文件；内部目录与临时文件一律忽略
    let Ok(rel) = p.strip_prefix(root) else {
        return true;
    };
    for seg in rel.components() {
        let name = seg.as_os_str().to_string_lossy();
        if is_internal_dir_name(&name) || is_temp_file_name(&name) {
            return true;
        }
    }
    vault_core::path::NotePath::from_absolute(root, p).is_none()
}

fn adjudicate(
    root: &Path,
    known: &KnownVersions,
    history: &HistoryStore,
    p: &Path,
) -> Option<ExternalChange> {
    let note_path = vault_core::path::NotePath::from_absolute(root, p)?;
    let rel = note_path.as_str().to_string();

    match std::fs::read(p) {
        Ok(bytes) => {
            let disk_hash = ContentHash::from_bytes(&bytes).as_str().to_string();
            if known.get(&rel).as_deref() == Some(disk_hash.as_str()) {
                return None; // 伪事件：自保存回声 / 内容未变
            }
            // 真实外部变更：先 snapshot（external-change）再上报
            let _ = history.snapshot(&rel, &bytes, HistorySource::ExternalChange);
            known.set(&rel, &disk_hash);
            let content =
                vault_core::normalize::load(&bytes, &rel).ok().map(|l| l.content);
            Some(ExternalChange { path: rel, disk_hash, content })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // 文件被外部删除：known 标记删除，上报 None 内容
            if known.get(&rel).is_some() {
                return Some(ExternalChange {
                    path: rel,
                    disk_hash: String::new(),
                    content: None,
                });
            }
            None
        }
        Err(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 端到端：外部写入（模拟 Cyrene 的 tmp+rename）→ watcher 应上报一次、
    /// 且自保存回声（known == disk）不上报。
    #[test]
    fn external_change_detected_and_echo_suppressed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let note = root.join("notes/a.md");
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(&note, "v1\n").unwrap();

        let history = std::sync::Arc::new(HistoryStore::open(&root).unwrap());
        let known = KnownVersions::new();
        known.set("notes/a.md", ContentHash::from_bytes(b"v1\n").as_str());

        let (out_tx, out_rx) = mpsc::channel();
        let k2 = KnownVersions::new();
        k2.set("notes/a.md", ContentHash::from_bytes(b"v1\n").as_str());
        let h2 = history.clone();
        let root2 = root.clone();
        let _watcher = WatcherService::start(
            root2,
            std::sync::Arc::new(k2),
            h2,
            move |c| {
                let _ = out_tx.send(c);
            },
        )
        .unwrap();

        // 等待 watcher 完成注册（watch 建立有延迟）
        std::thread::sleep(Duration::from_millis(300));

        // 1) 自保存回声：写入 known 相同内容（hash 相同）
        atomic_like_write(&note, b"v1\n");
        // 2) 外部变更：不同内容
        std::thread::sleep(Duration::from_millis(150));
        atomic_like_write(&note, b"v2 from cyrene\n");

        let change = out_rx
            .recv_timeout(Duration::from_secs(3))
            .expect("应收到外部变更");
        assert_eq!(change.path, "notes/a.md");
        assert_eq!(change.content.as_deref(), Some("v2 from cyrene\n"));
        assert_eq!(change.disk_hash, ContentHash::from_bytes(b"v2 from cyrene\n").as_str());

        // 之后不应再有事件（回声已在上一步裁决为伪事件）
        match out_rx.recv_timeout(Duration::from_millis(700)) {
            Ok(c) => panic!("不应有第二个事件: {c:?}"),
            Err(_) => {}
        }
    }

    #[test]
    fn internal_dirs_and_temp_files_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let known = KnownVersions::new();
        let history = std::sync::Arc::new(HistoryStore::open(&root).unwrap());

        let (out_tx, out_rx) = mpsc::channel();
        let _watcher = WatcherService::start(
            root.clone(),
            std::sync::Arc::new(known),
            history,
            move |c| {
                let _ = out_tx.send(c);
            },
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));

        // .cyrene 内写文件
        fs::create_dir_all(root.join(".cyrene/history")).unwrap();
        fs::write(root.join(".cyrene/history/whatever"), "x").unwrap();
        // 临时文件 pattern
        fs::write(root.join("a.md.cyrene-tmp-1-abc"), "tmp").unwrap();
        fs::write(root.join(".a.md.cyrene-note-tmp-9"), "tmp").unwrap();
        // 非笔记扩展名
        fs::write(root.join("img.png"), "png").unwrap();

        match out_rx.recv_timeout(Duration::from_millis(800)) {
            Ok(c) => panic!("内部目录/临时文件不应产生事件: {c:?}"),
            Err(_) => {}
        }
    }

    /// 模拟 Cyrene 的原子写：tmp + rename
    fn atomic_like_write(target: &Path, bytes: &[u8]) {
        let tmp = target.with_extension("cyrene-tmp-test");
        fs::write(&tmp, bytes).unwrap();
        fs::rename(&tmp, target).unwrap();
    }
}
