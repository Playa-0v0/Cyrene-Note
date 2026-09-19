# Cyrene Notes 架构

| | |
|---|---|
| **版本** | 1.0.0 |
| **日期** | 2026-09-19 |
| **上游契约** | [cyrene-vault-contract.md](./cyrene-vault-contract.md) v1.0.0（已冻结） |
| **本文档定位** | 指导实现：边界、依赖方向、数据归属、关键流程。不写实现细节 |

## 1. Goals / Non-goals

**Goals**

- 高度适配 Cyrene-Agent Learn 模式的本地 Markdown 笔记软件（双开共存、实时热重载、冲突不丢内容）。
- Obsidian 级编辑体验：CM6 Live Preview、`[[wikilink]]`、backlinks、本地图谱。
- Vault 永远是纯文件夹，可被 Obsidian / VS Code / Git 直接打开。

**Non-goals（刻意不做）**

- 插件系统、多窗口多 Vault、移动端、协作 sync。
- frontmatter 深度解析（v1 透传）。
- rename 时的链接重写（契约 §7.3 v2 裁决）。
- 跨进程文件锁（Layer 0，观察到高频并发写再引入）。

## 2. System Context

```text
             Markdown Vault（文件夹，source of truth）
                    ▲           ▲
        读/写+watch │           │ obsidian_* 工具（tmp+rename 原子写）
                    │           │
             Cyrene Notes       Cyrene-Agent（Learn 模式）
          Tauri 2 + React        Electron + 内部 toolRegistry
```

双方不直接通信。全部协作通过文件系统 + SHA-256 乐观锁完成（契约 v1 §10.3：v0 零集成代码）。

## 3. Rust 三层

```text
app（src-tauri/，crate 名 cyrene-note-app）
  Tauri State / Commands / Events / 窗口 / 对话框 / DTO 映射
     ↓ 依赖
vault-engine（crates/vault-engine/）
  VaultService / 原子写 / History / Watcher / SQLite(FTS5) / Indexer /
  LinkResolver / BacklinkIndex / Search / Graph 投影
     ↓ 依赖
vault-core（crates/vault-core/）
  纯领域层：NotePath / ContentHash / Heading / WikiLink / Backlink /
  路径安全 / 归一化 / 章节语义 / wikilink 解析 / 领域错误
```

**依赖规则（硬约束，CI 检查）**

```text
允许：app → engine → core
禁止：core → Tauri / SQLite / notify / tokio / OS API
禁止：engine → Tauri / React / IPC 类型
禁止：任何层反向依赖
```

- `vault-core` 零 IO、零 async、可脱离磁盘全量单测。它是仓库中测试密度最高的代码。
- `vault-engine` 拥有全部 IO 与 SQLite；rusqlite 同步连接由专属 DB actor 线程持有（WAL），mpsc 收命令。
- `app` 薄到只有粘合：**业务逻辑绝不写进 command**，command 只做 `state.vault.xxx().await.map(Into::into)`。
- 三层结构同时支持未来 `CLI → engine`、`MCP Server → engine` 复用。

## 4. Frontend

```text
src/
├── lib/bindings.ts      # tauri-specta 生成，提交 Git，手改无效
├── stores/              # zustand：vault / doc / tab / search（协调态）
├── editor/              # CM6 装配（不掺 React；wikilink/livePreview/autosave/hotReload）
└── features/            # tree / search / backlinks / graph / learn / settings
```

**三权分立的状态模型（本架构最重要的单一决定）**

```text
Rust        = 磁盘真相的权威（baseHash / known version / 索引）
CodeMirror  = 缓冲区真相的权威（editorContent / selection / undo）
Zustand     = 协调态（dirty / externalChanged / 状态机位置）
```

推论：编辑器内容永不进 React state、永不过 IPC（保存时值传递）；Rust 永不持有缓冲区，save 后即忘。

## 5. Data Ownership

| 数据 | 归属 | 语义 |
|---|---|---|
| `*.md` 正文 | 用户 | canonical，唯一权威副本 |
| `.cyrene/index.db` | engine | derived，可删除可重建（FTS5/links/files） |
| `.cyrene/history/` | engine | recovery data，可删除但可能失去恢复能力 |
| `.cyrene/workspace.json` | app | 应用工作区状态 |
| 编辑器缓冲 | CodeMirror | 内存，不落盘不进索引 |

注意：history 的索引表放在 `.cyrene/history/index.db`，**不在** `index.db` 内——派生数据的重建流程（删 index.db 重建）绝不能触碰恢复数据（契约 §5.4）。

## 6. 保存流程（正常路径）

