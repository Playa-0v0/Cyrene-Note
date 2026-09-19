/**
 * vaultStore —— Vault 打开状态与文件树。
 */
import { create } from 'zustand'
import { commands, events } from '../lib/bindings'

interface VaultState {
  open: boolean
  root: string | null
  notes: { path: string; size: number; modified_ms: number | null }[]
  loading: boolean

  openVault: (root: string) => Promise<void>
  refreshTree: () => Promise<void>
}

export const useVaultStore = create<VaultState>((set) => ({
  open: false,
  root: null,
  notes: [],
  loading: false,

  openVault: async (root) => {
    set({ loading: true })
    const result = await commands.vaultOpen(root)
    if (result.status === 'ok') {
      set({ open: true, root: result.data.root ?? null })
      await useVaultStore.getState().refreshTree()
    }
    set({ loading: false })
  },

  refreshTree: async () => {
    const result = await commands.notesList()
    if (result.status === 'ok') {
      set({ notes: result.data })
    }
  },
}))

// Rust 侧 save/create 后广播 tree-changed，统一在这里订阅刷新
events.treeChanged.listen(() => {
  useVaultStore.getState().refreshTree()
})
