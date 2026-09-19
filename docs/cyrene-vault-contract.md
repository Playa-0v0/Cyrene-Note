# Cyrene Vault Contract

| | |
|---|---|
| **版本** | 1.0.0 |
| **状态** | Frozen（已冻结） |
| **日期** | 2026-09-19 |
| **参与方** | Cyrene Notes（本仓库）、Cyrene-Agent（`E:\Cyrene-Agent`）Learn 模式 |
| **权威副本** | 本文件。Cyrene-Agent 侧文档以引用本版本号为准 |

---

## 0. 摘要

> Markdown 文件是笔记正文的唯一权威副本；`.cyrene/` 是可删除的派生数据与恢复数据；两个应用通过文件系统 + SHA-256 乐观锁协作，永不静默覆盖对方。

Cyrene Notes 与 Cyrene-Agent Learn 模式共享同一个 Vault 目录。本契约规定双方对这个目录的全部互操作义务，使以下场景成立：

- 任意一方不在线，另一方功能完整可用；
- Vault 可以随时被 Obsidian / VS Code / Typora / Git 直接打开；
- 最坏情况是「需要从恢复数据中找回版本」，而不是「永久丢失笔记」。

## 1. 术语与规范词汇

规范词汇按 RFC 2119：**MUST / MUST NOT / SHOULD / SHOULD NOT / MAY**。

| 术语 | 定义 |
|---|---|
| Vault | 一个根目录，内含用户的全部笔记与 `.cyrene/` 内部数据 |
| 正式内容（canonical content） | Vault 内的 Markdown 文件。唯一权威副本 |
| 派生数据（derived data） | 可删除、可从正式内容完整重建的数据（SQLite 索引等） |
| 恢复数据（recovery data） | 可删除，但删除后可能失去恢复历史版本能力的数据（history） |
| 磁盘版本 | 某一时刻文件在磁盘上的原始字节 |
| 已知版本（known version） | 某方最后一次成功读到的完整版本，由 `(path, hash)` 标识 |
| 笔记扩展名（互操作集合） | `.md` / `.markdown` / `.mdown` / `.mdx`（与 Cyrene 白名单一致） |

## 2. 核心原则

1. **Markdown 是 source of truth。** SQLite、缓存、history 都不是正文副本。索引损坏或删除 MUST NOT 影响任何 `.md` 文件。
2. **松耦合。** 任何一方的完整功能 MUST NOT 依赖另一方正在运行。Cyrene Learn 在 Notes 未运行时 MUST 保持完全可用；反之亦然。
3. **修契约，不绕实现。** 两个项目同属一个所有者。当一方的实现细节妨碍契约时，修改该实现，而不是让另一方永久规避。
4. **字节级诚实。** 双方对「文件内容是什么」的判断只依赖原始磁盘字节与其 SHA-256，不依赖事件、时间戳或内存印象。

## 3. Vault 格式规范

### 3.1 编码、BOM 与行尾

- 编码：**MUST** 为合法 UTF-8 字节序列。
- BOM：**MUST NOT** 存在。
- 行尾：**MUST** 为 LF（`\n`）。

依据（已对 Cyrene 源码验证）：

- Cyrene 的标题正则 `^(#{1,6})\s+(.+)$`（`obsidian-markdown.ts`）在 CRLF 行上永不匹配（JS 的 `.` 不匹配 `\r`），导致 CRLF 文件的全部章节操作（`read_section` / `replace_section` / `append_to_section`）失效。
- BOM 会使第一行的标题匹配失败（`#` 不在行首）。
- 非法 UTF-8 字节会被 Node 的 utf8 解码替换为 U+FFFD，导致双方 hash 不一致（见 3.2）。

**读取容错**：Notes 加载文件时 MUST 容忍违规文件（剥 BOM、CRLF/CR 归一为 LF 后进编辑器），同时向用户提示格式异常。归一化重写 MUST NOT 丢失内容，且重写前原始字节版本 MUST 先进入恢复存储（见 §5.1）。

### 3.2 内容 Hash

- 内容 hash **MUST** 定义为：对原始磁盘字节的 SHA-256，十六进制小写。
- 已验证：Cyrene 的 `contentHash()`（`obsidian-markdown.ts:29`）经 `fs.readFile(path, "utf8")` 读入后 hash，对合法 UTF-8 无 BOM 内容与逐字节 SHA-256 完全等价。Notes 侧 `sha256(fs::read(path))` 可直接互换校验。
- hash 是版本变更的**最终事实**。事件、mtime、大小都只是提示（见 §4.2）。

