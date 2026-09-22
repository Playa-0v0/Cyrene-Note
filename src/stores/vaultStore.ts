/**
 * vaultStore —— Vault 打开状态与文件树。
 */
import { create } from 'zustand'
import { commands, events } from '../lib/bindings'
import { useDocStore, describeError } from './docStore'
import { useTabsStore } from './tabsStore'

/** 排序方式 */
export type SortKey = 'name' | 'mtime'

/** 已登记仓库列表的持久化键（localStorage；启动只记列表不自动打开） */
const VAULTS_KEY = 'cyrene.vaults'

/** 已登记仓库记录：路径 + 上次打开时间（0 = 只登记从未打开过）+ 启动画面卡片快照 */
export interface VaultRecord {
  root: string
  lastOpenedAt: number
  /** 第一篇笔记的纯文本快照（打开仓库时抓取缓存；Rust 只能读当前打开的 vault，启动画面无法跨库现读） */
  preview?: string
  /** 封面图绝对路径（根目录 welcome.*，png 优先）；启动画面经 asset 协议直接加载 */
  cover?: string
}

/**
 * 把 Markdown 正文转成启动画面卡片用的纯文本行：
 * 跳过围栏代码块、剥离标题/引用/列表/加粗/斜体/高亮/删除线/行内代码/双链/链接标记，
 * 跳过空行，最多 10 行、总计 400 字符。
 */
export function markdownToPreviewText(md: string): string {
  const lines: string[] = []
  let inCode = false
  for (const raw of md.split(/\r?\n/)) {
    // 围栏代码块：开闭行都跳过，块内整段不进预览
    if (raw.trimStart().startsWith('```')) {
      inCode = !inCode
      continue
    }
    if (inCode) continue
    const line = raw
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s?/, '')
      // 任务列表：勾选框转字形，保留"待办感"
      .replace(/^[-*+]\s+\[ \]\s*/, '☐ ')
      .replace(/^[-*+]\s+\[x\]\s*/i, '☑ ')
      .replace(/^[-*+]\s+/, '· ')
      // 行内标记：带别名的双链先于普通双链处理
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/==([^=]+)==/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
      .replace(/\[\[([^\]|]+)\]\]/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<\/?span[^>]*>/g, '')
      .trim()
    if (!line) continue
    lines.push(line)
    if (lines.length >= 10) break
  }
  return lines.join('\n').slice(0, 400)
}

/**
 * 轻量路径归一化：统一分隔符为 /、去尾部斜杠（POSIX 根 '/' 保留原样）。
 * 已知限制：不做大小写归一 / 真实路径解析（symlink、盘符大小写差异会视为不同仓库）；
 * 完整 canonical 化应由 Rust 完成，MVP 先接受字符串级去重。
 */
export function normalizeRoot(p: string): string {
  if (p === '/') return '/'
  return p.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
}

/** Vault 显示名：路径最后一段；根路径（'/'、盘符根）没有可读段则显示根本身 */
export function vaultName(root: string): string {
  const norm = normalizeRoot(root)
  const last = norm.split('/').filter(Boolean).pop()
  if (!last) return norm
  // 盘符根（'C:'）补上斜杠，避免看起来像个普通文件夹名
  if (/^[A-Za-z]:$/.test(last)) return `${last}/`
  return last
}

