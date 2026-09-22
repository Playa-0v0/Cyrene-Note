/**
 * foldOnHeading —— 标题行首的折叠开关（Obsidian 式）。
 *
 * 在每个 ATX 标题行的行首放一个尖角箭头 widget：
 * - 展开时尖角向下（▾ 形状的 SVG），点击 → 折叠该标题下的内容
 * - 折叠后尖角向右（>），点击 → 展开
 * - 不用 gutter（已去掉行号栏），箭头用负 margin 悬浮在内容左缘留白区
 *
 * 关键：foldState 由 codeFolding() 注册——缺了它 foldEffect 派发后无人处理，
 * 点击就没反应（这是第一版的 bug）。
 * 折叠范围只包内容（标题行之后 → 下一个同级/更高级标题之前），标题行本身始终可见。
 */
import { RangeSetBuilder } from '@codemirror/state'
import {
  EditorView,
  Decoration,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
} from '@codemirror/view'
import { syntaxTree, foldState, foldEffect, unfoldEffect, codeFolding } from '@codemirror/language'
import type { Extension } from '@codemirror/state'

/** 折叠尖角箭头：SVG 细 > 形，展开时旋转 90° 向下 */
class FoldArrowWidget extends WidgetType {
  readonly pos: number
  readonly folded: boolean
  constructor(pos: number, folded: boolean) {
    super()
    this.pos = pos
    this.folded = folded
  }
  eq(other: FoldArrowWidget) {
    return other.pos === this.pos && other.folded === this.folded
  }
  toDOM(view: EditorView) {
    const span = document.createElement('span')
    span.className = `lp-fold-arrow ${this.folded ? 'lp-folded' : ''}`
    span.title = this.folded ? '展开' : '折叠'
    // SVG 细尖角（chevron），方向由 CSS 旋转控制
    span.innerHTML =
      '<svg viewBox="0 0 10 10" width="10" height="10">' +
      '<path d="M2 1 L7 5 L2 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>'
    // mousedown 而非 click：避免点击后光标跳进标题行
    span.onmousedown = (e) => {
      e.preventDefault()
      const line = view.state.doc.lineAt(this.pos)
      const range = foldableRange(view, line.from)
      if (!range) return
      // 展开必须用 unfoldEffect：foldEffect 不认 fold:false，
      // 已折叠范围再派发 foldEffect 会被 foldExists 拦下变成 no-op
      const effect = isFolded(view, range) ? unfoldEffect.of(range) : foldEffect.of(range)
      view.dispatch({ effects: effect })
    }
    return span
  }
}

/** 某个折叠范围当前是否已折叠（FoldState.between 是回调式 API，返回 void） */
function isFolded(view: EditorView, range: { from: number; to: number }): boolean {
  const foldInfo = view.state.field(foldState, false)
  if (!foldInfo) return false
  let folded = false
  foldInfo.between(
    range.from,
    Math.min(range.to, view.state.doc.length),
    (from) => {
      if (from === range.from) folded = true
    },
  )
  return folded
}

/**
 * 计算标题的折叠范围：只包内容——
 * 从标题行末尾的换行后（line.to + 1）到下一个同级/更高级标题行首之前（next.from - 1）。
 * 标题行本身不在范围内（始终可见）。
 * 范围内没有实际文字（只有空行/换行，含文档尾部空行的情况）→ 返回 null，不显示箭头。
 */
function foldableRange(
  view: EditorView,
  lineFrom: number,
): { from: number; to: number } | null {
  const line = view.state.doc.lineAt(lineFrom)
  const m = /^(#+)\s/.exec(line.text)
  if (!m) return null
  const level = m[1].length
  const next = view.state.doc.lines
  for (let i = line.number + 1; i <= next; i++) {
    const l = view.state.doc.line(i)
    const h = /^(#+)\s/.exec(l.text)
    if (h && h[1].length <= level) {
      return hasContent(view, line.to + 1, l.from - 1)
        ? { from: line.to + 1, to: l.from - 1 }
        : null
    }
  }
  // 没有下一个标题 → 折到文档尾
  return hasContent(view, line.to + 1, view.state.doc.length)
    ? { from: line.to + 1, to: view.state.doc.length }
    : null
}

/** 范围内是否有实际文字（纯空白/空范围都算没有） */
function hasContent(view: EditorView, from: number, to: number): boolean {
  if (to <= from) return false
  return view.state.doc.sliceString(from, to).trim().length > 0
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        if (!/^ATXHeading\d$/.test(node.name)) return
        const line = view.state.doc.lineAt(node.from)
        const range = foldableRange(view, line.from)
        // 没有可折叠内容的标题不显示箭头
        if (!range) return
        builder.add(
          line.from,
          line.from,
          Decoration.widget({
            widget: new FoldArrowWidget(line.from, isFolded(view, range)),
            side: -10, // 排在行首所有内容之前
          }),
        )
      },
    })
  }
  return builder.finish()
}

export const foldOnHeading: Extension = [
  // 注册 foldState（foldEffect 的处理器）——缺了它点击箭头无任何效果
  codeFolding({ placeholderText: '…' }),
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view)
      }
      update(update: import('@codemirror/view').ViewUpdate) {
        // 文档变化、折叠/展开、视口变化都重建（箭头方向要翻转）
        if (
          update.docChanged ||
          update.transactions.some((tr) =>
            tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)),
          ) ||
          update.viewportChanged
        ) {
          this.decorations = buildDecorations(update.view)
        }
      }
    },
    { decorations: (v) => v.decorations },
  ),
]