### 3.3 原子写入与临时文件

- 所有对正式内容的写入 **MUST** 走同目录临时文件 + rename 的原子写。任何一方 MUST NOT 出现「读到对方半截文件」的可能。
- 临时文件命名：

```text
Cyrene Notes:  .<filename>.cyrene-note-tmp-<uuid>
Cyrene-Agent:  <filename>.cyrene-tmp-<ts>-<rand>
```

- 双方的 watcher 与索引 **MUST** 忽略：`.cyrene/`、`.obsidian/`、`*.cyrene-tmp-*`、`.*.cyrene-note-tmp-*`。
- 临时文件 **MUST NOT** 进入：文件树、搜索索引、backlinks、graph。
- 写入失败的临时文件 MUST 被清理。

### 3.4 文件句柄纪律

- Notes（以及任何长期驻留进程）**MUST NOT** 长期持有 Vault 文件的打开句柄，读完即关。此规则将 Windows 上的共享冲突整类消除。

### 3.5 加载与保存管线（规范流程）

加载：

```text
raw disk bytes
  ├─ SHA-256 ────────────→ diskHash（与 Cyrene 逐字节一致）
  └─ UTF-8 校验（非法 → 报错，不静默替换）
       ↓
   剥 BOM（如有）
       ↓
   CRLF / CR → LF
       ↓
   snapshot 原始字节版本 → .cyrene/history/   （见 §5.1，先于任何重写）
       ↓
   editor
```

保存（Notes）：

```text
editor content（已为 LF）
  ↓
UTF-8 编码，无 BOM
  ↓
冲突预检：重读磁盘字节，hash MUST == baseHash，否则转入冲突流程（§4.5）
  ↓
写同目录临时文件 → rename 覆盖目标
  ↓
计算新字节 hash → 更新已知版本 → 追加 history 行（source = notes-save）
  ↓
emit 变更事件
```

## 4. 并发与冲突模型

### 4.1 写入纪律（双方共同遵守）

对已有文件的修改 **MUST** 携带 `expectedContentHash`（ optimistic lock）：读 → 拿 hash → 写时校验 → 不匹配则拒绝并要求重读。

- 创建新文件：默认 `mustNotExist`，目标已存在 MUST 拒绝。
- 覆盖已有文件：只能通过显式的例外操作（如 `overwrite_existing`，仍须携带 `expectedContentHash`）。
- 历史上 Cyrene 的实现曾以 advisory hash + `create` 静默覆盖；Cyrene Vault Contract v1 已将该行为升级为强制（C1/C2，于 2026-09-19 合入 `c6a8d3d9`）。

> Cyrene 的写入粒度：每次 `obsidian_edit` 调用 = 一次完整的 tmp+rename 原子替换。不存在流式写文件；「实时写入」是离散的版本跳变序列。

### 4.2 Watcher 事件语义

- 文件系统事件 ≠ 修改。一次原子写 **MAY** 产生多个事件。
- 处理模型（Notes，Rust 侧执行）：

```text
events
  ↓ 按 path debounce / coalesce（默认 ~200ms，Rust 内完成，不跨 IPC）
读取最终磁盘内容 → 计算 hash
  ↓ hash == 已知 hash？ → 是 → 丢弃（伪事件）
  ↓ 否
snapshot 新版本 → history 行（source = external-change）
  ↓
分派：
  · 文档已打开且干净 → 热重载（§4.4）
  · 文档已打开且脏   → externalChanged = true（§4.5）
  · 未打开           → 仅更新索引
```

- 删除事件：从索引移除；history 保留。
- 重命名在多数平台上表现为 delete + create，按此处理；rename 检测 MAY 后补。

### 4.3 文档状态机

每个打开的文档维护：

```ts
interface DocumentState {
  path: string
  baseContent: string      // 上次已知磁盘版本（LF 归一化后）
  baseHash: string         // 该版本的原始字节 SHA-256
  editorContent: string    // 当前编辑器缓冲
  dirty: boolean           // editorContent !== baseContent
  externalChanged: boolean // 磁盘 hash ≠ baseHash 且 dirty
}
```

