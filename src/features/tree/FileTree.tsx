/**
 * FileTree —— 按 `/` 路径段折叠的树。
 * 展开/排序/时间显示状态在 vaultStore，TreeToolbar 可控。
 * 右键菜单：笔记（重命名/删除）、目录（新建笔记/新建文件夹/重命名/删除）。
 * 行内重命名 + 删除确认弹窗。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useVaultStore, type SortKey } from '../../stores/vaultStore'
import { useDocStore } from '../../stores/docStore'
import { useTabsStore } from '../../stores/tabsStore'

interface TreeNode {
  name: string
  path: string
  isNote: boolean
  children: TreeNode[]
  /** 笔记的修改时间（目录为 null） */
  modified_ms: number | null
}

/** 右键菜单目标 */
type MenuTarget =
  | { kind: 'note'; path: string; name: string; parent: string }
  | { kind: 'dir'; path: string; name: string; parent: string }
  | { kind: 'root' }

/** 相对时间：刚刚 / x分钟前 / x小时前 / x天前 / MM-DD */
function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}天前`
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function buildTree(
  paths: { path: string; modified_ms: number | null }[],
  sortKey: SortKey,
  sortAsc: boolean,
): TreeNode[] {
  const root: TreeNode = { name: '', path: '', isNote: false, children: [], modified_ms: null }
  for (const { path: p, modified_ms } of paths) {
    const segs = p.split('/')
    let cur = root
    segs.forEach((seg, i) => {
      const isNote = i === segs.length - 1
      const path = segs.slice(0, i + 1).join('/')
      let next = cur.children.find((c) => c.name === seg && c.isNote === isNote)
      if (!next) {
        next = { name: seg, path, isNote, children: [], modified_ms: isNote ? modified_ms : null }
        cur.children.push(next)
      }
      cur = next
    })
  }
  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) => {
      if (a.isNote !== b.isNote) return a.isNote ? 1 : -1 // 目录在前
      let r: number
      if (sortKey === 'mtime') {
        // 修改时间排序：null 沉底
        const av = a.modified_ms ?? 0
        const bv = b.modified_ms ?? 0
        r = av - bv
      } else {
        r = a.name.localeCompare(b.name, 'zh-CN')
      }
      return sortAsc ? r : -r
    })
    n.children.forEach(sortRec)
  }
  sortRec(root)
  return root.children
}

/** 行内重命名输入框：Enter 确认、Esc 取消、失焦取消 */
function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string
  onCommit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      className="tree-rename-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onCommit(value.trim())
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
      onBlur={() => onCancel()}
    />
  )
}

function Node({
  node,
  depth,
  onContextMenu,
}: {
  node: TreeNode
  depth: number
  onContextMenu: (e: React.MouseEvent, target: MenuTarget) => void
}) {
  const activePath = useDocStore((s) => s.path)
  const expandedDirs = useVaultStore((s) => s.expandedDirs)
  const toggleDir = useVaultStore((s) => s.toggleDir)
  const showMtime = useVaultStore((s) => s.showMtime)
  const renamingPath = useVaultStore((s) => s.renamingPath)
  const renameNote = useVaultStore((s) => s.renameNote)
  const renameDir = useVaultStore((s) => s.renameDir)
  const setRenaming = useVaultStore((s) => s.setRenaming)

  // 路径父目录（重命名时拼接新路径用）
  const parent = node.path.includes('/')
    ? node.path.slice(0, node.path.lastIndexOf('/'))
    : ''

  if (node.isNote) {
    const active = activePath === node.path
    const renaming = renamingPath === node.path
    return (
      <div
        className={`tree-note ${active ? 'active' : ''}`}
        style={{ paddingLeft: depth * 14 + 8 }}
        onClick={() => {
          // 走 tabsStore：已有标签则激活，没有则开新标签
          useTabsStore.getState().openTab(node.path)
        }}
        onContextMenu={(e) =>
          onContextMenu(e, { kind: 'note', path: node.path, name: node.name, parent })
        }
      >
        {renaming ? (
          <RenameInput
            initial={node.name}
            onCommit={(value) => {
              // 空值或没变 → 取消；含 / 非法（后端也会拦，这里提前止损）
              if (!value || value === node.name || value.includes('/')) {
                setRenaming(null)
                return
              }
              void renameNote(node.path, `${parent ? `${parent}/` : ''}${value}`)
            }}
            onCancel={() => setRenaming(null)}
          />
        ) : (
          <span className="tree-note-name">{node.name}</span>
        )}
        {showMtime && !renaming && node.modified_ms != null && (
          <span className="tree-note-time">{formatRelativeTime(node.modified_ms)}</span>
        )}
      </div>
    )
  }
  const expanded = expandedDirs.has(node.path)
  const renaming = renamingPath === node.path
  return (
    <div>
      <div
        className={`tree-dir ${expanded ? 'expanded' : ''}`}
        style={{ paddingLeft: depth * 14 + 8 }}
        onClick={() => toggleDir(node.path)}
        onContextMenu={(e) =>
          onContextMenu(e, { kind: 'dir', path: node.path, name: node.name, parent })
        }
      >
        <span className={`tree-dir-arrow ${expanded ? 'expanded' : ''}`}>›</span>
        {renaming ? (
          <RenameInput
            initial={node.name}
            onCommit={(value) => {
              if (!value || value === node.name || value.includes('/')) {
                setRenaming(null)
                return
              }
              void renameDir(node.path, `${parent ? `${parent}/` : ''}${value}`)
            }}
            onCancel={() => setRenaming(null)}
          />
        ) : (
          <span className="tree-dir-name">{node.name}</span>
        )}
      </div>
      {expanded && (
        <div>
          {node.children.map((c) => (
            <Node key={c.path + (c.isNote ? ':f' : ':d')} node={c} depth={depth + 1} onContextMenu={onContextMenu} />
          ))}
        </div>
      )}
    </div>
  )
}

/** 右键菜单（fixed 定位在光标处，贴边收进视口内） */
function ContextMenu({
  x,
  y,
  target,
  onClose,
}: {
  x: number
  y: number
  target: MenuTarget
  onClose: () => void
}) {
  const createNote = useVaultStore((s) => s.createNote)
  const createFolder = useVaultStore((s) => s.createFolder)
  const setRenaming = useVaultStore((s) => s.setRenaming)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const deleteNote = useVaultStore((s) => s.deleteNote)
  const deleteDir = useVaultStore((s) => s.deleteDir)

  // Esc / 点击菜单外关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const menuRef = useRef<HTMLDivElement>(null)
  // 渲染后按实际尺寸收进视口（先按 x,y 放，再 clamp）
  const [pos, setPos] = useState({ left: x, top: y })
  useEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({
      left: Math.min(x, window.innerWidth - rect.width - 8),
      top: Math.min(y, window.innerHeight - rect.height - 8),
    })
  }, [x, y])

  // 删除确认：菜单本身变成确认态（红字按钮）
  if (confirmDelete && target.kind !== 'root') {
    return (
      <>
        <div className="ctx-overlay" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
        <div ref={menuRef} className="ctx-menu" style={pos}>
          <div className="ctx-menu-title">删除「{target.name}」？</div>
          <div className="ctx-menu-hint">内容已存入历史，可恢复</div>
          <button
            className="ctx-menu-item danger"
            onClick={() => {
              if (target.kind === 'note') void deleteNote(target.path)
              else void deleteDir(target.path)
              onClose()
            }}
          >
            确认删除
          </button>
          <button className="ctx-menu-item" onClick={onClose}>
            取消
          </button>
        </div>
      </>
    )
  }

  return (
    <>
      <div className="ctx-overlay" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div ref={menuRef} className="ctx-menu" style={pos}>
        {target.kind === 'note' && (
          <>
            <button
              className="ctx-menu-item"
              onClick={() => {
                setRenaming(target.path)
                onClose()
              }}
            >
              重命名
            </button>
            <button className="ctx-menu-item danger" onClick={() => setConfirmDelete(true)}>
              删除
            </button>
          </>
        )}
        {target.kind === 'dir' && (
          <>
            <button
              className="ctx-menu-item"
              onClick={() => {
                void createNote(target.path)
                onClose()
              }}
            >
              新建笔记
            </button>
            <button
              className="ctx-menu-item"
              onClick={() => {
                void createFolder(target.path)
                onClose()
              }}
            >
              新建文件夹
            </button>
            <div className="ctx-menu-sep" />
            <button
              className="ctx-menu-item"
              onClick={() => {
                setRenaming(target.path)
                onClose()
              }}
            >
              重命名
            </button>
            <button className="ctx-menu-item danger" onClick={() => setConfirmDelete(true)}>
              删除
            </button>
          </>
        )}
        {target.kind === 'root' && (
          <>
            <button
              className="ctx-menu-item"
              onClick={() => {
                void createNote()
                onClose()
              }}
            >
              新建笔记
            </button>
            <button
              className="ctx-menu-item"
              onClick={() => {
                void createFolder()
                onClose()
              }}
            >
              新建文件夹
            </button>
          </>
        )}
      </div>
    </>
  )
}

export function FileTree() {
  const notes = useVaultStore((s) => s.notes)
  const sortKey = useVaultStore((s) => s.sortKey)
  const sortAsc = useVaultStore((s) => s.sortAsc)
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null)
  const tree = useMemo(
    () => buildTree(notes.map((n) => ({ path: n.path, modified_ms: n.modified_ms })), sortKey, sortAsc),
    [notes, sortKey, sortAsc],
  )

  if (notes.length === 0) {
    return <div className="tree-empty">（没有笔记）</div>
  }
  return (
    <div
      className="file-tree"
      onContextMenu={(e) => {
        // 空白区域右键 → 根目录菜单（只在树自身空白处，不冒泡自节点）
        if (e.target === e.currentTarget) {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY, target: { kind: 'root' } })
        }
      }}
    >
      {tree.map((n) => (
        <Node
          key={n.path + (n.isNote ? ':f' : ':d')}
          node={n}
          depth={0}
          onContextMenu={(e, target) => {
            e.preventDefault()
            e.stopPropagation()
            setMenu({ x: e.clientX, y: e.clientY, target })
          }}
        />
      ))}
      {menu && <ContextMenu x={menu.x} y={menu.y} target={menu.target} onClose={() => setMenu(null)} />}
    </div>
  )
}
