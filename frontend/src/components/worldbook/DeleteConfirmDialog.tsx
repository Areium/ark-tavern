import { useEffect, useRef } from "react";
import AppIcon from "../AppIcon";
import "../../styles/worldbook-delete-dialog.css";

interface Props {
  kind: "book" | "entry";
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function DeleteConfirmDialog({ kind, name, onCancel, onConfirm }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    cancelRef.current?.focus();
    return () => {
      dialog?.close();
      previousFocus?.focus();
    };
  }, []);

  const isBook = kind === "book";
  return <dialog ref={dialogRef} className="wber-delete-dialog" aria-labelledby="wber-delete-title"
    aria-describedby="wber-delete-description"
    onCancel={(event) => { event.preventDefault(); onCancel(); }}>
    <div className="wber-delete-icon" aria-hidden="true"><AppIcon name="trash" size={19} /></div>
    <h2 id="wber-delete-title">{isBook ? "删除世界书" : "删除条目"}</h2>
    <p id="wber-delete-description">
      {isBook ? <>确定删除《<strong>{name}</strong>》吗？书内条目、此书导入时创建的私有角色资料和图片会一并删除。仍被其他世界书或会话使用的角色会阻止删除。</>
        : <>确定删除条目「<strong>{name}</strong>」吗？</>}
    </p>
    <div className="wber-dialog-actions">
      <button ref={cancelRef} type="button" className="is-ghost" onClick={onCancel}>取消</button>
      <button type="button" className="is-danger wber-delete-confirm" onClick={onConfirm}>
        {isBook ? "删除世界书" : "删除条目"}
      </button>
    </div>
  </dialog>;
}
