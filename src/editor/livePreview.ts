/**
 * Live Preview —— CM6 decoration 方案的 Markdown 富文本观感。
 *
 * 原则（Obsidian Live Preview 同款路线）：
 * - Markdown 仍是 source of truth；只是"视觉上隐藏语法标记"
 * - 光标所在行保持源码可见（Obsidian 行为）——该行不做替换
 * - 行内装饰从 Lezer 语法树生成，无正则扫描（公式例外：语法树不认 $，行内正则）
 *
 * 两层结构（CM6 硬性约束：跨行的 replace 装饰只能来自 StateField，插件会报错）：
 * - livePreview（ViewPlugin）：标题、粗斜体、删除线、高亮、行内代码、引用、列表、
 *   链接、代码块卡片（行装饰）、行内公式 $...$
 * - livePreviewBlocks（StateField）：表格、块级公式 $$...$$、内嵌 SVG（HTML 块）
 */
import {
  type Range,
  StateField,
  type Extension,
  type EditorState,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
  type DecorationSet,
} from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import katex from 'katex'
import 'katex/dist/katex.min.css'

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

/** 代码块围栏行（```lang）→ 语言小标签；空语言/闭合围栏 → 极薄占位（当卡片内边距） */
class FenceChipWidget extends WidgetType {
  readonly lang: string
  constructor(lang: string) {
    super()
    this.lang = lang
  }
  eq(other: FenceChipWidget) {
    return other.lang === this.lang
  }
  toDOM() {
    if (!this.lang) {
      const s = document.createElement('span')
      s.className = 'lp-code-fence-end'
      return s
    }
    const span = document.createElement('span')
    span.className = 'lp-code-lang-chip'
    span.textContent = this.lang
    return span
  }
}

/** 行内公式 $x^2$ → KaTeX 行内渲染 */
class MathInlineWidget extends WidgetType {
  readonly latex: string
  constructor(latex: string) {
    super()
    this.latex = latex
  }
  eq(other: MathInlineWidget) {
    return other.latex === this.latex
  }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'lp-math'
    span.innerHTML = katex.renderToString(this.latex, { throwOnError: false })
    return span
  }
}

/** 块级公式 $$...$$ → KaTeX 独立块渲染 */
class MathBlockWidget extends WidgetType {
  readonly latex: string
  constructor(latex: string) {
    super()
    this.latex = latex
  }
  eq(other: MathBlockWidget) {
    return other.latex === this.latex
  }
  toDOM() {
    const div = document.createElement('div')
    div.className = 'lp-math-block'
    div.innerHTML = katex.renderToString(this.latex, {
      throwOnError: false,
      displayMode: true,
    })
    return div
  }
}

/** 表格：源码整块替换为真 <table>（解析 header/delimiter/rows，支持对齐） */
class TableWidget extends WidgetType {
  readonly raw: string
  constructor(raw: string) {
    super()
    this.raw = raw
  }
  eq(other: TableWidget) {
    return other.raw === this.raw
  }
  toDOM(view: EditorView) {
    const parsed = parseTable(this.raw)
    const wrap = document.createElement('div')
    wrap.className = 'lp-table-wrap'
    // 单击进入源码编辑：显式把光标放进表格范围内
    // （不能依赖 CM6 默认行为——点击被替换 widget 会把光标映射到范围外侧，
    //  光标从不进入范围 → 永远切不回源码）
    wrap.onmousedown = (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      // widget 起点对应的文档位置 ≈ 表格 from；+1 保证落在范围内（第一行 | 之后）
      const head = view.posAtDOM(wrap, 0)
      const anchor = Math.min(head + 1, view.state.doc.length)
      view.dispatch({ selection: { anchor } })
      view.focus()
    }
    if (!parsed) return wrap // 解析失败兜底：空占位（理论上不会，语法树已确认是表格）
    const { header, rows, aligns } = parsed
    const table = document.createElement('table')
    table.className = 'lp-table'
    const thead = document.createElement('thead')
    const trh = document.createElement('tr')
    header.forEach((cell, i) => {
      const th = document.createElement('th')
      th.textContent = cell
      if (aligns[i] && aligns[i] !== 'left') th.style.textAlign = aligns[i]
      trh.appendChild(th)
    })
    thead.appendChild(trh)
    table.appendChild(thead)
    const tbody = document.createElement('tbody')
    for (const row of rows) {
      const tr = document.createElement('tr')
      header.forEach((_, i) => {
        const td = document.createElement('td')
        td.textContent = row[i] ?? ''
        if (aligns[i] && aligns[i] !== 'left') td.style.textAlign = aligns[i]
        tr.appendChild(td)
      })
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    wrap.appendChild(table)
    return wrap
  }
}

/** 解析 GFM 表格源码：首行表头、次行分隔线（含对齐冒号）、其余数据行 */
function parseTable(raw: string): {
  header: string[]
  rows: string[][]
  aligns: string[]
} | null {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length < 2) return null
  const cells = (l: string) =>
    l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
  const header = cells(lines[0])
  const delim = cells(lines[1])
  // 分隔线每格必须是 :--- / ---: / :---: 形态
  if (!delim.every((c) => /^:?-+:?$/.test(c) && c.includes('-'))) return null
  const aligns = delim.map((c) => {
    const left = c.startsWith(':')
    const right = c.endsWith(':')
    return left && right ? 'center' : right ? 'right' : 'left'
  })
  const rows = lines.slice(2).map(cells)
  return { header, rows, aligns }
}

