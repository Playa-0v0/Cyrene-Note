/**
 * Editor —— CodeMirror 6 装配。
 *
 * 内容流的三权分立模型：
 * - 打开文档：openDoc() 返回内容 → dispatch 全文档 change（带 MutationOrigin 注解）
 * - 编辑：CM6 内部持有缓冲区，update listener 只对用户输入 origin markDirty/scheduleSave
 * - 保存：scheduleSave 捕获 immutable SaveSnapshot，timer 触发时用 snap 而非现读
 * - 外部修改（watcher）：onExternalChange 裁决 →
 *     干净：dispatch 全文档 change 热重载（带 external-reload origin，光标/滚动保留）
 *     脏：置冲突态，横幅三选一
 *
 * autosave：停止输入 800ms 或失焦时触发。
 *
 * 会话安全约束：
 * - 切文档时旧的 in-flight save 自动失效（用 sessionId + generation 标识）
 * - 程序化 CM dispatch（打开 / 热重载 / 冲突重读）不会触发 autosave 也不会标 dirty
 */
import { useEffect, useRef } from 'react'
import {
  Annotation,
  EditorState,
  StateEffect,
  Compartment as CmCompartment,
} from '@codemirror/state'
import { EditorView, keymap, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { syntaxHighlighting, defaultHighlightStyle, HighlightStyle, bracketMatching, foldKeymap } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { languages } from '@codemirror/language-data'

import { events, commands } from '../lib/bindings'
import { useDocStore, describeError } from '../stores/docStore'
import { MutationOrigin, type SaveSnapshot } from '../docSession'
import { livePreview, livePreviewBlocks } from './livePreview'
import { Highlight } from './highlight'
import { foldOnHeading } from './foldOnHeading'
import { selectionMenu } from './selectionMenu'
import { wikilinkDecorations, wikilinkClick } from './wikilink'
import { editorViewRef } from './editorViewRef'
import { BacklinksPanel } from '../features/backlinks/BacklinksPanel'
import './livePreview.css'

const AUTOSAVE_DELAY_MS = 800

/** 程序化 CM6 事务的标记。配合 update listener 区分用户输入 vs 程序替换 */
const programmaticTxn = Annotation.define<true>()

export function Editor() {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const pendingSnapRef = useRef<SaveSnapshot | null>(null)

  const path = useDocStore((s) => s.path)
  const status = useDocStore((s) => s.status)

  // ── path 变化 → 打开文档（唯一驱动源）────────
  // 效果只依赖 path：openDoc 内部会换 sessionId，若也依赖它会造成
  // "openDoc 改 sessionId → 效果重跑 → 再 openDoc" 的无限循环，
  // 所有读取结果都被判过期丢弃，编辑器永远是空的。
  useEffect(() => {
    if (!viewRef.current || !path) return
    const myPath = path
    let cancelled = false
    ;(async () => {
      const content = await useDocStore.getState().openDoc(myPath)
      const view = viewRef.current
      // 异步期间路径又变了 → 丢弃
      if (!view || cancelled || content === null) return
      if (useDocStore.getState().path !== myPath) return
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
        annotations: programmaticTxn.of(true),
        // 程序替换不进入 undo 历史，避免热重载被用户 Ctrl+Z 撤销成旧磁盘版本
      })
    })()
    return () => {
      cancelled = true
      // 切走文档：作废挂起的自动保存（脏内容已由 tabsStore 切换前冲盘处理）
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      pendingSnapRef.current = null
    }
  }, [path])

  // ── watcher 外部修改：热重载 / 冲突裁决 ─────────
  useEffect(() => {
    const unlisten = events.fileChanged.listen((e) => {
      const { path: p, content_hash: hash, disk_kind: diskKind, content } = e.payload
      const view = viewRef.current
      if (!view) return
      const decision = useDocStore.getState().onExternalChange(p, hash, diskKind, content)
      if (decision.kind === 'reload') {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: decision.content },
          annotations: programmaticTxn.of(true),
        })
      }
      // unreadable / deleted / conflict / ignore：缓冲区不动（或由冲突横幅接管）
    })
    return () => {
      unlisten.then((f) => f())
    }
  }, [])

  // ── 编辑器实例化（只一次）────────
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const scheduleSave = () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
      // 捕获快照：timer 触发时不再读 store，避免任何中间切换污染
      const view = viewRef.current
      const state = useDocStore.getState()
      if (!view || !state.path || !state.baseHash || state.sessionId === null) return
      const snap: SaveSnapshot = {
        sessionId: state.sessionId,
        generation: -1, // 真正的 generation 由 saveDoc 内部分配
        path: state.path,
        baseHash: state.baseHash,
        content: view.state.doc.toString(),
        revision: state.revision,
      }
      pendingSnapRef.current = snap
      saveTimerRef.current = window.setTimeout(() => {
        const s = pendingSnapRef.current
        if (!s) return
        pendingSnapRef.current = null
        // 快照属于旧文档（切换标签期间残留）→ 丢弃，防止旧内容写进新文档
        if (s.path !== useDocStore.getState().path) return
        useDocStore.getState().saveDoc(s.content)
      }, AUTOSAVE_DELAY_MS)
    }

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: '',
        extensions: [
          // 不显示行号栏（Obsidian 默认无行号）
          highlightSpecialChars(),
          // 软换行：超长行在可视宽度处折行，不横向滚动
          EditorView.lineWrapping,
          history(),
          // 折叠开关不放在行号栏（gutter），而是嵌在标题行首（见 foldOnHeading）
          foldOnHeading,
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          rectangularSelection(),
          crosshairCursor(),
          // 不启用 highlightActiveLine：光标所在行不做整行高亮（Obsidian 同款行为）
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          // 去掉默认高亮给标题（# 一~六级）加的下划线
          syntaxHighlighting(headingNoUnderline),
          bracketMatching(),
          // GFM 扩展：表格、任务列表、删除线等（base 只有 commonmark，不带表格解析）
          // Highlight 扩展：==高亮==（Obsidian 风格，非 GFM 标准，自实现）
          markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [GFM, Highlight] }),
          livePreview,
          livePreviewBlocks,
          // 选中文字后右键弹出格式菜单（Obsidian 式）
          selectionMenu,
          wikilinkDecorations,
          wikilinkClick,
          keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
          // 缓冲区变化 → 协调态
          // 只有"用户输入"origin 的更新才触发 dirty 标记和 autosave。
          // 程序化替换（打开 / 热重载 / 冲突重读）都带 programmaticTxn 注解，
          // 不会计入 dirty、不会进入 autosave、也不会进 undo 历史（见各 dispatch 调用）。
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            const programmatic = update.transactions.some((tr) =>
              tr.annotation(programmaticTxn),
            )
            if (programmatic) return
            // 真实用户输入
            useDocStore.getState().markDirty()
            scheduleSave()
            if (update.focusChanged && !update.view.hasFocus) {
              const st = useDocStore.getState()
              if (st.status === 'dirty') st.saveDoc(update.view.state.doc.toString())
            }
          }),
        ],
      }),
    })
    viewRef.current = view
    // 注册给 tabsStore：切标签前冲盘保存需要读到当前缓冲
    editorViewRef.current = view
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
      pendingSnapRef.current = null
      view.destroy()
      viewRef.current = null
      editorViewRef.current = null
    }
  }, [])

  return (
    <div className={`editor-host status-${status}`}>
      <div ref={hostRef} className="cm-host" />
      {status === 'conflict' && <ConflictBanner />}
      <BacklinksPanel />
    </div>
  )
}

