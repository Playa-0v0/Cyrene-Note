/**
 * selectionMenu —— 选区右键菜单（Obsidian 式）。
 *
 * 行为：
 * - 选中文字后在选区内右键 → 弹出浮动菜单
 * - 空白处右键（无选区/不在选区内）→ 不弹（不劫持系统右键菜单）
 * - 三组命令：
 *   - 文本格式：加粗/倾斜/删除线/行内代码/高亮（对选区 toggle 包裹）
 *   - 文字颜色：预设五色 + 原生色盘（span color 值的包裹/替换/清除）
 *   - 段落设置：H1-H6/正文/列表/引用（对选区覆盖到的段落行首前缀 toggle）
 *   - 插入：表格/代码块/公式块/分隔线（光标处插入模板）
 *   - 基础：剪切/复制/粘贴/全选
 * - Esc / 点击菜单外 / 执行命令后关闭
 *
 * 实现为 DOM 事件层（domEventHandlers），菜单挂在 body 上（fixed 定位）。
 */
import { EditorView, keymap } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import type { Extension } from '@codemirror/state'

// ── 文本格式命令：toggle 包裹 ─────────────────────────────

/** 对选区包裹/去包裹标记（如 ** 加粗）。选区已有同标记则去掉 */
function toggleWrap(view: EditorView, mark: string): boolean {
  const { from, to } = view.state.selection.main
  const selected = view.state.sliceDoc(from, to)
  // 已包裹 → 去掉
  if (selected.startsWith(mark) && selected.endsWith(mark) && selected.length >= mark.length * 2) {
    view.dispatch({
      changes: [
        { from, to: from + mark.length, insert: '' },
        { from: to - mark.length, to, insert: '' },
      ],
      selection: { anchor: from, head: to - mark.length * 2 },
    })
    return true
  }
  view.dispatch({
    changes: [
      { from, insert: mark },
      { from: to, insert: mark },
    ],
    selection: { anchor: from + mark.length, head: to + mark.length },
  })
  return true
}

// ── 文字颜色命令：span 包裹（livePreview 可渲染）──────────

/** 选区内容恰为一个 <span style="...">...</span> 时捕获其样式与内文 */
const SPAN_RE = /^<span\s+style="([^"]*)"\s*>([\s\S]*)<\/span>$/i

/** 从 style 串提取 color 值（无则 null） */
function styleColorValue(style: string): string | null {
  for (const part of style.split(';')) {
    const m = /^\s*color\s*:\s*(.+?)\s*$/i.exec(part)
    if (m) return m[1]
  }
  return null
}

/** style 串替换或追加 color 属性，其余属性不动 */
function withColorProp(style: string, color: string): string {
  const parts = style.split(';').map((s) => s.trim()).filter(Boolean)
  const prop = `color: ${color}`
  const idx = parts.findIndex((p) => /^color\s*:/i.test(p))
  if (idx >= 0) parts[idx] = prop
  else parts.push(prop)
  return parts.join('; ')
}

/**
 * 应用文字颜色：控制 span 的 color 值。
 * - 未包裹 → 包上 <span style="color: ...">
 * - 同色再点 → 去掉包裹（toggle，与其他格式命令一致）
 * - 异色 → 只换 color 值，其他样式属性保留
 */
export function applyColor(view: EditorView, color: string): boolean {
  const { from, to } = view.state.selection.main
  const m = SPAN_RE.exec(view.state.sliceDoc(from, to))
  if (m) {
    const [style, inner] = [m[1], m[2]]
    // 同色 → 去掉包裹
    if (styleColorValue(style)?.toLowerCase() === color.toLowerCase()) {
      view.dispatch({
        changes: { from, to, insert: inner },
        selection: { anchor: from, head: from + inner.length },
      })
      return true
    }
    // 异色 → 换色值（保留其他属性）
    const open = `<span style="${withColorProp(style, color)}">`
    view.dispatch({
      changes: { from, to, insert: open + inner + '</span>' },
      selection: { anchor: from + open.length, head: from + open.length + inner.length },
    })
    return true
  }
  const open = `<span style="color: ${color}">`
  view.dispatch({
    changes: [
      { from, insert: open },
      { from: to, insert: '</span>' },
    ],
    selection: { anchor: from + open.length, head: to + open.length },
  })
  return true
}

