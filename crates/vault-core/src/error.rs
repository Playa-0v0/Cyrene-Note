//! 领域错误。错误码字符串与 Cyrene-Agent 的 ObsidianError 对齐，
//! 双开排查时两边日志说同一种语言。

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("路径不在 Vault 内: {0}")]
    PathOutsideVault(String),

    #[error("文件不存在: {0}")]
    NotFound(String),

    #[error("文件已存在: {0}")]
    AlreadyExists(String),

    #[error("文件不是合法的 UTF-8: {0}")]
    InvalidEncoding(String),

    #[error("文件包含 BOM（契约要求 UTF-8 无 BOM）: {0}")]
    BomPresent(String),

    #[error("内容冲突: {path} 已被外部修改")]
    Conflict {
        path: String,
        expected: String,
        actual: String,
    },

    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),

    #[error("尚未打开 Vault")]
    VaultNotOpen,
}

pub type VaultResult<T> = Result<T, VaultError>;
