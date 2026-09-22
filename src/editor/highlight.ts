/**
 * Highlight —— ==高亮== 语法扩展（Obsidian 风格，非 GFM 标准）。
 *
 * Lezer 的 GFM 只有删除线（~~）没有高亮，这里照官方 Strikethrough 的
 * 同款结构自己写一个：== 作分隔符，配对成功后内容包成 Highlight 节点，
 * == 本身成为 HighlightMark 节点。渲染端见 livePreview.ts 的 lp-highlight。
 */
import type { MarkdownConfig } from '@lezer/markdown'

/** == 分隔符：配对后内容包成 Highlight 节点，标记本身成为 HighlightMark */
const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' }

/** 标点符号集合：判断 == 是否紧贴标点（与官方 Strikethrough 的边界规则一致） */
const Punctuation = /[\p{S}|\p{P}]/u

export const Highlight: MarkdownConfig = {
  defineNodes: [{ name: 'Highlight' }, { name: 'HighlightMark' }],
  parseInline: [
    {
      name: 'Highlight',
      parse(cx, next, pos) {
        // 只认 ==；三个等号（===）不处理，避免与 setext 标题下划线混淆
        if (next !== 61 /* '=' */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) {
          return -1
        }
        const before = cx.slice(pos - 1, pos)
        const after = cx.slice(pos + 2, pos + 3)
        const sBefore = /\s|^$/.test(before)
        const sAfter = /\s|^$/.test(after)
        const pBefore = Punctuation.test(before)
        const pAfter = Punctuation.test(after)
        // 开/闭条件与 Strikethrough 相同：内侧不能是空白；
        // 紧贴标点时要求另一侧是空白或标点（否则当普通文本）
        return cx.addDelimiter(
          HighlightDelim,
          pos,
          pos + 2,
          !sAfter && (!pAfter || sBefore || pBefore),
          !sBefore && (!pBefore || sAfter || pAfter),
        )
      },
      after: 'Emphasis',
    },
  ],
}
