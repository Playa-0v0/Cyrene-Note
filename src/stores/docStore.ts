/**
 * docStore —— 单文档协调态。
 *
 * 三权分立模型：
 * - 磁盘真相在 Rust（baseHash）
 * - 缓冲区真相在 CodeMirror（editorContent 不进这里）
 * - 这里只放协调态：dirty / saving / conflict
 *
 * 文档会话的概念说明：
 * - sessionId / generation / revision 三层身份绑定到所有跨异步操作
 * - openDoc / saveDoc / onExternalChange 全部校验 sessionId，避免过期结果污染
 * - clean ⟺ revision === savedRevision：存活的用户输入总能正确清除 dirty 标记
 */
import { create } from 'zustand'
import { commands, type AppError, type BacklinkDto, type DiskKind } from '../lib/bindings'
import { useVaultStore } from './vaultStore'
import { newSessionId, newGeneration, type SaveSnapshot } from '../docSession'

export type DocStatus = 'clean' | 'dirty' | 'saving' | 'conflict'

/** watcher 外部变更的裁决结果（Editor 消费） */
export type HotReloadDecision =
  | { kind: 'reload'; content: string; hash: string }
  | { kind: 'conflict'; remoteContent: string; remoteHash: string }
  | { kind: 'deleted' }
  | { kind: 'unreadable'; hash: string }
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

  // ── 文档会话相关状态 ─────────────────────────
  /** 当前文档会话；切换或重开都重新生成 */
  sessionId: number | null
  /** 进入保存路径（fire save）时递增；旧 save 返回若 generation 变了 → 丢弃 */
  saveGeneration: number
  /** CM6 用户输入产生的缓冲版本（save 落盘后对齐 savedRevision） */
  revision: number
  /** 上次成功保存的 revision；clean ⟺ revision === savedRevision */
  savedRevision: number

  /** 成功返回文档内容（交给编辑器），失败返回 null 并置 lastError */
  openDoc: (path: string) => Promise<string | null>
  /** 保存：content 从 CM6 buffer 值传入 */
  saveDoc: (content: string) => Promise<boolean>
  /** 暴露 editor 在 schedule 时用：拿到当下会话快照用于捕获 immutable save 上下文 */
  currentSession: () => number | null
  /** 旧 save 返回时校验 generation，false → result 视为过期 */
  isCurrentGeneration: (gen: number) => boolean
  /** CM6 update listener 报告缓冲区变化（用户输入） */
  markDirty: () => void
  /**
   * watcher 的 file-changed 事件到达时调用。
   * 状态机裁决在这里；缓冲区替换由 Editor 拿返回值 dispatch。
   * diskKind 三态（Rust DiskContent 的映射）：content / deleted / unreadable。
   */
  onExternalChange: (path: string, hash: string, diskKind: DiskKind, content: string | null) => HotReloadDecision
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
  /**
   * Vault 切换后清空文档会话（调用前必须已 flushActive 成功，内容已安全落盘）。
   * 让编辑器自动卸载旧文档；所有会话字段回到初始态，旧异步结果全部失效。
   */
  resetForVaultSwitch: () => void
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
  // 文档会话字段的初始值
  sessionId: null,
  saveGeneration: 0,
  revision: 0,
  savedRevision: 0,

  openDoc: async (path) => {
    // 1) 生成新会话——旧会话的 pending save 会自动失效
    const newId = newSessionId()
    set({
      sessionId: newId,
      saveGeneration: 0,
      revision: 0,
      savedRevision: 0,
      backlinks: [],
    })
    const result = await commands.notesRead(path)
    // 2) read 期间用户可能切了文档：再校验一次会话未变
    if (get().sessionId !== newId) return null
    if (result.status === 'ok') {
      set({
        path: result.data.path,
        baseHash: result.data.content_hash,
        status: 'clean',
        conflict: null,
        lastError: null,
        // 重新计算 revision（保证 clean 立刻成立）
        revision: 0,
        savedRevision: 0,
      })
      void get()._refreshBacklinks(result.data.path)
      return result.data.content
    }
    // 失败：回滚会话/路径，让 UI 保持在"无文档"状态
    set({ path: null, baseHash: null, sessionId: null, lastError: describeError(result.error) })
    return null
  },

  saveDoc: async (content) => {
    const { path, baseHash, status, sessionId, revision } = get()
    if (!path || !baseHash || !sessionId) return false
    if (status === 'saving' || status === 'conflict') return false
    // 取下当下会话与本次 revision；Editor 拿到这个 snap 后再 fire save
    // （实际 fire 在 Editor 内：saveDoc 接收 snap 而不是裸 content）
    const snap: SaveSnapshot = {
      sessionId,
      generation: newGeneration(),
      path,
      baseHash,
      content,
      revision,
    }
    set({ status: 'saving', lastError: null, saveGeneration: snap.generation })
    const result = await commands.notesSave({
      path: snap.path,
      content: snap.content,
      expected_hash: snap.baseHash,
    })
    // 关键校验：保存结果到达时如果会话已换 / generation 已变 → 丢弃
    const cur = get()
    if (cur.sessionId !== snap.sessionId || cur.saveGeneration !== snap.generation) {
      // 过期结果：不动状态；新会话的 save 已经接管
      return false
    }
    if (result.status === 'ok') {
      set({ baseHash: result.data.new_content_hash, status: 'clean' })
      // 仅当没有更新过的 revision 时才算 clean；用户如果保存后又输入了 revision > saved，
      // 仍然 dirty（不能被旧 save 抹掉）
      const fresh = get()
      if (fresh.revision === snap.revision) {
        set({ savedRevision: snap.revision })
      }
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

  currentSession: () => get().sessionId,

  isCurrentGeneration: (gen) => get().saveGeneration === gen,

  markDirty: () => {
    const s = get()
    if (!s.sessionId || !s.path) return // 没有打开文档时不计入
    const next = s.revision + 1
    set({ revision: next })
    // 状态升级：
    // - clean → dirty
    // - saving → dirty（取消正在进行的 save：旧结果返回时 generation 必然不匹配；
    //   旧的 savedRevision 不变，dirty 保留到下次 save）
    // - dirty/conflict → 不变
    if (s.status === 'clean' || s.status === 'saving') {
      set({ status: 'dirty', saveGeneration: s.saveGeneration + 1 })
    }
  },

  onExternalChange: (path, hash, diskKind, content) => {
    const { path: cur, status, sessionId } = get()
    if (!sessionId) return { kind: 'ignore' }
    if (cur !== path) return { kind: 'ignore' } // 未打开的文档：watcher 只更新索引，UI 不动
    if (diskKind === 'deleted') {
      // 外部删除
      if (status !== 'conflict') {
        set({ status: 'clean', conflict: null })
      }
      return { kind: 'deleted' }
    }
    if (diskKind === 'unreadable') {
      // 文件在、读不了（非法 UTF-8 等）：不替换缓冲区、不推进 baseHash——
      // 磁盘内容无法安全呈现，提示用户外部修改无法热重载。
      // 脏缓冲时同样不进冲突流程（REMOTE 内容拿不到，冲突横幅无法展示）。
      set({ lastError: '文件已被外部修改为无法读取的格式（非法 UTF-8），已保留当前缓冲区；历史中有先前版本可恢复' })
      return { kind: 'unreadable', hash }
    }

    if (status === 'clean' || status === 'saving') {
      // 干净缓冲（或保存中——保存结果会覆盖这里，冲突路径由 save 响应处理）：
      // 热重载，baseHash 直接推进到外部版本
      set({ baseHash: hash, status: 'clean', conflict: null })
      return { kind: 'reload', content: content ?? '', hash }
    }
    // 脏缓冲 + 外部修改 → 冲突。REMOTE 由 watcher 已 snapshot，
    // 内容给冲突横幅展示（后续可加 diff）
    set({
      status: 'conflict',
      conflict: { expected: get().baseHash ?? '', actual: hash },
    })
    return { kind: 'conflict', remoteContent: content ?? '', remoteHash: hash }
  },

  discardLocalAndReload: async (localContent) => {
    const { path, status, sessionId } = get()
    if (!path || status !== 'conflict' || !sessionId) return null
    // 原子化 IPC：把"把 LOCAL 写入恢复存储"和"读取磁盘最新版本"在后端合成一个事务。
    // snapshot 失败时整条 Err，LOCAL 保留不丢；reload 成功则返回新内容。
    // sessionId 校验：旧会话的等待结果不会污染新会话（与 saveDoc 处理方式一致）。
    const mySession = sessionId
    const result = await commands.notesDiscardLocalAndReload({ path, content: localContent })
    if (get().sessionId !== mySession) return null // 会话已换，丢弃结果
    if (result.status === 'ok') {
      const doc = result.data
      // 一次性吃下：磁盘内容 + hash + 新的 base
      set({
        path: doc.path,
        baseHash: doc.content_hash,
        status: 'clean',
        conflict: null,
        revision: 0,
        savedRevision: 0,
      })
      return doc.content
    }
    // snapshot 或 reload 失败：保留 LOCAL + 冲突态 + lastError
    set({ lastError: `保留本地修改失败（已保护你的内容）：${describeError(result.error)}` })
    return null
  },

  _refreshBacklinks: async (path) => {
    const result = await commands.notesBacklinks(path)
    if (result.status === 'ok') {
      set({ backlinks: result.data })
    } else {
      set({ backlinks: [] })
    }
  },

  resolveAndOpenWikilink: async (target) => {
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

  clearError: () => set({ lastError: null }),

  resetForVaultSwitch: () =>
    set({
      path: null,
      baseHash: null,
      status: 'clean',
      conflict: null,
      lastError: null,
      backlinks: [],
      sessionId: null,
      saveGeneration: 0,
      revision: 0,
      savedRevision: 0,
    }),
}))