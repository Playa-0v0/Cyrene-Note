/**
 * selectionMenu 命令层测试（菜单 DOM/剪贴板依赖浏览器环境，只测纯命令逻辑）。
 *
 * 命令通过菜单 UI 触发，但逻辑本身是对 EditorView 的纯 dispatch——
 * 这里直接从模块内部行为验证：通过模拟右键菜单太脆，改为导出命令表测。
 * 为此 selectionMenu.ts 导出了 commandsFor 供测试使用。
 */
import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

// 直接测菜单 sections 的 run 函数：构造 view → 调 run → 断言文档
import { applyColor, clearColor, menuSectionsForTest } from './selectionMenu'

function makeView(doc: string, selFrom: number, selTo?: number): EditorView {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: selFrom, head: selTo ?? selFrom },
    }),
    parent: host,
  })
  return view
}

/** 从菜单结构里找命令并执行 */
function runCmd(view: EditorView, sectionTitle: string, label: string) {
  const section = menuSectionsForTest().find((s) => s.title === sectionTitle)
  if (!section) throw new Error(`找不到分组：${sectionTitle}`)
  const item = section.items.find(
    (i) => i.kind === 'item' && i.label === label,
  )
  if (!item || item.kind !== 'item') throw new Error(`找不到命令：${label}`)
  void item.run(view)
}

describe('selectionMenu 命令', () => {
  it('加粗：选区包裹 **，再执行一次取消包裹', () => {
    // "一段" 是第 0-2 个字符（一个汉字算 1 个位置）
    const view = makeView('一段文字', 0, 2)
    runCmd(view, '文本格式', '加粗')
    expect(view.state.doc.toString()).toBe('**一段**文字')
    // 选中"一段"（现在带 **）再取消
    view.dispatch({ selection: { anchor: 0, head: 6 } })
    runCmd(view, '文本格式', '加粗')
    expect(view.state.doc.toString()).toBe('一段文字')
    view.destroy()
  })

  it('H2 标题：行首加 ## ，正文命令移除 #', () => {
    const view = makeView('标题行', 0)
    runCmd(view, '段落设置', 'H2 标题')
    expect(view.state.doc.toString()).toBe('## 标题行')
    runCmd(view, '段落设置', '正文')
    expect(view.state.doc.toString()).toBe('标题行')
    view.destroy()
  })

  it('无序列表：多行批量加 - ，再执行取消', () => {
    // '甲\n乙\n丙' 长度 5（含两个换行），全选 0-5
    const view = makeView('甲\n乙\n丙', 0, 5)
    runCmd(view, '段落设置', '无序列表')
    expect(view.state.doc.toString()).toBe('- 甲\n- 乙\n- 丙')
    // 全选再执行 → 全部去掉（toggle）
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
    runCmd(view, '段落设置', '无序列表')
    expect(view.state.doc.toString()).toBe('甲\n乙\n丙')
    view.destroy()
  })

  it('引用：行首加 > ，任务列表加 - [ ] ', () => {
    const view = makeView('文本', 0)
    runCmd(view, '段落设置', '引用')
    expect(view.state.doc.toString()).toBe('> 文本')
    runCmd(view, '段落设置', '任务列表')
    expect(view.state.doc.toString()).toBe('- [ ] 文本')
    view.destroy()
  })

  it('插入表格：光标在行中间时先换行再插入模板', () => {
    const view = makeView('前文', 2) // 光标在"前文"末尾（"文"后）
    runCmd(view, '插入', '表格')
    const doc = view.state.doc.toString()
    expect(doc).toContain('| 列1 | 列2 | 列3 |')
    expect(doc).toContain('| --- | --- | --- |')
    // 行中间插入：前文断行，模板独占后续行
    expect(doc.startsWith('前文\n')).toBe(true)
    view.destroy()
  })

  it('插入代码块/公式块/分隔线：模板落位', () => {
    const view = makeView('', 0)
    runCmd(view, '插入', '代码块')
    expect(view.state.doc.toString()).toContain('```ts')
    view.destroy()
    const view2 = makeView('', 0)
    runCmd(view2, '插入', '公式块')
    expect(view2.state.doc.toString()).toContain('$$')
    view2.destroy()
    const view3 = makeView('', 0)
    runCmd(view3, '插入', '分隔线')
    expect(view3.state.doc.toString()).toContain('---')
    view3.destroy()
  })
})

describe('文字颜色命令', () => {
  it('应用颜色：未包裹的选区包上 span（livePreview 可渲染的格式）', () => {
    const view = makeView('一段文字', 0, 2)
    applyColor(view, '#ff69b4')
    expect(view.state.doc.toString()).toBe('<span style="color: #ff69b4">一段</span>文字')
    view.destroy()
  })

  it('同色再应用 → 去掉包裹（toggle，与加粗等一致）', () => {
    const doc = '<span style="color: #ff69b4">一段</span>文字'
    const view = makeView(doc, 0, doc.length - 2)
    applyColor(view, '#ff69b4')
    expect(view.state.doc.toString()).toBe('一段文字')
    view.destroy()
  })

  it('异色再应用 → 只换 color 值，其余样式属性保留', () => {
    const doc = '<span style="color: #ff69b4; font-weight: 700">一段</span>文字'
    const view = makeView(doc, 0, doc.length - 2)
    applyColor(view, '#3e63dd')
    expect(view.state.doc.toString()).toBe('<span style="color: #3e63dd; font-weight: 700">一段</span>文字')
    view.destroy()
  })

  it('清除颜色：只去 color 属性，font-weight 保留', () => {
    const doc = '<span style="color: #ff69b4; font-weight: 700">一段</span>文字'
    const view = makeView(doc, 0, doc.length - 2)
    runCmd(view, '文字颜色', '清除颜色')
    expect(view.state.doc.toString()).toBe('<span style="font-weight: 700">一段</span>文字')
    view.destroy()
  })

  it('清除颜色：style 只剩 color 时整个 span 去掉', () => {
    const doc = '<span style="color: #ff69b4">一段</span>文字'
    const view = makeView(doc, 0, doc.length - 2)
    clearColor(view)
    expect(view.state.doc.toString()).toBe('一段文字')
    view.destroy()
  })

  it('清除颜色：选区不是完整 span 时不动文档', () => {
    const view = makeView('一段文字', 0, 2)
    expect(clearColor(view)).toBe(false)
    expect(view.state.doc.toString()).toBe('一段文字')
    view.destroy()
  })
})
