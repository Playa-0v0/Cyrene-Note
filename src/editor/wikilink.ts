/**
 * wikilink 的 CodeMirror 6 扩展：
 * - Decoration：把 `[[`、`]]`、`|` 隐藏；target 替换为可点击的链接标记
 * - Click handler：走 docStore.resolveAndOpenWikilink（path 完全匹配 → 打开；
 *   唯一 basename 匹配 → 打开；多匹配/无匹配 → toast 提示）
 *
 * 语法树解析（Lezer inline parser）作为下一个里程碑：当前以 Rust 解析为准，
 * 前端先用 CM6 markdown 内置的解析 + 正则 fallback 找到 wikilink 范围做装饰。
 * 后续 Lezer 扩展再换成语法树驱动。
 */
import {
  Decoration,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type EditorView,
} from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'
import { useDocStore } from '../stores/docStore'
import { useTabsStore } from '../stores/tabsStore'

/** wikilink 语法：`[[...]]`，5 种内部形态（详见本文件上方的枚举）。 */
const WIKILINK_RE = /\[\[([^\n[\]]+?)\]\]/g

class WikilinkWidget extends WidgetType {
  target: string
  constructor(target: string) {
    super()
    this.target = target
  }
  eq(other: WikilinkWidget) {
    return other.target === this.target
  }
  ignoreEvents() {
    return false
  }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'lp-wikilink'
    span.textContent = '→ '
    span.title = this.target
    span.style.cursor = 'pointer'
    span.dataset.target = this.target
    return span
  }
}

const hideMark = Decoration.mark({ class: 'lp-hide' })

interface Range {
  from: number
  to: number
  replacement?: { widget?: WikilinkWidget; onlyHide?: boolean }
}

function buildDecorations(view: EditorView): DecorationSet {
  const ranges: Range[] = []
  const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number

  for (const { from, to } of view.visibleRanges) {
    const slice = view.state.sliceDoc(from, to)
    const baseFrom = from
    let m: RegExpExecArray | null
    WIKILINK_RE.lastIndex = 0
    while ((m = WIKILINK_RE.exec(slice)) !== null) {
      const mFrom = baseFrom + m.index
      const mTo = mFrom + m[0].length
      const line = view.state.doc.lineAt(mFrom).number
      if (line === cursorLine) continue

      const inner = m[1]
      // target / heading / alias 拆分（镜像 Rust 端：首 `|` 切 alias，其后首 `#` 切 heading）
      let target = inner
      let alias: string | undefined
      const pipe = inner.indexOf('|')
      if (pipe >= 0) {
        target = inner.slice(0, pipe)
        const rest = inner.slice(pipe + 1)
        if (rest) alias = rest
      }
      const hash = target.indexOf('#')
      if (hash >= 0) {
        const rest = target.slice(hash + 1)
        void rest
        target = target.slice(0, hash)
      }

      // 隐藏 `[[` 和 `]]`
      ranges.push({ from: mFrom, to: mFrom + 2, replacement: { onlyHide: true } })
      ranges.push({ from: mTo - 2, to: mTo, replacement: { onlyHide: true } })

      // 定位 target 段在原文中的字节范围
      // target 在内部字符串中的起始位置：inner 去除 |alias 后的位置
      const targetStartInInner = inner.indexOf(target)
      const targetEndInInner = targetStartInInner + target.length
      const targetFrom = mFrom + 2 + targetStartInInner
      const targetTo = mFrom + 2 + targetEndInInner

      ranges.push({
        from: targetFrom,
        to: targetTo,
        replacement: { widget: new WikilinkWidget(target) },
      })

      // 隐藏 alias 段（`[[T|alias]]` → 显示 `→ T`，把 `|alias` 隐藏）
      if (alias !== undefined) {
        // alias 段从 `|` 开始，到 `]]` 前
        const aliasFrom = targetTo + 1 // the '|'
        const aliasContentFrom = aliasFrom + 1
        const aliasTo = mTo - 2
        if (aliasContentFrom < aliasTo) {
          // 隐藏 `|`
          ranges.push({ from: aliasFrom, to: aliasContentFrom, replacement: { onlyHide: true } })
          // alias 内容加装饰样式
          ranges.push({
            from: aliasContentFrom,
            to: aliasTo,
            replacement: { onlyHide: true }, // 暂不替换文字，纯粹隐藏；后续保留 alias 显示
          })
        } else {
          // `[[T|]]` 形式，隐藏 `|`
          ranges.push({ from: aliasFrom, to: mTo - 2, replacement: { onlyHide: true } })
        }
      }

      // 隐藏 heading 标记（如果有）— heading 在 target 内，不再单独处理
    }
  }

  // 用 RangeSetBuilder 按 from 排序合并；装饰之间重叠时后者覆盖前者
  ranges.sort((a, b) => a.from - b.from || b.to - a.to)
  const builder = new RangeSetBuilder<Decoration>()
  for (const r of ranges) {
    const deco = r.replacement?.widget
      ? Decoration.replace({ widget: r.replacement.widget })
      : hideMark
    builder.add(r.from, r.to, deco)
  }
  return builder.finish()
}

export const wikilinkDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(update: {
      docChanged: boolean
      selectionSet: boolean
      viewportChanged: boolean
      view: EditorView
    }) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (v) => v.decorations },
)

export const wikilinkClick = ViewPlugin.fromClass(
  class {
    view: EditorView
    constructor(view: EditorView) {
      this.view = view
    }
  },
  {
    eventHandlers: {
      click(event: MouseEvent, _view: EditorView) {
        const target = (event.target as HTMLElement | null)?.closest(
          '.lp-wikilink',
        ) as HTMLElement | null
        if (!target?.dataset.target) return
        event.preventDefault()
        const wikilinkTarget = target.dataset.target
        useDocStore
          .getState()
          .resolveAndOpenWikilink(wikilinkTarget)
          .then((r) => {
            if (r.found && r.path) {
              // 走标签页打开（已有标签则激活）
              useTabsStore.getState().openTab(r.path)
            } else if (r.ambiguous) {
              useDocStore.setState({
                lastError: `找到多个同名笔记，请用精确路径`,
              })
            } else {
              useDocStore.setState({
                lastError: `目标不存在: ${wikilinkTarget}`,
              })
            }
          })
      },
    },
  },
)