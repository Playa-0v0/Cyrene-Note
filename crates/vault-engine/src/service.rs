//! VaultService —— Vault 的打开、列举、读取、保存。
//!
//! 保存语义（契约 §4.1，与 Cyrene 写契约对齐）：
//! 1. 重读磁盘字节，SHA-256 必须等于 expected_hash，否则 CONTENT_CONFLICT；
//! 2. tmp + rename 原子写（LF、UTF-8 无 BOM）；
//! 3. 返回新 hash。
//!
//! Snapshot-on-sight（契约 §5.1）：每次成功读到的完整磁盘版本都进 history。
//! known 版本表供 watcher 裁决伪事件（自保存回声）。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use vault_core::{
    error::{VaultError, VaultResult},
    normalize, ContentHash, HistorySource, NotePath,
};

use crate::history::HistoryStore;
use crate::watcher::KnownVersions;
use vault_core::WikiLink;

/// 文件树节点（IPC 序列化由 app 层的 DTO 负责，这里只有领域形状）。
#[derive(Debug, Clone)]
pub struct NoteSummary {
    pub path: NotePath,
    pub size: u64,
    pub modified_ms: u64,
}

/// read_note 的完整产物：内容 + hash + 出链列表。
#[derive(Debug, Clone)]
pub struct NoteDocument {
    pub path: String,
    pub content: String,
    pub disk_hash: ContentHash,
    pub links: Vec<WikiLink>,
}

/// 内存 link index：src_path → 出链。v1 用 HashMap，FTS5 阶段再迁 SQLite。
#[derive(Default)]
pub struct LinkIndex {
    /// 笔记路径 → 它的出链 (raw，含未解析 target/alias/heading)
    outgoing: std::sync::Mutex<std::collections::HashMap<String, Vec<WikiLink>>>,
}

impl LinkIndex {
    pub fn rebuild_for(&self, path: &str, links: Vec<WikiLink>) {
        self.outgoing
            .lock()
            .unwrap()
            .insert(path.to_string(), links);
    }

    pub fn remove(&self, path: &str) {
        self.outgoing.lock().unwrap().remove(path);
    }

    /// 反向索引：找出所有 src 指向 target 的笔记。
    /// v1 用精确 target 匹配；basename/大小写/rename 留 §7.3 决议。
    pub fn backlinks(&self, target: &str) -> Vec<(String, WikiLink)> {
        self.outgoing
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(src, links)| {
                let matching: Vec<WikiLink> = links
                    .iter()
                    .filter(|l| l.target == target)
                    .cloned()
                    .collect();
                if matching.is_empty() {
                    None
                } else {
                    matching.into_iter().next().map(|l| (src.clone(), l))
                }
            })
            .collect()
    }

    pub fn outgoing_for(&self, path: &str) -> Vec<WikiLink> {
        self.outgoing
            .lock()
            .unwrap()
            .get(path)
            .cloned()
            .unwrap_or_default()
    }
}

pub struct VaultService {
    root: Option<PathBuf>,
    history: Option<Arc<HistoryStore>>,
    known: Option<Arc<KnownVersions>>,
    links: Arc<LinkIndex>,
}

impl VaultService {
    pub fn new() -> Self {
        Self { root: None, history: None, known: None, links: Arc::new(LinkIndex::default()) }
    }

    /// 打开 Vault：校验目录存在，初始化 `.cyrene/`（history store + known 表）。
    pub fn open(&mut self, root: &Path) -> VaultResult<()> {
        let canonical = root.canonicalize().map_err(VaultError::Io)?;
        if !canonical.is_dir() {
            return Err(VaultError::Io(std::io::Error::new(
                std::io::ErrorKind::NotADirectory,
                format!("不是目录: {}", canonical.display()),
            )));
        }
        std::fs::create_dir_all(canonical.join(".cyrene"))?;
        let history = Arc::new(HistoryStore::open(&canonical)?);
        let known = Arc::new(KnownVersions::new());
        self.root = Some(canonical);
        self.history = Some(history);
        self.known = Some(known);
        Ok(())
    }

