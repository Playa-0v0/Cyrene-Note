//! History 快照来源标记。写入 history 表，用于追溯版本是被谁、
//! 在哪个环节记录的。提示性字段，不参与任何裁决逻辑。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistorySource {
    /// Notes 自己保存产生的新版本
    NotesSave,
    /// watcher 检测到外部（Cyrene 等）修改
    ExternalChange,
    /// 索引扫描时读到的版本
    IndexScan,
    /// 打开文档时读到的版本
    Open,
    /// 冲突处理中被丢弃的本地版本（丢弃前抢救入链）
    ConflictDiscard,
}

impl HistorySource {
    pub fn as_str(&self) -> &'static str {
        match self {
            HistorySource::NotesSave => "notes-save",
            HistorySource::ExternalChange => "external-change",
            HistorySource::IndexScan => "index-scan",
            HistorySource::Open => "open",
            HistorySource::ConflictDiscard => "conflict-discard",
        }
    }
}

impl std::fmt::Display for HistorySource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}
