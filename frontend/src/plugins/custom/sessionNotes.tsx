/**
 * 示例插件：会话笔记 —— 演示第三方场景面板如何通过 `ctx.data` 读写本会话的数据。
 *
 * 放在 `plugins/custom/` 下的文件由 `plugins/index.ts` 自动加载；照着这个文件写你自己的面板即可。
 * 数据存在会话覆盖层的 `plugin_data.session-notes`，随剧情树节点快照回档、随存档导出。
 */
import { useEffect, useRef, useState } from "react";
import { registerScenePanel, type ScenePanelProps } from "../scenePanels";

const NAMESPACE = "session-notes";

function SessionNotesPanel({ ctx }: ScenePanelProps) {
  const [text, setText] = useState("");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    ctx.data.get(NAMESPACE).then((slot) => {
      if (cancelled) return;
      setText(typeof slot.data.text === "string" ? slot.data.text : "");
      setSavedAt(slot.updated_at);
      loadedFor.current = ctx.sessionId;
    }).catch(() => { if (!cancelled) setStatus("error"); });
    return () => { cancelled = true; };
  }, [ctx.sessionId]);

  const save = (next: string) => {
    setText(next);
    setStatus("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const slot = await ctx.data.set(NAMESPACE, { text: next });
        setSavedAt(slot.updated_at);
        setStatus("saved");
      } catch {
        setStatus("error");
      }
    }, 600);
  };

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-gray-500 leading-relaxed">
        写给自己的备忘：线索、约定、还没兑现的伏笔。只属于本会话，回档到旧节点时会一起回到那时的内容。
      </p>
      <textarea
        className="input text-xs min-h-[160px] resize-y leading-relaxed"
        value={text}
        placeholder="例如：答应过瑕光去看比赛；临光的剑还没修好……"
        onChange={(e) => save(e.target.value)}
      />
      <div className="flex items-center justify-between text-[10px] text-gray-500">
        <span>
          {status === "saving" ? "保存中…" : status === "error" ? "保存失败" : savedAt ? `已保存 ${new Date(savedAt * 1000).toLocaleTimeString()}` : "尚未保存"}
        </span>
        {text && (
          <button
            type="button"
            className="hover:text-red-300 transition-colors"
            onClick={async () => { await ctx.data.remove(NAMESPACE); setText(""); setSavedAt(null); setStatus("idle"); }}
          >
            清空
          </button>
        )}
      </div>
    </div>
  );
}

registerScenePanel({
  id: "session-notes",
  title: "笔记",
  icon: "file",
  order: 110,
  hint: "会话笔记（示例插件：演示 ctx.data 读写）",
  component: SessionNotesPanel,
});