    pub fn is_open(&self) -> bool {
        self.root.is_some()
    }

    pub fn root(&self) -> VaultResult<&Path> {
        self.root.as_deref().ok_or(VaultError::VaultNotOpen)
    }

    /// history 引用（watcher 装配用）。
    pub fn history(&self) -> VaultResult<Arc<HistoryStore>> {
        self.history.clone().ok_or(VaultError::VaultNotOpen)
    }

    /// known 版本表引用（watcher 装配用）。
    pub fn known_versions(&self) -> VaultResult<Arc<KnownVersions>> {
        self.known.clone().ok_or(VaultError::VaultNotOpen)
    }

    /// 列出全部笔记（walkdir，跳过内部目录与临时文件）。
    /// 目录内文件按名称排序；目录本身也作为条目返回（前端树需要）。
    pub fn list_notes(&self) -> VaultResult<Vec<NoteSummary>> {
        let root = self.root()?;
        let mut notes = Vec::new();
        for entry in walkdir::WalkDir::new(root)
            .min_depth(1)
            .sort_by_file_name()
            .into_iter()
            .filter_entry(|e| {
                let name = e.file_name().to_string_lossy();
                !(e.depth() > 0 && vault_core::path::is_internal_dir_name(&name))
            })
        {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    // 本 walkdir 版本 into_io_error() 返回 Option
                    let io_err = e.into_io_error().unwrap_or_else(|| {
                        std::io::Error::new(std::io::ErrorKind::Other, "walkdir 遍历错误")
                    });
                    return Err(VaultError::Io(io_err));
                }
            };
            if !entry.file_type().is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy();
            if vault_core::path::is_temp_file_name(&name) {
                continue;
            }
            // 只收笔记扩展名；NotePath::new 负责全部校验（含内部目录防御）
            let Some(note_path) = NotePath::from_absolute(root, entry.path()) else {
                continue;
            };
            let meta = entry
                .metadata()
                .map_err(|e| VaultError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))?;
            notes.push(NoteSummary {
                path: note_path,
                size: meta.len(),
                modified_ms: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
            });
        }
        Ok(notes)
    }

    /// 全量重建 link index：遍历所有笔记，读全文、跑 wikilink 扫描器。
    /// vault_open 后调用一次，覆盖"从未打开过的笔记"——这些笔记没机会
    /// read_note，索引里就不会有它们的出链，backlinks 自然会缺。
    pub fn rebuild_all_links(&self) -> VaultResult<()> {
        let notes = self.list_notes()?;
        for note in notes {
            let full = note.path.join(self.root()?);
            if let Ok(bytes) = std::fs::read(&full) {
                if let Ok(loaded) = normalize::load(&bytes, note.path.as_str()) {
                    let links = vault_core::wikilink::extract_links(&loaded.content);
                    self.links.rebuild_for(note.path.as_str(), links);
                }
            }
        }
        Ok(())
    }

    /// 读取笔记：归一化管线 + 原始字节 hash。
    /// Snapshot-on-sight：读到的版本进 history（source=open），known 表刷新，
    /// 同时扫描 wikilink 重建该路径的出链索引。
    pub fn read_note_full(&self, path: &str) -> VaultResult<NoteDocument> {
        let root = self.root()?;
        let note_path = NotePath::new(path)?;
        let abs = note_path.join(root);
        let bytes = match std::fs::read(&abs) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(VaultError::NotFound(path.to_string()))
            }
            Err(e) => return Err(VaultError::Io(e)),
        };
        let loaded = normalize::load(&bytes, path)?;
        if let Some(h) = &self.history {
            let _ = h.snapshot(path, &bytes, HistorySource::Open);
        }
        if let Some(k) = &self.known {
            k.set(path, loaded.disk_hash.as_str());
        }
        // wikilink 提取 + 更新索引（顺序：先扫描，再更新索引）
        let links = vault_core::wikilink::extract_links(&loaded.content);
        self.links.rebuild_for(path, links.clone());
        Ok(NoteDocument {
            path: path.to_string(),
            content: loaded.content,
            disk_hash: loaded.disk_hash,
            links,
        })
    }

    /// 保留旧接口（仅 content + hash），供未来不需 link 的场景
    pub fn read_note(&self, path: &str) -> VaultResult<(String, ContentHash)> {
        let doc = self.read_note_full(path)?;
        Ok((doc.content, doc.disk_hash))
    }

    /// 反向链接查询。
    pub fn backlinks(&self, target: &str) -> Vec<(String, WikiLink)> {
        self.links.backlinks(target)
    }

    /// 保存笔记：乐观锁 + 原子写 + snapshot（notes-save）。成功返回新 hash。
    pub fn save_note(&self, path: &str, content: &str, expected_hash: &str) -> VaultResult<ContentHash> {
        let root = self.root()?;
        let note_path = NotePath::new(path)?;
        let abs = note_path.join(root);

        let bytes = normalize::encode_for_disk(content);
        let new_hash = ContentHash::from_bytes(&bytes);

        // 乐观锁：重读磁盘原始字节比对（不与内存缓存比——磁盘才是事实）
        let disk_hash = match std::fs::read(&abs) {
            Ok(disk) => ContentHash::from_bytes(&disk),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // 文件被外部删除：视为冲突，让用户重新读取（创建走 create_note）
                return Err(VaultError::Conflict {
                    path: path.to_string(),
                    expected: expected_hash.to_string(),
                    actual: "(不存在)".to_string(),
                });
            }
            Err(e) => return Err(VaultError::Io(e)),
        };
        if disk_hash.as_str() != expected_hash {
            return Err(VaultError::Conflict {
                path: path.to_string(),
                expected: expected_hash.to_string(),
                actual: disk_hash.as_str().to_string(),
            });
        }

        atomic_write(&abs, &bytes)?;
        // 自保存的新版本也入链（notes-save），known 表指向新版本
        if let Some(h) = &self.history {
            let _ = h.snapshot(path, &bytes, HistorySource::NotesSave);
        }
        if let Some(k) = &self.known {
            k.set(path, new_hash.as_str());
        }
        // wikilink 索引同步：重提取并替换该路径的出链
        let normalized = String::from_utf8(bytes).unwrap_or_default();
        let links = vault_core::wikilink::extract_links(&normalized);
        self.links.rebuild_for(path, links);
        Ok(new_hash)
    }

    /// 创建笔记：目标必须不存在（写契约：create 永不覆盖）。
    pub fn create_note(&self, path: &str, content: &str) -> VaultResult<ContentHash> {
        let root = self.root()?;
        let note_path = NotePath::new(path)?;
        let abs = note_path.join(root);
        if abs.exists() {
            return Err(VaultError::AlreadyExists(path.to_string()));
        }
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let bytes = normalize::encode_for_disk(content);
        atomic_write(&abs, &bytes)?;
        let hash = ContentHash::from_bytes(&bytes);
        if let Some(h) = &self.history {
            let _ = h.snapshot(path, &bytes, HistorySource::NotesSave);
        }
        if let Some(k) = &self.known {
            k.set(path, hash.as_str());
        }
        self.links.rebuild_for(path, vec![]);
        Ok(hash)
    }

    /// 冲突抢救：把本地版本（即将被丢弃的 LOCAL）落 history 后丢弃。
    /// 契约 §4.5：任何被丢弃版本在丢弃前必须已入恢复存储。
    pub fn discard_local(&self, path: &str, content: &str) -> VaultResult<ContentHash> {
        let bytes = normalize::encode_for_disk(content);
        let hash = ContentHash::from_bytes(&bytes);
        if let Some(h) = &self.history {
            h.snapshot(path, &bytes, HistorySource::ConflictDiscard)
                .map_err(VaultError::Io)?;
        }
        Ok(hash)
    }

    /// 原子化的 discard + reload（PR 2 P0-3 落地）：
    /// 1. snapshot LOCAL（失败 → 整条 Err，磁盘原样不动，LOCAL 仍可用）
    /// 2. 重新读取磁盘当前内容（normalize + hash）
    /// 3. 返回 {content, content_hash, path} 一包，前端一次性替换缓冲
    ///
    /// 这两步必须一起——中间失败不能 reload（否则 LOCAL 丢失且没 snapshot）。
    pub fn discard_local_and_reload(&self, path: &str, content: &str) -> VaultResult<NoteDocument> {
        // Step 1: 抢救 LOCAL
        let local_bytes = normalize::encode_for_disk(content);
        if let Some(h) = &self.history {
            // map_err std::io::Error → VaultError::Io——前端从 AppError 透出
            h.snapshot(path, &local_bytes, HistorySource::ConflictDiscard)
                .map_err(VaultError::Io)?;
        }
        // Step 2: 重读磁盘（snapshot 已持久化后才执行——若失败 LOCAL 已保护）
        self.read_note_full(path)
    }

    pub fn link_index(&self) -> Arc<LinkIndex> {
        self.links.clone()
    }
}

