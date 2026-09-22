/**
 * foldOnHeading 折叠箭头测试。
 *
 * 断言：
 * - 每个有下方内容的标题行首都渲染一个折叠箭头（lp-fold-arrow）
 * - 没有下方内容的标题不显示箭头
 * - 点击箭头后该范围进入折叠态（箭头翻转 lp-folded）
 */
import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'

import { foldOnHeading } from './foldOnHeading'

const DOC = `# 标题一

内容 A

## 标题二

内容 B

# 没内容的标题
# 紧跟的标题
`

function makeView(doc: string): { view: EditorView; host: HTMLElement } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        foldOnHeading,
      ],
    }),
    parent: host,
  })
  return { view, host }
}

describe('foldOnHeading', () => {
  it('有内容的标题渲染箭头，无内容的不渲染', () => {
    const { view, host } = makeView(DOC)
    // 标题一、标题二有内容；「没内容的标题」下一行紧跟标题 → 不渲染
    expect(host.querySelectorAll('.lp-fold-arrow').length).toBe(2)
    view.destroy()
  })

  it('点击箭头进入折叠态（lp-folded），再点展开', () => {
    const { view, host } = makeView(DOC)
    const arrow = host.querySelector<HTMLElement>('.lp-fold-arrow')!
    arrow.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    const folded = host.querySelector('.lp-fold-arrow.lp-folded')
    expect(folded).toBeTruthy()
    // 再点一次 → 展开
    host
      .querySelector<HTMLElement>('.lp-fold-arrow')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(host.querySelector('.lp-fold-arrow.lp-folded')).toBeNull()
    view.destroy()
  })
})
