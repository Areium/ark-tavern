import ConfirmDialog from "../common/ConfirmDialog";

interface Props {
  kind: "book" | "entry";
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function DeleteConfirmDialog({ kind, name, onCancel, onConfirm }: Props) {
  const isBook = kind === "book";
  return <ConfirmDialog title={isBook ? "删除世界书" : "删除条目"}
    confirmLabel={isBook ? "删除世界书" : "删除条目"} onCancel={onCancel} onConfirm={onConfirm}>
      {isBook ? <>确定删除《<strong>{name}</strong>》吗？书内条目、此书导入时创建的私有角色资料和图片会一并删除。仍被其他世界书或会话使用的角色会阻止删除。</>
        : <>确定删除条目「<strong>{name}</strong>」吗？</>}
  </ConfirmDialog>;
}