```text
Editor（CM6, autosave idle 800ms / blur）
  │ save(path, content, expected_hash)
  ▼
App IPC → VaultEngine.save_note
  │ 重读磁盘字节 → SHA-256
  ├── hash ≠ expected → Err(CONTENT_CONFLICT{remote_content}) ─→ UI 冲突流程
  └── hash = expected
        │ snapshot 新版本 → .cyrene/history/
        │ tmp + rename 原子写（LF、UTF-8 无 BOM）
        │ 更新 known version；索引入队
        ▼
      返回 new_hash → 前端更新 baseHash
```

## 7. 外部修改流程（Cyrene 写入）

```text
Cyrene obsidian_edit → tmp + rename
  ▼
notify 事件（可能多个）
  ▼
Rust 侧 debounce ~200ms（按 path 合并，不跨 IPC 抖动）
  ▼
读磁盘 → SHA-256 == known hash? → 是 → 丢弃（伪事件，含自保存回声）
  ▼ 否
snapshot 新版本（source=external-change）→ 索引入队
  ▼
emit file-changed {path, hash, content}
  ├── 文档干净 → dispatch 全文档 change（CM6 映射光标/滚动）
  └── 文档脏   → externalChanged = true，冲突横幅，autosave 挂起
```

## 8. 冲突模型

```text
            BASE（打开时已知版本，history 可取回）
           /    \
LOCAL（编辑器缓冲）   REMOTE（磁盘当前版本，watcher 已 snapshot）
           \    /
            冲突横幅：[保留我的版本] [使用磁盘版本] [比较修改]
```

- 进入冲突后禁止一切静默覆盖（包括 autosave）。
- 任何被丢弃版本先落 history（REMOTE 已 snapshot；LOCAL 丢弃前写 `conflict-discard`）。
- v1 提供三方视图 + 手动选择，不做自动 merge。

## 9. IPC Contract（tauri-specta）

- specta 的 derive 只出现在 `app` 层的 DTO 上；`vault-core`/`vault-engine` 不知道 Specta 存在。
- Domain model 与 IPC DTO 分离：`ContentHash` 内部可以是 `([u8;32])`，前端只见 `string`。rusqlite/notify/io 错误永不穿过 IPC，统一映射为 `AppError` 判别联合。
- `bindings.ts` 生成后提交 Git；CI 校验 `重新生成 → git diff --exit-code`。
- 版本精确 pin（`tauri-specta = "=2.0.0-rc.x"`），升级是显式决定。
- tauri-specta 只是 codegen，不是架构：移除它只影响 app IPC 层。

Command 面（vertical slice 起步集，后续扩展）：

```text
vault    open / status / close
notes    list_tree / read / create / save(path, content, expected_hash) / rename / delete
search   query
links    backlinks(path) / graph(scope)
history  versions(path) / restore(path, hash)
events   vault://file-changed {path, hash, content}
         vault://tree-changed
         vault://index-status
```

## 10. Search / Index

- SQLite FTS5 `trigram`（rusqlite `bundled`，保证 ≥3.34）；启动 probe，失败降级 LIKE。
- 查询 ≥3 字符 → trigram MATCH；<3 → 文件名/标题精确+前缀 + 正文 LIKE 回退。
- Indexer 按 `(path, hash)` 版本化去重；启动扫描 mtime+size 快路径，watcher 路径全量 hash。
- jieba 分词是 benchmark 驱动的后续优化，不进 v1。

## 11. Testing Strategy

| 层 | 策略 |
|---|---|
| vault-core | 纯函数单测（CRLF/BOM/章节边界/wikilink 全语法），测试密度最高 |
| vault-engine | tmpdir 集成测试（原子写、hash 冲突、history、watcher 往返） |
| app | IPC DTO 映射测试；commands 薄到基本不需要测 |
| 前端 | vitest：store 状态机、editor 装配逻辑 |
| 双实现风险 | `fixtures/` golden 文件同时被 `cargo test` 与 `vitest` 消费（wikilink/归一化/章节语义两侧断言一致） |

## 12. Vertical Slice（第一刀，本里程碑完成）

```text
选择 Vault（对话框）
  → Rust 校验并打开目录
  → walkdir 列出 .md（跳过 .cyrene/.obsidian/tmp）
  → React 文件树
  → 点击文件 → engine 读取（归一化管线 + hash）
  → CM6 显示
  → 编辑 → 带 expected_hash 保存
  → 原子写 → 返回 new_hash
```

此切片贯通 `React → typed IPC → app → engine → core → filesystem` 全链条。watcher、history、wikilink、conflict UI 均为后续向正确骨架上的增量。

## 13. Future Extensions

- CLI / MCP Server 复用 vault-engine（三 crate 的直接回报）。
- Layer 0 跨进程锁（`.cyrene/locks/`）。
- Learn 专属 UI（progress 面板 / materials 只读视图）。
- Cyrene enhanced bridge（localhost API，可选增强）。