/** 清除颜色：选区恰为一个 span 时去掉 color 属性（其余属性保留，空了整个去掉） */
export function clearColor(view: EditorView): boolean {
  const { from, to } = view.state.selection.main
  const m = SPAN_RE.exec(view.state.sliceDoc(from, to))
  if (!m) return false
  const rest = m[1].split(';').map((s) => s.trim()).filter(Boolean).filter((p) => !/^color\s*:/i.test(p))
  const inner = m[2]
  const open = rest.length ? `<span style="${rest.join('; ')}">` : ''
  const close = rest.length ? '</span>' : ''
  view.dispatch({
    changes: { from, to, insert: open + inner + close },
    selection: { anchor: from + open.length, head: from + open.length + inner.length },
  })
  return true
}

// ── 段落设置命令：行首前缀 toggle ─────────────────────────

/** 行首标记的正则（H1-6/正文/无序/有序/任务/引用） */
const PARA_PATTERNS: Record<string, RegExp> = {
  h1: /^#\s+/,
  h2: /^##\s+/,
  h3: /^###\s+/,
  h4: /^####\s+/,
  h5: /^#####\s+/,
  h6: /^######\s+/,
  body: /^#{1,6}\s+/,
  ul: /^[-*+]\s+/,
  ol: /^\d+\.\s+/,
  task: /^[-*+]\s\[[ xX]\]\s+/,
  quote: /^>\s?/,
}

/**
 * 对选区覆盖的每个段落行设置行首标记。
 * - mode 已是该标记 → 去掉（toggle）
 * - 否则替换为该标记
 */
