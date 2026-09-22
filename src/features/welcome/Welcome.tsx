/**
 * Welcome —— 主区域启动画面（未打开 Vault 时）。
 * 有历史：最近仓库卡片网格（封面图或首篇笔记标题 + 粉色名条）+ 打开/新建卡片；
 * 无历史（首次启动）：欢迎引导，"开始使用"自动在文档目录创建欢迎库并写入教学笔记。
 */
import { useState } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { documentDir, join } from '@tauri-apps/api/path'
import { convertFileSrc } from '@tauri-apps/api/core'
import { useVaultStore, vaultName, formatLastOpened, type VaultRecord } from '../../stores/vaultStore'
import { useTabsStore } from '../../stores/tabsStore'
import { useDocStore, describeError } from '../../stores/docStore'
import { commands } from '../../lib/bindings'
import './Welcome.css'

/** 首启自动创建的欢迎库目录名（位于系统文档目录下） */
const WELCOME_VAULT_DIR = 'Cyrene-Welcome'
/** 欢迎笔记在库内的相对路径 */
const WELCOME_NOTE_PATH = 'welcome.md'

/** 欢迎笔记内容：教学当前版本已有的用法（用户可随意编辑/删除） */
const WELCOME_MD = `# 欢迎使用 Cyrene Note

这是一个**本地优先**的 Markdown 笔记库——所有笔记都是磁盘上的普通 \`.md\` 文件，随时可以用其他工具打开，数据永远属于你。

## 先试试基本排版

- **加粗**、*斜体*、~~删除线~~
- ==高亮== 是这个软件的招牌语法
- 选中一段文字后**右键**，可以快速设置文字颜色

## 列表与任务

- 咖啡豆
- 滤纸
- [ ] 读完《卡片笔记写作法》
- [x] 安装 Cyrene Note

> 把你喜欢的句子引用在这里。

## 双向链接

输入 \`[[\` 可以链接到库里的任意笔记。比如先在左侧新建一篇 \`读书笔记\`，然后就能写 [[读书笔记]]。
被链接的笔记底部会显示"反向链接"——知识就是这样串成网的。

## 你需要知道的事

- 左侧文件树：浏览/新建笔记和文件夹，顶栏可切换排序
- 标签页：像浏览器一样同时打开多篇笔记
- 底部状态栏：已保存 / 未保存 / 冲突
- 左下角：切换或管理多个仓库（Vault）
- 所有历史版本自动保存在 \`.cyrene/history\`，误删也能找回

---

这篇笔记可以随意编辑、删除。祝你写得开心。
`

/**
 * 单张仓库卡片：有封面图（根目录 welcome.*，png 优先）铺满显示；
 * 没有则显示首篇笔记的标题；图挂载失败自动回退标题。
 */
function VaultCard({ v, loading, onOpen }: { v: VaultRecord; loading: boolean; onOpen: (root: string) => void }) {
  const [imgFailed, setImgFailed] = useState(false)
  // 预览只取第一行当标题（用户约定：展示个标题就行）
  const title = v.preview ? v.preview.split('\n')[0] : ''
  const showImg = Boolean(v.cover) && !imgFailed
  return (
    <button className="vault-card" onClick={() => onOpen(v.root)} disabled={loading} title={v.root}>
      <div className="vc-preview">
        {showImg ? (
          <img className="vc-cover" src={convertFileSrc(v.cover!)} alt={vaultName(v.root)} onError={() => setImgFailed(true)} />
        ) : title ? (
          <p className="vc-title">{title}</p>
        ) : (
          <span className="vc-empty">
            <svg width="22" height="22" viewBox="0 0 16 16" fill="none">
              <path
                d="M2 4a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V4z"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
            </svg>
            空仓库
          </span>
        )}
      </div>
      {/* 下：粉色名条（仓库名 + 上次打开时间） */}
      <div className="vc-label">
        <span className="vc-name">{vaultName(v.root)}</span>
        <span className="vc-time">{formatLastOpened(v.lastOpenedAt)}</span>
      </div>
    </button>
  )
}

