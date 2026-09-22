//! lib 入口：注册 commands/events、装配 specta、暴露 bindings 生成入口。

use tauri_specta::{collect_commands, collect_events, Builder};

pub mod commands;
pub mod dto;
pub mod events;

pub fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            commands::vault_open,
            commands::vault_status,
            commands::vault_cover,
            commands::welcome_cover_write,
            commands::notes_list,
            commands::notes_read,
            commands::notes_backlinks,
            commands::notes_save,
            commands::notes_create,
            commands::notes_discard_local_and_reload,
            commands::notes_delete,
            commands::notes_rename,
            commands::notes_delete_dir,
            commands::notes_rename_dir,
        ])
        .events(collect_events![events::TreeChanged, events::FileChanged])
        .error_handling(tauri_specta::ErrorHandlingMode::Result)
}

/// 把 bindings.ts 导出到前端 src/lib/。由 export-bindings bin 与 CI 调用；
/// 不放在 run() 内——生成不依赖窗口生命周期。
/// 路径用编译期常量锚定到本仓库（bin 的 cwd 是 workspace 根，相对路径不可靠）。
pub fn export_bindings() -> Result<(), specta_typescript::Error> {
    let out = concat!(env!("CARGO_MANIFEST_DIR"), "\\..\\src\\lib\\bindings.ts");
    specta_builder().export(specta_typescript::Typescript::default(), out)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = specta_builder();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            use tauri::Manager;
            app.manage(commands::AppState {
                vault: std::sync::Mutex::new(vault_engine::VaultService::new()),
                watcher: std::sync::Mutex::new(None),
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Tauri 运行失败");
}
