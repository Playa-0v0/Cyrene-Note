/**
 * Vault 切换器测试集：核心是 openVault 的三阶段事务边界。
 *
 * 重点覆盖失败路径（数据安全边界，比成功路径重要）：
 * 1. 冲盘失败 → 不切换，vaultOpen 不被调用，工作区原封不动；
 * 2. vaultOpen 失败 → 不切换，工作区原封不动；
 * 3. 树加载失败 → 已切换不回滚，单独提示；
 * 4. A→B→A 往返 → 无状态泄漏。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// 替身：每个测试覆写对应方法的实现
const mockVaultOpen = vi.fn()
const mockNotesList = vi.fn()
const mockNotesSave = vi.fn()
const mockNotesRead = vi.fn()
const mockVaultCover = vi.fn()
// backlinks 默认成功空表：openDoc/saveDoc 成功路径都会 fire _refreshBacklinks
const mockNotesBacklinks = vi.fn().mockResolvedValue({ status: 'ok', data: [] })

vi.mock('../lib/bindings', () => ({
  commands: {
    vaultOpen: (...args: any[]) => mockVaultOpen(...args),
    vaultStatus: () => Promise.resolve({ status: 'ok', data: { open: false, root: null } }),
    vaultCover: (...args: any[]) => mockVaultCover(...args),
    welcomeCoverWrite: () => Promise.resolve({ status: 'ok', data: true }),
    notesList: (...args: any[]) => mockNotesList(...args),
    notesRead: (...args: any[]) => mockNotesRead(...args),
    notesBacklinks: (...args: any[]) => mockNotesBacklinks(...args),
    notesSave: (...args: any[]) => mockNotesSave(...args),
    notesCreate: () => Promise.resolve({ status: 'error', error: { type: 'VaultNotOpen' } }),
    notesRename: () => Promise.resolve({ status: 'error', error: { type: 'VaultNotOpen' } }),
    notesDelete: () => Promise.resolve({ status: 'error', error: { type: 'VaultNotOpen' } }),
    notesRenameDir: () => Promise.resolve({ status: 'error', error: { type: 'VaultNotOpen' } }),
    notesDeleteDir: () => Promise.resolve({ status: 'error', error: { type: 'VaultNotOpen' } }),
    notesDiscardLocal: () => Promise.resolve({ status: 'error', error: { type: 'VaultNotOpen' } }),
    notesDiscardLocalAndReload: () =>
      Promise.resolve({ status: 'error', error: { type: 'VaultNotOpen' } }),
  },
  events: {
    fileChanged: { listen: () => Promise.resolve(() => {}) },
    treeChanged: { listen: () => Promise.resolve(() => {}) },
  },
}))

import { useVaultStore, vaultName, normalizeRoot, loadVaults, markdownToPreviewText } from './vaultStore'
import { useTabsStore } from './tabsStore'
import { useDocStore } from './docStore'
import { editorViewRef } from '../editor/editorViewRef'

/** 最小 CM6 view 替身：flushActive 只用到 state.doc.toString() */
const stubView = { state: { doc: { toString: () => 'buffer content' } } } as any

const resetStores = () => {
  useVaultStore.setState({
    open: false,
    root: null,
    notes: [],
    loading: false,
    vaults: [],
    sortKey: 'name',
    sortAsc: true,
    showMtime: false,
    expandedDirs: new Set(),
    renamingPath: null,
  })
  useTabsStore.setState({ tabs: [], activePath: null })
  useDocStore.setState({
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
  })
  localStorage.removeItem('cyrene.vaults')
  editorViewRef.current = null
}

describe('normalizeRoot / vaultName', () => {
  it('统一分隔符与尾斜杠', () => {
    expect(normalizeRoot('C:\\Notes\\')).toBe('C:/Notes')
    expect(normalizeRoot('C:/Notes/')).toBe('C:/Notes')
    expect(normalizeRoot('/home/a/vault/')).toBe('/home/a/vault')
    expect(normalizeRoot('/')).toBe('/')
  })

  it('显示名取最后一段；根路径原样显示', () => {
    expect(vaultName('C:/Notes')).toBe('Notes')
    expect(vaultName('C:\\Notes\\')).toBe('Notes')
    expect(vaultName('/home/a/我的笔记')).toBe('我的笔记')
    expect(vaultName('/')).toBe('/')
    expect(vaultName('C:\\')).toBe('C:/')
  })
})

