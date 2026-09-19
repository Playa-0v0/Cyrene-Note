/**
 * Live Preview —— CM6 decoration 方案的 Markdown 富文本观感。
 *
 * 原则（Obsidian Live Preview 同款路线）：
 * - Markdown 仍是 source of truth；只是"视觉上隐藏语法标记"
 * - 光标所在行保持源码可见（ Obsidian 行为）——该行不做替换
 * - 全部 decoration 从 Lezer 语法树生成，无正则扫描
 *
 * 覆盖（v1）：标题字号、粗体/斜体标记隐藏、行内代码标记隐藏、
 * 引用条、列表符号渲染、水平线、链接文本化。
 * 不覆盖：表格、任务框、嵌入、wikilink（等语法扩展阶段统一做）。
 */
import { RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
  type DecorationSet,
} from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'

// ── widgets ──────────────────────────────────────────────

/** 列表符号：- / * / + / 1. → 标准圆点（有序保留数字） */
class BulletWidget extends WidgetType {
  marker: string
  constructor(marker: string) {
    super()
    this.marker = marker
  }
  eq(other: BulletWidget) {
    return other.marker === this.marker
  }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'lp-bullet'
    // 有序列表保留编号
    span.textContent = /^\d+\.$/.test(this.marker) ? `${this.marker} ` : '•'
    return span
  }
}

/** 水平线 --- / *** */
class HrWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    const div = document.createElement('div')
    div.className = 'lp-hr'
    return div
  }
}

/** 链接 [text](url) → 只显示 text */
class LinkTextWidget extends WidgetType {
  text: string
  url: string
  constructor(text: string, url: string) {
    super()
    this.text = text
    this.url = url
  }
  eq(other: LinkTextWidget) {
    return other.text === this.text && other.url === this.url
  }
  toDOM() {
    const a = document.createElement('a')
    a.className = 'lp-link'
    a.textContent = this.text
    a.title = this.url
    a.href = '#'
    a.onclick = (e) => e.preventDefault() // v1 不跳转
    return a
  }
}

// ── 行内样式 ─────────────────────────────────────────────

const hideMark = Decoration.mark({ class: 'lp-hide' }) // 语法标记隐藏（光标行豁免）
const strongBody = Decoration.mark({ class: 'lp-strong' })
const emBody = Decoration.mark({ class: 'lp-em' })
const codeBody = Decoration.mark({ class: 'lp-code' })

const headingLevel = (name: string): number | null => {
  const m = /^ATXHeading(\d)$/.exec(name)
  return m ? Number(m[1]) : null
}

// ── 插件 ─────────────────────────────────────────────────

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        const name = node.name
        const line = view.state.doc.lineAt(node.from)

        // 光标所在行：保持源码可见，只跳过（但块级 widget 行除外——
        // 标题行也保持源码，符合 Obsidian：光标进入时看到 #）
        if (line.number === cursorLine && headingLevel(name) !== null) return
        if (line.number === cursorLine && name !== 'HorizontalRule') {
          // 行内元素不处理（保持源码），继续深入子节点由后续迭代自然处理
        }

        // ── 块级 ──
        const h = headingLevel(name)
        if (h !== null) {
          if (line.number !== cursorLine) {
            builder.add(node.from, node.to, Decoration.mark({ class: `lp-h${h}` }))
            // 隐藏 "# " 前缀（ATXHeading1 下的 HeaderMark）
          }
          return
        }
        if (name === 'HorizontalRule' && line.number !== cursorLine) {
          builder.add(node.from, node.to, Decoration.replace({ widget: new HrWidget() }))
          return
        }
        if (name === 'Blockquote' && line.number !== cursorLine) {
          builder.add(node.from, node.to, Decoration.mark({ class: 'lp-quote' }))
          return
        }

        // ── 行内（光标行跳过）──
        if (line.number === cursorLine) return

        // HeaderMark（# 前缀、列表符号等）
        if (name === 'HeaderMark') {
          builder.add(node.from, node.to, hideMark)
          return
        }
        // 列表符号 ListMark（- * 1. >）
        if (name === 'ListMark') {
          const marker = view.state.sliceDoc(node.from, node.to)
          builder.add(
            node.from,
            node.to,
            Decoration.replace({ widget: new BulletWidget(marker) }),
          )
          return
        }
        // 粗体：StrongMark 隐藏，Strong 内文本加粗
        if (name === 'StrongEmphasis' || name === 'Emphasis') {
          const cls = name === 'StrongEmphasis' ? strongBody : emBody
          builder.add(node.from, node.to, cls)
          return
        }
        if (name.endsWith('Mark') && (name.startsWith('Strong') || name.startsWith('Emphasis') || name.startsWith('InlineCode'))) {
          builder.add(node.from, node.to, hideMark)
          return
        }
        if (name === 'InlineCode') {
          builder.add(node.from, node.to, codeBody)
          return
        }
        // 链接：整个 Link 节点替换为文本 widget（md 链接的子节点结构复杂，
        // 直接取第一个文本子节点显示）
        if (name === 'Link') {
          // [text](url) —— 取 [ ] 之间的文本
          const raw = view.state.sliceDoc(node.from, node.to)
          const m = /^\[(.*)\]\((.*)\)$/.exec(raw)
          if (m) {
            builder.add(
              node.from,
              node.to,
              Decoration.replace({ widget: new LinkTextWidget(m[1], m[2]) }),
            )
          }
          return
        }
      },
    })
  }
  return builder.finish()
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (v) => v.decorations },
)