impl Default for VaultService {
    fn default() -> Self {
        Self::new()
    }
}

/// 原子写：同目录临时文件 + rename。
/// 临时文件 pattern `.<name>.cyrene-note-tmp-<uuid>`——双方 watcher 都忽略它。
fn atomic_write(target: &Path, bytes: &[u8]) -> VaultResult<()> {
    let dir = target.parent().ok_or_else(|| {
        VaultError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "目标没有父目录",
        ))
    })?;
    let file_name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let tmp = dir.join(format!(
        ".{file_name}.cyrene-note-tmp-{}",
        uuid_segment()
    ));
    std::fs::write(&tmp, bytes)?;
    match std::fs::rename(&tmp, target) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp); // 清理失败也无害（watcher 忽略该 pattern）
            Err(VaultError::Io(e))
        }
    }
}

fn uuid_segment() -> String {
    // 无 uuid 依赖：时间戳 + 进程内计数器 + 随机性，仅用于临时文件名唯一性
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{t:x}-{n:x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn svc_with_notes(files: &[(&str, &str)]) -> (VaultService, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        for (p, c) in files {
            let abs = dir.path().join(p);
            fs::create_dir_all(abs.parent().unwrap()).unwrap();
            fs::write(abs, c).unwrap();
        }
        let mut svc = VaultService::new();
        svc.open(dir.path()).unwrap();
        (svc, dir)
    }

    #[test]
    fn open_creates_cyrene_dir() {
        let dir = tempfile::tempdir().unwrap();
        let mut svc = VaultService::new();
        svc.open(dir.path()).unwrap();
        assert!(dir.path().join(".cyrene").is_dir());
    }

    #[test]
    fn list_skips_internal_and_temp() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "a").unwrap();
        fs::create_dir(dir.path().join("notes")).unwrap();
        fs::write(dir.path().join("notes/b.md"), "b").unwrap();
        fs::create_dir_all(dir.path().join(".cyrene/history")).unwrap();
        fs::write(dir.path().join(".cyrene/leak.md"), "leak").unwrap();
        fs::write(dir.path().join("tmp.md.cyrene-tmp-1-a"), "tmp").unwrap();
        fs::write(dir.path().join("img.png"), "png").unwrap();

        let mut svc = VaultService::new();
        svc.open(dir.path()).unwrap();
        let paths: Vec<String> = svc
            .list_notes()
            .unwrap()
            .into_iter()
            .map(|n| n.path.as_str().to_string())
            .collect();
        assert_eq!(paths, vec!["a.md", "notes/b.md"]);
    }

    #[test]
    fn read_normalizes_and_hashes_raw() {
        let (svc, _d) = svc_with_notes(&[("crlf.md", "# T\r\n\r\nbody\r\n")]);
        let (content, hash) = svc.read_note("crlf.md").unwrap();
        assert_eq!(content, "# T\n\nbody\n");
        assert_eq!(hash, ContentHash::from_bytes(b"# T\r\n\r\nbody\r\n"));
    }

    #[test]
    fn save_roundtrip_with_hash() {
        let (svc, _d) = svc_with_notes(&[("n.md", "v1\n")]);
        let (_, h1) = svc.read_note("n.md").unwrap();
        let h2 = svc.save_note("n.md", "v2\n", h1.as_str()).unwrap();
        assert_eq!(h2, ContentHash::from_bytes(b"v2\n"));
        let (content, h3) = svc.read_note("n.md").unwrap();
        assert_eq!(content, "v2\n");
        assert_eq!(h3, h2);
    }

    #[test]
    fn save_conflict_on_stale_hash() {
        let (svc, _d) = svc_with_notes(&[("n.md", "v1\n")]);
        let err = svc.save_note("n.md", "v2\n", "deadbeef").unwrap_err();
        match err {
            VaultError::Conflict { path, expected, actual } => {
                assert_eq!(path, "n.md");
                assert_eq!(expected, "deadbeef");
                assert_ne!(actual, "deadbeef");
            }
            other => panic!("期望 Conflict，得到 {other:?}"),
        }
        // 内容未被覆盖
        let (content, _) = svc.read_note("n.md").unwrap();
        assert_eq!(content, "v1\n");
    }

    #[test]
    fn save_conflict_when_deleted_externally() {
        let (svc, dir) = svc_with_notes(&[("n.md", "v1\n")]);
        let (_, h) = svc.read_note("n.md").unwrap();
        fs::remove_file(dir.path().join("n.md")).unwrap();
        assert!(matches!(
            svc.save_note("n.md", "v2\n", h.as_str()),
            Err(VaultError::Conflict { .. })
        ));
    }

    #[test]
    fn create_refuses_existing() {
        let (svc, _d) = svc_with_notes(&[("n.md", "v1\n")]);
        assert!(matches!(
            svc.create_note("n.md", "x"),
            Err(VaultError::AlreadyExists(_))
        ));
        // 原内容未动
        let (content, _) = svc.read_note("n.md").unwrap();
        assert_eq!(content, "v1\n");
    }

    #[test]
    fn create_makes_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let mut svc = VaultService::new();
        svc.open(dir.path()).unwrap();
        svc.create_note("notes/AI/new.md", "# 新\n").unwrap();
        let (content, _) = svc.read_note("notes/AI/new.md").unwrap();
        assert_eq!(content, "# 新\n");
    }

    #[test]

