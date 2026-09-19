# Cyrene Notes

高度适配 [Cyrene-Agent](../Cyrene-Agent) Learn 模式的本地 Markdown 笔记软件。Tauri 2 + React + CodeMirror 6 + Rust。

## 核心文档

- [docs/cyrene-vault-contract.md](docs/cyrene-vault-contract.md) —— 与 Cyrene-Agent 共享 Vault 的互操作契约（v1.0.0，已冻结）
- [docs/architecture.md](docs/architecture.md) —— 架构：三层 Rust crate、状态三权分立、关键流程

## 开发

```bash
npm install          # 前端依赖
npm run tauri dev    # 开发模式（自动编译 Rust + 前端）
npm run tauri build  # 发布构建

cargo test --workspace                                # Rust 测试
cargo run -p cyrene-note-app --bin export-bindings    # 重新生成 IPC bindings
npx tsc -b && npx vite build                          # 前端类型检查与构建
```

## 结构

```text
crates/vault-core     纯领域层（零 IO）：路径安全 / SHA-256 / 归一化 / 领域错误
crates/vault-engine   知识引擎：VaultService / 原子写 /（后续）watcher / SQLite / FTS5
src-tauri/            Tauri 壳：IPC DTO / commands / events（tauri-specta）
src/                  React 前端：文件树 / CM6 编辑器 / Zustand 协调态
```

依赖方向单向：`app → engine → core`。编辑器缓冲区永不过 IPC；磁盘真相的权威在 Rust。
