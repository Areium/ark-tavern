import { useState } from "react";
import WorldBookConfigOverview from "../WorldBookConfigOverview";
import WorldBookEntryWorkbench from "../WorldBookEntryWorkbench";
import WorldBookScopeManager from "../../WorldBookScopeManager";
import type { WorldBookTabProps } from "./types";

/**
 * 工作台第 2 个页签：分类与载入（A-1 / R-5）。
 *
 * 三个子视图（配置概览 / 条目与角色 / 分类结构）**是页签内部状态**，不进全局 store
 * （R-4：`worldbookTab` 是唯一跨组件页签状态，只有 5 个值）。
 *
 * 本页签由原「世界书配置」页面的三视图迁入，去掉它自带的世界书选择下拉
 * ——所选书由工作台统一持有并通过 props 下发。
 */
type LoadView = "overview" | "entries" | "taxonomy";

const VIEWS: Array<{ id: LoadView; label: string; hint: string }> = [
  { id: "overview", label: "配置概览", hint: "基础设定、角色设定、关联补充与待处理，一眼看完并一次保存" },
  { id: "entries", label: "条目与角色", hint: "逐条决定怎么用：加入基础设定、角色入队时选用、同时选用、仅标记相关" },
  { id: "taxonomy", label: "分类结构", hint: "分类树与条目归属，配合批量起点、批量依赖与批量归属" },
];

export default function LoadTab({ ctx, onNotice, onReload }: WorldBookTabProps) {
  const [view, setView] = useState<LoadView>("overview");

  return <div className="wbg-load">
    <nav className="wbg-view-tabs" aria-label="分类与载入子视图">
      {VIEWS.map((item) => <button key={item.id} title={item.hint} aria-pressed={view === item.id}
        onClick={() => setView(item.id)}>{item.label}</button>)}
    </nav>
    {view === "overview" && <div className="wbg-page-content">
      <WorldBookConfigOverview {...ctx} />
    </div>}
    {view === "entries" && <div className="wbg-page-content">
      <WorldBookEntryWorkbench {...ctx} onNotice={onNotice} />
    </div>}
    {view === "taxonomy" && <div className="wbg-taxonomy-shell">
      {/* 换书时重建内部状态：分类草稿、批量选择与属性栏都不该跨书保留 */}
      <WorldBookScopeManager key={ctx.detail.id} {...ctx} view="taxonomy" onChanged={onReload} />
    </div>}
  </div>;
}
