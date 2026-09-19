//! IPC DTO —— specta derive 只允许出现在这一层。
//! vault-core / vault-engine 不知道 Specta 的存在；领域类型与 IPC 形状分离，
//! ContentHash 内部如何表示不泄漏给前端。

use specta::Type;
use serde::{Deserialize, Serialize};

use vault_engine::NoteSummary;
use vault_core::error::VaultError;

#[derive(Debug, Clone, Serialize, Type)]
pub struct NoteSummaryDto {
    /// Vault 相对路径，`/` 分隔
    pub path: String,
    /// 字节数（u32：单文件 4GB 上限对 Markdown 笔记足够）
    pub size: u32,
    /// 修改时间（Unix 毫秒，f64 承载至 2286 年无精度损失）
    pub modified_ms: f64,
}

impl From<NoteSummary> for NoteSummaryDto {
    fn from(s: NoteSummary) -> Self {
        Self {
            path: s.path.as_str().to_string(),
            size: s.size.min(u32::MAX as u64) as u32,
            modified_ms: s.modified_ms as f64,
        }
    }
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct ReadNoteResponse {
    pub path: String,
    /// 归一化后内容（LF、无 BOM）
    pub content: String,
    /// 原始磁盘字节 SHA-256（保存时作为 expected_hash 传回）
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct SaveNoteResponse {
    pub path: String,
    pub new_content_hash: String,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct VaultStatus {
    pub open: bool,
    /// Vault 根的绝对路径（未打开为 None）
    pub root: Option<String>,
}

/// 统一 IPC 错误。领域/IO 错误的具体类型永不穿越 IPC 边界。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "type")]
pub enum AppError {
    NotFound { path: String },
    AlreadyExists { path: String },
    Conflict { path: String, expected: String, actual: String },
    InvalidEncoding { path: String },
    PathOutsideVault { detail: String },
    VaultNotOpen,
    Io { detail: String },
}

impl From<VaultError> for AppError {
    fn from(e: VaultError) -> Self {
        match e {
            VaultError::NotFound(p) => AppError::NotFound { path: p },
            VaultError::AlreadyExists(p) => AppError::AlreadyExists { path: p },
            VaultError::Conflict { path, expected, actual } => AppError::Conflict { path, expected, actual },
            VaultError::InvalidEncoding(p) => AppError::InvalidEncoding { path: p },
            VaultError::BomPresent(p) => AppError::InvalidEncoding { path: p },
            VaultError::PathOutsideVault(d) => AppError::PathOutsideVault { detail: d },
            VaultError::VaultNotOpen => AppError::VaultNotOpen,
            VaultError::Io(io) => AppError::Io { detail: io.to_string() },
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(io: std::io::Error) -> Self {
        AppError::Io { detail: io.to_string() }
    }
}

// —— 命令请求参数 ——

#[derive(Debug, Clone, Deserialize, Type)]
pub struct SaveNoteRequest {
    pub path: String,
    pub content: String,
    pub expected_hash: String,
}

#[derive(Debug, Clone, Deserialize, Type)]
pub struct CreateNoteRequest {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize, Type)]
pub struct DiscardLocalRequest {
    pub path: String,
    /// 即将被丢弃的编辑器缓冲内容
    pub content: String,
}
