/**
 * tabsStore —— 浏览器式标签页（Obsidian / VSCode 形态）。
 *
 * 模型：docStore 仍是"单文档协调态"（驱动唯一编辑器实例）；
 * 这里只管标签列表与激活项。切换标签 = 冲盘保存当前缓冲 → openDoc(新路径)。
 *
 * 不变量：
 * - 只有激活标签可能 dirty（切走前一定 flush：dirty → save，conflict → LOCAL 入历史后重读）
 * - 标签列表里的路径都是 vault 内合法笔记路径
 */
import { create } from 'zustand'
import { useDocStore } from './docStore'
import { editorViewRef } from '../editor/editorViewRef'

interface TabsState {
  /** 打开的标签（vault 相对路径，按打开顺序） */
  tabs: string[]
  /** 激活标签路径；无标签为 null */
  activePath: string | null

  /** 打开（或激活已有）标签：文件树点击 / 快速切换 / 新建笔记都走这里 */
  openTab: (path: string) => void
  /** 激活一个已打开的标签（点击标签） */
  setActive: (path: string) => Promise<void>
  /** 关闭标签：关闭激活标签前先冲盘；关的是激活标签则激活邻位 */
  closeTab: (path: string) => Promise<void>
  /** 路径迁移（重命名笔记/目录）：同步标签列表与激活态 */
  renameTabs: (moves: { from: string; to: string }[]) => void
  /** 移除标签（删除笔记/目录时按前缀清理） */
  removeTabs: (predicate: (path: string) => boolean) => void
  /**
   * 冲盘保存当前激活文档：dirty → 立即保存；conflict → LOCAL 存历史后按磁盘重读。
   * 返回是否安全（true = 无需保存或已全部落盘）；false = 有内容未安全落盘，
   * 调用方（如 Vault 切换）必须中止后续动作。
   */
  flushActive: () => Promise<boolean>
  /** 清空标签列表（不碰 docStore；文档会话由 vaultStore 切换编排时另行清理） */
  reset: () => void
}

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  activePath: null,

  openTab: (path) => {
    const { tabs, activePath } = get()
    if (!tabs.includes(path)) {
      set({ tabs: [...tabs, path] })
    }
    if (activePath !== path) {
      // openDoc 的 sessionId 校验会丢弃旧会话的过期结果；冲盘交给 setActive 语义
      void get().setActive(path)
    }
  },

  setActive: async (path) => {
    const { tabs, activePath } = get()
    if (!tabs.includes(path) || activePath === path) return
    await get().flushActive()
    useDocStore.setState({ path })
    set({ activePath: path })
  },

  closeTab: async (path) => {
    const { tabs, activePath } = get()
    const idx = tabs.indexOf(path)
    if (idx === -1) return
    if (activePath === path) {
      await get().flushActive()
    }
    const next = tabs.filter((t) => t !== path)
    // 关的是激活标签 → 激活右邻（没有则左邻/最后一个）
    let newActive: string | null = activePath
    if (activePath === path) {
      newActive = next[Math.min(idx, next.length - 1)] ?? null
    }
    set({ tabs: next, activePath: newActive })
    // docStore.path 跟随激活态；编辑器按 path 变化自动开/关文档
    if (useDocStore.getState().path !== newActive) {
      useDocStore.setState({ path: newActive })
    }
  },

  renameTabs: (moves) => {
    if (moves.length === 0) return
    const { tabs, activePath } = get()
    const map = new Map(moves.map((m) => [m.from, m.to]))
    set({
      tabs: tabs.map((t) => map.get(t) ?? t),
      activePath: activePath ? (map.get(activePath) ?? activePath) : null,
    })
  },

  removeTabs: (predicate) => {
    const { tabs, activePath } = get()
    const next = tabs.filter((t) => !predicate(t))
    if (next.length === tabs.length) return
    // 激活标签被移除且还有剩余 → 接续到邻位（同 closeTab），否则清空
    let newActive: string | null = activePath
    if (activePath && predicate(activePath)) {
      const idx = tabs.indexOf(activePath)
      newActive = next[Math.min(idx, next.length - 1)] ?? null
    }
    set({ tabs: next, activePath: newActive })
    if (useDocStore.getState().path !== newActive) {
      useDocStore.setState({ path: newActive })
    }
  },

  flushActive: async () => {
    const st = useDocStore.getState()
    const view = editorViewRef.current
    // 没有编辑器或没打开文档：无需保护
    if (!view || !st.path) return true
    const content = view.state.doc.toString()
    if (st.status === 'dirty') {
      return await st.saveDoc(content)
    }
    if (st.status === 'conflict') {
      // LOCAL 内容先进恢复存储再重读，切回时看到的是磁盘版本，本地修改不丢（可从历史找回）
      return (await st.discardLocalAndReload(content)) !== null
    }
    if (st.status === 'saving') {
      // 保存结果尚未落定，不能在结果未知时销毁缓冲区——中止并让调用方稍后重试
      return false
    }
    return true
  },

  reset: () => set({ tabs: [], activePath: null }),
}))
