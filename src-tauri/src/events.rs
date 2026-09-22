//! IPC 事件定义。载荷保持自足（带最终内容），前端不必二次读取。

use serde::{Deserialize, Serialize};
use tauri_specta::Event;

/// 文件树结构变化（新建/删除/重命名后触发前端刷新）
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Event)]
pub struct TreeChanged {
    /// 变化原因（提示性，非事实源）
    pub reason: String,
}

/// 单文件内容变化（外部修改热重载/冲突检测）。
/// disk_kind 三态：content = 正常内容（content 字段为归一化文本）；
/// deleted = 文件被外部删除；unreadable = 文件在但无法加载（非法 UTF-8 等）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Event)]
pub struct FileChanged {
    pub path: String,
    pub content_hash: String,
    /// 见结构体注释；与 content 字段联动：content 仅为 Some 当且仅当 kind == content
    pub disk_kind: DiskKind,
    pub content: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum DiskKind {
    Content,
    Deleted,
    Unreadable,
}
