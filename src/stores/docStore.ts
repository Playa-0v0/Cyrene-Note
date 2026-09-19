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
import { commands, type AppError } from '../lib/bindings'

export type DocStatus = 'clean' | 'dirty' | 'saving' | 'conflict'

interface DocState {
  path: string | null
  baseHash: string | null
  status: DocStatus
  /** 冲突详情（status === 'conflict' 时非空） */
  conflict: { expected: string; actual: string } | null
  lastError: string | null

  /** 成功返回文档内容（交给编辑器），失败返回 null 并置 lastError */
  openDoc: (path: string) => Promise<string | null>
  /** 保存：content 从 CM6 buffer 值传入 */
  saveDoc: (content: string) => Promise<boolean>
  /** CM6 update listener 报告缓冲区变化 */
  markDirty: () => void
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

  clearError: () => set({ lastError: null }),
}))