/**
 * 内嵌 SVG：HTML 块里的 <svg>...</svg> 直接渲染。
 * 安全：DOM 解析后按白名单清洗——不在名单里的标签/属性全部剔除（防 script/事件注入）
 */
class SvgWidget extends WidgetType {
  readonly raw: string
  constructor(raw: string) {
    super()
    this.raw = raw
  }
  eq(other: SvgWidget) {
    return other.raw === this.raw
  }
  toDOM() {
    const wrap = document.createElement('div')
    wrap.className = 'lp-svg'
    const svg = sanitizeSvg(this.raw)
    if (svg) wrap.appendChild(svg)
    return wrap
  }
}

/** SVG 清洗白名单：形状/渐变/文本等绘图标签 + 几何/描边/填充属性 */
const SVG_TAGS = new Set([
  'svg', 'g', 'defs', 'title', 'desc', 'path', 'circle', 'ellipse', 'rect',
  'line', 'polyline', 'polygon', 'text', 'tspan', 'linearGradient',
  'radialGradient', 'stop', 'use',
])
const SVG_ATTRS = new Set([
  'xmlns', 'viewBox', 'preserveAspectRatio', 'width', 'height', 'x', 'y',
  'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
  'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
  'stroke-dashoffset', 'opacity', 'transform', 'text-anchor', 'font-size',
  'font-family', 'font-weight', 'dx', 'dy', 'dominant-baseline', 'offset',
  'stop-color', 'stop-opacity', 'gradientUnits', 'href',
])

/** 解析并清洗 SVG 源码：白名单外的标签和属性一律移除，返回干净的 svg 元素 */
function sanitizeSvg(raw: string): SVGSVGElement | null {
  const doc = new DOMParser().parseFromString(raw, 'image/svg+xml')
  const svg = doc.documentElement
  if (!svg || svg.nodeName.toLowerCase() !== 'svg') return null
  const clean = (el: Element) => {
    for (const child of Array.from(el.children)) {
      if (!SVG_TAGS.has(child.nodeName.toLowerCase())) {
        child.remove()
        continue
      }
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase()
        if (!SVG_ATTRS.has(name) || name.startsWith('on')) child.removeAttribute(attr.name)
      }
      clean(child)
    }
  }
  for (const attr of Array.from(svg.attributes)) {
    const name = attr.name.toLowerCase()
    if (!SVG_ATTRS.has(name) || name.startsWith('on')) svg.removeAttribute(attr.name)
  }
  clean(svg)
  return document.importNode(svg, true) as unknown as SVGSVGElement
}

// ── 行内样式 ─────────────────────────────────────────────