export function Welcome() {
  const vaults = useVaultStore((s) => s.vaults)
  const loading = useVaultStore((s) => s.loading)
  const openVault = useVaultStore((s) => s.openVault)

  /** 选择任意已有文件夹作为仓库 */
  const openOther = async () => {
    const dir = await openDialog({ directory: true, multiple: false, title: '选择 Vault 文件夹' })
    if (typeof dir === 'string') await openVault(dir)
  }

  /**
   * 首启"开始使用"：在系统文档目录创建欢迎库（已存在则复用），
   * 写入教学笔记（已存在则直接打开），并打开它。
   */
  const startWelcome = async () => {
    const base = await documentDir()
    const dir = await join(base, WELCOME_VAULT_DIR)
    await openVault(dir, true)
    // 创建/打开失败：错误已 toast，停留在欢迎界面
    if (!useVaultStore.getState().open) return
    // 默认封面：内嵌图写入库根目录（用户已有同名文件则不覆盖）
    const cover = await commands.welcomeCoverWrite(dir)
    if (cover.status === 'error') {
      useDocStore.setState({ lastError: `写入默认封面失败：${describeError(cover.error)}` })
    }
    const result = await commands.notesCreate({ path: WELCOME_NOTE_PATH, content: WELCOME_MD })
    if (result.status === 'ok' || result.error.type === 'AlreadyExists') {
      useTabsStore.getState().openTab(WELCOME_NOTE_PATH)
      // openVault 里的快照抓取发生在建库时（仓库还是空的），补抓一次让欢迎库卡片有预览
      const store = useVaultStore.getState()
      await store.refreshTree()
      await store.capturePreview()
    } else {
      useDocStore.setState({ lastError: `创建欢迎笔记失败：${describeError(result.error)}` })
    }
  }

  return (
    <div className="welcome">
      {/* 有历史时展示卡片网格，容器放宽 */}
      <div className={`welcome-card${vaults.length > 0 ? ' wide' : ''}`}>
        {vaults.length === 0 ? (
          <>
            {/* 品牌标记（仅首启引导保留） */}
            <div className="welcome-mark">
              <svg width="34" height="34" viewBox="0 0 16 16" fill="none">
                <path
                  d="M3 12.5C1.5 11 1 8.5 2.5 6.5C4 4.5 7 4 9 5.5C11 7 11.5 10 10 12C8.5 14 5 14.5 3 12.5Z"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
                <path d="M9 5.5C10 3.5 12.5 2.5 14 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                <path d="M6 8c.8-1 2-1.2 2.8-.4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
              </svg>
            </div>
            <h1 className="welcome-title">欢迎使用 Cyrene Note</h1>
            <p className="welcome-desc">一个本地优先的 Markdown 笔记本，先从一个带教学笔记的示例库开始</p>
            <div className="welcome-actions">
              <button className="btn btn-primary" onClick={() => void startWelcome()} disabled={loading}>
                开始使用
              </button>
              <button className="btn" onClick={() => void openOther()} disabled={loading}>
                选择已有文件夹
              </button>
            </div>
            <p className="welcome-hint">「开始使用」将在你的文档目录创建 {WELCOME_VAULT_DIR} 示例库</p>
          </>
        ) : (
          <>
            <h1 className="welcome-title">欢迎回来！</h1>
            <p className="welcome-desc">选择一个仓库继续~</p>
            <div className="welcome-grid">
              {vaults.map((v) => (
                <VaultCard key={v.root} v={v} loading={loading} onOpen={(root) => void openVault(root)} />
              ))}
              {/* 打开/新建其他仓库：虚线空卡片 */}
              <button
                className="vault-card vc-add"
                onClick={() => void openOther()}
                disabled={loading}
                title="打开或新建仓库"
              >
                <svg width="22" height="22" viewBox="0 0 16 16" fill="none">
                  <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
                <span className="vc-add-text">打开或新建</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
