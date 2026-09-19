//! IPC 事件定义。载荷保持自足（带最终内容），前端不必二次读取。

use serde::{Deserialize, Serialize};
use tauri_specta::Event;

/// 文件树结构变化（新建/删除/重命名后触发前端刷新）
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Event)]
pub struct TreeChanged {
    /// 变化原因（提示性，非事实源）
    pub reason: String,
}

/// 单文件内容变化（watcher 阶段启用：外部修改热重载/冲突检测）
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Event)]
pub struct FileChanged {
    pub path: String,
    pub content_hash: String,
    pub content: String,
}
