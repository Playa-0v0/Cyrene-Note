//! NotePath —— Vault 相对路径的领域类型。
//!
//! 路径解析规则（与 Cyrene resolveSafe 行为保持一致）：
//! - 内部统一 `/` 分隔（Windows 反斜杠归一）
//! - 拒绝绝对路径、`..` 逃逸、空段
//! - 只接受笔记扩展名集合（与 Cyrene 白名单一致）
//! - 拒绝进入内部目录（`.cyrene/`、`.obsidian/`）

use crate::error::{VaultError, VaultResult};
use std::path::Path;

pub const NOTE_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mdx"];
const INTERNAL_DIRS: &[&str] = &[".cyrene", ".obsidian"];
const TEMP_MARKERS: &[&str] = &[".cyrene-tmp-", ".cyrene-note-tmp-"];

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct NotePath(String);

impl NotePath {
    /// 从 Vault 相对路径构造（`notes/AI/Transformer.md`）。
    pub fn new(relative: &str) -> VaultResult<Self> {
        let normalized = relative.trim().replace('\\', "/");
        if normalized.is_empty() {
            return Err(VaultError::PathOutsideVault(relative.to_string()));
        }
        if Path::new(&normalized).is_absolute() {
            return Err(VaultError::PathOutsideVault(relative.to_string()));
        }

        let segments: Vec<&str> = normalized.split('/').collect();
        for seg in &segments {
            if seg.is_empty() || *seg == "." {
                return Err(VaultError::PathOutsideVault(relative.to_string()));
            }
            if *seg == ".." {
                return Err(VaultError::PathOutsideVault(relative.to_string()));
            }
        }

        // 内部目录保护（读写双向）
        if let Some(first) = segments.first() {
            if INTERNAL_DIRS.contains(first) {
                return Err(VaultError::PathOutsideVault(relative.to_string()));
            }
        }

        // 临时文件（原子写中间产物）不合法作为笔记路径
        if TEMP_MARKERS.iter().any(|m| normalized.contains(m)) {
            return Err(VaultError::PathOutsideVault(relative.to_string()));
        }

        // 扩展名白名单
        let ext = segments
            .last()
            .and_then(|f| f.rsplit_once('.'))
            .map(|(_, e)| e.to_ascii_lowercase());
        match ext.as_deref() {
            Some(e) if NOTE_EXTENSIONS.contains(&e) => {}
            _ => {
                return Err(VaultError::PathOutsideVault(format!(
                    "不支持的扩展名: {relative}（仅 {}）",
                    NOTE_EXTENSIONS.join("/")
                )))
            }
        }

        Ok(Self(normalized))
    }

    /// 从磁盘绝对路径 + Vault 根，反推出 Vault 相对路径。
    /// 返回 None 表示该绝对路径不在 Vault 内或不是笔记文件。
    pub fn from_absolute(vault_root: &Path, absolute: &Path) -> Option<Self> {
        let rel = absolute.strip_prefix(vault_root).ok()?;
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let first = rel_str.split('/').next()?;
        if INTERNAL_DIRS.contains(&first) {
            return None;
        }
        NotePath::new(&rel_str).ok()
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// 父目录（Vault 相对，根为空字符串）。
    pub fn parent(&self) -> &str {
        match self.0.rfind('/') {
            Some(i) => &self.0[..i],
            None => "",
        }
    }

    /// 文件名（含扩展名）。
    pub fn file_name(&self) -> &str {
        match self.0.rfind('/') {
            Some(i) => &self.0[i + 1..],
            None => &self.0,
        }
    }

    /// 无扩展名主干（wikilink 解析的基础，后续阶段使用）。
    pub fn stem(&self) -> &str {
        let name = self.file_name();
        match name.rfind('.') {
            Some(i) => &name[..i],
            None => name,
        }
    }

    /// 拼接到磁盘绝对路径。
    pub fn join(&self, vault_root: &Path) -> std::path::PathBuf {
        // NotePath 构造时已拒绝绝对路径与 `..`，join 安全
        let mut p = vault_root.to_path_buf();
        for seg in self.0.split('/') {
            p.push(seg);
        }
        p
    }
}

impl std::fmt::Display for NotePath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// 磁盘扫描时的过滤谓词：该 entry 是否应被索引/显示。
/// 目录：跳过内部目录；文件：合法笔记路径才收。
pub fn is_internal_dir_name(name: &str) -> bool {
    INTERNAL_DIRS.contains(&name)
}

pub fn is_temp_file_name(name: &str) -> bool {
    TEMP_MARKERS.iter().any(|m| name.contains(m))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_normal_relative_paths() {
        assert!(NotePath::new("Transformer.md").is_ok());
        assert!(NotePath::new("notes/AI/Transformer.md").is_ok());
        assert!(NotePath::new("notes/论文精读/注意力.MARKDOWN").is_ok()); // 大写扩展名
        assert!(NotePath::new(r"notes\AI\Transformer.md").is_ok()); // 反斜杠归一
    }

    #[test]
    fn rejects_escape_and_absolute() {
        assert!(NotePath::new("../outside.md").is_err());
        assert!(NotePath::new("notes/../../outside.md").is_err());
        assert!(NotePath::new("C:/abs/path.md").is_err());
        assert!(NotePath::new("/abs/path.md").is_err());
        assert!(NotePath::new("").is_err());
    }

    #[test]
    fn rejects_internal_dirs_and_temp_files() {
        assert!(NotePath::new(".cyrene/index.db").is_err());
        assert!(NotePath::new(".cyrene/leak.md").is_err());
        assert!(NotePath::new(".obsidian/app.json").is_err());
        assert!(NotePath::new("notes/a.md.cyrene-tmp-123-abc").is_err());
        assert!(NotePath::new("notes/.a.md.cyrene-note-tmp-x").is_err());
    }

    #[test]
    fn rejects_non_note_extensions() {
        assert!(NotePath::new("img.png").is_err());
        assert!(NotePath::new("index.html").is_err());
        assert!(NotePath::new("noext").is_err());
        assert!(NotePath::new("data.json").is_err());
    }

    #[test]
    fn path_parts() {
        let p = NotePath::new("notes/AI/Transformer.md").unwrap();
        assert_eq!(p.parent(), "notes/AI");
        assert_eq!(p.file_name(), "Transformer.md");
        assert_eq!(p.stem(), "Transformer");
        let p2 = NotePath::new("README.md").unwrap();
        assert_eq!(p2.parent(), "");
    }

    #[test]
    fn join_stays_in_root() {
        let root = std::path::Path::new("E:/vault");
        let p = NotePath::new("notes/a.md").unwrap();
        let joined = p.join(root);
        assert_eq!(joined, std::path::Path::new("E:/vault/notes/a.md"));
    }

    #[test]
    fn from_absolute_roundtrip() {
        let root = std::path::Path::new("E:/vault");
        let abs = std::path::Path::new("E:/vault/notes/a.md");
        let p = NotePath::from_absolute(root, abs).unwrap();
        assert_eq!(p.as_str(), "notes/a.md");
        // 内部目录
        assert!(NotePath::from_absolute(
            root,
            std::path::Path::new("E:/vault/.cyrene/index.db")
        )
        .is_none());
        // Vault 外
        assert!(NotePath::from_absolute(root, std::path::Path::new("E:/other/a.md")).is_none());
    }
}
