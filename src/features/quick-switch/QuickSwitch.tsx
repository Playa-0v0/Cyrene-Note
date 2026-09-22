/**
 * QuickSwitch —— 快速切换面板
 * 最近打开的笔记 + 常用命令（只保留 UI）。
 */
import { useEffect, useMemo, useState } from 'react'
import { useVaultStore } from '../../stores/vaultStore'
import { useDocStore } from '../../stores/docStore'
import { useTabsStore } from '../../stores/tabsStore'
import './QuickSwitch.css'

/** 面板模式：最近文件 / 命令 */
type QuickTab = 'files' | 'commands'

interface QuickSwitchProps {
  onClose: () => void
}

const COMMANDS = [
  { id: 'new-note', name: '新建笔记', shortcut: 'Ctrl+N' },
  { id: 'new-folder', name: '新建文件夹', shortcut: 'Ctrl+Shift+N' },
  { id: 'open-vault', name: '打开 Vault 文件夹', shortcut: '' },
  { id: 'toggle-ai', name: '打开/关闭 AI 面板', shortcut: '' },
  { id: 'collapse-all', name: '全部折叠', shortcut: '' },
]

export function QuickSwitch({ onClose }: QuickSwitchProps) {
  const notes = useVaultStore((s) => s.notes)
  const [tab, setTab] = useState<QuickTab>('files')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)

  type FileItem = { kind: 'file'; path: string; name: string }
  type CmdItem = (typeof COMMANDS)[number]

  const items = useMemo<(FileItem | CmdItem)[]>(() => {
    if (tab === 'commands') {
      return COMMANDS.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
    }
    return notes
      .map<FileItem>((n) => ({ kind: 'file', path: n.path, name: n.path.split('/').pop() ?? n.path }))
      .filter((n) => n.name.toLowerCase().includes(query.toLowerCase()))
  }, [tab, query, notes])

  useEffect(() => {
    setSelected(0)
  }, [tab, query])

  const handleSelect = () => {
    const item = items[selected]
    if (!item) return
    if (tab === 'files' && item.kind === 'file') {
      useTabsStore.getState().openTab(item.path)
      onClose()
    } else if (tab === 'commands') {
      const cmd = item as (typeof COMMANDS)[number]
      switch (cmd.id) {
        case 'new-note':
          void useVaultStore.getState().createNote()
          break
        case 'new-folder':
          void useVaultStore.getState().createFolder()
          break
        case 'collapse-all':
          useVaultStore.getState().collapseAll()
          break
      }
      onClose()
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (items.length === 0) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelected((i) => (i + 1) % items.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected((i) => (i - 1 + items.length) % items.length)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        handleSelect()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, selected])

  return (
    <div className="quick-switch-overlay" onClick={onClose}>
      <div className="quick-switch-panel" onClick={(e) => e.stopPropagation()}>
        {/* 搜索框 */}
        <div className="quick-switch-search">
          <svg width="16" height="16" viewBox="0 0 48 48" fill="none">
            <path d="M10 44H38C39.1046 44 40 43.1046 40 42V14H30V4H10C8.89543 4 8 4.89543 8 6V42C8 43.1046 8.89543 44 10 44Z" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M30 4L40 14" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="22" cy="26" r="6" stroke="currentColor" strokeWidth="4"/>
            <path d="M27 30L32 34" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <input
            type="text"
            placeholder={tab === 'files' ? '搜索笔记…' : '搜索命令…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>

        {/* 标签 */}
        <div className="quick-switch-tabs">
          <button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>最近文件</button>
          <button className={tab === 'commands' ? 'active' : ''} onClick={() => setTab('commands')}>命令</button>
        </div>

        {/* 列表 */}
        <div className="quick-switch-list">
          {items.length === 0 && <div className="quick-switch-empty">没有匹配项</div>}
          {items.map((item, idx) => {
            if (tab === 'files') {
              const f = item as { kind: 'file'; path: string; name: string }
              return (
                <div
                  key={f.path}
                  className={`quick-switch-item ${idx === selected ? 'selected' : ''}`}
                  onMouseEnter={() => setSelected(idx)}
                  onClick={handleSelect}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <path d="M14 2v6h6" />
                  </svg>
                  <span className="quick-switch-name">{f.name}</span>
                  <span className="quick-switch-meta">{f.path}</span>
                </div>
              )
            }
            const c = item as (typeof COMMANDS)[number]
            return (
              <div
                key={c.id}
                className={`quick-switch-item ${idx === selected ? 'selected' : ''}`}
                onMouseEnter={() => setSelected(idx)}
                onClick={handleSelect}
              >
                <span className="quick-switch-name">{c.name}</span>
                {c.shortcut && <span className="quick-switch-shortcut">{c.shortcut}</span>}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
