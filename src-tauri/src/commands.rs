//! Tauri commands —— 薄粘合层：DTO 进、engine 调用、DTO 出。
//! 业务逻辑一律在 vault-engine；这里只做映射。

use std::sync::Mutex;

use tauri::State;
use tauri_specta::Event;

use crate::dto::{
    AppError, CreateNoteRequest, NoteSummaryDto, ReadNoteResponse, SaveNoteRequest,
    SaveNoteResponse, VaultStatus,
};
use crate::events::TreeChanged;
use vault_engine::VaultService;

/// 全局状态。VaultService 当前是同步 IO；后续 watcher/indexer 加入时
/// 会升级为 engine 内部的 Tokio 运行时 + 通道，IPC 面不变。
pub struct AppState {
    pub vault: Mutex<VaultService>,
}

#[tauri::command]
#[specta::specta]
pub fn vault_open(state: State<'_, AppState>, root: String) -> Result<VaultStatus, AppError> {
    let mut svc = state.vault.lock().map_err(|_| AppError::Io {
        detail: "状态锁中毒".into(),
    })?;
    svc.open(std::path::Path::new(&root))?;
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
    let (content, hash) = svc.read_note(&path)?;
    Ok(ReadNoteResponse {
        path,
        content,
        content_hash: hash.as_str().to_string(),
    })
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
