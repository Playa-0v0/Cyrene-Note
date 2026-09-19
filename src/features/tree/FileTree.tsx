/**
 * FileTree —— 按 `/` 路径段折叠的简单树。
 * v1 扁平列表 + 缩进；后续阶段换虚拟化树。
 */
import { useMemo } from 'react'
import { useVaultStore } from '../../stores/vaultStore'
import { useDocStore } from '../../stores/docStore'

interface TreeNode {
  name: string
  path: string
  isNote: boolean
  children: TreeNode[]
}

function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', isNote: false, children: [] }
  for (const p of paths) {
    const segs = p.split('/')
    let cur = root
    segs.forEach((seg, i) => {
      const isNote = i === segs.length - 1
      const path = segs.slice(0, i + 1).join('/')
      let next = cur.children.find((c) => c.name === seg && c.isNote === isNote)
      if (!next) {
        next = { name: seg, path, isNote, children: [] }
        cur.children.push(next)
      }
      cur = next
    })
  }
  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) => {
      if (a.isNote !== b.isNote) return a.isNote ? 1 : -1 // 目录在前
      return a.name.localeCompare(b.name, 'zh-CN')
    })
    n.children.forEach(sortRec)
  }
  sortRec(root)
  return root.children
}

function Node({ node, depth }: { node: TreeNode; depth: number }) {
  const activePath = useDocStore((s) => s.path)

  if (node.isNote) {
    const active = activePath === node.path
    return (
      <div
        className={`tree-note ${active ? 'active' : ''}`}
        style={{ paddingLeft: depth * 14 + 8 }}
        onClick={() => useDocStore.getState().openDoc(node.path)}
      >
        {node.name}
      </div>
    )
  }
  return (
    <details open style={{ paddingLeft: depth * 14 }}>
      <summary className="tree-dir">{node.name}</summary>
      {node.children.map((c) => (
        <Node key={c.path + (c.isNote ? ':f' : ':d')} node={c} depth={depth + 1} />
      ))}
    </details>
  )
}

export function FileTree() {
  const notes = useVaultStore((s) => s.notes)
  const tree = useMemo(() => buildTree(notes.map((n) => n.path)), [notes])

  if (notes.length === 0) {
    return <div className="tree-empty">（没有笔记）</div>
  }
  return (
    <div className="file-tree">
      {tree.map((n) => (
        <Node key={n.path + (n.isNote ? ':f' : ':d')} node={n} depth={0} />
      ))}
    </div>
  )
}