/** 上次打开时间的友好显示（"3 分钟前"；0 = 从未打开） */
export function formatLastOpened(ts: number): string {
  if (!ts) return '从未打开'
  const diff = Date.now() - ts
  const MIN = 60_000
  if (diff < MIN) return '刚刚'
  if (diff < 60 * MIN) return `${Math.floor(diff / MIN)} 分钟前`
  if (diff < 24 * 60 * MIN) return `${Math.floor(diff / (60 * MIN))} 小时前`
  if (diff < 7 * 24 * 60 * MIN) return `${Math.floor(diff / (24 * 60 * MIN))} 天前`
  // 更久之前：显示具体日期（本地时区）
  const d = new Date(ts)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/**
 * 从 localStorage 读已登记仓库列表。
 * 兼容旧格式（纯 string[]，无时间信息）：统一迁移成 VaultRecord[]。
 */
export function loadVaults(): VaultRecord[] {
  try {
    const raw = localStorage.getItem(VAULTS_KEY)
    const arr = raw ? JSON.parse(raw) : []
    if (!Array.isArray(arr)) return []
    const out: VaultRecord[] = []
    for (const x of arr) {
      if (typeof x === 'string') {
        out.push({ root: normalizeRoot(x), lastOpenedAt: 0 })
      } else if (x && typeof x === 'object' && typeof x.root === 'string') {
        out.push({
          root: normalizeRoot(x.root),
          lastOpenedAt: typeof x.lastOpenedAt === 'number' ? x.lastOpenedAt : 0,
          preview: typeof x.preview === 'string' ? x.preview : undefined,
          cover: typeof x.cover === 'string' ? x.cover : undefined,
        })
      }
      // 其余视为损坏数据丢弃
    }
    return out
  } catch {
    return []
  }
}

/** 写回 localStorage（隐身模式等写入失败不影响本次会话使用） */
function persistVaults(vaults: VaultRecord[]) {
  try {
    localStorage.setItem(VAULTS_KEY, JSON.stringify(vaults))
  } catch {
    // 忽略：持久化失败只是下次启动少了记忆
  }
}

interface VaultState {
  open: boolean
  root: string | null
  notes: { path: string; size: number; modified_ms: number | null }[]
  loading: boolean
  /** 已登记的仓库列表（归一化路径 + 上次打开时间；localStorage 持久化，启动不自动打开） */
  vaults: VaultRecord[]

  /** 文件树排序（名称/修改时间 + 升降序） */
  sortKey: SortKey
  sortAsc: boolean
  /** 视图选项：笔记行是否显示修改时间 */
  showMtime: boolean
  /** 展开的目录集合（vault 相对路径） */
  expandedDirs: Set<string>

  /**
   * 打开（或切换到）仓库。三阶段事务：
   * 1. 冲盘当前文档 —— 失败则中止，旧工作区状态原封不动；
   * 2. Rust vaultOpen —— 失败同上；
   * 3. 此后 Rust 已在新仓库上，任何失败都不回滚（树加载失败仅单独提示）。
   * create=true 时目录不存在会先递归创建（首启欢迎库用）。
   */
  openVault: (root: string, create?: boolean) => Promise<void>
  /** 登记仓库（归一化去重 + 持久化）；只登记不切换，不覆盖已有时间 */
  addVault: (root: string) => void
  /** 打开成功后记录时间戳并按最近使用排序（未打开过的沉底） */
  touchVault: (root: string) => void
  /**
   * 抓当前仓库第一篇笔记的文本快照存进 vaults 记录（启动画面卡片预览用）。
   * 纯锦上添花：任何失败都静默；await 期间仓库被切走则丢弃结果。
   */
  capturePreview: () => Promise<void>
  /** 从列表移除仓库；当前打开的仓库受保护不可移除（业务不变量，UI disabled 之外的第二道防线） */
  removeVault: (root: string) => void
  refreshTree: () => Promise<boolean>
  setSort: (key: SortKey, asc: boolean) => void
  toggleShowMtime: () => void
  toggleDir: (path: string) => void
  collapseAll: () => void
  /** 新建笔记（默认根目录，可指定目录），重名自动加序号，成功后打开 */
  createNote: (dir?: string) => Promise<void>
  /** 新建文件夹（内部放一篇笔记让目录在树中可见），成功后展开并打开 */
  createFolder: (dir?: string) => Promise<void>
  /** 行内重命名的目标路径（文件树渲染输入框）；null = 不在重命名 */
  renamingPath: string | null
  setRenaming: (path: string | null) => void
  /** 重命名笔记；若正打开则编辑器切到新路径 */
  renameNote: (from: string, to: string) => Promise<void>
  /** 删除笔记（内容已进 history 可恢复）；若正打开则关闭编辑器 */
  deleteNote: (path: string) => Promise<void>
  /** 重命名目录；正打开的子笔记跟随切换到新路径 */
  renameDir: (from: string, to: string) => Promise<void>
  /** 删除目录（内容已进 history 可恢复）；正打开的子笔记关闭编辑器 */
  deleteDir: (dir: string) => Promise<void>
}

export const useVaultStore = create<VaultState>((set, get) => ({
  open: false,
  root: null,
  notes: [],
  loading: false,
  vaults: loadVaults(),
  sortKey: 'name',
  sortAsc: true,
  showMtime: false,
  expandedDirs: new Set<string>(),

  openVault: async (root, create) => {
    // 切换进行中不接受并发触发（双击列表项等）
    if (get().loading) return
    // 点击当前仓库 = 无操作（VaultBar 点击当前项仅关闭菜单）
    const st = get()
    if (st.open && st.root && normalizeRoot(st.root) === normalizeRoot(root)) return
    set({ loading: true })
    // ── 阶段 1：冲盘当前文档。失败 → 中止切换，旧工作区状态原封不动 ──
    const flushed = await useTabsStore.getState().flushActive()
    if (!flushed) {
      set({ loading: false })
      // saveDoc/discardLocal 失败时自身已写具体原因，这里只在没写时兜底
      if (!useDocStore.getState().lastError) {
        useDocStore.setState({ lastError: '文档尚未安全保存，已取消切换 Vault（请稍后重试）' })
      }
      return
    }
    // ── 阶段 2：Rust 切换。失败 → 中止切换，旧工作区状态原封不动 ──
    const result = await commands.vaultOpen(root, create ?? false)
    if (result.status === 'error') {
      set({ loading: false })
      useDocStore.setState({ lastError: `打开 Vault 失败：${describeError(result.error)}` })
      return
    }
    // ── 切换已成功：此后任何失败都不回滚（Rust 已停旧 watcher、指向新仓库）──
    const newRoot = result.data.root ?? root
    useTabsStore.getState().reset()
    useDocStore.getState().resetForVaultSwitch()
    set({
      open: true,
      root: newRoot,
      notes: [],
      expandedDirs: new Set(),
      renamingPath: null,
    })
    get().touchVault(newRoot)
    // ── 阶段 3：树加载。失败 ≠ 切换失败：Vault 已在新仓库上，只是树没刷出来 ──
    const treeOk = await get().refreshTree()
    set({ loading: false })
    if (!treeOk) {
      useDocStore.setState({ lastError: 'Vault 已切换，但文件树加载失败' })
    }
    // 附带：抓首篇笔记快照做启动画面卡片预览（不阻塞切换，失败静默）
    void get().capturePreview()
  },

  addVault: (root) => {
    const key = normalizeRoot(root)
    const cur = get().vaults
    // 已登记过（可能带上次打开时间）则不覆盖时间
    if (cur.some((v) => normalizeRoot(v.root) === key)) return
    const next = [...cur, { root: key, lastOpenedAt: 0 }]
    set({ vaults: next })
    persistVaults(next)
  },

  touchVault: (root) => {
    const key = normalizeRoot(root)
    const now = Date.now()
    const cur = get().vaults
    const hit = cur.find((v) => normalizeRoot(v.root) === key)
    const next = hit
      ? cur.map((v) => (v === hit ? { ...v, lastOpenedAt: now } : v))
      : [...cur, { root: key, lastOpenedAt: now }]
    // 最近打开在前；同分（含从未打开的 0）保持原相对顺序（sort 稳定）
    next.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    set({ vaults: next })
    persistVaults(next)
  },

  removeVault: (root) => {
    const key = normalizeRoot(root)
    // 业务不变量：当前打开的仓库不允许从列表移除（交互层 disabled 之外的第二道防线）
    const cur = get()
    if (cur.open && cur.root && normalizeRoot(cur.root) === key) return
    const next = cur.vaults.filter((v) => normalizeRoot(v.root) !== key)
    if (next.length === cur.vaults.length) return
    set({ vaults: next })
    persistVaults(next)
  },

  capturePreview: async () => {
    const { open, root, notes } = get()
    if (!open || !root) return
    // ── 抓文本预览：第一篇（路径字典序最小）笔记 ──
    let preview: string | undefined
    if (notes.length > 0) {
      const first = [...notes].sort((a, b) => a.path.localeCompare(b.path))[0]
      try {
        const read = await commands.notesRead(first.path)
        if (read.status === 'ok') preview = markdownToPreviewText(read.data.content)
      } catch {
        // 读取失败就只是没有文本预览
      }
    }
    // ── 抓封面：根目录 welcome.* 图片（png 优先），Rust 只回路径 ──
    let cover: string | undefined
    try {
      const cov = await commands.vaultCover()
      if (cov.status === 'ok') cover = cov.data ?? undefined
    } catch {
      // 同上：失败静默
    }
    const key = normalizeRoot(root)
    // await 期间仓库可能已被切走：结果属于旧仓库就丢弃，避免写错记录
    const cur = get()
    if (!cur.open || !cur.root || normalizeRoot(cur.root) !== key) return
    const next = cur.vaults.map((v) => (normalizeRoot(v.root) === key ? { ...v, preview, cover } : v))
    set({ vaults: next })
    persistVaults(next)
  },

  refreshTree: async () => {
    const result = await commands.notesList()
    if (result.status === 'ok') {
      set({ notes: result.data })
      return true
    }
    return false
  },

  setSort: (key, asc) => set({ sortKey: key, sortAsc: asc }),
  toggleShowMtime: () => set({ showMtime: !get().showMtime }),

  toggleDir: (path) => {
    const next = new Set(get().expandedDirs)
    if (next.has(path)) {
      next.delete(path)
    } else {
      next.add(path)
    }
    set({ expandedDirs: next })
  },

  collapseAll: () => set({ expandedDirs: new Set() }),

  createNote: async (dir = '') => {
    const { notes } = get()
    const prefix = dir ? `${dir}/` : ''
    const existing = new Set(notes.map((n) => n.path))
    // 找一个不冲突的文件名：未命名.md → 未命名 1.md → …
    let name = `${prefix}未命名.md`
    for (let i = 1; existing.has(name); i++) name = `${prefix}未命名 ${i}.md`
    const result = await commands.notesCreate({ path: name, content: '' })
    if (result.status === 'ok') {
      useTabsStore.getState().openTab(name)
    } else {
      useDocStore.setState({ lastError: `新建笔记失败：${describeError(result.error)}` })
    }
  },

  createFolder: async (dir = '') => {
    const { notes } = get()
    const prefix = dir ? `${dir}/` : ''
    // 目录只有包含笔记才会出现在树里，所以新建文件夹 = 在其中创建第一篇笔记
    const occupied = (d: string) => notes.some((n) => n.path.startsWith(d + '/'))
    let folder = `${prefix}新文件夹`
    for (let i = 1; occupied(folder); i++) folder = `${prefix}新文件夹 ${i}`
    const path = `${folder}/未命名.md`
    const result = await commands.notesCreate({ path, content: '' })
    if (result.status === 'ok') {
      // 展开新目录并打开这篇笔记
      const next = new Set(get().expandedDirs)
      next.add(folder)
      set({ expandedDirs: next })
      useTabsStore.getState().openTab(path)
    } else {
      useDocStore.setState({ lastError: `新建文件夹失败：${describeError(result.error)}` })
    }
  },

  renamingPath: null,
  setRenaming: (path) => set({ renamingPath: path }),

  renameNote: async (from, to) => {
    const result = await commands.notesRename({ from, to })
    if (result.status === 'ok') {
      set({ renamingPath: null })
      // 标签与编辑器同步切到新路径
      useTabsStore.getState().renameTabs([{ from, to }])
      if (useDocStore.getState().path === from) {
        useDocStore.setState({ path: to })
      }
      await get().refreshTree()
    } else {
      useDocStore.setState({ lastError: `重命名失败：${describeError(result.error)}` })
    }
  },

  deleteNote: async (path) => {
    const result = await commands.notesDelete({ path })
    if (result.status === 'ok') {
      // 关掉对应标签（激活标签被关时 tabsStore 自动切邻位并收尾编辑器状态）
      await useTabsStore.getState().closeTab(path)
      if (useDocStore.getState().path === path) {
        useDocStore.setState({ path: null })
      }
      await get().refreshTree()
    } else {
      useDocStore.setState({ lastError: `删除失败：${describeError(result.error)}` })
    }
  },

  renameDir: async (from, to) => {
    const result = await commands.notesRenameDir({ from, to })
    if (result.status === 'ok') {
      set({ renamingPath: null })
      // 所有受影响标签同步换路径
      useTabsStore.getState().renameTabs(result.data.moved)
      const cur = useDocStore.getState().path
      if (cur) {
        const hit = result.data.moved.find((m) => m.from === cur)
        if (hit) useDocStore.setState({ path: hit.to })
      }
      await get().refreshTree()
    } else {
      useDocStore.setState({ lastError: `重命名失败：${describeError(result.error)}` })
    }
  },

  deleteDir: async (dir) => {
    const result = await commands.notesDeleteDir({ dir })
    if (result.status === 'ok') {
      // 清掉目录下所有标签（removeTabs 已处理激活标签被清的情况）
      useTabsStore.getState().removeTabs((p) => p === dir || p.startsWith(`${dir}/`))
      const cur = useDocStore.getState().path
      if (cur && (cur.startsWith(`${dir}/`) || cur === dir)) {
        useDocStore.setState({ path: null })
      }
      await get().refreshTree()
    } else {
      useDocStore.setState({ lastError: `删除失败：${describeError(result.error)}` })
    }
  },
}))

// Rust 侧 save/create 后广播 tree-changed，统一在这里订阅刷新
events.treeChanged.listen(() => {
  useVaultStore.getState().refreshTree()
})
