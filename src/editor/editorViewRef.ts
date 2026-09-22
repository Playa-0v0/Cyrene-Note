/**
 * editorViewRef —— Editor 实例的模块级引用。
 * tabsStore 切换标签前要"冲盘保存"当前缓冲，需要拿到 CM6 view；
 * 放在独立模块避免 docStore ↔ Editor 的循环依赖。
 */
import type { EditorView } from '@codemirror/view'

export const editorViewRef: { current: EditorView | null } = { current: null }