describe('vaults 列表持久化', () => {
  beforeEach(() => resetStores())

  it('addVault 归一化去重并写入 localStorage', () => {
    const { addVault } = useVaultStore.getState()
    addVault('C:\\Notes')
    addVault('C:/Notes/') // 同一路径的另一种写法：不重复登记
    addVault('D:\\Work')
    expect(useVaultStore.getState().vaults).toEqual([
      { root: 'C:/Notes', lastOpenedAt: 0 },
      { root: 'D:/Work', lastOpenedAt: 0 },
    ])
    expect(JSON.parse(localStorage.getItem('cyrene.vaults')!)).toEqual([
      { root: 'C:/Notes', lastOpenedAt: 0 },
      { root: 'D:/Work', lastOpenedAt: 0 },
    ])
  })

  it('loadVaults 兼容旧 string[] 格式（迁移成无时间记录）', () => {
    localStorage.setItem('cyrene.vaults', JSON.stringify(['C:\\Old', 'D:/Old']))
    expect(loadVaults()).toEqual([
      { root: 'C:/Old', lastOpenedAt: 0 },
      { root: 'D:/Old', lastOpenedAt: 0 },
    ])
  })

  it('touchVault 更新时间并按最近使用排序', async () => {
    const s = useVaultStore.getState()
    s.addVault('C:/A')
    s.addVault('D:/B')
    // 先打开 B 再打开 A：A 应排最前
    s.touchVault('D:/B')
    await new Promise((r) => setTimeout(r, 2)) // 保证时间戳严格递增
    s.touchVault('C:/A')
    const v = useVaultStore.getState().vaults
    expect(v.map((x) => x.root)).toEqual(['C:/A', 'D:/B'])
    expect(v[0].lastOpenedAt).toBeGreaterThan(v[1].lastOpenedAt)
  })

  it('addVault 对已登记仓库不重置时间', () => {
    const s = useVaultStore.getState()
    s.addVault('C:/A')
    s.touchVault('C:/A')
    const t = useVaultStore.getState().vaults[0].lastOpenedAt
    expect(t).toBeGreaterThan(0)
    s.addVault('C:/A')
    expect(useVaultStore.getState().vaults[0].lastOpenedAt).toBe(t)
  })

  it('removeVault 移除并持久化；当前打开的仓库受保护', () => {
    const s = useVaultStore.getState()
    s.addVault('C:/A')
    s.addVault('D:/B')
    // 模拟 Rust 回传的原始写法（反斜杠）
    useVaultStore.setState({ open: true, root: 'C:\\A' })

    s.removeVault('D:/B')
    expect(useVaultStore.getState().vaults.map((v) => v.root)).toEqual(['C:/A'])

    // 当前仓库：拒绝移除（业务不变量，不只靠 UI disabled）
    s.removeVault('C:/A')
    expect(useVaultStore.getState().vaults.map((v) => v.root)).toEqual(['C:/A'])
    expect(JSON.parse(localStorage.getItem('cyrene.vaults')!)).toEqual([
      { root: 'C:/A', lastOpenedAt: 0 },
    ])
  })
})

describe('tabsStore.flushActive 的安全语义', () => {
  beforeEach(() => {
    resetStores()
    mockNotesSave.mockReset()
  })

  it('无编辑器 / 无文档：安全放行', async () => {
    expect(await useTabsStore.getState().flushActive()).toBe(true)
    editorViewRef.current = stubView
    expect(await useTabsStore.getState().flushActive()).toBe(true)
  })

  it('保存中（saving）：拒绝放行', async () => {
    editorViewRef.current = stubView
    useDocStore.setState({ path: 'a.md', sessionId: 1, status: 'saving' })
    expect(await useTabsStore.getState().flushActive()).toBe(false)
  })

  it('脏文档保存失败拒绝放行；保存成功放行', async () => {
    editorViewRef.current = stubView
    useDocStore.setState({
      path: 'a.md', baseHash: 'H', sessionId: 1, status: 'dirty', revision: 1, savedRevision: 0,
    })
    mockNotesSave.mockResolvedValueOnce({ status: 'error', error: { type: 'Io', detail: 'denied' } })
    expect(await useTabsStore.getState().flushActive()).toBe(false)

    mockNotesSave.mockResolvedValueOnce({ status: 'ok', data: { path: 'a.md', new_content_hash: 'H2' } })
    expect(await useTabsStore.getState().flushActive()).toBe(true)
  })
})

