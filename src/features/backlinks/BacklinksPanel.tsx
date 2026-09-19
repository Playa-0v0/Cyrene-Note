/**
 * BacklinksPanel —— 右下角折叠面板，列出当前笔记被哪些笔记链接。
 *
 * 极简实现：顶栏一个展开/折叠按钮 + 计数；展开后是滚动列表。
 * 每条点击通过 docStore.openDoc 跳转。
 */
import { useDocStore } from '../../stores/docStore'
import { useState } from 'react'

export function BacklinksPanel() {
  const backlinks = useDocStore((s) => s.backlinks)
  const path = useDocStore((s) => s.path)
  const [open, setOpen] = useState(true)

  if (!path) return null

  return (
    <div className="backlinks-panel">
      <button
        className="backlinks-toggle"
        onClick={() => setOpen(!open)}
        title="展开/折叠反向链接"
      >
        {open ? '▼' : '▶'} 反向链接 ({backlinks.length})
      </button>
      {open && (
        <div className="backlinks-list">
          {backlinks.length === 0 ? (
            <div className="backlinks-empty">没有反向链接</div>
          ) : (
            backlinks.map((bl) => (
              <div
                key={`${bl.source_path}#${bl.target}`}
                className="backlinks-item"
                onClick={() => useDocStore.getState().openDoc(bl.source_path)}
                title={bl.source_path}
              >
                <span className="backlinks-source">{bl.source_path}</span>
                {bl.heading && <span className="backlinks-hash">#{bl.heading}</span>}
                {bl.alias && <span className="backlinks-alias">→ {bl.alias}</span>}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}