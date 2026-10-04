// Self-contained ES module. No npm package, host imports, network or build step.
const ACTIONS = ["strike", "guard", "focus", "burst", "retreat"];

export function initial(input) {
  for (const role of ["player", "enemy"]) {
    const unit = input[role];
    if (!unit || typeof unit.name !== "string" || unit.name.length > 80
        || !Number.isInteger(unit.hp) || unit.hp < 1 || unit.hp > 9999) {
      throw new Error(`${role} 需要 name 和 1..9999 的整数 hp`);
    }
  }
  return { turn: 1, hp: input.player.hp, enemyHp: input.enemy.hp, focus: 0,
    outcome: null, log: ["对决开始：观察守卫的下一步意图。"] };
}

export function restore(input, saved) {
  const base = initial(input);
  if (saved === null) return base;
  if (!saved || !Number.isInteger(saved.turn) || saved.turn < 1 || saved.turn > 10000
      || !Number.isInteger(saved.hp) || saved.hp < 0 || saved.hp > input.player.hp
      || !Number.isInteger(saved.enemyHp) || saved.enemyHp < 0 || saved.enemyHp > input.enemy.hp
      || !Number.isInteger(saved.focus) || saved.focus < 0 || saved.focus > 4
      || ![null, "victory", "defeat", "retreat"].includes(saved.outcome)
      || !Array.isArray(saved.log) || saved.log.length > 8
      || saved.log.some(line => typeof line !== "string" || line.length > 200)
      || (saved.outcome === "victory" && saved.enemyHp !== 0)
      || (saved.outcome === "defeat" && saved.hp !== 0)
      || (saved.outcome === null && (saved.hp === 0 || saved.enemyHp === 0))) {
    throw new Error("演练快照格式不正确，不能恢复");
  }
  return structuredClone(saved);
}

export function intent(state) {
  return state.turn % 3 === 0 ? { damage: 24, label: "重击 · 24" }
    : state.turn % 3 === 2 ? { damage: 0, label: "蓄势 · 本回合不攻击" }
      : { damage: 12, label: "攻击 · 12" };
}

export function step(input, saved, action) {
  const state = restore(input, saved);
  if (state.outcome || !ACTIONS.includes(action)) throw new Error("当前不能执行此动作");
  if (action === "burst" && state.focus < 2) throw new Error("爆发需要 2 点专注");
  const enemy = intent(state);
  if (action === "retreat") {
    state.outcome = "retreat"; state.log.push("你退出了对决。");
  } else {
    if (action === "strike" || action === "burst") {
      const damage = action === "burst" ? 34 : 18;
      state.enemyHp = Math.max(0, state.enemyHp - damage);
      if (action === "burst") state.focus -= 2;
      state.log.push(`你造成了 ${damage} 点伤害。`);
    } else {
      state.focus = Math.min(4, state.focus + (action === "focus" ? 2 : 1));
      if (action === "focus") state.hp = Math.min(input.player.hp, state.hp + 5);
      state.log.push(action === "guard" ? "你摆出防御架势并获得 1 点专注。" : "你回复 5 点体力并获得 2 点专注。");
    }
    if (state.enemyHp === 0) state.outcome = "victory";
    else {
      const damage = action === "guard" ? Math.max(0, enemy.damage - 18) : enemy.damage;
      state.hp = Math.max(0, state.hp - damage);
      state.log.push(enemy.damage ? `守卫造成了 ${damage} 点伤害。` : "守卫正在蓄势。");
      if (state.hp === 0) state.outcome = "defeat";
    }
    state.turn++;
    // Bound even an intentionally endless sequence of recovery actions.
    if (state.turn >= 10000 && !state.outcome) state.outcome = "retreat";
  }
  state.log = state.log.slice(-8);
  return state;
}

export default async function mount(ctx) {
  let state = restore(ctx.input, ctx.snapshot);
  let busy = false;
  let error = "";
  const style = document.createElement("style");
  style.textContent = `body{margin:0;background:#101921;color:#e9e4d5;font:16px system-ui}
    .duel{max-width:850px;margin:auto;padding:32px}h1{color:#e6c585}p{line-height:1.6}
    .units{display:flex;gap:24px;margin:24px 0}.unit{flex:1;padding:20px;border:1px solid #607080;border-radius:10px}
    progress{width:100%;height:18px;accent-color:#cea961}button{background:#263440;color:#f0e5cb;border:1px solid #8d7951;
    padding:12px 18px;border-radius:6px;cursor:pointer;margin:4px}button:focus-visible{outline:3px solid #eac36e;outline-offset:3px}
    button:disabled{opacity:.45;cursor:wait}.log{color:#b8c5cb;min-height:160px}.error{color:#ffb7b7}`;
  ctx.root.append(style);
  const area = document.createElement("main"); area.className = "duel"; ctx.root.append(area);
  const add = (tag, text, parent = area) => {
    const element = document.createElement(tag); element.textContent = text; parent.append(element); return element;
  };
  const labels = { strike: "进攻 · 18", guard: "防御 · 减伤 18 / 专注 +1", focus: "蓄力 · 回复 5 / 专注 +2", burst: "爆发 · 34 / 专注 -2", retreat: "撤退" };
  async function act(action) {
    if (busy) return;
    busy = true; error = ""; render();
    try {
      const next = step(ctx.input, state, action);
      if (next.outcome) await ctx.complete(next.outcome, next);
      else await ctx.save(next);
      state = next;
    } catch (reason) { error = `保存或动作失败：${reason.message}。未推进到未确认的状态。`; }
    finally { busy = false; render(); }
  }
  function render() {
    area.replaceChildren();
    add("h1", "架势对决");
    add("p", `回合 ${state.turn} · 专注 ${state.focus}/4 · 下一步：${intent(state).label}`);
    const units = add("div", ""); units.className = "units";
    for (const [unit, hp] of [[ctx.input.player, state.hp], [ctx.input.enemy, state.enemyHp]]) {
      const card = add("section", "", units); card.className = "unit";
      add("h2", unit.name, card); add("p", `体力 ${hp} / ${unit.hp}`, card);
      const bar = add("progress", "", card); bar.max = unit.hp; bar.value = hp; bar.setAttribute("aria-label", `${unit.name}体力`);
    }
    const buttons = add("div", "");
    for (const action of ACTIONS) {
      const button = add("button", labels[action], buttons); button.type = "button";
      button.disabled = busy || !!state.outcome || (action === "burst" && state.focus < 2);
      button.onclick = () => void act(action);
    }
    if (error) { const alert = add("p", error); alert.className = "error"; alert.setAttribute("role", "alert"); }
    const log = add("div", ""); log.className = "log"; log.setAttribute("aria-live", "polite");
    state.log.forEach(line => add("p", line, log));
  }
  render();
  if (state.outcome) await ctx.complete(state.outcome, state);
}