```text
        open(path)  ── 读盘、hash、snapshot-on-sight
             │
             ▼
        ┌────────┐  用户输入   ┌────────┐
        │ CLEAN  │ ─────────→ │ DIRTY  │ ──autosave 成功──→ CLEAN
        └────────┘            └────────┘
             │                     │
   watcher: 磁盘 hash 变   watcher: 磁盘 hash 变
             │                     │
             ▼                     ▼
        热重载 → CLEAN      ┌──────────┐
                             │ CONFLICT │（禁止 autosave）
                             └──────────┘
                                   │ 用户三选一（§4.5）
                                   ▼
                                 CLEAN
```

### 4.4 热重载（clean + external change）

- **MUST NOT** 用新 `EditorState` 整体替换编辑器；MUST dispatch 全文档 change，让 CM6 自动映射 selection 与滚动位置：

```ts
view.dispatch({ changes: { from: 0, to: doc.length, insert: newContent } })
```

- Cyrene 最常见的写入是 `append_to_section`（章节末尾追加），此路径下光标位置应几乎不动。
- **SHOULD** 提供跟随模式：用户未在编辑且视口接近底部时，新内容到达自动滚动到底——「开着笔记看昔涟写」是正式产品体验。

### 4.5 冲突处理（dirty + external change）

进入 CONFLICT 后 **MUST NOT** 任何形式的静默覆盖（包括 autosave）。呈现三方版本：

```text
BASE    打开时的已知版本（history 可取回）
LOCAL   编辑器缓冲（内存）
REMOTE  磁盘当前版本（watcher 已读入并 snapshot）
```

v1 交互（不要求自动 3-way merge）：

```text
Cyrene 修改了这篇笔记
[保留我的版本]  [使用磁盘版本]  [比较修改]
```

- 任一方向的丢弃发生前，被丢弃版本 **MUST** 已进入恢复存储（REMOTE 已由 watcher snapshot；LOCAL 若被丢弃，丢弃前以 source = `conflict-discard` 写入）。
- 「比较修改」进入 diff 视图手工合并，v1 **MAY** 用简单文本 diff，v2 **MAY** 升级为结构感知 merge。

### 4.6 TOCTOU 与跨进程锁（Layer 0，暂缓）

即使 hash 强制校验，「读 → 校验 → 写」之间仍存在理论竞态窗口。彻底解法是 `.cyrene/locks/` 下的跨进程 per-file 锁协议，双方共同遵守。**本契约暂不启用**（不卡 v0）；当观察到双进程高频并发写时作为 Layer 0 引入，届时升版为 v2。

## 5. Recovery History

### 5.1 快照时机：Snapshot on Sight

「watcher 事后保存旧版本」不成立——rename 之后旧版本在文件系统上已不存在。唯一可靠来源是各方「自己见过的版本」。

规则（Notes）：

> **任何一次成功读到的完整磁盘版本，当场写入 content-addressed store 并记入版本链。**

自然挂钩点：indexer 索引读取、打开文档读取、watcher 变更读取、归一化重写前、冲突丢弃前。自己保存的新版本同样入链（source = `notes-save`）。

已知版本状态因此退化为 `(path, hash)` 两个字段——字节永远可以从 store 取回。

### 5.2 存储布局

```text
.cyrene/
└── history/
    └── objects/
        ├── a8/4ef0….zst        # 内容寻址：sha256 分片 + zstd 压缩
        └── f9/1b2c….zst
```

索引表（位于 `index.db`）：

```sql
CREATE TABLE history (
  path   TEXT NOT NULL,     -- Vault 相对路径，/ 分隔
  hash   TEXT NOT NULL,     -- sha256，即对象文件名
  ts     INTEGER NOT NULL,  -- unix ms
  source TEXT NOT NULL,     -- notes-save | external-change | index-scan | open | conflict-discard
  PRIMARY KEY (path, hash, ts)
);
```

- 相同内容 hash 相同，天然去重，重复入链零对象成本。
- 写入顺序：先对象文件，后 DB 行；崩溃残留的孤儿对象由 GC 清理，无害。

### 5.3 数据保留与 GC

- **SHOULD** 保留：每路径最近 ≥20 个版本，且默认 30 天内版本；参数用户可配。
- 编辑器 autosave 产生的大量中间版本在 v1 全量入链（去重后成本可忽略），不为它做合并。
- GC **MUST** 只删除「无任何 history 行引用」的对象文件。

