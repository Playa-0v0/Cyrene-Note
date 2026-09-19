//! VaultService —— Vault 的打开、列举、读取、保存。
//!
//! 保存语义（契约 §4.1，与 Cyrene 写契约对齐）：
//! 1. 重读磁盘字节，SHA-256 必须等于 expected_hash，否则 CONTENT_CONFLICT；
//! 2. tmp + rename 原子写（LF、UTF-8 无 BOM）；
//! 3. 返回新 hash。
//!
//! 本阶段（vertical slice）尚无 watcher / history / 索引——它们向此骨架增量加入。

use std::path::{Path, PathBuf};

use vault_core::{
    error::{VaultError, VaultResult},
    normalize, ContentHash, NotePath,
};

/// 文件树节点（IPC 序列化由 app 层的 DTO 负责，这里只有领域形状）。
#[derive(Debug, Clone)]
pub struct NoteSummary {
    pub path: NotePath,
    pub size: u64,
    pub modified_ms: u64,
}

pub struct VaultService {
    root: Option<PathBuf>,
}

impl VaultService {
    pub fn new() -> Self {
        Self { root: None }
    }

    /// 打开 Vault：校验目录存在，确保 `.cyrene/` 内部目录就位。
    pub fn open(&mut self, root: &Path) -> VaultResult<()> {
        let canonical = root.canonicalize().map_err(VaultError::Io)?;
        if !canonical.is_dir() {
            return Err(VaultError::Io(std::io::Error::new(
                std::io::ErrorKind::NotADirectory,
                format!("不是目录: {}", canonical.display()),
            )));
        }
        std::fs::create_dir_all(canonical.join(".cyrene"))?;
        self.root = Some(canonical);
        Ok(())
    }

    pub fn is_open(&self) -> bool {
        self.root.is_some()
    }

    pub fn root(&self) -> VaultResult<&Path> {
        self.root.as_deref().ok_or(VaultError::VaultNotOpen)
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

    /// 读取笔记：归一化管线 + 原始字节 hash。
    pub fn read_note(&self, path: &str) -> VaultResult<(String, ContentHash)> {
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
        Ok((loaded.content, loaded.disk_hash))
    }

    /// 保存笔记：乐观锁 + 原子写。成功返回新 hash。
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
        Ok(ContentHash::from_bytes(&bytes))
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