function setParagraph(view: EditorView, mode: string): boolean {
  const pattern = PARA_PATTERNS[mode]
  if (!pattern) return false
  const { from, to } = view.state.selection.main
  const firstLine = view.state.doc.lineAt(from)
  const lastLine = view.state.doc.lineAt(to)
  // 所有行都已挂该标记 → 全部去掉（toggle 语义）
  let allMatched = true
  for (let i = firstLine.number; i <= lastLine.number; i++) {
    if (!pattern.test(view.state.doc.line(i).text)) {
      allMatched = false
      break
    }
  }
  const changes: { from: number; to?: number; insert: string }[] = []
  for (let i = firstLine.number; i <= lastLine.number; i++) {
    const line = view.state.doc.line(i)
    // 空行也允许设置（成为列表项/标题，Obsidian 同款）
    const m = /^(#{1,6}\s+|[-*+]\s\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+|>\s?)/.exec(line.text)
    const stripLen = m ? m[0].length : 0
    if (allMatched) {
      changes.push({ from: line.from, to: line.from + stripLen, insert: '' })
    } else {
      const prefix =
        mode === 'h1' ? '# ' : mode === 'h2' ? '## ' : mode === 'h3' ? '### '
        : mode === 'h4' ? '#### ' : mode === 'h5' ? '##### ' : mode === 'h6' ? '###### '
        : mode === 'body' ? '' : mode === 'ul' ? '- ' : mode === 'ol' ? '1. '
        : mode === 'task' ? '- [ ] ' : mode === 'quote' ? '> ' : ''
      changes.push({ from: line.from, to: line.from + stripLen, insert: prefix })
    }
  }
  view.dispatch({ changes })
  return true
}

// ── 插入命令：光标处插入模板 ──────────────────────────────

/** 在光标处插入块级模板；若光标行非空则先补换行（模板独占行） */
function insertBlock(view: EditorView, template: string): boolean {
  const { from } = view.state.selection.main
  const line = view.state.doc.lineAt(from)
  const atLineStart = from === line.from
  const leading = atLineStart ? '' : line.text.trim() === '' ? '' : '\n'
  const trailing = line.text.slice(from - line.from).trim() === '' ? '' : '\n'
  view.dispatch({
    changes: { from, insert: leading + template + trailing },
    selection: { anchor: from + leading.length + template.length },
  })
  return true
}

// ── 剪贴板基础命令 ────────────────────────────────────────

async function doCopy(view: EditorView) {
  const { from, to } = view.state.selection.main
  await navigator.clipboard.writeText(view.state.sliceDoc(from, to))
}

async function doCut(view: EditorView) {
  await doCopy(view)
  view.dispatch({
    changes: { from: view.state.selection.main.from, to: view.state.selection.main.to, insert: '' },
  })
}

async function doPaste(view: EditorView) {
  const text = await navigator.clipboard.readText()
  view.dispatch(view.state.replaceSelection(text))
}

// ── 菜单结构 ──────────────────────────────────────────────

type MenuItem =
  | { kind: 'item'; label: string; hint?: string; icon?: string; run: (view: EditorView) => boolean | void | Promise<void> }
  | { kind: 'sep' }
  | { kind: 'colors'; presets: string[] }

/** 文字颜色预设（品牌粉 + 常用四色；色盘输入可自定义任意色） */
const COLOR_PRESETS = ['#ff5b8a', '#e5484d', '#f08c00', '#30a46c', '#3e63dd']

/**
 * 菜单项图标（IconPark 线性图标 path 数据，viewBox 0 0 48 48，currentColor 描边）。
 * 名称对应 .assets/iconpark/source/Edit 等目录下的同名 svg。
 */
const ICONS: Record<string, string> = {
  // text-bold 加粗
  bold:
    '<path fill-rule="evenodd" clip-rule="evenodd" d="M24 24C29.5056 24 33.9688 19.5228 33.9688 14C33.9688 8.47715 29.5056 4 24 4H11V24H24Z"/>' +
    '<path fill-rule="evenodd" clip-rule="evenodd" d="M28.0312 44C33.5368 44 38 39.5228 38 34C38 28.4772 33.5368 24 28.0312 24H11V44H28.0312Z"/>',
  // text-italic 倾斜
  italic:
    '<path d="M20 6H36"/><path d="M12 42H28"/><path d="M29 5.95215L19 41.9998"/>',
  // strikethrough 删除线
  strikethrough:
    '<path d="M5 24H43"/>' +
    '<path d="M24 24C40 30 34 44 24 44C13.9999 44 12 36 12 36"/>' +
    '<path d="M35.9999 12C35.9999 12 33 4 23.9999 4C14.9999 4 11.4359 11.5995 15.6096 18"/>' +
    '<path d="M12 36C12 36 15.9999 44 24 44C32 44 36.564 36.4005 32.3903 30"/>',
  // high-light 高亮（笔头部分，去掉填充）
  highlight:
    '<path d="M6 44L6 25H12V17H36V25H42V44H6Z"/>' +
    '<path d="M17 17V8L31 4V17"/>',
  // background-color 文字颜色（笔头 + 墨滴 + 底线，墨滴填充跟随文字色）
  textColor:
    '<path fill-rule="evenodd" clip-rule="evenodd" d="M37 37C39.2091 37 41 35.2091 41 33C41 31.5272 39.6667 29.5272 37 27C34.3333 29.5272 33 31.5272 33 33C33 35.2091 34.7909 37 37 37Z" fill="currentColor"/>' +
    '<path d="M20.8535 5.50439L24.389 9.03993"/>' +
    '<path d="M23.6818 8.33281L8.12549 23.8892L19.4392 35.2029L34.9955 19.6465L23.6818 8.33281Z"/>' +
    '<path d="M12 20.0732L28.961 25.6496"/>' +
    '<path d="M4 43H44"/>',
  // code 行内代码
  code:
    '<path d="M16 13L4 25.4322L16 37"/><path d="M32 13L44 25.4322L32 37"/><path d="M28 4L21 44"/>',
  // text 正文
  text:
    '<path d="M6 4V44"/><path d="M42 4V44"/><path d="M14 15H34"/><path d="M14 33H42"/>',
  // h1-h3 标题（H/H1/H2 字形）
  h: '<path d="M12 5V43"/><path d="M36 5V43"/><path d="M12 24L36 24"/>',
  h1: '<path d="M6 8V40"/><path d="M25 8V40"/><path d="M6 24H25"/><path d="M34.2261 24L39.0001 19.0166V40"/>',
  h2: '<path d="M6 8V40"/><path d="M24 8V40"/><path d="M7 24H23"/><path d="M32 25C32 21.8334 34.6667 20 37 20C39.3334 20 42 21.8334 42 25C42 30.7 32 34.9333 32 40H42"/>',
  h3: '<path d="M6 8V40"/><path d="M24 8V40"/><path d="M7 24H23"/><path d="M32 20H42L35 29C39 29 42 31 42 35C42 39 39 40 37 40C34.619 40 33 39 32 37.9"/>',
  // list 无序列表
  list:
    '<path d="M5 10L8 13L14 7"/><path d="M5 24L8 27L14 21"/><path d="M5 38L8 41L14 35"/>' +
    '<path d="M21 24H43"/><path d="M21 38H43"/><path d="M21 10H43"/>',
  // ordered-list 有序列表
  orderedList:
    '<path d="M9 4V13"/><path d="M12 13H6"/><path d="M12 27H6"/>' +
    '<path d="M6 19.9998C6 19.9998 9 16.9998 11 19.9998C13 22.9999 6 26.9998 6 26.9998"/>' +
    '<path d="M6.00016 34.5001C6.00016 34.5001 8.00016 31.5 11.0002 33.5C14.0002 35.5 11.0002 38 11.0002 38C11.0002 38 14.0002 40.5 11.0002 42.5C8.00015 44.5 6.00015 41.5 6.00015 41.5"/>' +
    '<path d="M11 38H9"/><path d="M9 4L6 6"/>' +
    '<path d="M21 24H43"/><path d="M21 38H43"/><path d="M21 10H43"/>',
  // list-checkbox 任务列表
  task:
    '<rect x="4" y="6" width="8" height="8"/><rect x="4" y="20" width="8" height="8"/><rect x="4" y="34" width="8" height="8"/>' +
    '<path d="M20 10H44"/><path d="M20 24H44"/><path d="M20 38H44"/>',
  // quote 引用
  quote:
    '<path fill-rule="evenodd" clip-rule="evenodd" d="M18.8533 9.11587C11.3227 13.9521 7.13913 19.5811 6.30256 26.0028C5.00021 35.9999 13.9404 40.8932 18.4703 36.4966C23.0002 32.1 20.2848 26.5195 17.0047 24.9941C13.7246 23.4686 11.7187 23.9999 12.0686 21.9614C12.4185 19.923 17.0851 14.2712 21.1849 11.6391C21.4569 11.4078 21.5604 10.959 21.2985 10.6185C21.1262 10.3946 20.7883 9.95545 20.2848 9.30102C19.8445 8.72875 19.4227 8.75017 18.8533 9.11587Z" fill="currentColor"/>' +
    '<path fill-rule="evenodd" clip-rule="evenodd" d="M38.6789 9.11587C31.1484 13.9521 26.9648 19.5811 26.1282 26.0028C24.8259 35.9999 33.7661 40.8932 38.296 36.4966C42.8259 32.1 40.1105 26.5195 36.8304 24.9941C33.5503 23.4686 31.5443 23.9999 31.8943 21.9614C32.2442 19.923 36.9108 14.2712 41.0106 11.6391C41.2826 11.4078 41.3861 10.959 41.1241 10.6185C40.9519 10.3946 40.614 9.95545 40.1105 9.30102C39.6702 8.72875 39.2484 8.75017 38.6789 9.11587Z" fill="currentColor"/>',
  // insert-table 表格
  table:
    '<path d="M39.3 6H8.7C7.20883 6 6 7.20883 6 8.7V39.3C6 40.7912 7.20883 42 8.7 42H39.3C40.7912 42 42 40.7912 42 39.3V8.7C42 7.20883 40.7912 6 39.3 6Z"/>' +
    '<path d="M18 6V42"/><path d="M30 6V42"/><path d="M6 18H42"/><path d="M6 30H42"/>',
  // code-brackets 代码块
  codeBlock:
    '<path d="M16 4C14 4 11 5 11 9C11 13 11 15 11 18C11 21 6 23 6 23C6 23 11 25 11 28C11 31 11 35 11 39C11 43 14 44 16 44"/>' +
    '<path d="M32 4C34 4 37 5 37 9C37 13 37 15 37 18C37 21 42 23 42 23C42 23 37 25 37 28C37 31 37 35 37 39C37 43 34 44 32 44"/>',
  // formula 公式块
  formula: '<path d="M40 9L37 6H8L26 24L8 42H37L40 39"/>',
  // clear-format 清除格式（橡皮，去掉原填充色改纯描边）
  clearFormat:
    '<path d="M44.7818 24.1702L31.918 7.09935L14.1348 20.5L27.5 37L30.8556 34.6643L44.7818 24.1702Z"/>' +
    '<path d="M27.4998 37L23.6613 40.0748L13.0978 40.074L10.4973 36.6231L4.06543 28.0876L14.4998 20.2248"/>' +
    '<path d="M13.2056 40.072L44.5653 40.072"/>',
  // dividing-line 分隔线
  hr:
    '<path d="M5 24H43"/><path d="M21 38H27"/><path d="M37 38H43"/><path d="M21 10H27"/><path d="M5 38H11"/><path d="M5 10H11"/><path d="M37 10H43"/>',
  // cutting 剪切（斜杠）
  cut:
    '<path d="M6 10H38V42"/><path d="M10.5483 37.4519L42.385 5.61519"/><path d="M42 38H10V6"/>',
  // copy 复制（双卡片）
  copy:
    '<path d="M13 12.4316V7.8125C13 6.2592 14.2592 5 15.8125 5H40.1875C41.7408 5 43 6.2592 43 7.8125V32.1875C43 33.7408 41.7408 35 40.1875 35H35.5163"/>' +
    '<path d="M32.1875 13H7.8125C6.2592 13 5 14.2592 5 15.8125V40.1875C5 41.7408 6.2592 43 7.8125 43H32.1875C33.7408 43 35 41.7408 35 40.1875V15.8125C35 14.2592 33.7408 13 32.1875 13Z"/>',
  // clipboard 粘贴
  paste:
    '<path d="M17 7H16H10C8.89543 7 8 7.89543 8 9L8 42C8 43.1046 8.89543 44 10 44H38C39.1046 44 40 43.1046 40 42V9C40 7.89543 39.1046 7 38 7H33.0499H31"/>' +
    '<rect x="17" y="4" width="14" height="6"/>',
  // full-selection 全选
  selectAll:
    '<path d="M34 5H8C6.34315 5 5 6.34315 5 8V34C5 35.6569 6.34315 37 8 37H34C35.6569 37 37 35.6569 37 34V8C37 6.34315 35.6569 5 34 5Z"/>' +
    '<path d="M43.9998 13.002V42.0001C43.9998 43.1046 43.1044 44.0001 41.9998 44.0001H13.0034"/>' +
    '<path d="M13 20.4858L18.9997 26.0109L29 15.7192"/>',
}

/** 造图标 SVG 元素（16px，线性描边跟随文字颜色） */
function makeIcon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 48 48')
  svg.setAttribute('fill', 'none')
  svg.classList.add('lp-sel-menu-icon')
  svg.innerHTML = ICONS[name] ?? ''
  return svg
}

