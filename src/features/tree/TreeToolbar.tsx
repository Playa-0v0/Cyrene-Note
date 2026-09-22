/**
 * TreeToolbar —— 文件树顶部操作栏
 * 新建笔记 / 新建文件夹 / 排序菜单 / 视图选项菜单 / 全部折叠
 */
import { useEffect, useRef, useState } from 'react'
import { useVaultStore, type SortKey } from '../../stores/vaultStore'
import './TreeToolbar.css'

/** 下拉菜单开关（一次只开一个） */
type MenuKind = 'sort' | 'view' | null

const SORT_OPTIONS: { key: SortKey; asc: boolean; label: string }[] = [
  { key: 'name', asc: true, label: '名称 A → Z' },
  { key: 'name', asc: false, label: '名称 Z → A' },
  { key: 'mtime', asc: false, label: '修改时间 新 → 旧' },
  { key: 'mtime', asc: true, label: '修改时间 旧 → 新' },
]

export function TreeToolbar() {
  const [menu, setMenu] = useState<MenuKind>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)

  const sortKey = useVaultStore((s) => s.sortKey)
  const sortAsc = useVaultStore((s) => s.sortAsc)
  const showMtime = useVaultStore((s) => s.showMtime)
  const setSort = useVaultStore((s) => s.setSort)
  const toggleShowMtime = useVaultStore((s) => s.toggleShowMtime)
  const collapseAll = useVaultStore((s) => s.collapseAll)
  const createNote = useVaultStore((s) => s.createNote)
  const createFolder = useVaultStore((s) => s.createFolder)

  // 点击菜单外部时关闭
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        setMenu(null)
      }
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menu])

  return (
    <div className="tree-toolbar" ref={toolbarRef}>
      {/* 新建笔记 */}
      <button className="tree-tool-btn" onClick={() => void createNote()} title="新建笔记">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M11.5 2.5l2 2L6 12H4v-2L11.5 2.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
          <path d="M2 14h12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
        </svg>
      </button>

      {/* 新建文件夹 */}
      <button className="tree-tool-btn" onClick={() => void createFolder()} title="新建文件夹">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M2 4a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
          <path d="M8 7.5v3M6.5 9h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
        </svg>
      </button>

      {/* 排序（下拉菜单） */}
      <div className="tree-tool-menu-wrap">
        <button
          className={`tree-tool-btn ${menu === 'sort' ? 'active' : ''}`}
          onClick={() => setMenu(menu === 'sort' ? null : 'sort')}
          title="排序"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M5 3v10M5 13l-2-2.5M5 13l2-2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M9 4.5h5M9 8h4M9 11.5h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
        </button>
        {menu === 'sort' && (
          <div className="tree-menu">
            {SORT_OPTIONS.map((opt) => (
              <button
                key={opt.label}
                className={`tree-menu-item ${sortKey === opt.key && sortAsc === opt.asc ? 'active' : ''}`}
                onClick={() => {
                  setSort(opt.key, opt.asc)
                  setMenu(null)
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 视图选项（下拉菜单） */}
      <div className="tree-tool-menu-wrap">
        <button
          className={`tree-tool-btn ${menu === 'view' ? 'active' : ''}`}
          onClick={() => setMenu(menu === 'view' ? null : 'view')}
          title="视图选项"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="2" y="2" width="12" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
            <path d="M2 6h12M6 6v8" stroke="currentColor" strokeWidth="1.2"/>
          </svg>
        </button>
        {menu === 'view' && (
          <div className="tree-menu">
            <button
              className={`tree-menu-item ${showMtime ? 'checked' : ''}`}
              onClick={() => toggleShowMtime()}
            >
              <span className="tree-menu-check">{showMtime ? '✓' : ''}</span>
              显示修改时间
            </button>
          </div>
        )}
      </div>

      {/* 全部折叠 */}
      <button className="tree-tool-btn" onClick={collapseAll} title="全部折叠">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M4 8.5L8 4.5l4 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M4 12.5L8 8.5l4 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
    </div>
  )
}
