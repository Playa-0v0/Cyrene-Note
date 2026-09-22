/**
 * TabBar —— 浏览器式标签栏（Obsidian / VSCode 形态）。
 * 点击激活、× 关闭、中键关闭、dirty 圆点提示、横向滚动。
 */
import { useTabsStore } from '../../stores/tabsStore'
import { useDocStore } from '../../stores/docStore'

/** 标签标题：文件名去掉 .md 后缀 */
function tabTitle(path: string): string {
  const name = path.split('/').pop() ?? path
  return name.replace(/\.md$/, '')
}

export function TabBar() {
  const tabs = useTabsStore((s) => s.tabs)
  const activePath = useTabsStore((s) => s.activePath)
  const setActive = useTabsStore((s) => s.setActive)
  const closeTab = useTabsStore((s) => s.closeTab)
  const status = useDocStore((s) => s.status)

  if (tabs.length === 0) return null

  return (
    <div className="tabbar">
      <div className="tabbar-scroll">
        {tabs.map((path) => {
          const active = path === activePath
          // dirty 圆点只对激活标签有意义（切走前一定冲盘）
          const dirty = active && (status === 'dirty' || status === 'saving')
          return (
            <div
              key={path}
              className={`tab ${active ? 'active' : ''}`}
              title={path}
              onClick={() => void setActive(path)}
              onAuxClick={(e) => {
                // 中键关闭
                if (e.button === 1) {
                  e.preventDefault()
                  void closeTab(path)
                }
              }}
            >
              <span className="tab-title">{tabTitle(path)}</span>
              {dirty && <span className="tab-dirty" />}
              <button
                className="tab-close"
                title="关闭"
                onClick={(e) => {
                  e.stopPropagation()
                  void closeTab(path)
                }}
              >
                ×
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
