//! vault-core —— 领域层。
//!
//! 纯逻辑：零 IO、零 async。不知道 Tauri / SQLite / notify 的存在。
//! 这里是全仓库测试密度最高的一层。

pub mod error;
pub mod hash;
pub mod history_source;
pub mod normalize;
pub mod path;

pub use error::{VaultError, VaultResult};
pub use hash::ContentHash;
pub use history_source::HistorySource;
pub use path::NotePath;