/** 冲突横幅。LOCAL 丢弃前先落 history（conflict-discard，Rust 侧执行），
 * 三选一里 v1 提供两个按钮：以磁盘为准 / 保留我的（覆盖保存，走带 hash 的 save）。
 */
function ConflictBanner() {
  const conflict = useDocStore((s) => s.conflict)
  return (
    <div className="conflict-banner">
      <span>
        ⚠ 磁盘版本已变化（Cyrene 可能修改了这篇笔记）
        {conflict && <code> base={conflict.expected.slice(0, 8)}… remote={conflict.actual.slice(0, 8)}…</code>}
      </span>
      <button
        onClick={async () => {
          const view = viewRefOfBanner()
          if (!view) return
          const content = await useDocStore
            .getState()
            .discardLocalAndReload(view.state.doc.toString())
          if (content !== null && viewRefOfBanner()) {
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: content },
              annotations: programmaticTxn.of(true),
            })
          }
        }}
      >
        使用磁盘版本（本地修改已存入历史，可恢复）
      </button>
      <button
        onClick={async () => {
          const view = viewRefOfBanner()
          if (!view) return
          const st = useDocStore.getState()
          if (!st.path || !st.conflict) return
          const expected = st.conflict.actual
          useDocStore.setState({ status: 'saving' })
          const result = await commands.notesSave({
            path: st.path,
            content: view.state.doc.toString(),
            expected_hash: expected,
          })
          if (result.status === 'ok') {
            useDocStore.setState({
              baseHash: result.data.new_content_hash,
              status: 'clean',
              conflict: null,
            })
          } else {
            useDocStore.setState({
              status: 'conflict',
              lastError: describeError(result.error),
            })
          }
        }}
      >
        保留我的版本（覆盖磁盘）
      </button>
    </div>
  )
}

// 覆盖默认语法高亮给标题加的下划线：
// defaultHighlightStyle 对 tags.heading 定义了 underline + bold，
// 且注入的样式表会盖掉 .lp-h* 的同名属性，所以这里必须和
// livePreview.css 的标题字重保持同值（Obsidian 规范：标题 700）
const headingNoUnderline = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '700', textDecoration: 'none' },
])

// 从 DOM 反查 view（Banner 是 Editor 子组件；.cm-editor 元素 → findFromDOM）
function viewRefOfBanner(): EditorView | null {
  const host = document.querySelector('.cm-host .cm-editor') as HTMLElement | null
  return host ? EditorView.findFromDOM(host) : null
}

// 静音未使用导入（保留给后续 use）
void CmCompartment
void StateEffect
void MutationOrigin