#[test]
    fn rebuild_all_links_works_on_unopened_notes() {
        // 关键场景：Vault 里有个笔记用户从未打开过，索引里没有它的出链，
        // 反向链接就会缺。rebuild_all_links 必须能覆盖这种笔记。
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "see [[Target]]\n").unwrap();
        fs::write(dir.path().join("Target.md"), "target body\n").unwrap();
        let mut svc = VaultService::new();
        svc.open(dir.path()).unwrap();
        // 故意不 read_note；rebuild 前 backlinks 为空
        assert!(svc.backlinks("Target").is_empty());
        svc.rebuild_all_links().unwrap();
        let bl = svc.backlinks("Target");
        assert_eq!(bl.len(), 1);
        assert_eq!(bl[0].0, "a.md");
    }


#[test]
fn discard_local_and_reload_atomicity_snapshot_failure() {
    // PR 2 P0-3：history snapshot 失败时整个 discard_local_and_reload 必须失败。
    // 注入难点：vault.open() 会创建好 .cyrene/history 目录；后续把该目录
    // 替换成文件无法影响 service 内 HistoryStore 缓存的 PathBuf（snapshot
    // 会自动 create_dir_all 重新建回来）。跨平台稳定注入需要 HistoryStore
    // 接受错误注入钩子——留给后续 PR 加 #[cfg(test)] 入口。
    //
    // 本测试覆盖正常路径下的原子性语义：snapshot + reload 在同一个调用链
    // 完成，前端只调一次。前端的错误注入（PR 1 测试 11）已覆盖 history 失败
    // 时保留 LOCAL + 冲突态 + lastError 这条前端语义分支。
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.md"), "disk content v1\n").unwrap();
    let mut svc = VaultService::new();
    svc.open(dir.path()).unwrap();
    let doc = svc.discard_local_and_reload("a.md", "LOCAL was here").unwrap();
    assert_eq!(doc.content, "disk content v1\n");
    // LOCAL 落进 history（source=conflict-discard）
    let versions = svc.history().unwrap().versions("a.md");
    assert!(versions.iter().any(|(_, _, src)| src == "conflict-discard"));
}

