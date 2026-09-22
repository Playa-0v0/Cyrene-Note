/**
 * Live Preview decoration 断言测试。
 *
 * jsdom + 真实 CM6 跑同一个 livePreview extension，断言：
 * - 语法标记（# 前缀、** 星号、` 反引号）被隐藏（lp-hide）
 * - 标题挂对应 lp-hN class
 * - 粗体/斜体/行内代码 body class
 * - 列表符号被 widget 替换（BulletWidget 装饰）
 * - 引用块挂 lp-quote
 * - 光标所在行保持源码（Obsidian 行为）
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView, Decoration } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'

import { livePreview, livePreviewBlocks, livePreviewBlocksField } from './livePreview'
import { Highlight } from './highlight'

const DOC = `# 标题一

这是**粗体**和*斜体*和\`行内代码\`。

## 标题二

- 列表项

> 引用块
`

function makeView(doc: string, cursorAt = 0): EditorView {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursorAt },
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        livePreview,
      ],
    }),
    parent: host,
  })
  return view
}

/** 从 plugin 上的 decoration set 用 `between` 收集所有 active decoration */
function collectDecorations(view: EditorView) {
  const plugin = view.plugin(livePreview)
  if (!plugin) throw new Error('livePreview plugin 没挂上')
  const decoSet = (plugin as unknown as { decorations: unknown }).decorations as {
    between: (
      a: number,
      b: number,
      f: (from: number, to: number, value: Decoration) => void,
    ) => void
  }
  const items: { from: number; to: number; class?: string; widgetName?: string; style?: string }[] = []
  decoSet.between(
    0,
    view.state.doc.length,
    (from, to, value) => {
      // Decoration.mark({ class }) → value.spec.class
      // Decoration.replace({ widget }) → value.spec.widget (Mark 类没 widget)
      const spec = (value as unknown as { spec: Record<string, unknown> }).spec ?? {}
      const cls = typeof spec.class === 'string' ? spec.class : undefined
      const widget =
        spec.widget && typeof spec.widget === 'object'
          ? (spec.widget as { constructor: { name: string } }).constructor.name
          : undefined
      const attrs = spec.attributes as Record<string, string> | undefined
      items.push({ from, to, class: cls, widgetName: widget, style: attrs?.style })
    },
  )
  return items
}

const at = (doc: string, needle: string, occurrence = 1): number => {
  let idx = -1
  for (let i = 0; i < occurrence; i++) {
    idx = doc.indexOf(needle, idx + 1)
    expect(idx).toBeGreaterThanOrEqual(0)
  }
  return idx
}