const hideMark = Decoration.mark({ class: 'lp-hide' }) // 语法标记隐藏（光标行豁免）
// 光标行上的语法标记：半透明而非隐藏（Obsidian 行为——行仍保持富文本观感）
const faintMark = Decoration.mark({ class: 'lp-faint' })
const strongBody = Decoration.mark({ class: 'lp-strong' })
const emBody = Decoration.mark({ class: 'lp-em' })
const strikeBody = Decoration.mark({ class: 'lp-strike' })
const highlightBody = Decoration.mark({ class: 'lp-highlight' })
const codeBody = Decoration.mark({ class: 'lp-code' })
const codeblockLine = Decoration.line({ class: 'lp-codeblock' })
const codeblockFirst = Decoration.line({ class: 'lp-codeblock lp-codeblock-first' })
const codeblockLast = Decoration.line({ class: 'lp-codeblock lp-codeblock-last' })
const quoteLine = Decoration.line({ class: 'lp-quote-line' })

const headingLevel = (name: string): number | null => {
  const m = /^ATXHeading(\d)$/.exec(name)
  return m ? Number(m[1]) : null
}

/** 行内 HTML span 允许的 CSS 属性白名单（其余全部剔除） */
const SPAN_STYLE_PROPS = new Set(['color', 'background-color', 'font-weight', 'font-style'])

/** 清洗 style 字符串：只保留白名单属性，值里不能有 url()/expression 等危险内容 */
function sanitizeSpanStyle(style: string): string {
  return style
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const idx = s.indexOf(':')
      if (idx < 0) return null
      const prop = s.slice(0, idx).trim().toLowerCase()
      const value = s.slice(idx + 1).trim()
      if (!SPAN_STYLE_PROPS.has(prop)) return null
      // 值只允许颜色/数字/关键词等安全字符，杜绝 url()、expression() 注入
      if (!/^[\w#(),.%\s-]+$/.test(value) || /url|expression/i.test(value)) return null
      return `${prop}: ${value}`
    })
    .filter(Boolean)
    .join('; ')
}

// ── 插件层（行内 + 单行替换）────────────────────────────

