/**
 * SidebarToggle —— 顶栏的文件树收起/展开按钮
 * SVG 动画：框 + 竖线 + chevron，hover 时竖线收缩、chevron 淡入
 * 移植自 Cyrene-Agent，适配本项目 token
 */
import { useState } from 'react'
import './SidebarToggle.css'

interface SidebarToggleProps {
  collapsed?: boolean
  onToggle?: () => void
}

export function SidebarToggle({ collapsed = false, onToggle }: SidebarToggleProps) {
  const [hovered, setHovered] = useState(false)

  return (
    <button
      className={`sidebar-toggle ${collapsed ? 'is-collapsed' : ''} ${hovered ? 'is-hovered' : ''}`}
      onClick={onToggle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={collapsed ? '展开文件树' : '收起文件树'}
    >
      <svg width="20" height="20" viewBox="0 0 48 48" fill="none">
        {/* 框 */}
        <rect
          x="6" y="6" width="36" height="36" rx="3"
          stroke="currentColor" strokeWidth="3.5" strokeLinejoin="round"
        />
        {/* 竖线 */}
        <path
          className="sidebar-toggle-line"
          d="M24 6V42"
          stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"
        />
        {/* 上横线 */}
        <path d="M11 6H36" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
        {/* 下横线 */}
        <path d="M11 42H36" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
        {/* Chevron */}
        <path
          className="sidebar-toggle-chevron"
          d="M32 20L28 24L32 28"
          stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}