### 5.4 语义：Recovery Data

History 是**恢复数据**，不是 cache：

> `.cyrene/history/` SHOULD 被维护。用户 MAY 删除它。删除它 MUST NOT 影响当前正式内容，但 MAY 失去恢复既往版本的能力。

### 5.5 能力边界

- Notes 未运行期间发生的外部覆盖，Notes 的 watcher 无法事后恢复旧版本。该场景的保护归 Layer 1（Cyrene 写契约强化）管辖；跨进程锁（Layer 0）引入后进一步收紧。
- 此边界 MUST 在产品文档中向用户如实说明。

## 6. 目录约定

### 6.1 `.cyrene/` 内部目录

```text
.cyrene/
├── index.db          # SQLite：FTS5、links、backlinks、history 行（派生数据，可重建）
├── workspace.json    # 应用工作区状态
├── history/          # 恢复数据（§5）
└── locks/            # Layer 0 预留，v1 不使用
```

- `.cyrene/` 内 **MUST NOT** 存在任何笔记扩展名文件（一旦出现 `.md` 会泄漏进 Cyrene 的文件列表）。
- Cyrene 侧路径保护现在双向覆盖 `.obsidian/` 与 `.cyrene/`（C2，于 2026-09-19 合入 `c6a8d3d9`）。

### 6.2 Learn 工作区布局（learn-layout v1）

由 Cyrene 的 prompts 与 `vault-init.ts` 定义语义，Notes 渲染但 **MUST NOT** 改变语义：

```text
Vault/
├── materials/          # 原始学习资料。Cyrene 默认只读
├── notes/              # 共同维护的学习笔记（按科目建子目录）
├── exercises/          # 练习、测验、错题、复盘
├── exams/              # 正式试卷（cyrene-exam-paper 流程）
├── templates/          # topic / review / outline 模板
├── learn/
│   ├── progress.md     # 进度总览，Cyrene 每轮静默维护
│   └── outline.md      # 首次导学生成；存在即代表已建大纲
└── .cyrene/
```

- Cyrene 的 bootstrap 创建 8 个文件（README ×4、templates ×3、`learn/progress.md`），`outline.md` 与 `exams/` 不在 bootstrap 内。
- 布局变更由 Cyrene 发起并升版（learn-layout v2…），本契约同步记录。

### 6.3 Learn 目录的写入规则

- 「`materials/` 默认只读」是约束 Cyrene（agent）的行为规则。Notes 作为用户的编辑器 **MUST NOT** 硬性禁止用户编辑任何文件；**MAY** 提供与该规则一致的 UI 提示。
- Notes **SHOULD** 为 `learn/`、`materials/`、`exercises/` 提供一等公民 UI（进度面板渲染 `learn/progress.md` 等），此为产品差异化项，非互操作义务。

### 6.4 空 Vault 判定（Learn bootstrap）

- Cyrene 的 `isEmptyDirectory` 判定 **MUST** 忽略 `.cyrene/`（与 `.obsidian/` 同等对待），使 Notes 先建 `.cyrene/` 后 Cyrene 仍能自动初始化 Learn 结构。
- 历史上实现只忽略 `.DS_Store` / `Thumbs.db` / `.obsidian`，该缺口已于 C1 合入（2026-09-19，`c6a8d3d9`）。

## 7. Wikilink

### 7.1 v1 语法集

```text
[[Note]]
[[Note|Alias]]
[[Note#Heading]]
[[Folder/Note]]
[[Folder/Note|Alias]]
```

### 7.2 语法树（Lezer / CM6）

Wikilink **MUST** 以 `@lezer/markdown` inline 解析扩展实现（非 ViewPlugin 正则扫描），语法与解析共享同一棵树：

```text
WikiLink
├── WikiLinkMark "[["
├── WikiLinkTarget
├── WikiLinkAlias      （可选，含 "|" mark）
└── WikiLinkMark "]]"
```

高亮、点击跳转、自动补全、Live Preview、rename 重构、graph 索引全部消费同一语法定义。

### 7.3 解析语义（v2 待定项）

以下属 link resolution，依赖索引，**v1 不裁决**，留待实现期决定并在此登记：

