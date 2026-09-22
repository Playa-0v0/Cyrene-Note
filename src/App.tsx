import { useEffect, useState } from 'react'
import { useVaultStore } from './stores/vaultStore'
import { useDocStore } from './stores/docStore'
import { useTabsStore } from './stores/tabsStore'
import { FileTree } from './features/tree/FileTree'
import { TreeToolbar } from './features/tree/TreeToolbar'
import { VaultBar } from './features/tree/VaultBar'
import { Welcome } from './features/welcome/Welcome'
import { TabBar } from './features/tabs/TabBar'
import { Editor } from './editor/Editor'
import { WindowControls } from './components/WindowControls'
import { SidebarToggle } from './components/SidebarToggle'
import { ActivityBar, type ActivityKey } from './components/ActivityBar'
import { QuickSwitch } from './features/quick-switch/QuickSwitch'

/** 右侧面板类型 */
type RightPanel = 'ai' | 'graph' | 'video' | null

export default function App() {
  const open_ = useVaultStore((s) => s.open)
  const status = useDocStore((s) => s.status)
  const lastError = useDocStore((s) => s.lastError)
  const tabs = useTabsStore((s) => s.tabs)

  // 左侧文件树是否展开
  const [filesOpen, setFilesOpen] = useState(true)
  // 主页（欢迎界面）/ 编辑（工作界面）视图切换：编辑区隐藏不卸载，保住编辑器会话
  const [homeView, setHomeView] = useState(false)

  // 打开/切换仓库后自动回到编辑工作界面（欢迎界面的卡片点击后也应进入工作区）
  useEffect(() => {
    return useVaultStore.subscribe((s, prev) => {
      if (s.root !== prev.root && s.root) setHomeView(false)
    })
  }, [])
  // 活动栏当前激活的按钮（无激活为 null）
  const [activeActivity, setActiveActivity] = useState<ActivityKey | null>(null)
  // 快速切换弹层
  const [quickSwitchOpen, setQuickSwitchOpen] = useState(false)
  // 右侧当前面板
  const [rightPanel, setRightPanel] = useState<RightPanel>(null)

  const toggleFiles = () => setFilesOpen((v) => !v)

  const openQuickSwitch = () => {
    setActiveActivity('quick-switch')
    setQuickSwitchOpen(true)
  }

  const closeQuickSwitch = () => {
    setQuickSwitchOpen(false)
    setActiveActivity(null)
  }

  // 右侧面板互斥开关：点同一个 = 关闭，点别的 = 切换
  const toggleRightPanel = (panel: Exclude<RightPanel, null>) => {
    const next = rightPanel === panel ? null : panel
    setRightPanel(next)
    setActiveActivity(next)
  }

  return (
    <div className="app">
      {/* 窗口控制：绝对定位右上角（浮在顶部那一行的最右） */}
      <WindowControls />

      {/* 主布局：各栏自带顶部标题区，同一水平线，被侧栏分割线切开 */}
      <div className="main">
        {/* 最左侧：窄功能栏 */}
        <ActivityBar
          active={activeActivity}
          homeActive={homeView}
          onHome={() => setHomeView(true)}
          onEditor={() => setHomeView(false)}
          onOpenQuickSwitch={openQuickSwitch}
          onOpenAI={() => toggleRightPanel('ai')}
          onOpenGraph={() => toggleRightPanel('graph')}
          onOpenVideo={() => toggleRightPanel('video')}
        />

        {/* 左侧：文件树（顶部小标题区含开关；收起后开关跳到中间标签区左侧）。
            主页视图下整体隐藏，切回编辑视图按原状态恢复 */}
        {filesOpen && !homeView && (
          <aside className="sidebar sidebar-left">
            <div className="panel-header" data-tauri-drag-region>
              <SidebarToggle collapsed={false} onToggle={toggleFiles} />
            </div>
            {open_ ? (
              <>
                <TreeToolbar />
                <FileTree />
              </>
            ) : null}
            {/* 底部仓库切换条：已打开时显示当前仓库，未打开时也可从这里快速打开已登记仓库 */}
            <VaultBar />
          </aside>
        )}

        {/* 中间：笔记区（顶部小区域放标签，右侧留窗口控制的位置） */}
        <section className="content">
          <div className="content-header" data-tauri-drag-region>
            {!filesOpen && (
              <SidebarToggle collapsed onToggle={toggleFiles} />
            )}
            {tabs.length > 0 ? (
              <TabBar />
            ) : (
              /* 没有标签时空白占位仍可拖动窗口；有标签时标签区不可拖（标签交互优先） */
              <div className="topbar-drag" data-tauri-drag-region />
            )}
          </div>
          {tabs.length > 0 ? (
            <>
              {/* 编辑工作区：主页视图下隐藏不卸载（保住编辑器会话与未保存内容） */}
              <div className={`note-body${homeView ? ' is-hidden' : ''}`}>
                <Editor />
              </div>
              <footer className={`statusbar${homeView ? ' is-hidden' : ''}`}>
                <span className={`statusbar-indicator st-${status}`}>
                  {status === 'clean' && '已保存'}
                  {status === 'dirty' && '未保存'}
                  {status === 'saving' && '保存中…'}
                  {status === 'conflict' && '冲突'}
                </span>
              </footer>
              {homeView && (
                <div className="no-doc">
                  <Welcome />
                </div>
              )}
            </>
          ) : (
            <div className="no-doc">
              {open_ && !homeView ? (
                <p>从左侧选择一篇笔记</p>
              ) : (
                <Welcome />
              )}
            </div>
          )}
        </section>

        {/* 右侧：AI / 关系图谱 / 视频（条件渲染，互斥） */}
        {rightPanel === 'ai' && (
          <aside className="sidebar sidebar-right">
            <div className="panel-header" data-tauri-drag-region>
              <span className="panel-header-title">AI 助手</span>
            </div>
            <div className="ai-placeholder"><p>AI 会话功能即将上线</p></div>
          </aside>
        )}
        {rightPanel === 'graph' && (
          <aside className="sidebar sidebar-right">
            <div className="panel-header" data-tauri-drag-region>
              <span className="panel-header-title">关系图谱</span>
            </div>
            <div className="ai-placeholder"><p>关系图谱功能即将上线</p></div>
          </aside>
        )}
        {rightPanel === 'video' && (
          <aside className="sidebar sidebar-right">
            <div className="panel-header" data-tauri-drag-region>
              <span className="panel-header-title">视频</span>
            </div>
            <div className="ai-placeholder"><p>视频功能即将上线</p></div>
          </aside>
        )}
      </div>

      {/* 快速切换浮层 */}
      {quickSwitchOpen && <QuickSwitch onClose={closeQuickSwitch} />}

      {/* 错误提示 */}
      {lastError && (
        <div className="error-toast" onClick={() => useDocStore.getState().clearError()}>
          {lastError}
          <span className="error-hint">点击关闭</span>
        </div>
      )}
    </div>
  )
}
