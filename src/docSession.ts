/**
 * docSession —— 文档会话标识。
 *
 * 任何跨异步操作的保存/读取/冲突裁决，都必须绑定到具体的会话：
 * - sessionId 在 openDoc 时重新生成（每次切文档或重打开都是新会话）
 * - generation 是同一会话内的"代"——同一篇文档可能 open 多次（撤销、刷新冲突），
 *   每次进入保存路径都生成新 generation，避免旧 save 的结果污染新 revision
 * - revision 是会话内的缓冲版本（每次用户输入 ++）
 *
 * Invariant：
 * - save 回调只能读取自己捕获时的 sessionId+generation+content+baseHash+revision
 * - save 返回时校验：sessionId 仍是当前会话、generation 仍是当前 generation；
 *   否则视为过期，结果丢弃。
 * - clean = revision === savedRevision
 */
let SESSION_COUNTER = 0
let GEN_COUNTER = 0

export function newSessionId(): number {
  SESSION_COUNTER += 1
  return SESSION_COUNTER
}

export function newGeneration(): number {
  GEN_COUNTER += 1
  return GEN_COUNTER
}

/** 不可变保存上下文：定时器触发 / save 返回时拿这个对照当前状态。 */
export interface SaveSnapshot {
  sessionId: number
  generation: number
  path: string
  baseHash: string
  content: string
  revision: number
}

/** CM6 事务来源：决定 update listener 是否把它当用户编辑。 */
export const MutationOrigin = {
  /** 打开文档/openDoc 的全文替换 */
  Open: 'open' as const,
  /** watcher 外部变更热重载 */
  ExternalReload: 'external-reload' as const,
  /** 冲突解决后的程序替换 */
  ConflictResolution: 'conflict-resolution' as const,
}

export type MutationOriginKind = (typeof MutationOrigin)[keyof typeof MutationOrigin]