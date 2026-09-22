/**
 * ActivityBar —— 左侧窄功能栏
 * 顶部主导航组：主页（欢迎界面）/ 编辑（工作界面）
 * 其余按钮：快速切换 / AI / 关系图谱 / 视频（占位）
 * 图标来自 ByteDance IconPark（.assets/iconpark），统一为线性风格
 * 文件树开关在顶栏（SidebarToggle），不在这里
 */import './ActivityBar.css'

export type ActivityKey = 'quick-switch' | 'ai' | 'graph' | 'video'

interface ActivityBarProps {
  /** 当前激活的功能按钮 */
  active: ActivityKey | null
  /** 主页（欢迎界面）视图是否激活；编辑按钮取反 */
  homeActive: boolean
  onHome: () => void
  onEditor: () => void
  onOpenQuickSwitch: () => void
  onOpenAI: () => void
  onOpenGraph: () => void
  onOpenVideo: () => void
}

export function ActivityBar({
  active,
  homeActive,
  onHome,
  onEditor,
  onOpenQuickSwitch,
  onOpenAI,
  onOpenGraph,
  onOpenVideo,
}: ActivityBarProps) {
  return (
    <div className="activity-bar">
      {/* 主导航：主页 / 编辑（互斥视图切换） */}
      <div className="activity-group">
        {/* 主页（IconPark: home，outline） */}
        <button
          className={`activity-item ${homeActive ? 'active' : ''}`}
          onClick={onHome}
          title="主页"
        >
          <svg width="20" height="20" viewBox="0 0 48 48" fill="none">
            <path d="M9 18V42H39V18L24 6L9 18Z" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M19 29V42H29V29H19Z" stroke="currentColor" strokeWidth="4" strokeLinejoin="round"/>
            <path d="M9 42H39" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>

        {/* 编辑（IconPark: file-editing-one，outline） */}
        <button
          className={`activity-item ${!homeActive ? 'active' : ''}`}
          onClick={onEditor}
          title="编辑"
        >
          <svg width="20" height="20" viewBox="0 0 48 48" fill="none">
            <path d="M40 23V14L31 4H10C8.89543 4 8 4.89543 8 6V42C8 43.1046 8 44 10 44H22" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M32 44L42 34L38 30L28 40V44H32Z" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M30 4V14H40" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>

      <div className="activity-group">
        <button
          className={`activity-item ${active === 'quick-switch' ? 'active' : ''}`}
          onClick={onOpenQuickSwitch}
          title="快速切换"
        >
          <svg width="20" height="20" viewBox="0 0 48 48" fill="none">
            <path d="M10 44H38C39.1046 44 40 43.1046 40 42V14H30V4H10C8.89543 4 8 4.89543 8 6V42C8 43.1046 8.89543 44 10 44Z" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M30 4L40 14" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="22" cy="26" r="6" stroke="currentColor" strokeWidth="4"/>
            <path d="M27 30L32 34" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>

      <div className="activity-group">
        {/* AI（IconPark: application-two） */}
        <button
          className={`activity-item ${active === 'ai' ? 'active' : ''}`}
          onClick={onOpenAI}
          title="AI 助手"
        >
          <svg width="20" height="20" viewBox="0 0 48 48" fill="none">
            <circle cx="34.5" cy="13.5" r="6.5" stroke="currentColor" strokeWidth="4"/>
            <circle cx="34.5" cy="34.5" r="6.5" stroke="currentColor" strokeWidth="4"/>
            <circle cx="13.5" cy="13.5" r="6.5" stroke="currentColor" strokeWidth="4"/>
            <circle cx="13.5" cy="34.5" r="6.5" stroke="currentColor" strokeWidth="4"/>
          </svg>
        </button>

        {/* 关系图谱（IconPark: branch-two） */}
        <button
          className={`activity-item ${active === 'graph' ? 'active' : ''}`}
          onClick={onOpenGraph}
          title="关系图谱"
        >
          <svg width="20" height="20" viewBox="0 0 48 48" fill="none">
            <circle cx="36" cy="8" r="4" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="14" cy="8" r="4" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="14" cy="40" r="4" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M14 12L14 36L14 33C14 25 36 24 36 16V12" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>

        {/* 视频（IconPark: video-conference，占位） */}
        <button
          className={`activity-item ${active === 'video' ? 'active' : ''}`}
          onClick={onOpenVideo}
          title="视频（即将上线）"
        >
          <svg width="20" height="20" viewBox="0 0 48 48" fill="none">
            <path d="M4 10C4 8.89543 4.89543 8 6 8H34C35.1046 8 36 8.89543 36 10V19L44 13V36L36 30V38C36 39.1046 35.1046 40 34 40H6C4.89543 40 4 39.1046 4 38V10Z" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M10 16V20" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M15 14V22" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M20 16V20" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>
    </div>
  )
}