describe('markdownToPreviewText', () => {
  it('剥离常见 Markdown 语法标记', () => {
    const md = [
      '# 标题',
      '',
      '> 引用一行',
      '- **加粗**与*斜体*和==高亮==与~~删除线~~',
      '- [ ] 待办任务',
      '- [x] 已完成任务',
      '普通段落 `行内代码` 与 [[双链笔记]] 与 [外链](https://a.b)',
      '[[目标|别名]] 双链带别名',
    ].join('\n')
    expect(markdownToPreviewText(md).split('\n')).toEqual([
      '标题',
      '引用一行',
      '· 加粗与斜体和高亮与删除线',
      '☐ 待办任务',
      '☑ 已完成任务',
      '普通段落 行内代码 与 双链笔记 与 外链',
      '别名 双链带别名',
    ])
  })

  it('跳过围栏代码块与空行；限 10 行 / 400 字符', () => {
    expect(markdownToPreviewText(['```ts', 'const a = 1', '```', '', '正文'].join('\n'))).toBe('正文')

    const many = Array.from({ length: 20 }, (_, i) => `第${i}行`).join('\n')
    expect(markdownToPreviewText(many).split('\n').length).toBe(10)

    expect(markdownToPreviewText('a'.repeat(500)).length).toBe(400)
  })
})

describe('capturePreview 快照', () => {
  beforeEach(() => {
    resetStores()
    mockVaultOpen.mockReset()
    mockNotesList.mockReset()
    mockNotesRead.mockReset()
    mockVaultCover.mockReset()
    mockVaultOpen.mockImplementation(async (root: string) => ({
      status: 'ok',
      data: { open: true, root },
    }))
    mockNotesList.mockResolvedValue({ status: 'ok', data: [] })
    // 默认无封面
    mockVaultCover.mockResolvedValue({ status: 'ok', data: null })
  })

  it('openVault 成功后抓取首篇笔记快照存进记录并持久化', async () => {
    mockNotesList.mockResolvedValue({
      status: 'ok',
      data: [
        { path: 'b.md', size: 1, modified_ms: 1 },
        { path: 'a.md', size: 1, modified_ms: 1 },
      ],
    })
    mockNotesRead.mockImplementation(async (p: string) => ({
      status: 'ok',
      data: { path: p, content: '# 标题\n\n正文', content_hash: 'H', links: [] },
    }))
    // Rust 回传的封面绝对路径（原始写法）
    mockVaultCover.mockResolvedValue({ status: 'ok', data: 'C:\\A\\welcome.png' })

    await useVaultStore.getState().openVault('C:/A')
    // openVault 尾部的抓取是 fire-and-forget：等它落地
    await vi.waitFor(() => {
      expect(useVaultStore.getState().vaults[0].preview).toBe('标题\n正文')
    })
    // 封面路径也进记录并持久化
    expect(useVaultStore.getState().vaults[0].cover).toBe('C:\\A\\welcome.png')
    expect(JSON.parse(localStorage.getItem('cyrene.vaults')!)[0].cover).toBe('C:\\A\\welcome.png')
    // "第一篇"取路径字典序最小（a.md 而非 b.md）
    expect(mockNotesRead).toHaveBeenCalledWith('a.md')
  })

  it('读取失败：静默不写 preview/cover，仓库记录本身不受影响', async () => {
    mockNotesList.mockResolvedValue({
      status: 'ok',
      data: [{ path: 'a.md', size: 1, modified_ms: 1 }],
    })
    mockNotesRead.mockResolvedValue({ status: 'error', error: { type: 'Io', detail: 'x' } })
    mockVaultCover.mockResolvedValue({ status: 'error', error: { type: 'Io', detail: 'x' } })

    await useVaultStore.getState().openVault('C:/A')
    await new Promise((r) => setTimeout(r, 5))

    expect(useVaultStore.getState().vaults[0].preview).toBeUndefined()
    expect(useVaultStore.getState().vaults[0].cover).toBeUndefined()
    expect(useVaultStore.getState().vaults[0].root).toBe('C:/A')
    expect(useVaultStore.getState().loading).toBe(false)
  })
})