/** 菜单内容（文本格式 → 段落设置 → 插入 → 剪贴板）。测试直接调 run 验证命令逻辑 */
export function menuSectionsForTest(): { title: string; items: MenuItem[] }[] {
  return [
    {
      title: '文本格式',
      items: [
        { kind: 'item', label: '加粗', hint: 'B', icon: 'bold', run: (v) => void toggleWrap(v, '**') },
        { kind: 'item', label: '倾斜', hint: 'I', icon: 'italic', run: (v) => void toggleWrap(v, '*') },
        { kind: 'item', label: '删除线', hint: 'S', icon: 'strikethrough', run: (v) => void toggleWrap(v, '~~') },
        { kind: 'item', label: '高亮', hint: 'H', icon: 'highlight', run: (v) => void toggleWrap(v, '==') },
        { kind: 'item', label: '行内代码', hint: 'C', icon: 'code', run: (v) => void toggleWrap(v, '`') },
      ],
    },
    {
      title: '文字颜色',
      items: [
        { kind: 'colors', presets: COLOR_PRESETS },
        { kind: 'sep' },
        { kind: 'item', label: '清除颜色', icon: 'clearFormat', run: (v) => clearColor(v) },
      ],
    },
    {
      title: '段落设置',
      items: [
        { kind: 'item', label: '正文', icon: 'text', run: (v) => setParagraph(v, 'body') },
        { kind: 'sep' },
        { kind: 'item', label: 'H1 标题', icon: 'h1', run: (v) => setParagraph(v, 'h1') },
        { kind: 'item', label: 'H2 标题', icon: 'h2', run: (v) => setParagraph(v, 'h2') },
        { kind: 'item', label: 'H3 标题', icon: 'h3', run: (v) => setParagraph(v, 'h3') },
        { kind: 'item', label: 'H4 标题', icon: 'h', run: (v) => setParagraph(v, 'h4') },
        { kind: 'item', label: 'H5 标题', icon: 'h', run: (v) => setParagraph(v, 'h5') },
        { kind: 'item', label: 'H6 标题', icon: 'h', run: (v) => setParagraph(v, 'h6') },
        { kind: 'sep' },
        { kind: 'item', label: '无序列表', icon: 'list', run: (v) => setParagraph(v, 'ul') },
        { kind: 'item', label: '有序列表', icon: 'orderedList', run: (v) => setParagraph(v, 'ol') },
        { kind: 'item', label: '任务列表', icon: 'task', run: (v) => setParagraph(v, 'task') },
        { kind: 'item', label: '引用', icon: 'quote', run: (v) => setParagraph(v, 'quote') },
      ],
    },
    {
      title: '插入',
      items: [
        { kind: 'item', label: '表格', icon: 'table', run: (v) => insertBlock(v, '| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n') },
        { kind: 'item', label: '代码块', icon: 'codeBlock', run: (v) => insertBlock(v, '```ts\n\n```\n') },
        { kind: 'item', label: '公式块', icon: 'formula', run: (v) => insertBlock(v, '$$\n\n$$\n') },
        { kind: 'item', label: '分隔线', icon: 'hr', run: (v) => insertBlock(v, '---\n') },
      ],
    },
    {
      title: '',
      items: [
        { kind: 'item', label: '剪切', icon: 'cut', run: (v) => void doCut(v) },
        { kind: 'item', label: '复制', icon: 'copy', run: (v) => void doCopy(v) },
        { kind: 'item', label: '粘贴', icon: 'paste', run: (v) => void doPaste(v) },
        { kind: 'item', label: '全选', icon: 'selectAll', run: (v) => { v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } }); v.focus() } },
      ],
    },
  ]
}

