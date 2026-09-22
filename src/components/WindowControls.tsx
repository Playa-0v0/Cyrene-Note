/**
 * WindowControls —— 自定义窗口控制（最小化 / 最大化还原 / 关闭）
 * Obsidian 风格：顶栏右上角三键，关闭键 hover 红色
 * 窗口装饰已在 tauri.conf.json 关闭（decorations: false）
 */
import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import './WindowControls.css'

const appWindow = getCurrentWindow()

export function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  // 窗口尺寸变化时同步最大化状态（切换最大化/还原图标）
  useEffect(() => {
    const unlisten = appWindow.onResized(async () => {
      setMaximized(await appWindow.isMaximized())
    })
    return () => {
      unlisten.then((f) => f())
    }
  }, [])

  return (
    <div className="window-controls">
      <button
        className="wc-btn"
        onClick={() => appWindow.minimize()}
        aria-label="最小化"
        title="最小化"
      >
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
          <path d="M0.5 5.5H10.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
      </button>
      <button
        className="wc-btn"
        onClick={() => appWindow.toggleMaximize()}
        aria-label={maximized ? '还原' : '最大化'}
        title={maximized ? '还原' : '最大化'}
      >
        {maximized ? (
          // 还原图标：前后两个叠加方框
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
            <rect x="0.5" y="2.5" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1" />
            <path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-1" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          // 最大化图标：单个方框
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
            <rect x="0.5" y="0.5" width="10" height="10" rx="1" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </button>
      <button
        className="wc-btn wc-close"
        onClick={() => appWindow.close()}
        aria-label="关闭"
        title="关闭"
      >
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
          <path d="M0.5 0.5l10 10M10.5 0.5l-10 10" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}
