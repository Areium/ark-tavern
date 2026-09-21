import type { WorldBookPanelProps } from "../panel";

/**
 * 工作台页签契约（冻结，见 `.tmp/wb-redesign/contract.md` §2.3）。
 *
 * 工作台把所有跨页签共享的状态一次性下发：同一份统一草稿、同一条预览与保存路径、
 * 同一个试选阵容。页签内部只改草稿，不直接写盘；需要 `useApi()` / `useAppStore()`
 * 时自己调用（例如 Prompt 预览写 `promptPreviewOrder`），不通过 ctx 传。
 */
export type WorldBookTabContext = WorldBookPanelProps;

export interface WorldBookTabProps {
  ctx: WorldBookTabContext;
  /** 顶部提示条（保存成功等） */
  onNotice: (text: string) => void;
  /** 外部数据已变更，需要重新拉取 detail */
  onReload: () => Promise<void>;
}
