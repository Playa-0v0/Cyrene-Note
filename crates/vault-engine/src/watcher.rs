//! WatcherService —— 外部修改检测。
//!
//! 文件系统事件 ≠ 文件被修改：notify 事件只是"文件可能变了"的提示，
//! 真正是否变了要看读出内容后算出来的 hash 是否与之前一致。
//! 流水线（全部在 Rust 侧完成，不跨 IPC 抖动）：
//!
//! notify events → 按 path 合并（200ms 窗口）→ 读盘算 hash
//!   → hash == known hash / == 在途自写目标？ → 丢弃（伪事件 / 自保存回声）
//!   → 否则 snapshot（external-change）→ 复读确认磁盘未再变 → CAS 发布 → 回调
//!
//! 并发模型（2026-09 竞态修复，取代「调用方写完后更新 known」的旧约定）：
//! - `KnownVersions` 是 path → (hash, generation) 的版本状态机，不是普通缓存。
//!   跨异步间隙的推进（watcher 裁决、read 的对齐、save 的提交）都持观察时的
//!   generation 做 compare-and-swap，失败即放弃——慢了一拍的旧裁决 / 旧提交
//!   不能把 known 倒退回过期版本。
//! - VaultService 写盘**之前**先 `begin_self_write` 登记目标 hash；watcher
//!   「读到磁盘 == 登记目标」即判定自保存回声。由于登记先于 rename，
//!   「磁盘已是目标内容 ⇒ 标记必然可见」，不依赖任何时序假设
//!   （200ms 只是合并窗，不是同步机制）。
//! - 发布前复读磁盘确认内容稳定：绝不把 snapshot 期间已被覆盖的过期版本
//!   当作 external-change 发出去。
//! - 删除落 tombstone（空 hash + generation 前进）：同内容重建文件会再次
//!   产生事件，不会被伪事件逻辑吞掉。
//! - 「文件在但读不了」（非法 UTF-8 等）与「文件被删除」是不同的磁盘状态，
//!   分别上报，前端语义不混淆。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use notify::Watcher as _; // .watch() 在 trait 上
use vault_core::path::{is_internal_dir_name, is_temp_file_name};
use vault_core::{ContentHash, HistorySource};

use crate::history::HistoryStore;

const COALESCE_WINDOW: Duration = Duration::from_millis(200);
/// adjudicate 单轮重试上限：文件持续被写时返回 Retry 重新排队，
/// 而不是在原地无限循环。
const ADJUDICATE_MAX_ROUNDS: usize = 4;

