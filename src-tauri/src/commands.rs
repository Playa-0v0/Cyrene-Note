//! Tauri commands —— 薄粘合层：DTO 进、engine 调用、DTO 出。
//! 业务逻辑一律在 vault-engine；这里只做映射。

use std::sync::Mutex;

use tauri::State;
use tauri_specta::Event;

use crate::dto::{
    AppError, BacklinkDto, CreateNoteRequest, DeleteDirRequest, DeleteNoteRequest,
    DiscardLocalRequest, NoteSummaryDto, PathChangesResponse, PathMove, ReadNoteResponse,
    RenameDirRequest, RenameNoteRequest, SaveNoteRequest, SaveNoteResponse, VaultStatus,
};
use crate::events::{FileChanged, TreeChanged};
use vault_engine::{VaultService, WatcherService};

/// 全局状态：VaultService + 当前 vault 的 watcher。
/// 换 Vault 时先 drop 旧 watcher 再 open。
pub struct AppState {
    pub vault: Mutex<VaultService>,
    pub watcher: Mutex<Option<WatcherService>>,
}

#[tauri::command]
#[specta::specta]
pub fn vault_open(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    root: String,
    create: Option<bool>,
) -> Result<VaultStatus, AppError> {
    // 先停旧 watcher（旧 vault 的事件不再有意义）
    {
        let mut w = state.watcher.lock().map_err(|_| AppError::Io {
            detail: "状态锁中毒".into(),
        })?;
        if let Some(mut old) = w.take() {
            old.stop();
        }
    }

    let mut svc = state.vault.lock().map_err(|_| AppError::Io {
        detail: "状态锁中毒".into(),
    })?;
    // 首启欢迎库场景：目录不存在时递归创建（create_dir_all 对已存在目录幂等）
    if create.unwrap_or(false) {
        std::fs::create_dir_all(&root).map_err(|e| AppError::Io {
            detail: format!("创建目录失败: {e}"),
        })?;
    }
    svc.open(std::path::Path::new(&root))?;

    // 启动 watcher：外部变更 → snapshot 已在 engine 内完成 → emit file-changed
    let root_path = std::path::PathBuf::from(svc.root()?.display().to_string());
    let history = svc.history()?;
    let known = svc.known_versions()?;
    let emitter = app_handle.clone();
    let watcher = WatcherService::start(
        root_path,
        known,
        history,
        move |change| {
            // DiskContent → (DiskKind, Option<content>)，三态不混语义
            let (disk_kind, content) = match change.disk {
                vault_engine::DiskContent::Content(c) => {
                    (crate::events::DiskKind::Content, Some(c))
                }
                vault_engine::DiskContent::Deleted => {
                    (crate::events::DiskKind::Deleted, None)
                }
                vault_engine::DiskContent::Unreadable => {
                    (crate::events::DiskKind::Unreadable, None)
                }
            };
            let _ = FileChanged {
                path: change.path.clone(),
                content_hash: change.disk_hash.clone(),
                disk_kind,
                content,
            }
            .emit(&emitter);
            // 外部新建/删除文件会影响树结构
            let _ = TreeChanged { reason: "external".into() }.emit(&emitter);
        },
    )?;
    *state.watcher.lock().map_err(|_| AppError::Io {
        detail: "状态锁中毒".into(),
    })? = Some(watcher);

    // 全量建反向链接索引：覆盖从未打开过的笔记
    if let Err(e) = svc.rebuild_all_links() {
        // 索引失败不应阻止 vault 打开；用户随时打开笔记会补建
        eprintln!("[cyrene-note] rebuild_all_links 失败: {e}");
    }

    Ok(VaultStatus {
        open: true,
        root: Some(root),
    })
}

#[tauri::command]
#[specta::specta]
pub fn vault_status(state: State<'_, AppState>) -> Result<VaultStatus, AppError> {
    let svc = state.vault.lock().map_err(|_| AppError::Io {
        detail: "状态锁中毒".into(),
    })?;
    Ok(VaultStatus {
        open: svc.is_open(),
        root: svc
            .root()
            .ok()
            .map(|p| p.display().to_string()),
    })
}

/// 找当前 Vault 根目录的封面图（welcome.*，png 优先），返回绝对路径（无则 null）。
#[tauri::command]
#[specta::specta]
pub fn vault_cover(state: State<'_, AppState>) -> Result<Option<String>, AppError> {
    let svc = state.vault.lock().map_err(|_| AppError::Io {
        detail: "状态锁中毒".into(),
    })?;
    Ok(svc.find_cover()?.map(|p| p.display().to_string()))
}

/// 把内嵌的欢迎库默认封面写到指定 vault 根目录（welcome.jpg）。
/// 已有同名文件则跳过（用户自定义的封面不被覆盖）；返回是否实际写入。
#[tauri::command]
#[specta::specta]
pub fn welcome_cover_write(root: String) -> Result<bool, AppError> {
    let path = std::path::Path::new(&root).join("welcome.jpg");
    if path.exists() {
        return Ok(false);
    }
    std::fs::write(&path, include_bytes!("../assets/welcome.jpg")).map_err(|e| AppError::Io {
        detail: format!("写入默认封面失败: {e}"),
    })?;
    Ok(true)
}

#[tauri::command]
#[specta::specta]
pub fn notes_list(state: State<'_, AppState>) -> Result<Vec<NoteSummaryDto>, AppError> {
    let svc = state.vault.lock().map_err(|_| AppError::Io {
        detail: "状态锁中毒".into(),
    })?;
    Ok(svc.list_notes()?.into_iter().map(Into::into).collect())
}

