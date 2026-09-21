/**
 * 文档会话安全测试（PR 1：GPT P0-1 / P0-2 / H-1 / H-2）。
 *
 * 通过 vi.mock 把 IPC client 替换成可控替身，覆盖真异步路径。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// 替身：每个测试覆写对应方法的实现
const mockNotesRead = vi.fn()
const mockNotesSave = vi.fn()
const mockNotesBacklinks = vi.fn()
const mockNotesDiscardLocal = vi.fn()
const mockVaultOpen = vi.fn()
const mockVaultStatus = vi.fn()
const mockNotesList = vi.fn()

vi.mock('../lib/bindings', () => ({
  commands: {
    notesRead: (...args: any[]) => mockNotesRead(...args),
    notesSave: (...args: any[]) => mockNotesSave(...args),
    notesBacklinks: (...args: any[]) => mockNotesBacklinks(...args),
    notesDiscardLocal: (...args: any[]) => mockNotesDiscardLocal(...args),
    vaultOpen: (...args: any[]) => mockVaultOpen(...args),
    vaultStatus: (...args: any[]) => mockVaultStatus(...args),
    notesList: (...args: any[]) => mockNotesList(...args),
  },
  events: {
    fileChanged: { listen: () => Promise.resolve(() => {}) },
    treeChanged: { listen: () => Promise.resolve(() => {}) },
  },
}))

import { useDocStore } from './docStore'

const resetStore = () =>
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

describe('PR 1: openDoc 会话身份', () => {
  beforeEach(() => {
    resetStore()
    mockNotesRead.mockReset()
  })

  it('openDoc 每次生成新的 sessionId', async () => {
    mockNotesRead.mockResolvedValue({ status: 'ok', data: { path: 'a.md', content: 'a', content_hash: 'HA', links: [] } })
    await useDocStore.getState().openDoc('a.md')
    const s1 = useDocStore.getState().sessionId
    mockNotesRead.mockResolvedValue({ status: 'ok', data: { path: 'b.md', content: 'b', content_hash: 'HB', links: [] } })
    await useDocStore.getState().openDoc('b.md')
    const s2 = useDocStore.getState().sessionId
    expect(s1).not.toBeNull()
    expect(s2).not.toBeNull()
    expect(s2).not.toBe(s1)
    expect(useDocStore.getState().path).toBe('b.md')
  })

  it('openDoc 失败时记录 lastError 并保持 path=null', async () => {
    mockNotesRead.mockResolvedValue({ status: 'error', error: { type: 'NotFound', path: 'x.md' } })
    await useDocStore.getState().openDoc('x.md')
    expect(useDocStore.getState().path).toBeNull()
    expect(useDocStore.getState().sessionId).toBeNull()
    expect(useDocStore.getState().lastError).toBeTruthy()
  })
})

describe('PR 1: saveDoc revision-aware', () => {
  beforeEach(() => {
    resetStore()
    mockNotesSave.mockReset()
  })

  it('save 成功后 revision === savedRevision → clean', async () => {
    mockNotesRead.mockResolvedValue({ status: 'ok', data: { path: 'a.md', content: 'a', content_hash: 'HA', links: [] } })
    await useDocStore.getState().openDoc('a.md')
    mockNotesSave.mockResolvedValue({ status: 'ok', data: { path: 'a.md', new_content_hash: 'H2' } })
    const ok = await useDocStore.getState().saveDoc('content A')
    expect(ok).toBe(true)
    expect(useDocStore.getState().status).toBe('clean')
    expect(useDocStore.getState().baseHash).toBe('H2')
  })

  it('save 期间用户继续输入：旧 save 结果到达时 → status=dirty + savedRevision 不前进', async () => {
    mockNotesRead.mockResolvedValue({ status: 'ok', data: { path: 'a.md', content: 'a', content_hash: 'HA', links: [] } })
    await useDocStore.getState().openDoc('a.md')

    // 第一次 save 在飞（永不 resolve）
    let resolve1!: (v: any) => void
    mockNotesSave.mockReturnValueOnce(new Promise((res) => { resolve1 = res }))
    const p1 = useDocStore.getState().saveDoc('content A')

    // 用户继续输入：markDirty 推进 generation + 把 status 切回 dirty（同时取消旧 save）
    useDocStore.getState().markDirty()
    expect(useDocStore.getState().status).toBe('dirty')
    const genAfterDirty = useDocStore.getState().saveGeneration

    // 旧 save 返回了——generation 已变，丢弃
    resolve1({ status: 'ok', data: { path: 'a.md', new_content_hash: 'H_OLD' } })
    await p1

    const s = useDocStore.getState()
    expect(s.baseHash).toBe('HA') // 没被旧结果覆盖
    expect(s.status).toBe('dirty') // 仍在 dirty
    expect(s.saveGeneration).toBe(genAfterDirty)
  })

  it('Conflict 错误 → status=conflict 且保留 conflict 详情', async () => {
    mockNotesRead.mockResolvedValue({ status: 'ok', data: { path: 'a.md', content: 'a', content_hash: 'HA', links: [] } })
    await useDocStore.getState().openDoc('a.md')
    mockNotesSave.mockResolvedValue({ status: 'error', error: { type: 'Conflict', path: 'a.md', expected: 'HA', actual: 'HX' } })
    await useDocStore.getState().saveDoc('content')
    const s = useDocStore.getState()
    expect(s.status).toBe('conflict')
    expect(s.conflict).toEqual({ expected: 'HA', actual: 'HX' })
  })
})

describe('PR 1: 跨会话 save 结果丢弃', () => {
  beforeEach(() => {
    resetStore()
    mockNotesSave.mockReset()
    mockNotesRead.mockReset()
  })

  it('旧 save 返回时 sessionId 已变 → 状态不污染', async () => {
    mockNotesRead.mockResolvedValue({ status: 'ok', data: { path: 'a.md', content: 'a', content_hash: 'HA', links: [] } })
    await useDocStore.getState().openDoc('a.md')
    const sIdA = useDocStore.getState().sessionId!

    // A 的 save 请求"发出"但结果延后
    let resolveA!: (v: any) => void
    mockNotesSave.mockReturnValue(new Promise((res) => { resolveA = res }))
    const savePromiseA = useDocStore.getState().saveDoc('content A')

    // 切到 B（同时 B 也需要 read）
    mockNotesRead.mockResolvedValue({ status: 'ok', data: { path: 'b.md', content: 'b', content_hash: 'HB', links: [] } })
    await useDocStore.getState().openDoc('b.md')

    // A 的 save 结果回来了 → 必须丢弃（sessionId 已变）
    resolveA({ status: 'ok', data: { path: 'a.md', new_content_hash: 'H_WRONG' } })
    await savePromiseA

    const s = useDocStore.getState()
    expect(s.path).toBe('b.md')
    expect(s.baseHash).toBe('HB')
    expect(s.baseHash).not.toBe('H_WRONG')
    expect(s.sessionId).not.toBe(sIdA)
  })

  it('同一会话内：markDirty 推进 generation → 旧 save 结果丢弃', async () => {
    mockNotesRead.mockResolvedValue({ status: 'ok', data: { path: 'a.md', content: 'a', content_hash: 'HA', links: [] } })
    await useDocStore.getState().openDoc('a.md')

    // 第一次 save 在飞（永不 resolve）
    let resolve1!: (v: any) => void
    mockNotesSave.mockReturnValueOnce(new Promise((res) => { resolve1 = res }))
    const p1 = useDocStore.getState().saveDoc('first')

    // markDirty 推进 generation
    useDocStore.getState().markDirty()
    const genAfter = useDocStore.getState().saveGeneration

    // 旧 save 返回了——generation 已变，丢弃
    resolve1({ status: 'ok', data: { path: 'a.md', new_content_hash: 'H_OLD' } })
    await p1

    const s = useDocStore.getState()
    expect(s.baseHash).toBe('HA')
    expect(s.status).toBe('dirty')
    expect(s.saveGeneration).toBe(genAfter)
  })
})

describe('PR 1: markDirty / revision 规则', () => {
  beforeEach(() => resetStore())

  it('sessionId=null 时 markDirty 不生效（状态保持 clean，revision 不递增）', () => {
    useDocStore.getState().markDirty()
    expect(useDocStore.getState().status).toBe('clean')
    expect(useDocStore.getState().revision).toBe(0)
  })

  it('clean → dirty 后 revision 递增；dirty/saving/conflict 时 markDirty 也递增 revision 但 status 不变', () => {
    useDocStore.setState({ path: 'a.md', sessionId: 1, status: 'clean', revision: 0, savedRevision: 0 })
    useDocStore.getState().markDirty()
    expect(useDocStore.getState().revision).toBe(1)
    expect(useDocStore.getState().status).toBe('dirty')
    useDocStore.getState().markDirty()
    expect(useDocStore.getState().revision).toBe(2)
    expect(useDocStore.getState().status).toBe('dirty')
  })
})

describe('PR 1: discardLocalAndReload 失败保 LOCAL', () => {
  beforeEach(() => {
    resetStore()
    mockNotesDiscardLocal.mockReset()
  })

  it('history snapshot 失败 → 保留 LOCAL + 冲突态 + lastError', async () => {
    mockNotesDiscardLocal.mockResolvedValue({ status: 'error', error: { type: 'Io', detail: 'disk full' } })
    useDocStore.setState({
      path: 'a.md', baseHash: 'H0', status: 'conflict',
      conflict: { expected: 'H0', actual: 'H1' }, sessionId: 1, revision: 3, savedRevision: 0,
    })
    const result = await useDocStore.getState().discardLocalAndReload('LOCAL content')
    expect(result).toBeNull()
    expect(useDocStore.getState().path).toBe('a.md')
    expect(useDocStore.getState().status).toBe('conflict')
    expect(useDocStore.getState().conflict).toEqual({ expected: 'H0', actual: 'H1' })
    expect(useDocStore.getState().lastError).toContain('保护你的内容')
  })

  it('history snapshot 成功 + 重读成功 → 切到新 base，状态回 clean', async () => {
    mockNotesDiscardLocal.mockResolvedValue({ status: 'ok', data: { path: 'a.md', new_content_hash: 'H2' } })
    mockNotesRead.mockResolvedValue({ status: 'ok', data: { path: 'a.md', content: 'new disk', content_hash: 'H2', links: [] } })
    useDocStore.setState({
      path: 'a.md', baseHash: 'H0', status: 'conflict',
      conflict: { expected: 'H0', actual: 'H1' }, sessionId: 1, revision: 3, savedRevision: 0,
    })
    const result = await useDocStore.getState().discardLocalAndReload('LOCAL')
    expect(result).toBe('new disk')
    const s = useDocStore.getState()
    expect(s.baseHash).toBe('H2')
    expect(s.status).toBe('clean')
  })
})