/// watcher 检测到的真实外部变更（hash 已裁决，非伪事件）。
#[derive(Debug, Clone)]
pub struct ExternalChange {
    /// Vault 相对路径（`/` 分隔）
    pub path: String,
    /// 原始磁盘字节 SHA-256（删除时为空串）
    pub disk_hash: String,
    /// 磁盘状态：内容 / 已删除 / 存在但不可读
    pub disk: DiskContent,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DiskContent {
    /// 归一化后的内容（LF、无 BOM）
    Content(String),
    /// 文件被外部删除
    Deleted,
    /// 文件存在但无法作为笔记加载（非法 UTF-8 等）；原始字节 hash 仍有效
    Unreadable,
}

enum WatcherMsg {
    Event(PathBuf),
    Stop,
}

/// adjudicate 的裁决结果。
enum Adjudication {
    /// 真实外部变更，需要上报
    Emit(ExternalChange),
    /// 伪事件 / 自写回声 / 无需上报
    Quiet,
    /// 本轮未能达成稳定裁决（磁盘或 known 在裁决期间持续变化）——
    /// 重新排队，等下一轮
    Retry,
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
                match res {
                    Ok(ev) => {
                        for p in ev.paths {
                            let _ = event_tx.send(WatcherMsg::Event(p));
                        }
                    }
                    // 事件流级别的错误（如缓冲溢出）无法逐路径恢复。
                    // read/save 的兜底刷新仍在；此处至少留痕。
                    Err(e) => eprintln!("[cyrene-note] watcher 事件流错误: {e}"),
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
                    match adjudicate(&root, &known, &history, &p) {
                        Adjudication::Emit(change) => on_change(change),
                        Adjudication::Quiet => {}
                        // 磁盘/known 仍在动：推迟一个合并窗再看
                        Adjudication::Retry => {
                            pending.insert(p, Instant::now() + COALESCE_WINDOW);
                        }
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

/// 一次 `observe` 拿到的条目快照。
#[derive(Debug, Clone)]
pub struct Observation {
    /// 当前已知 hash；None = 未跟踪或已删除（tombstone）
    pub hash: Option<String>,
    /// 在途自写目标（save/create 已登记、尚未提交/中止）
    pub self_write: Option<String>,
    /// 条目 generation——advance_if_unchanged 的 CAS 凭据
    pub generation: u64,
}

/// 已知版本表：path → (hash, generation) 的**文件版本状态机**。
///
/// 并发正确性靠三条规则，而不是「调用方写完后更新」的时序约定：
/// 1. 每次推进 generation +1；跨了异步间隙的推进（watcher 裁决、read 的
///    对齐、save 的提交）必须持观察时的 generation 做 compare-and-swap，
///    失败即放弃——旧观察者不能覆盖新状态。
/// 2. 写盘方在 rename **之前** `begin_self_write` 登记目标 hash，watcher
///    据此识别自保存回声（登记先于 rename，所以「磁盘已是目标内容 ⇒
///    标记此刻必然可见」）。
/// 3. 所有推进都只把 known 对齐到「曾经真实存在于磁盘的版本」，永远不倒退。
pub struct KnownVersions(std::sync::Mutex<KnownInner>);

#[derive(Default)]
struct KnownInner {
    entries: HashMap<String, KnownEntry>,
}

#[derive(Default, Clone)]
struct KnownEntry {
    /// 最后确认的磁盘 hash；空串 = tombstone（文件已删除）
    hash: String,
    /// 条目状态版本号：每次推进 +1
    generation: u64,
    /// 在途自写目标 hash（save/create 在 rename 前登记）
    self_write: Option<String>,
    /// 登记自写时的 generation（commit 的 CAS 基准）
    write_gen: u64,
}

impl KnownVersions {
    pub fn new() -> Self {
        Self(std::sync::Mutex::new(KnownInner::default()))
    }

    /// 观察条目。None = 该路径从未被跟踪。
    pub fn observe(&self, path: &str) -> Option<Observation> {
        let inner = self.0.lock().unwrap();
        inner.entries.get(path).map(|e| Observation {
            hash: if e.hash.is_empty() { None } else { Some(e.hash.clone()) },
            self_write: e.self_write.clone(),
            generation: e.generation,
        })
    }

    /// 兼容接口：仅取已知 hash（None = 未知或已删除）。
    pub fn get(&self, path: &str) -> Option<String> {
        self.observe(path).and_then(|o| o.hash)
    }

    /// 首次跟踪：仅当条目不存在时插入。返回是否真的插入了。
    pub fn introduce(&self, path: &str, hash: &str) -> bool {
        let mut inner = self.0.lock().unwrap();
        if inner.entries.contains_key(path) {
            return false;
        }
        inner.entries.insert(
            path.to_string(),
            KnownEntry {
                hash: hash.to_string(),
                generation: 1,
                ..Default::default()
            },
        );
        true
    }

    /// 无条件推进（同时清掉在途标记）。仅用于测试与无并发竞争的初始化；
    /// 正式路径一律走 advance_if_unchanged / begin-commit。
    pub fn advance(&self, path: &str, hash: &str) {
        let mut inner = self.0.lock().unwrap();
        let e = inner.entries.entry(path.to_string()).or_default();
        e.generation += 1;
        e.hash = hash.to_string();
        e.self_write = None;
        e.write_gen = 0;
    }

    /// CAS 推进：仅当条目 generation 仍等于 `expected_gen` 时写入 `new_hash`。
    /// 同值幂等（不推 generation，避免无意义地作废别人的 CAS 凭据）；
    /// 失败 = 有别的推进者先到了——本次作废，调用方重新观察。
    /// 不动在途自写标记（它属于登记它的写盘方，由 commit/abort 清理）。
    pub fn advance_if_unchanged(&self, path: &str, expected_gen: u64, new_hash: &str) -> bool {
        let mut inner = self.0.lock().unwrap();
        match inner.entries.get_mut(path) {
            Some(e) if e.generation == expected_gen => {
                if e.hash == new_hash {
                    return true; // 幂等：known 已是该值
                }
                e.generation += 1;
                e.hash = new_hash.to_string();
                true
            }
            _ => false,
        }
    }

    /// 登记在途自写：调用方即将把 `target` 写到 `path`。
    /// **必须在 rename 之前调用**——这是 watcher 识别回声的前提。
    pub fn begin_self_write(&self, path: &str, target: &str) {
        let mut inner = self.0.lock().unwrap();
        let e = inner.entries.entry(path.to_string()).or_default();
        e.self_write = Some(target.to_string());
        e.write_gen = e.generation;
    }

    /// 自写完成：提交 target。标记总是清理；hash 只在 generation 未被别人
    /// 推进时提交——若 watcher 已发布更新的磁盘版本（或 read 已对齐），
    /// 保持现状，绝不倒退。
    pub fn commit_self_write(&self, path: &str, target: &str) {
        let mut inner = self.0.lock().unwrap();
        let Some(e) = inner.entries.get_mut(path) else { return };
        if e.self_write.as_deref() != Some(target) {
            return; // 不是本次登记的在途写（或已被清理）
        }
        let base_gen = e.write_gen;
        e.self_write = None;
        e.write_gen = 0;
        if e.generation == base_gen {
            e.generation += 1;
            e.hash = target.to_string();
        }
    }

    /// 自写失败（写盘出错 / 冲突放弃）：只清标记，known 保持原值。
    pub fn abort_self_write(&self, path: &str) {
        let mut inner = self.0.lock().unwrap();
        if let Some(e) = inner.entries.get_mut(path) {
            e.self_write = None;
            e.write_gen = 0;
        }
    }

    /// watcher 吸收自写回声：磁盘已是在途目标，把 known 前进到该 hash
    /// （磁盘事实），标记保留——由写盘方的 commit/abort 统一清理。
    pub fn absorb_self_write(&self, path: &str, hash: &str) {
        let mut inner = self.0.lock().unwrap();
        if let Some(e) = inner.entries.get_mut(path) {
            if e.self_write.as_deref() == Some(hash) && e.hash != hash {
                e.generation += 1;
                e.hash = hash.to_string();
            }
        }
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

/// 裁决单个路径的磁盘状态。见模块头部的并发模型说明。
fn adjudicate(
    root: &Path,
    known: &KnownVersions,
    history: &HistoryStore,
    p: &Path,
) -> Adjudication {
    let Some(note_path) = vault_core::path::NotePath::from_absolute(root, p) else {
        return Adjudication::Quiet;
    };
    let rel = note_path.as_str().to_string();

    for _ in 0..ADJUDICATE_MAX_ROUNDS {
        let bytes = match std::fs::read(p) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return adjudicate_deleted(&rel, known);
            }
            Err(_) => return Adjudication::Quiet,
        };
        let disk_hash = ContentHash::from_bytes(&bytes).as_str().to_string();

        // 读盘之后才观察：begin_self_write 先于 rename，
        // 所以「磁盘已是目标内容 ⇒ 标记此刻必然可见」。
        let Some(obs) = known.observe(&rel) else {
            // 从未跟踪的路径出现内容：外部新建 → 首次跟踪、入链并上报
            if known.introduce(&rel, &disk_hash) {
                let _ = history.snapshot(&rel, &bytes, HistorySource::ExternalChange);
                let disk = content_or_unreadable(&rel, &bytes);
                return Adjudication::Emit(ExternalChange {
                    path: rel,
                    disk_hash,
                    disk,
                });
            }
            continue; // 并发引入 → 下一轮重新观察
        };

        // 自保存回声：吸收，不发事件
        if obs.self_write.as_deref() == Some(disk_hash.as_str()) {
            known.absorb_self_write(&rel, &disk_hash);
            return Adjudication::Quiet;
        }
        // 伪事件：内容与已知版本一致
        if obs.hash.as_deref() == Some(disk_hash.as_str()) {
            return Adjudication::Quiet;
        }

        // 真实外部变更：先 snapshot——history 是恢复数据，即使本轮裁决
        // 最终放弃（磁盘又变了），这个中间版本也不该丢。
        let _ = history.snapshot(&rel, &bytes, HistorySource::ExternalChange);

        // 复读确认：snapshot 期间文件可能又被覆盖——绝不发布过期版本
        let confirmed = match std::fs::read(p) {
            Ok(b2) => ContentHash::from_bytes(&b2).as_str().to_string(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Adjudication::Quiet,
        };
        if confirmed != disk_hash {
            continue; // 本轮读到的版本已过期，重新裁决最新版本
        }

        // CAS 发布：known 仍是本轮观察到的 generation 才推进。
        // 失败 = read/save/别的裁决已推进状态 → 重新观察（下一轮要么
        // 发现 known == disk（Quiet），要么发布更新版本）。
        if !known.advance_if_unchanged(&rel, obs.generation, &disk_hash) {
            continue;
        }

        let disk = content_or_unreadable(&rel, &bytes);
        return Adjudication::Emit(ExternalChange {
            path: rel,
            disk_hash,
            disk,
        });
    }
    // 多轮未收敛：文件正在被连续写入。重新排队，等磁盘安静下来。
    Adjudication::Retry
}

/// 外部删除：落 tombstone 并上报。已知条件在函数内重新确认，
/// 重复删除事件（已是 tombstone）不上报。
fn adjudicate_deleted(rel: &str, known: &KnownVersions) -> Adjudication {
    let Some(obs) = known.observe(rel) else {
        return Adjudication::Quiet; // 从未跟踪：不关心
    };
    if obs.self_write.is_some() {
        // 自写在途：写盘方自己的事件会给出最终状态，这里不抢判。
        // 极端情形（外部删除 + 我方写盘恰好失败）会漏一次上报，
        // 等下次该路径的任何事件/read 兜底。
        return Adjudication::Quiet;
    }
    if obs.hash.is_none() {
        return Adjudication::Quiet; // 已是 tombstone：重复事件
    }
    if !known.advance_if_unchanged(rel, obs.generation, "") {
        return Adjudication::Retry;
    }
    Adjudication::Emit(ExternalChange {
        path: rel.to_string(),
        disk_hash: String::new(),
        disk: DiskContent::Deleted,
    })
}

fn content_or_unreadable(rel: &str, bytes: &[u8]) -> DiskContent {
    match vault_core::normalize::load(bytes, rel) {
        Ok(loaded) => DiskContent::Content(loaded.content),
        // 非法 UTF-8 等：文件在、读不了——与删除是两回事
        Err(_) => DiskContent::Unreadable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Arc;

    fn hash_of(bytes: &[u8]) -> String {
        ContentHash::from_bytes(bytes).as_str().to_string()
    }

    fn setup(dir_files: &[(&str, &str)]) -> (tempfile::TempDir, Arc<HistoryStore>, Arc<KnownVersions>) {
        let dir = tempfile::tempdir().unwrap();
        for (p, c) in dir_files {
            let abs = dir.path().join(p);
            fs::create_dir_all(abs.parent().unwrap()).unwrap();
            fs::write(abs, c).unwrap();
        }
        let history = Arc::new(HistoryStore::open(dir.path()).unwrap());
        let known = Arc::new(KnownVersions::new());
        (dir, history, known)
    }

    /// 起一个 watcher + 输出通道；返回 (接收端, WatcherService)
    fn start_watcher(
        root: &Path,
        known: Arc<KnownVersions>,
        history: Arc<HistoryStore>,
    ) -> (mpsc::Receiver<ExternalChange>, WatcherService) {
        let (out_tx, out_rx) = mpsc::channel();
        let w = WatcherService::start(root.to_path_buf(), known, history, move |c| {
            let _ = out_tx.send(c);
        })
        .unwrap();
        (out_rx, w)
    }

    /// 等待 watcher 完成注册
    fn wait_registered() {
        std::thread::sleep(Duration::from_millis(300));
    }

    /// 模拟 Cyrene / Notes 的原子写：tmp + rename
    fn atomic_like_write(target: &Path, bytes: &[u8]) {
        let tmp = target.with_extension("cyrene-tmp-test");
        fs::write(&tmp, bytes).unwrap();
        fs::rename(&tmp, target).unwrap();
    }

    /// 轮询直到条件成立（或超时 panic）——避免对 watcher 时序的硬编码假设
    fn wait_until(desc: &str, mut cond: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !cond() {
            if Instant::now() > deadline {
                panic!("等待超时: {desc}");
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// 端到端：外部写入 → 上报一次；自保存回声（known == disk）不上报。
    #[test]
    fn external_change_detected_and_echo_suppressed() {
        let (dir, history, known) = setup(&[("notes/a.md", "v1\n")]);
        let root = dir.path().to_path_buf();
        let note = root.join("notes/a.md");
        known.advance("notes/a.md", &hash_of(b"v1\n"));

        let (out_rx, _watcher) = start_watcher(&root, known.clone(), history);
        wait_registered();

        // 1) 自保存回声：写入 known 相同内容（hash 相同）
        atomic_like_write(&note, b"v1\n");
        // 2) 外部变更：不同内容
        std::thread::sleep(Duration::from_millis(150));
        atomic_like_write(&note, b"v2 from cyrene\n");

        let change = out_rx
            .recv_timeout(Duration::from_secs(3))
            .expect("应收到外部变更");
        assert_eq!(change.path, "notes/a.md");
        assert_eq!(change.disk, DiskContent::Content("v2 from cyrene\n".to_string()));
        assert_eq!(change.disk_hash, hash_of(b"v2 from cyrene\n"));

        // 之后不应再有事件（回声已裁决为伪事件）
        match out_rx.recv_timeout(Duration::from_millis(700)) {
            Ok(c) => panic!("不应有第二个事件: {c:?}"),
            Err(_) => {}
        }
    }

    /// 竞态 1 回归测试：save 的「rename 已完成、known 尚未提交」窗口内，
    /// watcher 不得把自保存当成外部修改——即使 commit 被拖过整个合并窗。
    #[test]
    fn self_write_echo_suppressed_regardless_of_commit_timing() {
        let (dir, history, known) = setup(&[("notes/a.md", "v1\n")]);
        let root = dir.path().to_path_buf();
        let note = root.join("notes/a.md");
        let target = hash_of(b"v2 mine\n");
        known.advance("notes/a.md", &hash_of(b"v1\n"));

        let (out_rx, _watcher) = start_watcher(&root, known.clone(), history);
        wait_registered();

        // 模拟 save_note：begin → rename →（snapshot 很慢，迟迟不 commit）
        known.begin_self_write("notes/a.md", &target);
        atomic_like_write(&note, b"v2 mine\n");

        // 拖过多个合并窗：watcher 必须吸收回声并把 known 前进到 v2
        wait_until("watcher 吸收自写回声", || {
            known.get("notes/a.md").as_deref() == Some(target.as_str())
        });
        match out_rx.try_recv() {
            Ok(c) => panic!("自保存回声不应上报: {c:?}"),
            Err(_) => {}
        }

        // commit 终于到达：无事件，known 不变
        known.commit_self_write("notes/a.md", &target);
        match out_rx.recv_timeout(Duration::from_millis(700)) {
            Ok(c) => panic!("commit 后不应有事件: {c:?}"),
            Err(_) => {}
        }
        assert_eq!(known.get("notes/a.md").as_deref(), Some(target.as_str()));
    }

    /// tombstone：删除 → Deleted 事件；**同内容**重建 → 必须再次上报
    /// （旧实现的 known 残留旧 hash 会把重建当伪事件吞掉）。
    #[test]
    fn deleted_then_recreated_same_content_emits() {
        let (dir, history, known) = setup(&[("notes/a.md", "v1\n")]);
        let root = dir.path().to_path_buf();
        let note = root.join("notes/a.md");
        known.advance("notes/a.md", &hash_of(b"v1\n"));

        let (out_rx, _watcher) = start_watcher(&root, known.clone(), history);
        wait_registered();

        fs::remove_file(&note).unwrap();
        let del = out_rx
            .recv_timeout(Duration::from_secs(3))
            .expect("删除应上报");
        assert_eq!(del.disk, DiskContent::Deleted);
        assert_eq!(known.get("notes/a.md"), None); // tombstone

        // 同内容重建（模拟 Cyrene 恢复了同样的字节）
        atomic_like_write(&note, b"v1\n");
        let back = out_rx
            .recv_timeout(Duration::from_secs(3))
            .expect("同内容重建必须再次上报");
        assert_eq!(back.disk, DiskContent::Content("v1\n".to_string()));
        assert_eq!(back.disk_hash, hash_of(b"v1\n"));
    }

    /// 非法 UTF-8：文件存在、读不了——上报 Unreadable 而不是 Deleted。
    #[test]
    fn invalid_utf8_reported_as_unreadable_not_deleted() {
        let (dir, history, known) = setup(&[("notes/a.md", "v1\n")]);
        let root = dir.path().to_path_buf();
        let note = root.join("notes/a.md");
        known.advance("notes/a.md", &hash_of(b"v1\n"));

        let (out_rx, _watcher) = start_watcher(&root, known.clone(), history);
        wait_registered();

        let bad: &[u8] = &[0x23, 0x20, 0xff, 0xfe];
        atomic_like_write(&note, bad);
        let change = out_rx
            .recv_timeout(Duration::from_secs(3))
            .expect("非法 UTF-8 应上报");
        assert_eq!(change.disk, DiskContent::Unreadable);
        assert_eq!(change.disk_hash, hash_of(bad));
    }

    #[test]
    fn internal_dirs_and_temp_files_ignored() {
        let (dir, history, known) = setup(&[]);
        let root = dir.path().to_path_buf();

        let (out_rx, _watcher) = start_watcher(&root, known, history);
        wait_registered();

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

    // ── KnownVersions 状态机单元测试（无 IO） ──────────────────────

    #[test]
    fn cas_rejects_stale_generation() {
        let k = KnownVersions::new();
        k.introduce("a", "H1");
        let gen1 = k.observe("a").unwrap().generation;
        k.advance("a", "H2"); // 别人推进了
        // 持旧 generation 的观察者不能倒退
        assert!(!k.advance_if_unchanged("a", gen1, "H3"));
        assert_eq!(k.get("a").as_deref(), Some("H2"));
    }

    #[test]
    fn cas_same_value_is_idempotent() {
        // 同值推进不 bump generation——否则会作废并发写盘方的 commit 凭据
        let k = KnownVersions::new();
        k.introduce("a", "H1");
        let gen1 = k.observe("a").unwrap().generation;
        assert!(k.advance_if_unchanged("a", gen1, "H1"));
        assert_eq!(k.observe("a").unwrap().generation, gen1);
    }

    #[test]
    fn commit_self_write_does_not_regress_after_external_publish() {
        let k = KnownVersions::new();
        k.introduce("a", "A");
        k.begin_self_write("a", "B");
        // watcher 已发布更新的磁盘版本 C（Cyrene 在我方 rename 后覆盖）
        k.advance("a", "C");
        k.commit_self_write("a", "B");
        assert_eq!(k.get("a").as_deref(), Some("C"), "commit 不得把 known 倒退回 B");
        assert!(k.observe("a").unwrap().self_write.is_none(), "标记必须清理");
    }

    #[test]
    fn commit_self_write_normal_path_advances() {
        let k = KnownVersions::new();
        k.introduce("a", "A");
        k.begin_self_write("a", "B");
        k.commit_self_write("a", "B");
        assert_eq!(k.get("a").as_deref(), Some("B"));
    }

    #[test]
    fn commit_without_matching_marker_is_noop() {
        let k = KnownVersions::new();
        k.introduce("a", "A");
        // 没登记就 commit（或 marker 已被 abort 清掉）
        k.commit_self_write("a", "B");
        assert_eq!(k.get("a").as_deref(), Some("A"));
        k.begin_self_write("a", "B");
        k.abort_self_write("a");
        k.commit_self_write("a", "B");
        assert_eq!(k.get("a").as_deref(), Some("A"), "abort 后 commit 不得推进");
    }

    #[test]
    fn abort_self_write_clears_marker_keeps_hash() {
        let k = KnownVersions::new();
        k.introduce("a", "A");
        k.begin_self_write("a", "B");
        k.abort_self_write("a");
        assert_eq!(k.get("a").as_deref(), Some("A"));
        assert!(k.observe("a").unwrap().self_write.is_none());
    }

    #[test]
    fn absorb_self_write_advances_but_keeps_marker_for_owner() {
        let k = KnownVersions::new();
        k.introduce("a", "A");
        k.begin_self_write("a", "B");
        // watcher 吸收回声：known 前进，标记保留
        k.absorb_self_write("a", "B");
        assert_eq!(k.get("a").as_deref(), Some("B"));
        assert_eq!(k.observe("a").unwrap().self_write.as_deref(), Some("B"));
        // 写盘方随后 commit：标记清理，known 不倒退
        k.commit_self_write("a", "B");
        assert_eq!(k.get("a").as_deref(), Some("B"));
        assert!(k.observe("a").unwrap().self_write.is_none());
    }

    #[test]
    fn introduce_is_insert_if_absent() {
        let k = KnownVersions::new();
        assert!(k.introduce("a", "H1"));
        assert!(!k.introduce("a", "H2"), "已存在时不得覆盖");
        assert_eq!(k.get("a").as_deref(), Some("H1"));
    }
}
