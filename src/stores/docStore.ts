/**
 * docStore —— 单文档协调态。
 *
 * 三权分立（architecture.md §4）：
 * - 磁盘真相在 Rust（baseHash）
 * - 缓冲区真相在 CodeMirror（editorContent 不进这里）
 * - 这里只放协调态：dirty / saving / conflict
 *
 * openDoc 返回归一化内容，由编辑器组件接住——内容不落 React state，
 * 唯一通道是函数返回值 → CM6 dispatch。
 */
import { create } from 'zustand'
import { commands, type AppError, type BacklinkDto } from '../lib/bindings'
import { useVaultStore } from './vaultStore'

export type DocStatus = 'clean' | 'dirty' | 'saving' | 'conflict'

/** watcher 外部变更的裁决结果（Editor 消费） */
export type HotReloadDecision =
  | { kind: 'reload'; content: string; hash: string }
  | { kind: 'conflict'; remoteContent: string; remoteHash: string }
  | { kind: 'deleted' }
  | { kind: 'ignore' }

interface DocState {
  path: string | null
  baseHash: string | null
  status: DocStatus
  /** 冲突详情（status === 'conflict' 时非空） */
  conflict: { expected: string; actual: string } | null
  lastError: string | null
  /** 反向链接列表（来自 engine LinkIndex） */
  backlinks: BacklinkDto[]

  /** 成功返回文档内容（交给编辑器），失败返回 null 并置 lastError */
  openDoc: (path: string) => Promise<string | null>
  /** 保存：content 从 CM6 buffer 值传入 */
  saveDoc: (content: string) => Promise<boolean>
  /** CM6 update listener 报告缓冲区变化 */
  markDirty: () => void
  /**
   * watcher 的 file-changed 事件到达时调用。
   * 状态机裁决在这里；缓冲区替换由 Editor 拿返回值 dispatch。
   */
  onExternalChange: (path: string, hash: string, content: string | null) => HotReloadDecision
  /**
   * 冲突解决——丢弃本地版本：先把 LOCAL 落 history（conflict-discard），
   * 再按磁盘内容重载。返回新内容（null = 失败）。
   */
  discardLocalAndReload: (localContent: string) => Promise<string | null>
  /**
   * wikilink 目标解析：path 完全匹配/唯一 basename 匹配返回 found；
   * 多匹配返回 ambiguous=true；无匹配 found=false。
   */
  resolveAndOpenWikilink: (target: string) => Promise<{ found: boolean; path?: string; ambiguous?: boolean }>
  /** 内部：从 engine 拉取当前文档的反向链接，写入 store */
  _refreshBacklinks: (path: string) => Promise<void>
  clearError: () => void
}

export function describeError(e: AppError): string {
  switch (e.type) {
    case 'Conflict':
      return '文件已被外部修改（Cyrene？），保存被拒绝。需要重新读取并决定保留哪个版本'
    case 'NotFound':
      return `文件不存在: ${e.path}`
    case 'AlreadyExists':
      return `文件已存在: ${e.path}`
    case 'InvalidEncoding':
      return `文件不是合法 UTF-8: ${e.path}`
    case 'PathOutsideVault':
      return `路径不合法: ${e.detail}`
    case 'VaultNotOpen':
      return '尚未打开 Vault'
    case 'Io':
      return `IO 错误: ${e.detail}`
  }
}

export const useDocStore = create<DocState>((set, get) => ({
  path: null,
  baseHash: null,
  status: 'clean',
  conflict: null,
  lastError: null,
  backlinks: [],

  openDoc: async (path) => {
    const result = await commands.notesRead(path)
    if (result.status === 'ok') {
      set({
        path: result.data.path,
        baseHash: result.data.content_hash,
        status: 'clean',
        conflict: null,
        lastError: null,
      })
      // 后台拉反向链接（失败不影响主流程）
      void get()._refreshBacklinks(result.data.path)
      return result.data.content
    }
    set({ lastError: describeError(result.error) })
    return null
  },

  saveDoc: async (content) => {
    const { path, baseHash, status } = get()
    if (!path || !baseHash || status === 'saving' || status === 'conflict') return false
    set({ status: 'saving', lastError: null })
    const result = await commands.notesSave({ path, content, expected_hash: baseHash })
    if (result.status === 'ok') {
      set({ baseHash: result.data.new_content_hash, status: 'clean' })
      // 保存后被链接关系可能变了（如本笔记里删了一个 wikilink）——刷新一次
      void get()._refreshBacklinks(result.data.path)
      return true
    }
    if (result.error.type === 'Conflict') {
      set({
        status: 'conflict',
        conflict: { expected: result.error.expected, actual: result.error.actual },
      })
    } else {
      set({ status: 'dirty', lastError: describeError(result.error) })
    }
    return false
  },

  markDirty: () => {
    if (useDocStore.getState().status === 'clean') set({ status: 'dirty' })
  },

  onExternalChange: (path, hash, content) => {
    const { path: cur, status } = get()
    if (cur !== path) return { kind: 'ignore' } // 未打开的文档：watcher 只更新索引，UI 不动
    if (content === null) return { kind: 'deleted' }

    if (status === 'clean' || status === 'saving') {
      // 干净缓冲（或保存中——保存结果会覆盖这里，冲突路径由 save 响应处理）：
      // 热重载，baseHash 直接推进到外部版本
      set({ baseHash: hash, status: 'clean', conflict: null })
      return { kind: 'reload', content, hash }
    }
    // 脏缓冲 + 外部修改 → 冲突。REMOTE 由 watcher 已 snapshot，
    // 内容给冲突横幅展示（后续可加 diff）
    set({
      status: 'conflict',
      conflict: { expected: get().baseHash ?? '', actual: hash },
    })
    return { kind: 'conflict', remoteContent: content, remoteHash: hash }
  },

  discardLocalAndReload: async (localContent) => {
    const { path, status } = get()
    if (!path || status !== 'conflict') return null
    // 1) LOCAL 先落 history（契约 §4.5：丢弃前必须已入恢复存储）
    await commands.notesDiscardLocal({ path, content: localContent })
    // 2) 重读磁盘为新的 base
    const content = await get().openDoc(path)
    return content
  },

  /**
   * 解析 wikilink 目标。契约 §7.1 5 种形式 + §7.3 留待 v2 的裁决项。
   * v1 实现：path 完全相等 → 打开；唯一 basename → 打开；多匹配/无匹配 → 返回 null 让 caller 提示。
   */
  resolveAndOpenWikilink: async (target: string): Promise<{ found: boolean; path?: string; ambiguous?: boolean }> => {
    const all = useVaultStore.getState().notes
    if (all.length === 0) return { found: false }
    const exact = all.find((n) => n.path === target)
    if (exact) return { found: true, path: exact.path }
    const basename = target.split('/').pop()!
    const stem = basename.replace(/\.[^.]+$/, '')
    const matches = all.filter((n) => {
      const nStem = n.path.split('/').pop()!.replace(/\.[^.]+$/, '')
      return nStem === stem
    })
    if (matches.length === 1) return { found: true, path: matches[0].path }
    if (matches.length > 1) return { found: false, ambiguous: true }
    return { found: false }
  },

  _refreshBacklinks: async (path: string) => {
    const result = await commands.notesBacklinks(path)
    if (result.status === 'ok') {
      set({ backlinks: result.data })
    } else {
      set({ backlinks: [] })
    }
  },

  clearError: () => set({ lastError: null }),
}))