describe('livePreview decorations', () => {
  let view: EditorView

  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('标题行（非光标行）挂 lp-h1/lp-h2', () => {
    view = makeView(DOC, at(DOC, '这是'))
    const decos = collectDecorations(view)
    expect(decos.find((d) => d.class === 'lp-h1')).toBeTruthy()
    expect(decos.find((d) => d.class === 'lp-h2')).toBeTruthy()
  })

  it('"# " 前缀（HeaderMark）被隐藏', () => {
    view = makeView(DOC, at(DOC, '这是'))
    const decos = collectDecorations(view)
    const hiddenHash = decos.find(
      (d) => d.class === 'lp-hide' && DOC.slice(d.from, d.to) === '#',
    )
    expect(hiddenHash).toBeTruthy()
  })

  it('** 两个星号各自被隐藏，粗体 body 加粗', () => {
    view = makeView(DOC, at(DOC, '标题二'))
    const decos = collectDecorations(view)
    const hiddenStars = decos.filter(
      (d) => d.class === 'lp-hide' && DOC.slice(d.from, d.to) === '**',
    )
    expect(hiddenStars.length).toBeGreaterThanOrEqual(2)
    expect(decos.find((d) => d.class === 'lp-strong')).toBeTruthy()
    expect(decos.find((d) => d.class === 'lp-em')).toBeTruthy()
    expect(decos.find((d) => d.class === 'lp-code')).toBeTruthy()
  })

  it('列表符号被 BulletWidget 替换', () => {
    view = makeView(DOC, at(DOC, '标题二'))
    const decos = collectDecorations(view)
    const bullet = decos.find((d) => d.widgetName === 'BulletWidget')
    expect(bullet).toBeTruthy()
    expect(DOC.slice(bullet!.from, bullet!.to)).toBe('-')
  })

  it('引用块挂 lp-quote-line 行装饰', () => {
    view = makeView(DOC, at(DOC, '标题二'))
    const decos = collectDecorations(view)
    expect(decos.find((d) => d.class === 'lp-quote-line')).toBeTruthy()
  })

  it('连续多行引用：逐行挂 lp-quote-line（视觉连续），> 标记隐藏，后续段落不被吞', () => {
    // 引用与正文之间必须空行——CommonMark 惰性延续规则下无空行时正文本就属于引用
    const doc = '> 甲\n> 乙\n> 丙\n\n正文\n'
    view = makeView(doc, 0) // 光标在第 1 行（引用行内），> 标记半透明
    const decos = collectDecorations(view)
    // 三行引用各挂一个行装饰 lp-quote-line，正文行（第 5 行）不能挂
    const lines = decos.filter((d) => d.class === 'lp-quote-line')
    expect(lines.length).toBe(3)
    // 光标行外（乙/丙）的 > 隐藏
    const hiddenQuoteMarks = decos.filter(
      (d) => d.class === 'lp-hide' && doc.slice(d.from, d.to) === '>',
    )
    expect(hiddenQuoteMarks.length).toBe(2)
    view.destroy()
  })

  it('光标所在行（标题行）保持富文本——仍挂 lp-h1，# 前缀半透明（lp-faint）', () => {
    view = makeView(DOC, at(DOC, '# 标题一') + 1) // 光标在标题行内
    const decos = collectDecorations(view)
    // 标题文字保持大字号渲染
    expect(decos.find((d) => d.class === 'lp-h1')).toBeTruthy()
    // # 前缀不隐藏，而是半透明显示
    const faint = decos.find(
      (d) => d.class === 'lp-faint' && DOC.slice(d.from, d.to) === '#',
    )
    expect(faint).toBeTruthy()
    expect(
      decos.find((d) => d.class === 'lp-hide' && DOC.slice(d.from, d.to) === '#'),
    ).toBeUndefined()
  })

  it('光标移走后该行恢复富文本', () => {
    view = makeView(DOC, at(DOC, '标题一'))
    // 移到另一行
    view.dispatch({ selection: { anchor: at(DOC, '列表项') } })
    const decos = collectDecorations(view)
    expect(decos.find((d) => d.class === 'lp-h1')).toBeTruthy()
  })

  it('光标所在行的 ** / * 标记半透明显示而非隐藏（与 #、~~ 行为一致）', () => {
    const doc = '这是**粗体**和*斜体*。\n下一行\n'
    view = makeView(doc, doc.indexOf('粗体'))
    const decos = collectDecorations(view)
    // 标记半透明可见
    expect(decos.filter((d) => d.class === 'lp-faint' && doc.slice(d.from, d.to) === '**').length).toBe(2)
    expect(decos.filter((d) => d.class === 'lp-faint' && doc.slice(d.from, d.to) === '*').length).toBe(2)
    // 不能再同时挂 lp-hide（font-size:0 会把标记彻底藏掉，光标行应保持源码可见）
    expect(decos.find((d) => d.class === 'lp-hide' && doc.slice(d.from, d.to) === '**')).toBeUndefined()
    expect(decos.find((d) => d.class === 'lp-hide' && doc.slice(d.from, d.to) === '*')).toBeUndefined()
    // 富文本样式照常生效
    expect(decos.find((d) => d.class === 'lp-strong')).toBeTruthy()
    expect(decos.find((d) => d.class === 'lp-em')).toBeTruthy()
    view.destroy()
  })

  it('DOM 实际渲染：行内 mark decoration 元素被插入（widget 在 jsdom 中惰性，仅 mark 断言）', () => {
    view = makeView(DOC, at(DOC, '列表项'))
    const dom = view.dom
    // 行内 mark decoration 通过装饰插入 <span class="lp-...">；jsdom 里会同步渲染
    expect(dom.querySelector('.lp-h1')).toBeTruthy()
    expect(dom.querySelector('.lp-hide')).toBeTruthy()
    expect(dom.querySelector('.lp-strong')).toBeTruthy()
    expect(dom.querySelector('.lp-em')).toBeTruthy()
    expect(dom.querySelector('.lp-code')).toBeTruthy()
    expect(dom.querySelector('.lp-quote-line')).toBeTruthy()
    // widget（BulletWidget）由 CM6 可见性引擎惰性构造，jsdom 不算可见性
    // 跳过；逻辑侧已在"列表符号被 BulletWidget 替换"中验证
  })
})

// ── 块级渲染：代码块卡片 / 公式 / 表格 / SVG ─────────────────

import { GFM } from '@lezer/markdown'

