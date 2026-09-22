/**
 * VaultBar —— 侧栏底部仓库切换条
 * 当前仓库名（未打开时显示"打开仓库"）+ 弹出仓库列表 + 管理仓库弹窗。
 * 弹层用 fixed 定位按按钮坐标计算，避免被侧栏 overflow 裁剪。
 */
import { useEffect, useRef, useState } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { useVaultStore, vaultName, normalizeRoot, formatLastOpened } from '../../stores/vaultStore'
import './VaultBar.css'

/** 弹层的 fixed 定位（点击时按按钮位置计算，向上弹出） */
type PopupPos = { left: number; bottom: number }

export function VaultBar() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [managerOpen, setManagerOpen] = useState(false)
  const [popupPos, setPopupPos] = useState<PopupPos | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  const open_ = useVaultStore((s) => s.open)
  const root = useVaultStore((s) => s.root)
  const vaults = useVaultStore((s) => s.vaults)
  const loading = useVaultStore((s) => s.loading)
  const openVault = useVaultStore((s) => s.openVault)
  const addVault = useVaultStore((s) => s.addVault)
  const removeVault = useVaultStore((s) => s.removeVault)

  const isCurrent = (v: string) =>
    open_ && root !== null && normalizeRoot(v) === normalizeRoot(root)

  const toggleMenu = () => {
    if (menuOpen) {
      setMenuOpen(false)
      return
    }
    // 按按钮矩形计算 fixed 弹层坐标（向上弹出）
    const rect = barRef.current?.getBoundingClientRect()
    if (rect) {
      setPopupPos({ left: rect.left, bottom: window.innerHeight - rect.top + 6 })
    }
    setMenuOpen(true)
  }

  // 弹层是短生命周期菜单：点击外部 / Esc / 窗口尺寸变化都直接关闭，不做跟随重算
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    const onResize = () => setMenuOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  }, [menuOpen])

  // Esc 关闭管理弹窗
  useEffect(() => {
    if (!managerOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setManagerOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [managerOpen])

  /** 切换到指定仓库（点当前仓库时 openVault 内部会直接返回） */
  const switchTo = async (dir: string) => {
    if (loading) return
    setMenuOpen(false)
    setManagerOpen(false)
    await openVault(dir)
  }

  /** 弹层里直接打开新文件夹（切换语义） */
  const pickAndOpen = async () => {
    setMenuOpen(false)
    const dir = await openDialog({ directory: true, multiple: false, title: '选择 Vault 文件夹' })
    if (typeof dir === 'string') await openVault(dir)
  }

  /**
   * 管理弹窗里添加仓库：只登记不切换（"管理列表"语义，避免一个动词偷做两个动作）；
   * 当前没有打开任何仓库时才顺带打开（没有可打断的工作区）。
   */
  const addFromPicker = async () => {
    const dir = await openDialog({ directory: true, multiple: false, title: '选择 Vault 文件夹' })
    if (typeof dir !== 'string') return
    addVault(dir)
    if (!useVaultStore.getState().open) {
      setManagerOpen(false)
      await openVault(dir)
    }
  }

  return (
    <div className="vault-bar" ref={barRef}>
      <button className="vault-bar-btn" onClick={toggleMenu} disabled={loading}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
          <path
            d="M2 4a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V4z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
        <span className="vault-bar-name">
          {open_ && root ? vaultName(root) : '打开仓库'}
        </span>
        <svg
          className={`vault-bar-chevron ${menuOpen ? 'open' : ''}`}
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
        >
          <path
            d="M4 10l4-4 4 4"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {/* 仓库列表弹层（fixed，向上弹出） */}
      {menuOpen && popupPos && (
        <div className="vault-popup" style={popupPos}>
          {vaults.length === 0 ? (
            <div className="vault-popup-empty">还没有登记的仓库</div>
          ) : (
            vaults.map((v) => (
              <button
                key={v.root}
                className={`vault-popup-item ${isCurrent(v.root) ? 'current' : ''}`}
                onClick={() => void switchTo(v.root)}
                title={v.root}
              >
                <span className="vp-name">
                  {vaultName(v.root)}
                  {isCurrent(v.root) && <span className="vp-check">✓</span>}
                </span>
                <span className="vp-path">{v.root}</span>
              </button>
            ))
          )}
          <div className="vault-popup-divider" />
          <button className="vault-popup-action" onClick={() => void pickAndOpen()}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <path
                d="M2 4a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V4z"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
              <path d="M8 6.5v4M6 8.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
            打开仓库文件夹…
          </button>
          <button
            className="vault-popup-action"
            onClick={() => {
              setMenuOpen(false)
              setManagerOpen(true)
            }}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <path
                d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
              <circle cx="3" cy="4.5" r="1.1" stroke="currentColor" strokeWidth="1.2" />
              <circle cx="3" cy="8" r="1.1" stroke="currentColor" strokeWidth="1.2" />
              <circle cx="3" cy="11.5" r="1.1" stroke="currentColor" strokeWidth="1.2" />
            </svg>
            管理仓库…
          </button>
        </div>
      )}

      {/* 管理仓库弹窗 */}
      {managerOpen && (
        <div className="vault-manager-overlay" onClick={() => setManagerOpen(false)}>
          <div className="vault-manager" onClick={(e) => e.stopPropagation()}>
            <div className="vm-head">
              <span className="vm-title">管理仓库</span>
              <button className="vm-close" onClick={() => setManagerOpen(false)} title="关闭">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M4 4l8 8M12 4l-8 8"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
            <div className="vm-list">
              {vaults.length === 0 && <p className="vm-empty">还没有登记任何仓库</p>}
              {vaults.map((v) => (
                <div key={v.root} className={`vm-row ${isCurrent(v.root) ? 'current' : ''}`}>
                  <button className="vm-info" onClick={() => void switchTo(v.root)} title={v.root}>
                    <span className="vm-name">{vaultName(v.root)}</span>
                    <span className="vm-path">{v.root}</span>
                  </button>
                  <span className="vm-time">{formatLastOpened(v.lastOpenedAt)}</span>
                  {isCurrent(v.root) ? (
                    <span className="vm-current-tag">当前</span>
                  ) : (
                    <button
                      className="vm-remove"
                      onClick={() => removeVault(v.root)}
                      title="从列表移除（不删除磁盘文件）"
                    >
                      移除
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button className="vm-add" onClick={() => void addFromPicker()}>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <path
                  d="M2 4a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V4z"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                />
                <path d="M8 6.5v4M6 8.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
              添加仓库…
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
