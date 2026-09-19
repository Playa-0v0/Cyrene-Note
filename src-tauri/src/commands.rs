//! Tauri commands —— 薄粘合层：DTO 进、engine 调用、DTO 出。
//! 业务逻辑一律在 vault-engine；这里只做映射。

use std::sync::Mutex;

use tauri::State;
use tauri_specta::Event;

use crate::dto::{
    AppError, BacklinkDto, CreateNoteRequest, DiscardLocalRequest, NoteSummaryDto, ReadNoteResponse,
    SaveNoteRequest, SaveNoteResponse, VaultStatus,
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
            let _ = FileChanged {
                path: change.path.clone(),
                content_hash: change.disk_hash.clone(),
                content: change.content.clone(),
            }
            .emit(&emitter);
            // 外部新建/删除文件会影响树结构
            let _ = TreeChanged { reason: "external".into() }.emit(&emitter);
        },
    )?;
    *state.watcher.lock().map_err(|_| AppError::Io {
        detail: "状态锁中毒".into(),
    })? = Some(watcher);

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

/// 冲突抢救：把即将被丢弃的本地版本写入 history（source=conflict-discard），
/// 然后前端再执行"重新读取"。契约 §4.5：丢弃前必须已入恢复存储。
#[tauri::command]
#[specta::specta]
pub fn notes_discard_local(
    state: State<'_, AppState>,
    req: DiscardLocalRequest,
) -> Result<SaveNoteResponse, AppError> {
    let svc = state.vault.lock().map_err(|_| AppError::Io {
        detail: "状态锁中毒".into(),
    })?;
    let hash = svc.discard_local(&req.path, &req.content)?;
    Ok(SaveNoteResponse {
        path: req.path,
        new_content_hash: hash.as_str().to_string(),
    })
}