function buildDecorations(view: EditorView): DecorationSet {
  const decos: Range<Decoration>[] = []
  const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number
  // 代码类范围（代码块/行内代码）：行内公式扫描时跳过
  const codeRanges: { from: number; to: number }[] = []
  // 行内 HTML span 配对栈：<span style> 开标签入栈，</span> 出栈配对
  const openSpans: { from: number; style: string }[] = []

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        const name = node.name
        const line = view.state.doc.lineAt(node.from)
        const onCursorLine = line.number === cursorLine

        // ── 代码块卡片：每行挂行装饰（连续同底色拼成卡片），首尾行圆角 ──
        if (name === 'FencedCode') {
          codeRanges.push({ from: node.from, to: node.to })
          const startLine = view.state.doc.lineAt(node.from)
          const endLine = view.state.doc.lineAt(node.to)
          for (let i = startLine.number; i <= endLine.number; i++) {
            const l = view.state.doc.line(i)
            const first = i === startLine.number
            const last = i === endLine.number
            decos.push(
              (first && last ? codeblockLine
                : first ? codeblockFirst
                : last ? codeblockLast
                : codeblockLine).range(l.from),
            )
            // 围栏行（```lang / ```）：光标不在时整行替换为语言标签/薄占位
            const fence = /^\s*(```+|~~~+)\s*(\S*)\s*$/.exec(l.text)
            if (fence && i !== cursorLine) {
              decos.push(
                Decoration.replace({
                  widget: new FenceChipWidget(fence[2] ?? ''),
                }).range(l.from, l.to),
              )
            }
          }
          return
        }

        // ── 块级 ──
        const h = headingLevel(name)
        if (h !== null) {
          // 标题行无论光标是否在，都保持大字号渲染（Obsidian 行为）
          decos.push(Decoration.mark({ class: `lp-h${h}` }).range(node.from, node.to))
          return
        }
        if (name === 'HorizontalRule' && !onCursorLine) {
          decos.push(Decoration.replace({ widget: new HrWidget() }).range(node.from, node.to))
          return
        }
        if (name === 'Blockquote') {
          // 引用块逐行挂行装饰：背景/左边框/文字样式全在行类上（继承到内容）
          // 不用跨行 mark：跨行 mark 会被按行拆开且边界行为不可靠
          // （Blockquote.to 含尾随换行，会吞掉紧跟的下一行）
          // 光标行也保持渲染（Obsidian 行为：引用不打回源码）
          const startLine = view.state.doc.lineAt(node.from)
          // to 前移一位：若 to 恰在下一行行首（范围以换行结尾），不算那一行
          const endLine = view.state.doc.lineAt(Math.max(node.from, node.to - 1))
          for (let i = startLine.number; i <= endLine.number; i++) {
            decos.push(quoteLine.range(view.state.doc.line(i).from))
          }
          return
        }
        // 引用标记 >：非光标行隐藏，光标行半透明
        if (name === 'QuoteMark') {
          decos.push((onCursorLine ? faintMark : hideMark).range(node.from, node.to))
          return
        }

        // 行内 HTML：<span style="...">…</span> 渲染颜色等样式（白名单清洗）
        if (name === 'HTMLTag') {
          const raw = view.state.sliceDoc(node.from, node.to)
          const open = /^<span\s+style="([^"]*)"\s*>$/i.exec(raw)
          if (open) {
            openSpans.push({ from: node.to, style: sanitizeSpanStyle(open[1]) })
            decos.push((onCursorLine ? faintMark : hideMark).range(node.from, node.to))
            return
          }
          if (/^<\/span>$/i.test(raw)) {
            const matched = openSpans.pop()
            if (matched?.style) {
              decos.push(
                Decoration.mark({ attributes: { style: matched.style } })
                  .range(matched.from, node.from),
              )
            }
            decos.push((onCursorLine ? faintMark : hideMark).range(node.from, node.to))
            return
          }
          // 其他行内 HTML 标签：不渲染，保持原样显示
          return
        }

        // ── 行内 ──
        // HeaderMark（# 前缀等）：光标行半透明显示，非光标行隐藏
        if (name === 'HeaderMark') {
          decos.push((onCursorLine ? faintMark : hideMark).range(node.from, node.to))
          return
        }
        // 代码围栏标记与语言名：非光标行隐藏（语言由 chip 展示），光标行半透明
        if (name === 'CodeMark' || name === 'CodeInfo') {
          decos.push((onCursorLine ? faintMark : hideMark).range(node.from, node.to))
          return
        }
        // 光标行上的行内语法标记：半透明显示而非隐藏（Obsidian 行为）
        // 父节点（StrongEmphasis 等）的富文本样式在遍历到子节点前已单独挂上，
        // 这里 return 不影响父级样式
        if (onCursorLine && name.endsWith('Mark')) {
          decos.push(faintMark.range(node.from, node.to))
          return
        }
        // 列表符号 ListMark（- * 1. >）
        if (name === 'ListMark') {
          if (onCursorLine) {
            decos.push(faintMark.range(node.from, node.to))
            return
          }
          const marker = view.state.sliceDoc(node.from, node.to)
          decos.push(
            Decoration.replace({ widget: new BulletWidget(marker) }).range(node.from, node.to),
          )
          return
        }
        // 粗体：StrongMark 隐藏，Strong 内文本加粗
        if (name === 'StrongEmphasis' || name === 'Emphasis') {
          const cls = name === 'StrongEmphasis' ? strongBody : emBody
          decos.push(cls.range(node.from, node.to))
          return
        }
        // 删除线 / 高亮：标记隐藏，内文挂对应样式
        if (name === 'Strikethrough' || name === 'Highlight') {
          const cls = name === 'Strikethrough' ? strikeBody : highlightBody
          decos.push(cls.range(node.from, node.to))
          return
        }
        if (name.endsWith('Mark') && (name.startsWith('Strong') || name.startsWith('Emphasis') || name.startsWith('InlineCode') || name.startsWith('Strikethrough') || name.startsWith('Highlight'))) {
          decos.push(hideMark.range(node.from, node.to))
          return
        }
        if (name === 'InlineCode') {
          codeRanges.push({ from: node.from, to: node.to })
          decos.push(codeBody.range(node.from, node.to))
          return
        }
        // 链接：整个 Link 节点替换为文本 widget（md 链接的子节点结构复杂，
        // 直接取第一个文本子节点显示）
        if (name === 'Link') {
          if (onCursorLine) return // 光标行保持源码 [text](url)
          // [text](url) —— 取 [ ] 之间的文本
          const raw = view.state.sliceDoc(node.from, node.to)
          const m = /^\[(.*)\]\((.*)\)$/.exec(raw)
          if (m) {
            decos.push(
              Decoration.replace({ widget: new LinkTextWidget(m[1], m[2]) }).range(node.from, node.to),
            )
          }
          return
        }
      },
    })
  }

  // ── 行内公式 $...$（语法树不认 $，按行正则扫描；代码范围和光标行豁免）──
  const inCode = (pos: number) =>
    codeRanges.some((r) => pos >= r.from && pos <= r.to)
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos)
      if (line.number !== cursorLine && !inCode(line.from)) {
        const re = /\$([^$\n]+?)\$/g
        let m: RegExpExecArray | null
        while ((m = re.exec(line.text))) {
          const start = line.from + m.index
          const end = start + m[0].length
          // 前后紧贴 $ 的是块级公式 $$..$$，跳过
          if (line.text[m.index - 1] === '$' || line.text[m.index + m[0].length] === '$') continue
          if (inCode(start)) continue
          decos.push(
            Decoration.replace({ widget: new MathInlineWidget(m[1]) }).range(start, end),
          )
        }
      }
      pos = line.to + 1
    }
  }

  return Decoration.set(decos, true)
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

// ── 状态字段层（跨行块替换：表格 / 块级公式 / SVG）────────

/** CM6 约束：跨行 replace 只能来自 StateField（同 foldState），插件里会直接报错 */
function buildBlockDecorations(state: EditorState): DecorationSet {
  const decos: Range<Decoration>[] = []
  const cursor = state.selection.main.head
  const doc = state.doc
  /** 光标在范围内 → 保持源码（Obsidian 行为：编辑时看源码） */
  const cursorInside = (from: number, to: number) => cursor >= from && cursor <= to

  syntaxTree(state).iterate({
    enter(node) {
      // GFM 表格：整块替换为真表格
      if (node.name === 'Table') {
        if (cursorInside(node.from, node.to)) return
        decos.push(
          Decoration.replace({ widget: new TableWidget(doc.sliceString(node.from, node.to)) })
            .range(node.from, node.to),
        )
        return
      }
      // HTML 块：<svg> 开头的才渲染，其余 HTML 保持源码（v1 不做通用 HTML）
      if (node.name === 'HTMLBlock') {
        const raw = doc.sliceString(node.from, node.to)
        if (!/^\s*<svg[\s>]/i.test(raw)) return
        if (cursorInside(node.from, node.to)) return
        decos.push(Decoration.replace({ widget: new SvgWidget(raw) }).range(node.from, node.to))
        return
      }
    },
  })

  // ── 块级公式 $$...$$：逐行扫描（单行闭合或跨行闭合）──
  let i = 1
  while (i <= doc.lines) {
    const line = doc.line(i)
    const t = line.text.trim()
    if (!t.startsWith('$$')) {
      i++
      continue
    }
    // 找闭合：单行 $$x$$ 或后续以 $$ 结尾的行
    let endLine = line
    let closed = t.length >= 4 && t.endsWith('$$')
    if (!closed) {
      for (let j = i + 1; j <= doc.lines; j++) {
        const l = doc.line(j)
        if (l.text.trim().endsWith('$$')) {
          endLine = l
          closed = true
          break
        }
      }
    }
    if (closed) {
      const from = line.from + line.text.indexOf('$$')
      const to = endLine.to
      if (!cursorInside(from, to)) {
        // 公式体：去掉首尾的 $$ 定界符
        const latex = doc.sliceString(from + 2, to).trimEnd().replace(/\$\$$/, '')
        decos.push(
          Decoration.replace({ widget: new MathBlockWidget(latex.trim()) }).range(from, to),
        )
      }
      i = endLine.number + 1
    } else {
      i++ // 未闭合的 $$：当普通文本，继续
    }
  }

  return Decoration.set(decos, true)
}

const blockField = StateField.define<DecorationSet>({
  create: buildBlockDecorations,
  update(value, tr) {
    // 文档或选区变化都要重算（光标进出表格/公式要切换源码态）
    if (tr.docChanged || tr.selection) return buildBlockDecorations(tr.state)
    return value.map(tr.changes)
  },
})

/** 块级渲染扩展：状态字段 + 把装饰喂给 EditorView.decorations facet */
export const livePreviewBlocks: Extension = [
  blockField,
  EditorView.decorations.from(blockField),
]

export { blockField as livePreviewBlocksField }
