import { open } from '@tauri-apps/plugin-dialog'
import { useVaultStore } from './stores/vaultStore'
import { useDocStore } from './stores/docStore'
import { FileTree } from './features/tree/FileTree'
import { Editor } from './editor/Editor'

export default function App() {
  const open_ = useVaultStore((s) => s.open)
  const root = useVaultStore((s) => s.root)
  const path = useDocStore((s) => s.path)
  const status = useDocStore((s) => s.status)
  const lastError = useDocStore((s) => s.lastError)

  const pickVault = async () => {
    const dir = await open({ directory: true, multiple: false, title: '选择 Vault 文件夹' })
    if (typeof dir === 'string') {
      await useVaultStore.getState().openVault(dir)
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Cyrene Notes</span>
        {root && <span className="vault-path" title={root}>{root}</span>}
        <span className={`doc-status st-${status}`}>
          {status === 'clean' && '✓ 已保存'}
          {status === 'dirty' && '… 未保存'}
          {status === 'saving' && '⏳ 保存中'}
          {status === 'conflict' && '⚠ 冲突'}
        </span>
        <button onClick={pickVault}>{open_ ? '切换 Vault' : '打开 Vault'}</button>
      </header>

      {!open_ ? (
        <div className="welcome">
          <h1>Cyrene Notes</h1>
          <p>高度适配 Cyrene Learn 模式的本地 Markdown 笔记</p>
          <button className="primary" onClick={pickVault}>打开 Vault 文件夹</button>
        </div>
      ) : (
        <div className="main">
          <aside className="sidebar">
            <FileTree />
          </aside>
          <section className="content">
            {path ? <Editor /> : <div className="no-doc">从左侧选择一篇笔记</div>}
          </section>
        </div>
      )}

      {lastError && (
        <div className="error-toast" onClick={() => useDocStore.getState().clearError()}>
          {lastError}
          <span className="hint">（点击关闭）</span>
        </div>
      )}
    </div>
  )
}