const DOC2 = `# 标题

公式 $E=mc^2$ 行内。

| 列A | 列B |
| --- | :---: |
| 1 | 2 |

\`\`\`ts
const x = 1
\`\`\`

$$
\\int_0^1 x\\,dx
$$

<svg width="20" height="20">
  <circle cx="10" cy="10" r="8" fill="pink"/>
  <script>alert(1)</script>
</svg>
`

function makeView2(doc: string, cursorAt = 0): EditorView {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursorAt },
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [GFM, Highlight] }),
        livePreview,
        livePreviewBlocks,
      ],
    }),
    parent: host,
  })
  return view
}

type Deco = { from: number; to: number; class?: string; widgetName?: string }

/** 收集 StateField（块级装饰）里的所有项 */
function collectFieldDecorations(view: EditorView): Deco[] {
  const set = view.state.field(livePreviewBlocksField)
  const items: Deco[] = []
  set.between(0, view.state.doc.length, (from, to, value) => {
    const spec = (value as unknown as { spec: Record<string, unknown> }).spec ?? {}
    const cls = typeof spec.class === 'string' ? spec.class : undefined
    const widget =
      spec.widget && typeof spec.widget === 'object'
        ? (spec.widget as { constructor: { name: string } }).constructor.name
        : undefined
    items.push({ from, to, class: cls, widgetName: widget })
  })
  return items
}

describe('livePreview 块级渲染', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('代码块：逐行挂卡片行类，围栏行替换为语言标签', () => {
    const view = makeView2(DOC2, 0) // 光标在文档头，远离代码块
    const decos = collectDecorations(view)
    // 行装饰（lp-codeblock*）至少 3 行：```ts / 代码 / ```
    const lines = decos.filter((d) => d.class?.startsWith('lp-codeblock'))
    expect(lines.length).toBe(3)
    expect(lines[0].class).toContain('lp-codeblock-first')
    expect(lines[2].class).toContain('lp-codeblock-last')
    // 围栏行 → FenceChipWidget（```ts → ts 标签，``` → 薄占位）
    const chips = decos.filter((d) => d.widgetName === 'FenceChipWidget')
    expect(chips.length).toBe(2)
    view.destroy()
  })

  it('行内公式：光标不在时渲染 KaTeX widget，光标行保持源码', () => {
    // 光标远离公式行
    let view = makeView2(DOC2, 0)
    expect(
      collectDecorations(view).some((d) => d.widgetName === 'MathInlineWidget'),
    ).toBe(true)
    view.destroy()
    // 光标放进公式行 → 源码态
    view = makeView2(DOC2, DOC2.indexOf('E=mc'))
    expect(
      collectDecorations(view).some((d) => d.widgetName === 'MathInlineWidget'),
    ).toBe(false)
    view.destroy()
  })

  it('行内 HTML span：内容挂白名单内联样式，标签隐藏，危险样式被剔除', () => {
    const doc = '前 <span style="color:#ff69b4;font-weight:700">粉字</span> 后\n' +
      '坏 <span style="color:red;background:url(evil)">x</span> 结束\n'
    const view = makeView2(doc, doc.length) // 光标在文档末尾空行，远离两个 span
    const decos = collectDecorations(view)
    // 两个开标签、两个闭标签全部隐藏
    const hidden = decos.filter(
      (d) => d.class === 'lp-hide' && /^<\/?span/.test(doc.slice(d.from, d.to)),
    )
    expect(hidden.length).toBe(4)
    // 第一个 span：内容（粉字）挂白名单样式，color + font-weight 都保留
    const good = decos.find((d) => doc.slice(d.from, d.to) === '粉字')
    expect(good?.style).toBe('color: #ff69b4; font-weight: 700')
    // 第二个 span：background:url 被剔除，只剩 color: red
    const bad = decos.find((d) => doc.slice(d.from, d.to) === 'x')
    expect(bad?.style).toBe('color: red')
    view.destroy()
  })

  it('块级公式：整块替换为 KaTeX 显示块，光标进入时保持源码', () => {
    let view = makeView2(DOC2, 0)
    const block = collectFieldDecorations(view).find(
      (d) => d.widgetName === 'MathBlockWidget',
    )
    expect(block).toBeTruthy()
    // 替换范围覆盖 $$ 到 $$（含两行）
    expect(DOC2.slice(block!.from, block!.to)).toContain('\\int_0^1')
    view.destroy()
    // 光标进入公式块 → 无替换装饰
    view = makeView2(DOC2, DOC2.indexOf('\\int'))
    expect(
      collectFieldDecorations(view).some((d) => d.widgetName === 'MathBlockWidget'),
    ).toBe(false)
    view.destroy()
  })

  it('表格：整块替换为真表格 widget，光标进入时保持源码', () => {
    let view = makeView2(DOC2, 0)
    const table = collectFieldDecorations(view).find((d) => d.widgetName === 'TableWidget')
    expect(table).toBeTruthy()
    expect(DOC2.slice(table!.from, table!.to)).toContain('列A')
    view.destroy()
    // 光标进表格 → 源码态
    view = makeView2(DOC2, DOC2.indexOf('列A'))
    expect(
      collectFieldDecorations(view).some((d) => d.widgetName === 'TableWidget'),
    ).toBe(false)
    view.destroy()
  })

  it('内嵌 SVG：HTML 块替换渲染，白名单外的 script 被剔除', () => {
    const view = makeView2(DOC2, 0)
    const svg = collectFieldDecorations(view).find((d) => d.widgetName === 'SvgWidget')
    expect(svg).toBeTruthy()
    // 清洗验证：直接调 widget 的 toDOM，断言 script 不在、circle 还在
    const set = view.state.field(livePreviewBlocksField)
    let dom: HTMLElement | null = null
    set.between(0, view.state.doc.length, (_f, _t, value) => {
      const spec = (value as unknown as { spec: { widget?: { constructor: { name: string }; toDOM: () => HTMLElement } } }).spec
      if (spec.widget?.constructor.name === 'SvgWidget') {
        dom = spec.widget.toDOM()
      }
    })
    expect(dom).toBeTruthy()
    expect(dom!.querySelector('script')).toBeNull()
    expect(dom!.querySelector('circle')).toBeTruthy()
    view.destroy()
  })
})

