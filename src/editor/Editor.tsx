/**
 * Editor —— CodeMirror 6 装配。
 *
 * 内容流（architecture.md §4 三权分立）：
 * - 打开文档：openDoc() 返回内容 → dispatch 全文档 change
 * - 编辑：CM6 内部持有缓冲区，update listener 只上报 markDirty()
 * - 保存：saveDoc(view.state.doc.toString())，内容以值传递过 IPC
 * - 外部修改（watcher）：onExternalChange 裁决 →
 *     干净：dispatch 全文档 change 热重载（CM6 自动映射光标/滚动）
 *     脏：置冲突态，横幅三选一
 *
 * autosave：停止输入 800ms 或失焦时触发。
 */
import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter, foldKeymap } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'

import { events, commands } from '../lib/bindings'
import { useDocStore, describeError } from '../stores/docStore'

const AUTOSAVE_DELAY_MS = 800

export function Editor() {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const saveTimerRef = useRef<number | null>(null)

  const path = useDocStore((s) => s.path)
  const status = useDocStore((s) => s.status)

  // path 变化 → 拉取内容并整体替换缓冲区
  useEffect(() => {
    if (!viewRef.current || !path) return
    let cancelled = false
    ;(async () => {
      const content = await useDocStore.getState().openDoc(path)
      const view = viewRef.current
      if (!view || cancelled || content === null) return
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } })
    })()
    return () => {
      cancelled = true
    }
  }, [path])

  // watcher 外部修改：热重载 / 冲突裁决（一次订阅，组件生命周期内有效）
  useEffect(() => {
    const unlisten = events.fileChanged.listen((e) => {
      const { path: p, content_hash: hash, content } = e.payload
      const view = viewRef.current
      if (!view) return
      const decision = useDocStore.getState().onExternalChange(p, hash, content)
      if (decision.kind === 'reload') {
        // 全文档 change：CM6 自动把 selection/滚动映射到新内容
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: decision.content },
        })
      }
      // conflict / deleted / ignore：UI 态已由 store 置好，横幅/提示渲染
    })
    return () => {
      unlisten.then((f) => f())
    }
  }, [])

  // 编辑器只建一次
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const scheduleSave = () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = window.setTimeout(() => {
        const view = viewRef.current
        if (!view) return
        useDocStore.getState().saveDoc(view.state.doc.toString())
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
          keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
          // 缓冲区变化 → 协调态 markDirty（内容本身留在 CM6）
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              useDocStore.getState().markDirty()
              scheduleSave()
            }
            if (update.focusChanged && !update.view.hasFocus) {
              // 失焦立即保存（若有待保存内容）
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
      view.destroy()
      viewRef.current = null
    }
  }, [])

  return (
    <div className={`editor-host status-${status}`}>
      <div ref={hostRef} className="cm-host" />
      {status === 'conflict' && <ConflictBanner />}
    </div>
  )
}

/**
 * 冲突横幅。LOCAL 丢弃前先落 history（conflict-discard，Rust 侧执行），
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
          // 1) LOCAL 抢救入 history；2) 以磁盘为准重载
          const content = await useDocStore
            .getState()
            .discardLocalAndReload(view.state.doc.toString())
          if (content !== null && viewRefOfBanner()) {
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: content },
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
          // 保留我的：以 REMOTE hash 为 expected 覆盖保存（显式选择，非静默）
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