// ── 浮层菜单（DOM）───────────────────────────────────────

let currentMenu: HTMLElement | null = null
let menuCleanup: (() => void) | null = null

/** 关闭当前菜单 */
export function closeSelectionMenu() {
  if (menuCleanup) {
    menuCleanup()
    menuCleanup = null
  }
  currentMenu?.remove()
  currentMenu = null
}

/** 在屏幕坐标 (x, y) 弹出选区菜单 */
function openMenu(view: EditorView, x: number, y: number) {
  closeSelectionMenu()
  const menu = document.createElement('div')
  menu.className = 'lp-sel-menu'
  // 子面板的清理函数（挂 body 的元素不由主菜单 remove 带走，需单独清）
  const subCleanups: (() => void)[] = []

  /** 给菜单项绑定执行逻辑（点击 → 关菜单 → 执行 → 焦点回编辑器） */
  function bindRun(btn: HTMLButtonElement, item: Extract<MenuItem, { kind: 'item' }>) {
    btn.onmousedown = (e) => e.preventDefault() // 不让按钮抢走编辑器焦点
    btn.onclick = () => {
      closeSelectionMenu()
      void item.run(view)
      view.focus()
    }
  }

  /** 造一个菜单项按钮（图标 + 文字 + 快捷键提示） */
  function makeItem(item: Extract<MenuItem, { kind: 'item' }>): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.className = 'lp-sel-menu-item'
    if (item.icon) btn.appendChild(makeIcon(item.icon))
    const label = document.createElement('span')
    label.className = 'lp-sel-menu-label'
    label.textContent = item.label
    btn.appendChild(label)
    if (item.hint) {
      const hint = document.createElement('span')
      hint.className = 'lp-sel-menu-hint'
      hint.textContent = item.hint
      btn.appendChild(hint)
    }
    bindRun(btn, item)
    return btn
  }

  /** 造文字颜色行：预设色块 + 原生色盘（选区当前色对应的色块带选中圈） */
  function makeColorsRow(presets: string[], view: EditorView): HTMLElement {
    const row = document.createElement('div')
    row.className = 'lp-sel-colors'
    // 读选区当前颜色：恰为一个完整 span 时可读出
    const { from, to } = view.state.selection.main
    const m = SPAN_RE.exec(view.state.sliceDoc(from, to))
    const current = m ? styleColorValue(m[1])?.toLowerCase() : null
    for (const c of presets) {
      const btn = document.createElement('button')
      btn.className = 'lp-sel-swatch' + (current && current === c.toLowerCase() ? ' lp-sel-swatch-on' : '')
      btn.style.background = c
      btn.title = c
      btn.onmousedown = (e) => e.preventDefault() // 不抢编辑器焦点
      btn.onclick = () => {
        closeSelectionMenu()
        applyColor(view, c)
        view.focus()
      }
      row.appendChild(btn)
    }
    // 原生色盘：确认取色（change）后应用
    const picker = document.createElement('input')
    picker.type = 'color'
    picker.className = 'lp-sel-picker'
    picker.title = '自定义颜色'
    picker.addEventListener('change', () => {
      closeSelectionMenu()
      applyColor(view, picker.value)
      view.focus()
    })
    row.appendChild(picker)
    return row
  }

  /** 造一个带子菜单的入口项（悬停向右展开；子面板挂 body，避免被主菜单 overflow 裁剪） */
  function makeSubmenuEntry(label: string, sectionTitle: string, iconName?: string): HTMLDivElement {
    const entry = document.createElement('div')
    entry.className = 'lp-sel-menu-entry'
    const btn = document.createElement('button')
    btn.className = 'lp-sel-menu-item'
    if (iconName) btn.appendChild(makeIcon(iconName))
    const text = document.createElement('span')
    text.className = 'lp-sel-menu-label'
    text.textContent = label
    btn.appendChild(text)
    // 右侧展开箭头
    const arrow = document.createElement('span')
    arrow.className = 'lp-sel-menu-arrow'
    arrow.textContent = '›'
    btn.appendChild(arrow)

    // 子菜单面板：悬停时才挂到 body（fixed 定位，完全脱离主菜单）
    let sub: HTMLElement | null = null
    let hideTimer: number | null = null

    const hideSub = () => {
      if (hideTimer !== null) window.clearTimeout(hideTimer)
      hideTimer = null
      sub?.remove()
      sub = null
      entry.classList.remove('lp-sel-open')
    }

    const showSub = () => {
      if (hideTimer !== null) {
        window.clearTimeout(hideTimer)
        hideTimer = null
      }
      if (sub) return
      sub = document.createElement('div')
      sub.className = 'lp-sel-menu-sub'
      const section = menuSectionsForTest().find((s) => s.title === sectionTitle)
      if (section) {
        for (const item of section.items) {
          if (item.kind === 'sep') {
            sub.appendChild(document.createElement('div')).className = 'lp-sel-menu-sep'
            continue
          }
          if (item.kind === 'colors') {
            sub.appendChild(makeColorsRow(item.presets, view))
            continue
          }
          sub.appendChild(makeItem(item))
        }
      }
      // 子面板悬停期间保持打开（鼠标移入子面板本身时）
      sub.addEventListener('mouseenter', () => {
        if (hideTimer !== null) {
          window.clearTimeout(hideTimer)
          hideTimer = null
        }
      })
      sub.addEventListener('mouseleave', () => {
        hideTimer = window.setTimeout(hideSub, 120)
      })
      // 先隐藏挂载量尺寸，再定位（右侧优先，右边缘放不下翻转；垂直钳制在视口内）
      sub.style.visibility = 'hidden'
      document.body.appendChild(sub)
      const entryRect = entry.getBoundingClientRect()
      const subRect = sub.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      const flipLeft = entryRect.right + subRect.width + 4 > vw
      const left = flipLeft
        ? Math.max(4, entryRect.left - subRect.width - 2)
        : entryRect.right + 2
      let top = Math.min(Math.max(4, entryRect.top - 7), vh - subRect.height - 4)
      sub.style.left = `${left}px`
      sub.style.top = `${top}px`
      // 菜单比视口还高 → 顶到上缘限高滚动
      if (subRect.height > vh - 8) {
        top = 4
        sub.style.top = `${top}px`
        sub.style.maxHeight = `${vh - 8}px`
        sub.style.overflowY = 'auto'
      }
      sub.style.visibility = ''
      entry.classList.add('lp-sel-open')
    }

    entry.addEventListener('mouseenter', showSub)
    entry.addEventListener('mouseleave', () => {
      // 短延迟：给鼠标移进子面板留出通道
      hideTimer = window.setTimeout(hideSub, 120)
    })
    // 菜单整体关闭时一并清理子面板
    subCleanups.push(hideSub)
    entry.appendChild(btn)
    return entry
  }

  // 主菜单：四个子菜单入口 + 剪贴板（一列短菜单，Obsidian 式）
  const [fmtSec, colorSec, paraSec, insSec, clipSec] = menuSectionsForTest()
  menu.appendChild(makeSubmenuEntry('文本格式', fmtSec.title, 'bold'))
  menu.appendChild(makeSubmenuEntry('文字颜色', colorSec.title, 'textColor'))
  menu.appendChild(makeSubmenuEntry('段落设置', paraSec.title, 'text'))
  menu.appendChild(makeSubmenuEntry('插入', insSec.title, 'table'))
  menu.appendChild(Object.assign(document.createElement('div'), { className: 'lp-sel-menu-sep' }))
  for (const item of clipSec.items) {
    if (item.kind === 'item') menu.appendChild(makeItem(item))
  }

  document.body.appendChild(menu)
  currentMenu = menu

  // 定位：光标右下方，越界自动翻转
  menu.style.visibility = 'hidden'
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const left = x + rect.width > vw ? Math.max(4, x - rect.width) : x
    const top = y + rect.height > vh ? Math.max(4, y - rect.height) : y
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
    menu.style.visibility = ''
    // 主菜单本身比视口还高（窗口极矮的兜底）→ 限高滚动
    if (rect.height > vh - 8) {
      menu.style.top = '4px'
      menu.style.maxHeight = `${vh - 8}px`
      menu.style.overflowY = 'auto'
    }
  })

  // 关闭时机：点击菜单外 / Esc / 滚动 / 窗口尺寸变化
  const onDown = (e: MouseEvent) => {
    // 菜单本体或挂 body 的子面板内 → 不算外部点击
    if (menu.contains(e.target as Node)) return
    if ((e.target as HTMLElement).closest?.('.lp-sel-menu-sub')) return
    closeSelectionMenu()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeSelectionMenu()
  }
  const onClose = () => closeSelectionMenu()
  document.addEventListener('mousedown', onDown, true)
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('resize', onClose)
  window.addEventListener('scroll', onClose, true)
  menuCleanup = () => {
    document.removeEventListener('mousedown', onDown, true)
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('resize', onClose)
    window.removeEventListener('scroll', onClose, true)
    // 清掉挂在 body 上的子面板
    for (const fn of subCleanups) fn()
  }
}

// ── 扩展装配 ──────────────────────────────────────────────

export const selectionMenu: Extension = [
  // 高优先级：在选区内右键时拦截默认菜单，弹自定义菜单
  Prec.highest(
    EditorView.domEventHandlers({
      contextmenu(event, view) {
        const { from, to } = view.state.selection.main
        // 无选区或点击处不在选区内 → 不拦截（系统默认菜单）
        if (from === to) return false
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos === null || pos < from || pos > to) return false
        event.preventDefault()
        openMenu(view, event.clientX, event.clientY)
        return true
      },
    }),
  ),
  // Esc 关菜单（菜单未打开时不拦截）
  keymap.of([
    {
      key: 'Escape',
      run: () => {
        if (currentMenu) {
          closeSelectionMenu()
          return true
        }
        return false
      },
    },
  ]),
]
