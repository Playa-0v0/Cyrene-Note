/**
 * Editor —— CodeMirror 6 装配。
 *
 * 内容流（architecture.md §4 三权分立）：
 * - 打开文档：openDoc() 返回内容 → dispatch 全文档 change（带 MutationOrigin 注解）
 * - 编辑：CM6 内部持有缓冲区，update listener 只对用户输入 origin markDirty/scheduleSave
 * - 保存：scheduleSave 捕获 immutable SaveSnapshot，timer 触发时用 snap 而非现读
 * - 外部修改（watcher）：onExternalChange 裁决 →
 *     干净：dispatch 全文档 change 热重载（带 external-reload origin，光标/滚动保留）
 *     脏：置冲突态，横幅三选一
 *
 * autosave：停止输入 800ms 或失焦时触发。
 *
 * PR 1 安全：
 * - 切文档时旧的 in-flight save 自动失效（sessionId + generation）
 * - 程序化 CM dispatch（open / 热重载 / 冲突重读）不触发 autosave / dirty
 */
import { useEffect, useRef } from 'react'
import {
  Annotation,
  EditorState,
  StateEffect,
  Compartment as CmCompartment,
} from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter, foldKeymap } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'

import { events, commands } from '../lib/bindings'
import { useDocStore, describeError } from '../stores/docStore'
import { MutationOrigin, type SaveSnapshot } from '../docSession'
import { livePreview } from './livePreview'
import { wikilinkDecorations, wikilinkClick } from './wikilink'
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
  const sessionId = useDocStore((s) => s.sessionId)
  const status = useDocStore((s) => s.status)

  // ── path 变化 → 打开文档（每个 sessionId 触发一次）────────
  useEffect(() => {
    if (!viewRef.current || !path || sessionId === null) return
    const mySession = sessionId
    let cancelled = false
    ;(async () => {
      const content = await useDocStore.getState().openDoc(path)
      const view = viewRef.current
      // 异步期间会话变了 → 丢弃
      if (!view || cancelled || content === null) return
      if (useDocStore.getState().sessionId !== mySession) return
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
        annotations: programmaticTxn.of(true),
        // 程序替换不进入 undo 历史，避免热重载被用户 Ctrl+Z 撤销成旧磁盘版本
      })
    })()
    return () => {
      cancelled = true
    }
  }, [path, sessionId])

  // 兜底：FileTree click 同路径不触发 sessionId 变化时，sessionId 为空 → 直接走 openDoc。
  // （FileTree 现已统一用 setState({path}) 走 Editor；这里是边界兜底）
  useEffect(() => {
    if (!viewRef.current || !path || sessionId !== null) return
    void useDocStore.getState().openDoc(path)
  }, [path, sessionId])

  // ── watcher 外部修改：热重载 / 冲突裁决 ─────────
  useEffect(() => {
    const unlisten = events.fileChanged.listen((e) => {
      const { path: p, content_hash: hash, content } = e.payload
      const view = viewRef.current
      if (!view) return
      const decision = useDocStore.getState().onExternalChange(p, hash, content)
      if (decision.kind === 'reload') {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: decision.content },
          annotations: programmaticTxn.of(true),
        })
      }
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
        useDocStore.getState().saveDoc(s.content)
      }, AUTOSAVE_DELAY_MS)
    }

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: '',
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          bracketMatching(),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          livePreview,
          wikilinkDecorations,
          wikilinkClick,
          keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
          // 缓冲区变化 → 协调态
          // PR 1 (P0-2)：只有"用户输入"origin 才触发 dirty + autosave；
          // 程序替换（open / external-reload / conflict-resolution）带 programmaticTxn 注解，
          // 不计入 dirty、不入 autosave、不入 undo 历史（见各 dispatch 调用）
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
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
      pendingSnapRef.current = null
      view.destroy()
      viewRef.current = null
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

// 从 DOM 反查 view（Banner 是 Editor 子组件；.cm-editor 元素 → findFromDOM）
function viewRefOfBanner(): EditorView | null {
  const host = document.querySelector('.cm-host .cm-editor') as HTMLElement | null
  return host ? EditorView.findFromDOM(host) : null
}

// 静音未使用导入（保留给后续 use）
void CmCompartment
void StateEffect
void MutationOrigin