#[tauri::command]
#[specta::specta]
pub fn notes_read(state: State<'_, AppState>, path: String) -> Result<ReadNoteResponse, AppError> {
    let svc = state.vault.lock().map_err(|_| AppError::Io {
        detail: "状态锁中毒".into(),
    })?;
    let doc = svc.read_note_full(&path)?;
    Ok(ReadNoteResponse::from(doc))
}

#[tauri::command]
#[specta::specta]
pub fn notes_backlinks(state: State<'_, AppState>, target: String) -> Result<Vec<BacklinkDto>, AppError> {
    let svc = state.vault.lock().map_err(|_| AppError::Io {
        detail: "状态锁中毒".into(),
    })?;
    Ok(svc
        .backlinks(&target)
        .into_iter()
        .map(|(source_path, link)| BacklinkDto {
            source_path,
            target: link.target,
            heading: link.heading,
            alias: link.alias,
        })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub fn notes_save(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    req: SaveNoteRequest,
) -> Result<SaveNoteResponse, AppError> {
    let svc = state.vault.lock().map_err(|_| AppError::Io {
        detail: "状态锁中毒".into(),
    })?;
    let new_hash = svc.save_note(&req.path, &req.content, &req.expected_hash)?;
    // 文件树可能因首保存/目录新建而变化；tree-changed 让前端刷新
    TreeChanged { reason: "save".into() }.emit(&app_handle).ok();
    Ok(SaveNoteResponse {
        path: req.path,
        new_content_hash: new_hash.as_str().to_string(),
    })
}

#[tauri::command]
#[specta::specta]
pub fn notes_create(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    req: CreateNoteRequest,
) -> Result<SaveNoteResponse, AppError> {
    let svc = state.vault.lock().map_err(|_| AppError::Io {
        detail: "状态锁中毒".into(),
    })?;
    let new_hash = svc.create_note(&req.path, &req.content)?;
    TreeChanged { reason: "create".into() }.emit(&app_handle).ok();
    Ok(SaveNoteResponse {
        path: req.path,
        new_content_hash: new_hash.as_str().to_string(),
    })
}

/// 把"抢救 LOCAL"和"重读磁盘最新版本"合成一次原子操作：
/// 1. 先把 LOCAL 写入 history（source=conflict-discard）——失败则整条 Err
/// 2. 再读取磁盘当前内容
/// 单次调用的保证：snapshot 失败时 LOCAL 不会被丢弃、磁盘内容也不会被错读；
/// 前端拿到 Err 时缓冲区保持不变，状态机仍为 conflict。
#[tauri::command]
#[specta::specta]
pub fn notes_discard_local_and_reload(
    state: State<'_, AppState>,
    req: DiscardLocalRequest,
) -> Result<ReadNoteResponse, AppError> {
    let svc = state.vault.lock().map_err(|_| AppError::Io {
        detail: "状态锁中毒".into(),
    })?;
    let doc = svc.discard_local_and_reload(&req.path, &req.content)?;
    Ok(ReadNoteResponse::from(doc))
}

/// 删除笔记。内容已先抢救进 history，可恢复。
#[tauri::command]
#[specta::specta]
pub fn notes_delete(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    req: DeleteNoteRequest,
) -> Result<PathChangesResponse, AppError> {
    let svc = state.vault.lock().map_err(|_| AppError::Io {
        detail: "状态锁中毒".into(),
    })?;
    svc.delete_note(&req.path)?;
    TreeChanged { reason: "delete".into() }.emit(&app_handle).ok();
    Ok(PathChangesResponse {
        moved: vec![],
        deleted: vec![req.path],
    })
}

/// 重命名/移动笔记。返回旧→新映射，前端更新打开的编辑器。
#[tauri::command]
#[specta::specta]
pub fn notes_rename(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    req: RenameNoteRequest,
) -> Result<PathChangesResponse, AppError> {
    let svc = state.vault.lock().map_err(|_| AppError::Io {
        detail: "状态锁中毒".into(),
    })?;
    svc.rename_note(&req.from, &req.to)?;
    TreeChanged { reason: "rename".into() }.emit(&app_handle).ok();
    Ok(PathChangesResponse {
        moved: vec![PathMove { from: req.from, to: req.to }],
        deleted: vec![],
    })
}

/// 删除目录：目录下所有笔记先抢救进 history 再整体移除。
#[tauri::command]
#[specta::specta]
pub fn notes_delete_dir(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    req: DeleteDirRequest,
) -> Result<PathChangesResponse, AppError> {
    let svc = state.vault.lock().map_err(|_| AppError::Io {
        detail: "状态锁中毒".into(),
    })?;
    let deleted = svc.delete_dir(&req.dir)?;
    TreeChanged { reason: "delete-dir".into() }.emit(&app_handle).ok();
    Ok(PathChangesResponse { moved: vec![], deleted })
}

/// 重命名目录：目录下全部笔记路径前缀替换，返回受影响映射。
#[tauri::command]
#[specta::specta]
pub fn notes_rename_dir(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    req: RenameDirRequest,
) -> Result<PathChangesResponse, AppError> {
    let svc = state.vault.lock().map_err(|_| AppError::Io {
        detail: "状态锁中毒".into(),
    })?;
    let moved = svc.rename_dir(&req.from, &req.to)?;
    TreeChanged { reason: "rename-dir".into() }.emit(&app_handle).ok();
    Ok(PathChangesResponse {
        moved: moved
            .into_iter()
            .map(|(from, to)| PathMove { from, to })
            .collect(),
        deleted: vec![],
    })
}