- 重名笔记（两个 `Note.md`）的解析优先级；
- 大小写敏感性（Windows 文件系统大小写不敏感 vs 链接文本大小写敏感）；
- rename 后的链接更新策略（`[[a]]` 目标改名时是否重写链接文本）；
- 不存在目标（虚链）的渲染与索引；
- `#heading` anchor 的归一化规则（空格/大小写/重复标题）。

## 8. 搜索

- **v1**：SQLite FTS5 `trigram` tokenizer。
  - 查询 ≥3 字符 → trigram MATCH；
  - 查询 <3 字符 → 文件名/标题精确与前缀匹配 + 正文 LIKE 回退（个人 Vault 规模下线性扫描可接受）。
- 依赖 **MUST** 用 `rusqlite` 的 `bundled` feature（保证 SQLite ≥ 3.34，trigram 最低版本），并在启动时做能力探测：

```sql
CREATE VIRTUAL TABLE temp.__fts5_probe USING fts5(content, tokenize='trigram');
```

探测失败 → 降级为 LIKE 全量路径，不崩溃、不玄学。

- jieba-rs 分词索引为**Benchmark 驱动的后续优化**，v1 不引入。

## 9. 章节操作语义（与 Cyrene 对齐）

若 Notes 将来向 Cyrene 或自身暴露章节级编辑，语义 **MUST** 与 `obsidian-markdown.ts` 逐条一致：

- 标题识别：`^(#{1,6})\s+(.+)$`（`#` 与文字间必须有空格）；
- 标题路径：级别栈，遇到同级或更高级标题弹栈；
- 匹配要求：完整路径相等；零匹配 = NOT_FOUND，多匹配 = AMBIGUOUS（拒绝执行）；
- `replace_section` 边界：不含子章节 → 下一个任意级标题；含子章节 → 下一个同级或更高级标题；
- 写回规整：尾部多个换行收敛为一个（`/\n+$/ → "\n"`）；
- `append_to_section`：在含子章节的章节末尾插入，前以空行分隔；
- `append`：目标不以 `\n` 结尾时先补一个。

## 10. Cyrene-Agent 侧契约

### 10.1 现有工具面（已验证，Learn 模式独占注册）

`obsidian_list_files` / `obsidian_search` / `obsidian_read_file` / `obsidian_read_section` / `obsidian_edit`（create | replace_file | append | replace_section | append_to_section）/ `obsidian_open_note`。

路径安全：拒绝绝对路径、`..` 逃逸、symlink 逃逸、写 `.obsidian/`。

### 10.2 变更清单（Cyrene-Agent 仓库待办）

| # | 变更 | 位置 | 量级 |
|---|---|---|---|
| ~~C1~~ ✅ 已合入（`c6a8d3d9`，2026-09-19） | `isEmptyDirectory` 忽略集合加入 `.cyrene` | `src/main/learn/obsidian/vault-init.ts` | ~3 行 |
| ~~C2~~ ✅ 已合入（`c6a8d3d9`，2026-09-19） | 写契约强化：① modify 类操作 `expectedContentHash` 必填（TS 类型 + 运行时双重强制，新增 `CONTENT_HASH_REQUIRED` 错误码），缺失即拒绝；② `create` 无条件拒绝已存在目标（`mustNotExist` 参数移除）；③ `resolveSafe` 与 `listFiles` 读写双向保护 `.cyrene/`；④ `saveProgress()` 同步改为读→拿 hash→写；⑤ 工具描述与 `learn_system.md` 措辞升为"必须"。附带新增 `obsidian-workspace-service.test.ts`（17 例，该目录此前零测试） | `obsidian-tools.ts` + `obsidian-workspace-service.ts` + `learn-progress-service.ts` + `prompts/learn_system.md` | 已完成 |
| C3 | 契约文档化：临时文件 pattern `*.cyrene-tmp-*` 与 hash 语义在 Cyrene 侧文档登记并引用本契约版本 | docs | 文档 |
| C4 | `obsidian_open_note` → `note_open` provider 抽象（`ObsidianProvider` → `obsidian://`；`CyreneNotesProvider` → `cyrene-notes://`），默认 opener 可配置 | `obsidian-open.ts` / `obsidian-tools.ts` | 小，早期但不卡 v0 |

