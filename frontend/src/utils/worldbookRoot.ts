import type { WorldBookExpansion, WorldBookRootDTO } from "../types";

/** 更新起点展开方式，并只保留当前规则字段。 */
export const withManualExpansion = (
  root: WorldBookRootDTO,
  expansion: WorldBookExpansion,
): WorldBookRootDTO => {
  const next: WorldBookRootDTO = {
    entry_uid: root.entry_uid,
    activation: root.activation,
    expansion,
  };
  if (root.character_ids !== undefined) next.character_ids = [...root.character_ids];
  return next;
};
