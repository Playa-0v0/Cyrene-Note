//! vault-engine —— 本地知识引擎。
//!
//! 拥有全部 IO 与 SQLite。依赖方向唯一：engine → core。

pub mod history;
pub mod service;
pub mod watcher;

pub use history::HistoryStore;
pub use service::{LinkIndex, NoteSummary, NoteDocument, VaultService};
pub use watcher::{DiskContent, ExternalChange, KnownVersions, WatcherService};
