//! 独立导出 bin：`cargo run -p cyrene-note-app --bin export-bindings`
//! CI 校验 bindings 与提交版本一致（重新生成 → git diff --exit-code）。

fn main() {
    cyrene_note_app_lib::export_bindings().expect("导出 bindings.ts 失败");
    println!("bindings.ts 已导出到 src/lib/");
}
