//! vault-engine —— 本地知识引擎。
//!
//! 拥有全部 IO 与 SQLite。依赖方向唯一：engine → core。
//! watcher / indexer / search / history 将在后续阶段加入此 crate。

pub mod service;

pub use service::{NoteSummary, VaultService};