#[test]
fn discard_local_and_reload_success_returns_disk_state() {
    // 正常路径：snapshot LOCAL + 重新读取磁盘，返回新 base
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.md"), "disk content v2\n").unwrap();
    let mut svc = VaultService::new();
    svc.open(dir.path()).unwrap();
    let doc = svc.discard_local_and_reload("a.md", "LOCAL was here").unwrap();
    assert_eq!(doc.content, "disk content v2\n");
    assert_eq!(doc.path, "a.md");
    // LOCAL 的快照应已落入 history
    let versions = svc.history.as_ref().unwrap().versions("a.md");
    let has_local = versions.iter().any(|(_, _, src)| src == "conflict-discard");
    assert!(has_local, "LOCAL 内容必须出现在 history 链上");
}

#[test]
    fn wikilink_index_rebuilds_on_read() {
    let (svc, _d) = svc_with_notes(&[
        ("a.md", "see [[B]] and [[C]] end"),
        ("b.md", "leaf"),
    ]);
    svc.read_note("a.md").unwrap();
    let out = svc.link_index().outgoing_for("a.md");
    let targets: Vec<&str> = out.iter().map(|l| l.target.as_str()).collect();
    assert_eq!(targets, vec!["B", "C"]);
}

#[test]
fn backlinks_inverse_resolution() {
    let (svc, _d) = svc_with_notes(&[
        ("a.md", "see [[B]]"),
        ("b.md", "also [[B]] and [[C]]"),
        ("c.md", "[B] but not wikilink"),
        ("target.md", "leaf"),
    ]);
    svc.read_note("a.md").unwrap();
    svc.read_note("b.md").unwrap();
    svc.read_note("c.md").unwrap();
    let mut bl = svc.link_index().backlinks("B");
    bl.sort_by(|a, b| a.0.cmp(&b.0));
    let paths: Vec<&str> = bl.iter().map(|(p, _)| p.as_str()).collect();
    assert_eq!(paths, vec!["a.md", "b.md"]);
}

#[test]
fn wikilink_index_updates_on_save() {
    let (svc, _d) = svc_with_notes(&[("a.md", "[[OLD]]")]);
    svc.read_note("a.md").unwrap();
    assert_eq!(svc.link_index().outgoing_for("a.md").len(), 1);
    let (_, h) = svc.read_note("a.md").unwrap();
    svc.save_note("a.md", "[[NEW]]", h.as_str()).unwrap();
    let out = svc.link_index().outgoing_for("a.md");
    let targets: Vec<&str> = out.iter().map(|l| l.target.as_str()).collect();
    assert_eq!(targets, vec!["NEW"]);
}

    fn atomic_write_leaves_no_tmp_on_success() {
        let (svc, dir) = svc_with_notes(&[("n.md", "v1\n")]);
        let (_, h) = svc.read_note("n.md").unwrap();
        svc.save_note("n.md", "v2\n", h.as_str()).unwrap();
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .contains("cyrene-note-tmp")
            })
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件: {leftovers:?}");
    }
}