C1、C2 已于双开并发验证（开发顺序第 7 步）之前合入，符合计划。原设计中"③ 显式 `overwrite_existing` 作为唯一覆盖通道"经实现时评估暂缓：当前不存在覆盖已有文件的合法场景，`replace_file`（带 hash）已覆盖其需求；如未来出现，以 minor 版本补充。

### 10.3 桥接演进路线

```text
v0  共享 Vault（零集成代码，本契约即全部接口）
v1  + Notes 可选 localhost HTTP API（FTS5 / graph / index 查询）
     Cyrene 新增 note_search 工具：发现 API 在线则用之，否则回退现有全量扫描
v2  + 若 Cyrene 引入统一工具协议（MCP client），再包装接入
```

不变式：**桥接永远是增强，不是依赖。** Notes 未运行时 Cyrene Learn MUST 保持完全可用。

## 11. 冻结契约总表

| # | 项目 | 规则 |
|---|------|------|
| 1 | 正式内容 | `.md` 等笔记扩展名文件是正文唯一权威副本（MUST） |
| 2 | 编码 | UTF-8 合法字节序列（MUST） |
| 3 | BOM | MUST NOT |
| 4 | 行尾 | LF（MUST）；读取容错归一，重写前先 snapshot 原始版本 |
| 5 | 内容 hash | SHA-256 over raw disk bytes（MUST） |
| 6 | 已有文件修改 | MUST 携带 expectedContentHash（Cyrene 侧 C2 落实） |
| 7 | 创建 | 默认 mustNotExist；覆盖走显式例外操作 |
| 8 | 原子写入 | tmp + rename（MUST） |
| 9 | 临时文件 | `*.cyrene-tmp-*` / `.*.cyrene-note-tmp-*` 双方忽略，不入任何索引（MUST） |
| 10 | 事件语义 | 事件只是提示，hash 比较为最终事实；Rust 侧 debounce（MUST） |
| 11 | 干净缓冲 + 外部变更 | 热重载，dispatch 全文档 change 保光标/滚动（MUST/SHOULD 跟随模式） |
| 12 | 脏缓冲 + 外部变更 | MUST NOT 静默覆盖；冲突流程三方版本（BASE/LOCAL/REMOTE） |
| 13 | 丢弃保护 | 任一版本被丢弃前 MUST 已入恢复存储 |
| 14 | Recovery history | SHOULD 维护于 `.cyrene/history/`，snapshot-on-sight，内容寻址去重 |
| 15 | History 语义 | Recovery Data：可删除；删除不影响正式内容，但可能失去恢复能力 |
| 16 | History 边界 | Notes 离线期间的外部覆盖不担保可恢复，须向用户说明 |
| 17 | 内部目录 | `.cyrene/`；其内 MUST NOT 有笔记扩展名文件 |
| 18 | SQLite | 派生数据，可删除可重建（MUST） |
| 19 | 文件句柄 | 读后即关，禁止长期持有（MUST） |
| 20 | 笔记扩展名 | `.md` `.markdown` `.mdown` `.mdx`（互操作集合） |
| 21 | Wikilink 语法 | §7.1 五种形式；Lezer inline 扩展实现 |
| 22 | Learn bootstrap | `.cyrene/` 不影响空 Vault 判定（Cyrene 侧 C1 落实） |
| 23 | Learn 布局 | learn-layout v1，§6.2；语义归 Cyrene，Notes 只渲染 |
| 24 | 打开笔记 | provider 抽象，长期演进为 `note_open`（C4） |
| 25 | AI 桥接 | 可选增强，非依赖；任何一方离线另一方完整可用（MUST） |
| 26 | 章节语义 | 若暴露章节编辑，MUST 与 §9 逐条对齐 |
| 27 | 跨进程锁 | Layer 0 预留 `.cyrene/locks/`，v1 不启用 |

## 12. 安全模型分层

```text
Layer 0（预留）  .cyrene/locks/ 跨进程 per-file lock —— 消除 TOCTOU，v2 引入
Layer 1         expectedContentHash 乐观锁 —— 修改必带 hash，创建必防覆盖
Layer 2         原子写入（tmp + rename）—— 不存在半截读
Layer 3         Notes 冲突检测 —— 脏缓冲 + 外部变更 → 横幅，绝不静默覆盖
Layer 4         Recovery history —— snapshot-on-sight，内容寻址
```

