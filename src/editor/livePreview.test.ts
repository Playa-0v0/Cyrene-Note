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

import { livePreview } from './livePreview'

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
  const items: { from: number; to: number; class?: string; widgetName?: string }[] = []
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
      items.push({ from, to, class: cls, widgetName: widget })
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

  it('引用块挂 lp-quote', () => {
    view = makeView(DOC, at(DOC, '标题二'))
    const decos = collectDecorations(view)
    expect(decos.find((d) => d.class === 'lp-quote')).toBeTruthy()
  })

  it('光标所在行（标题行）保持源码——不挂 lp-h1、# 前缀不隐藏', () => {
    view = makeView(DOC, at(DOC, '# 标题一') + 1) // 光标在标题行内
    const decos = collectDecorations(view)
    expect(decos.find((d) => d.class === 'lp-h1')).toBeUndefined()
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

  it('DOM 实际渲染：行内 mark decoration 元素被插入（widget 在 jsdom 中惰性，仅 mark 断言）', () => {
    view = makeView(DOC, at(DOC, '列表项'))
    const dom = view.dom
    // 行内 mark decoration 通过装饰插入 <span class="lp-...">；jsdom 里会同步渲染
    expect(dom.querySelector('.lp-h1')).toBeTruthy()
    expect(dom.querySelector('.lp-hide')).toBeTruthy()
    expect(dom.querySelector('.lp-strong')).toBeTruthy()
    expect(dom.querySelector('.lp-em')).toBeTruthy()
    expect(dom.querySelector('.lp-code')).toBeTruthy()
    expect(dom.querySelector('.lp-quote')).toBeTruthy()
    // widget（BulletWidget）由 CM6 可见性引擎惰性构造，jsdom 不算可见性
    // 跳过；逻辑侧已在"列表符号被 BulletWidget 替换"中验证
  })
})