describe('openVault 三阶段事务', () => {
  beforeEach(() => {
    resetStores()
    mockVaultOpen.mockReset()
    mockNotesList.mockReset()
    mockNotesSave.mockReset()
    mockNotesRead.mockReset()
    mockVaultCover.mockReset().mockResolvedValue({ status: 'ok', data: null })
    // 默认行为：回显输入路径（与 Rust vault_open 的行为一致）
    mockVaultOpen.mockImplementation(async (root: string) => ({
      status: 'ok',
      data: { open: true, root },
    }))
    mockNotesList.mockResolvedValue({ status: 'ok', data: [] })
  })

  it('成功切换：清标签 / 清文档会话 / 清树瞬态 / 登记仓库', async () => {
    await useVaultStore.getState().openVault('C:/A')
    await new Promise((r) => setTimeout(r, 2)) // 保证两次 touch 时间戳严格递增
    // 预置 A 的工作区
    useTabsStore.setState({ tabs: ['a.md'], activePath: 'a.md' })
    useDocStore.setState({ path: 'a.md', sessionId: 1, status: 'clean' })
    useVaultStore.setState({ expandedDirs: new Set(['adir']) })

    await useVaultStore.getState().openVault('D:/B')

    const v = useVaultStore.getState()
    expect(v.root).toBe('D:/B')
    expect(v.open).toBe(true)
    // 最近打开的排最前；两个仓库都记录了打开时间（A 在首次打开时记录）
    expect(v.vaults.map((x) => x.root)).toEqual(['D:/B', 'C:/A'])
    expect(v.vaults[0].lastOpenedAt).toBeGreaterThan(v.vaults[1].lastOpenedAt)
    expect(v.expandedDirs.size).toBe(0)
    expect(v.renamingPath).toBeNull()
    expect(v.loading).toBe(false)
    expect(useTabsStore.getState().tabs).toEqual([])
    expect(useTabsStore.getState().activePath).toBeNull()
    expect(useDocStore.getState().path).toBeNull()
    expect(useDocStore.getState().sessionId).toBeNull()
  })

  it('vaultOpen 失败：tabs / activePath / root / expandedDirs 全部保持原状', async () => {
    await useVaultStore.getState().openVault('C:/A')
    useTabsStore.setState({ tabs: ['a.md'], activePath: 'a.md' })
    useDocStore.setState({ path: 'a.md', sessionId: 1 })
    useVaultStore.setState({ expandedDirs: new Set(['adir']) })
    // 目录被删 / 权限错误等
    mockVaultOpen.mockResolvedValueOnce({ status: 'error', error: { type: 'Io', detail: 'gone' } })

    await useVaultStore.getState().openVault('D:/B')

    expect(useVaultStore.getState().root).toBe('C:/A')
    expect(useVaultStore.getState().expandedDirs.has('adir')).toBe(true)
    expect(useVaultStore.getState().loading).toBe(false)
    expect(useTabsStore.getState().tabs).toEqual(['a.md'])
    expect(useTabsStore.getState().activePath).toBe('a.md')
    expect(useDocStore.getState().path).toBe('a.md')
    expect(useDocStore.getState().lastError).toContain('打开 Vault 失败')
  })

  it('冲盘失败：vaultOpen 根本不被调用，工作区原封不动', async () => {
    await useVaultStore.getState().openVault('C:/A')
    // 预置脏文档 + 保存失败
    editorViewRef.current = stubView
    useDocStore.setState({
      path: 'a.md', baseHash: 'H', sessionId: 1, status: 'dirty', revision: 1, savedRevision: 0,
    })
    useTabsStore.setState({ tabs: ['a.md'], activePath: 'a.md' })
    mockNotesSave.mockResolvedValueOnce({ status: 'error', error: { type: 'Io', detail: 'denied' } })
    mockVaultOpen.mockClear()

    await useVaultStore.getState().openVault('D:/B')

    expect(mockVaultOpen).not.toHaveBeenCalled()
    expect(useVaultStore.getState().root).toBe('C:/A')
    expect(useVaultStore.getState().loading).toBe(false)
    expect(useTabsStore.getState().tabs).toEqual(['a.md'])
    expect(useDocStore.getState().path).toBe('a.md')
  })

  it('树加载失败：已切换不回滚，单独提示', async () => {
    mockNotesList.mockResolvedValueOnce({
      status: 'ok',
      data: [{ path: 'a.md', size: 1, modified_ms: 1 }],
    })
    await useVaultStore.getState().openVault('C:/A')
    expect(useVaultStore.getState().notes.length).toBe(1)
    // 切换到 B 时树加载失败
    mockNotesList.mockResolvedValueOnce({ status: 'error', error: { type: 'Io', detail: 'x' } })

    await useVaultStore.getState().openVault('D:/B')

    // Rust 已切换：root 指向新仓库（不假装还在旧 Vault），但明确提示树没刷出来
    expect(useVaultStore.getState().root).toBe('D:/B')
    expect(useVaultStore.getState().open).toBe(true)
    expect(useVaultStore.getState().notes).toEqual([])
    expect(useVaultStore.getState().loading).toBe(false)
    expect(useDocStore.getState().lastError).toContain('文件树加载失败')
  })

  it('A→B→A 往返：无状态泄漏', async () => {
    await useVaultStore.getState().openVault('C:/A')
    useTabsStore.setState({ tabs: ['a.md'], activePath: 'a.md' })
    useVaultStore.setState({ expandedDirs: new Set(['adir']) })

    await useVaultStore.getState().openVault('D:/B')
    expect(useVaultStore.getState().root).toBe('D:/B')
    expect(useTabsStore.getState().tabs).toEqual([])
    expect(useVaultStore.getState().expandedDirs.size).toBe(0)

    // 在 B 上建立工作区后再切回 A
    useTabsStore.setState({ tabs: ['b.md'], activePath: 'b.md' })
    useVaultStore.setState({ expandedDirs: new Set(['bdir']) })
    await new Promise((r) => setTimeout(r, 2)) // 保证回切 A 的时间戳最新

    await useVaultStore.getState().openVault('C:/A')
    expect(useVaultStore.getState().root).toBe('C:/A')
    expect(useTabsStore.getState().tabs).toEqual([])
    expect(useVaultStore.getState().expandedDirs.size).toBe(0)
    // 回到 A 后 A 的时间最新、排最前
    expect(useVaultStore.getState().vaults.map((x) => x.root)).toEqual(['C:/A', 'D:/B'])
  })

  it('create 参数透传给 vaultOpen（首启欢迎库用）', async () => {
    mockVaultOpen.mockClear()
    await useVaultStore.getState().openVault('C:/New', true)
    expect(mockVaultOpen).toHaveBeenCalledWith('C:/New', true)
    expect(useVaultStore.getState().root).toBe('C:/New')

    mockVaultOpen.mockClear()
    await useVaultStore.getState().openVault('D:/Other')
    expect(mockVaultOpen).toHaveBeenCalledWith('D:/Other', false)
  })

  it('点击当前仓库：无操作（归一化后同路径不再触发 vaultOpen）', async () => {
    await useVaultStore.getState().openVault('C:/A')
    mockVaultOpen.mockClear()

    await useVaultStore.getState().openVault('C:/A/')

    expect(mockVaultOpen).not.toHaveBeenCalled()
  })

  it('切换进行中：并发触发被忽略', async () => {
    // 用一个手动 resolve 的 promise 卡住第一次切换的中间过程
    let release!: () => void
    mockVaultOpen.mockImplementationOnce(
      () => new Promise((res) => { release = () => res({ status: 'ok', data: { open: true, root: 'C:/A' } }) })
    )
    const first = useVaultStore.getState().openVault('C:/A')
    await vi.waitFor(() => expect(useVaultStore.getState().loading).toBe(true))

    // loading 期间再次触发：直接忽略
    await useVaultStore.getState().openVault('D:/B')
    expect(useVaultStore.getState().loading).toBe(true)

    release()
    await first
    expect(useVaultStore.getState().root).toBe('C:/A')
  })
})