// ── 删除线（~~）与高亮（==）─────────────────────────────

describe('livePreview 删除线与高亮', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  const doc = '~~删除线~~ 和 ==高亮== 在这行\n光标在这行\n'

  it('非光标行：~~ 与 == 标记隐藏，内文挂 lp-strike / lp-highlight', () => {
    const view = makeView2(doc, doc.indexOf('光标'))
    const decos = collectDecorations(view)
    // 两对 ~~ 和两对 == 全部隐藏
    expect(decos.filter((d) => d.class === 'lp-hide' && doc.slice(d.from, d.to) === '~~').length).toBe(2)
    expect(decos.filter((d) => d.class === 'lp-hide' && doc.slice(d.from, d.to) === '==').length).toBe(2)
    // 样式覆盖含标记的完整节点
    const strike = decos.find((d) => d.class === 'lp-strike')
    expect(strike).toBeTruthy()
    expect(doc.slice(strike!.from, strike!.to)).toBe('~~删除线~~')
    const hl = decos.find((d) => d.class === 'lp-highlight')
    expect(hl).toBeTruthy()
    expect(doc.slice(hl!.from, hl!.to)).toBe('==高亮==')
    view.destroy()
  })

  it('光标所在行：标记半透明（lp-faint）而非隐藏，样式保留', () => {
    const view = makeView2(doc, doc.indexOf('删除线'))
    const decos = collectDecorations(view)
    expect(decos.filter((d) => d.class === 'lp-faint' && doc.slice(d.from, d.to) === '~~').length).toBe(2)
    expect(decos.filter((d) => d.class === 'lp-faint' && doc.slice(d.from, d.to) === '==').length).toBe(2)
    expect(decos.find((d) => d.class === 'lp-hide' && doc.slice(d.from, d.to) === '~~')).toBeUndefined()
    expect(decos.find((d) => d.class === 'lp-hide' && doc.slice(d.from, d.to) === '==')).toBeUndefined()
    // 富文本样式照常生效
    expect(decos.find((d) => d.class === 'lp-strike')).toBeTruthy()
    expect(decos.find((d) => d.class === 'lp-highlight')).toBeTruthy()
    view.destroy()
  })

  it('== 未配对或紧贴空白时当普通文本，不误渲染', () => {
    const doc = 'a == b 和单独 == 结尾\n光标在这行\n'
    const view = makeView2(doc, doc.indexOf('光标'))
    const decos = collectDecorations(view)
    expect(decos.find((d) => d.class === 'lp-highlight')).toBeUndefined()
    expect(decos.filter((d) => d.class === 'lp-hide' && doc.slice(d.from, d.to) === '==').length).toBe(0)
    view.destroy()
  })
})