目标底线：即使模型某一次未按预期调用工具，最坏情况从「永久丢笔记」降级为「需要从 Recovery 恢复」。

## 13. 架构与开发顺序（参考）

技术栈：Tauri 2 + React + TypeScript + Vite / CodeMirror 6 + Lezer / Zustand / Graphology + Sigma.js；Rust 侧 Tokio + Serde + thiserror + notify + walkdir + rusqlite(bundled)。Rust 只做本地知识引擎（文件、监听、索引、SQLite、FTS5、双链、后台任务），TS 负责编辑、渲染、交互、图谱、UI 状态。

```text
 0. Cyrene Vault Contract（本文件）            ← 已完成
 1. Tauri + React shell
 2. Rust VaultService
 3. File tree
 4. CodeMirror Markdown
 5. LF + SHA-256 + atomic save（§3.5 管线）
 6. File watcher（§4.2）
 7. Cyrene / Notes 双开并发验证（含 C1、C2 合入）
 8. Wikilink parser（§7.2）
 9. Link resolution + backlinks
10. Live Preview
11. FTS5 trigram search（§8）
12. Local Graph
13. Learn 专属 UI（§6.3）
14. Cyrene enhanced bridge（§10.3 v1）
```

核心质量闭环：`编辑 → 保存 → 外部修改 → 不丢内容 → Link → Backlink`。图谱与 AI 均在其后。

## 14. 已验证事实附录

验证日期 2026-09-19，对象为 `E:\Cyrene-Agent` 工作区。行号为当日快照，可能随上游漂移，以符号名为准。

| # | 事实 | 来源 |
|---|------|------|
| 1 | `contentHash` ≡ 对原始磁盘字节的 SHA-256（utf8 读入不剥 BOM、不归一行尾） | `obsidian-workspace-service.ts:376` + `obsidian-markdown.ts:29` |
| 2 | CRLF 使标题正则永不匹配 → 章节操作全部失效 | `obsidian-markdown.ts` HEADING_RE + JS 正则语义 |
| 3 | BOM 破坏首行标题识别 | 同上 |
| 4 | `edit` 的 hash 校验可选；`create` 未传 `mustNotExist` 时静默覆盖 | `obsidian-workspace-service.ts:446-483` |
| 5 | 全部写入走 tmp+rename，pattern `<file>.cyrene-tmp-<ts>-<rand>` | 同上 atomicWrite |
| 6 | `listFiles` 仅跳过 `.obsidian`；扩展名白名单四种 | 同上 `:133`、`:277` |
| 7 | `isEmptyDirectory` 仅忽略 `.DS_Store`/`Thumbs.db`/`.obsidian` | `vault-init.ts` |
| 8 | Learn 无 MCP client；工具为内部 toolRegistry，仅 learn 模式注册 | `obsidian-tools.ts` |
| 9 | `obsidian_search` 为全量扫描 + 小写子串匹配 | `obsidian-workspace-service.ts:301` |
| 10 | 章节语义（正则/栈/边界/尾部规整）如 §9 所述 | `obsidian-markdown.ts` |
| 11 | Cyrene 模板要求 Obsidian wikilink 交叉引用 | `vault-templates.ts:68` |
| 12 | `obsidian_open_note` 硬编码 `obsidian://` 协议 | `obsidian-tools.ts:316-331` |
| 13 | Learn bootstrap 共 8 个初始文件 | `vault-init.ts` VAULT_ENTRIES |
| 14 | `resolveSafe` 保护 `.obsidian/` 但不保护 `.cyrene/` | `obsidian-workspace-service.ts:234-241` |
| 15 | Learn 工作区目录语义（materials 只读等） | `prompts/learn_system.md` + `skills/cyrene-learn-tutor` |

## 15. 契约变更流程

1. 权威副本在本仓库 `docs/cyrene-vault-contract.md`；Cyrene-Agent 侧以版本号引用，不维护副本正文。
2. 版本语义：新增 SHOULD/MAY 条目 → minor；改动 MUST 语义、冻结表已裁决项、或引入 Layer 0 → major（v2）。
3. 任何变更 MUST 同步更新 §11 冻结表与 §14 已验证事实（若受影响），并在两个仓库的变更说明中注明契约版本。
4. Learn 布局（learn-layout）由 Cyrene 发起的变更，同样在本契约登记版本。
