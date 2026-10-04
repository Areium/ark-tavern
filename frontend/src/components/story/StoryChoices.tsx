import type { BranchChoice, ChatMessage } from "../../types";

export function latestStoryBranches(messages: ChatMessage[]): BranchChoice[] {
  return [...messages].reverse().find(message => message.branches?.length)?.branches ?? [];
}

/** 无结构化 ID 的同名选项不能绕过服务端声明的禁选分支。 */
export function resolveChoiceBranch(label: string, branches: BranchChoice[]): BranchChoice | undefined {
  const matching = branches.filter(branch => branch.label.trim() === label.trim());
  return matching.find(branch => branch.available === false) ?? matching[0];
}

export function BranchRuleSummary({ branch, historical = false }: { branch: BranchChoice; historical?: boolean }) {
  return <span className="block space-y-1 text-sm leading-relaxed font-normal">
    {branch.available === false && <span className="block">
      <strong>{historical ? "记录时不可选" : "不可选"}</strong>
      {branch.blocked_reasons?.length
        ? branch.blocked_reasons.map((reason, index) => <span className="block" key={index}>{reason}</span>)
        : <span className="block">当前条件未满足</span>}
    </span>}
    {branch.condition_summary?.map((line, index) => <span className="block" key={`condition-${index}`}>条件：{line}</span>)}
    {branch.effect_summary?.map((line, index) => <span className="block" key={`effect-${index}`}>效果：{line}</span>)}
  </span>;
}

export default function StoryChoices({ message, knownBranches = [], disabled, variant = "chat", onChoice }: {
  message: Pick<ChatMessage, "branches" | "choices">;
  knownBranches?: BranchChoice[];
  disabled: boolean;
  variant?: "chat" | "stage";
  onChoice: (label: string, branch?: BranchChoice) => void;
}) {
  const options = message.branches?.length
    ? message.branches.map(branch => ({ label: branch.label, branch }))
    : (message.choices ?? []).map(label => ({ label, branch: resolveChoiceBranch(label, knownBranches) }));
  return <>{options.map(({ label, branch }, index) => {
    const blocked = branch?.available === false;
    return <button type="button" key={`${branch?.id ?? label}-${index}`}
      className={`${variant === "stage" ? "stage-choice" : "chat-choice"} story-choice focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300`}
      disabled={disabled || blocked} onClick={() => { if (!disabled && !blocked) onChoice(label, branch); }}>
      <span className="story-choice-label">{label}</span>
      {blocked && <span className="story-choice-reason">
        {branch.blocked_reasons?.length ? branch.blocked_reasons.join("；") : "当前条件未满足"}
      </span>}
    </button>;
  })}</>;
}
