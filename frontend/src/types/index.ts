/** 后端状态 */
export interface BackendStatus {
  status: "connecting" | "connected" | "disconnected" | "error";
  url: string;
}

/** LLM 后端信息 */
export interface LLMEndpoint {
  id: string;
  name: string;
  type: "cloud" | "local";
  model: string;
  available: boolean;
  latency_ms: number;
  detail: string;
}

export interface LLMStatus {
  primary: LLMEndpoint | null;
  fallback: LLMEndpoint | null;
  endpoints: LLMEndpoint[];
  available: boolean;
}

/** 会话 */
export interface Session {
  id: string;
  name: string;
  mode: "free" | "story";
  player_identity?: string;
  plot_id: string | null;
  worldbook_id?: string | null;
  worldbook_ids?: string[];
  worldbook_scope?: WorldBookScopeDTO | null;
  worldbook_scopes?: Record<string, WorldBookScopeDTO | null>;
  created_at: number;
  usable: boolean;
  /** 场景角色（NPC 队友）。主控角色不在其中：它由 `player_identity` 声明 */
  characters: string[];
  /**
   * 会话阵容：主控角色在前 + 队友，已去重（后端 `SceneManager.get_roster()`）。
   * 阵容列表显示这一份，同一角色不会因「身份」与「入队」两条路径出现两次。
   */
  roster?: string[];
  character_colors: Record<string, string>;
  active_character: string | null;
  environment: {
    location: string;
    weather: string;
    time: string;
    atmosphere: string[];
  };
  scene_log: string[];
  narration_count?: number;
  total_usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  in_combat?: boolean;
  combat_mode: "narrative" | "tactical" | "sideview";
  sideview_status?: { operatorName: string; hp: number; maxHp: number; outcome: string; runId: string } | null;
  /** 是否存在可继续的战斗（内存中仍在，或磁盘上有挂起存档） */
  combat_resumable?: boolean;
  /** 挂起存档摘要（`in_combat` 为真时为 null，因为战斗未挂起） */
  combat_resume?: CombatResumeSummaryDTO | null;
  custom_prompt?: string;
}

/** 挂起战斗摘要 —— 「继续战斗」入口展示所需的最小信息 */
export interface CombatResumeSummaryDTO {
  engine?: "sideview";
  encounter_id: string;
  suspended_at: number | null;
  round_num: number;
  phase: string;
  battle_over: boolean;
  player_alive: number;
  hand_size: number;
  pending_waves: number;
}

/** 可恢复的会话战（`/api/combat/resumes`） */
export interface CombatResumeSessionDTO {
  session_id: string;
  name: string;
  mode: string;
  /** 战斗是否仍在后端内存中（false = 已挂起落盘，需走 resume 重建） */
  in_memory: boolean;
  combat: CombatResumeSummaryDTO | null;
}

/** 可恢复的战斗测试（无会话） */
export interface CombatResumeTestDTO extends CombatResumeSummaryDTO {
  test_id: string;
}

export interface CombatResumesDTO {
  sessions: CombatResumeSessionDTO[];
  tests: CombatResumeTestDTO[];
}

/** Electron API （通过 preload 暴露） */
export interface ElectronAPI {
  getBackendUrl: () => Promise<string>;
  openDirectory: (dirPath: string) => Promise<{ success: boolean; error: string }>;
}

/** 聊天消息 */
export interface ChatMessage {
  role: "user" | "assistant" | "character" | "system" | "narrator";
  content: string;
  character?: string;
  choices?: string[];
  /** 结构化分支选项（含目标节拍），与 choices 并存 */
  branches?: BranchChoice[];
  round?: number;
  variants?: string[];
  variantIndex?: number;
  dialogueSegments?: { type: string; text: string; speaker?: string }[];
  /** 是否为正在流式生成的叙述消息（气泡模式下流式期间先显示纯文本） */
  streaming?: boolean;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  reasoning?: string;
  rollData?: AttributeRollData;
}

/** 剧情分支选项（LLM 生成或作者预设） */
export interface BranchChoice {
  id: string;
  label: string;
  intent?: string | null;
  target_beat_id?: string | null;
  source?: "llm" | "author";
}

/** 剧情节点状态（路线图中的一个节拍） */
export interface StoryBeatNode {
  id: string;
  summary: string;
  keep_on_deviate?: boolean;
  state: "done" | "current" | "locked";
  round_start: number | null;
  round_end: number | null;
  has_combat?: boolean;
  authored_branches?: BranchChoice[];
}

/** 剧情章节（含节拍列表） */
export interface StoryRoad {
  chapter_idx: number;
  title: string;
  summary?: string;
  state: "done" | "current" | "locked";
  beats: StoryBeatNode[];
}

/** 剧情树节点（LLM 现场生成的场景节点；节点内容非作者节拍骨架） */
export interface StoryTreeNode {
  id: string;
  parent_id: string | null;
  depth: number;
  title: string;
  summary: string;
  intent?: string;
  branch_label?: string;
  /** 节点种类：plot 剧情节点（入口 / 章节切换 / 偏离分支线起点）、beat 节拍节点、combat 战斗节点 */
  kind?: "plot" | "beat" | "combat";
  /** 落盘时所处的参考章节 / 节拍（来自参考大纲或剧情文件骨架） */
  ref_chapter_id?: string;
  ref_beat_id?: string;
  /** kind === "combat" 时指向注册表里的战斗节点 */
  combat_node_id?: string;
  /** 偏离检测开出的分支线起点 */
  deviation?: { round: number; chapter_id: string } | null;
  children: string[];
  branches: (BranchChoice & { child_id?: string; taken?: boolean })[];
  round_start?: number | null;
  round_end?: number | null;
  has_state: boolean;
  state: "current" | "path" | "visited";
}

/** 剧情树视图（GET /story-state 的 tree 字段） */
export interface StoryTreeDTO {
  has_tree: boolean;
  root_id: string;
  current_id: string;
  path?: string[];
  nodes: StoryTreeNode[];
  current_node?: StoryTreeNode | null;
}

/** 剧情状态 DTO（GET /story-state） */
export interface StoryStateDTO {
  has_plot: boolean;
  plot_id?: string;
  plot_name?: string;
  chapter?: { idx: number; title: string; total: number; id: string } | null;
  beat?: {
    idx: number; total: number; id: string; summary: string; narrations_on_beat: number;
  } | null;
  roads: StoryRoad[];
  /** 动态剧情树（LLM 生成的节点结构） */
  tree?: StoryTreeDTO;
  /** 参考大纲（节点生成的参考条目）摘要；剧情文件自带骨架的会话为 null */
  outline?: {
    source: string; generated_at?: number | null; chapter_count: number;
    branch_chapters: { id: string; title: string; origin: Record<string, any> }[];
  } | null;
  /** 偏离检测状态：上次检测轮次 + 历史记录 */
  deviation?: {
    last_check_round: number;
    history: { round: number; deviated: boolean; confidence: number; reason: string; branch?: any }[];
  };
  completed_beats?: string[];
  pending_branch?: any;
  character_states?: Record<string, any>;
  quest_states?: Record<string, any>;
  node_history?: {
    node_id: string; title?: string; depth?: number;
    round_start: number | null; round_end: number | null;
  }[];
  combat_nodes?: Record<string, any>;
}

/** 属性检定结果 */
export interface AttributeRollData {
  attribute: string;
  character: string;
  roll: number;
  modifier: number;
  total: number;
  dc: number;
  success: boolean;
  text: string;
  source: string;
  stream_id: string;
}

/** 任务 */
export interface Quest {
  id: string;
  name: string;
  type: "main" | "side" | "deep";
  chapter: string;
  objective: string;
  trigger: string;
  completion: string;
  reward: string;
  failure: string;
  status: "hidden" | "locked" | "visible" | "active" | "completed" | "failed";
  updated_at: number;
  task_id?: string;
  subtype?: string;
}

/** 任务列表响应 */
export interface QuestsResponse {
  plot_id: string | null;
  quests: Quest[];
}

/** 可用剧情 */
export interface PlotInfo {
  id: string;
  name: string;
  category: string;
  priority: number;
  initial_characters?: string[];
  /** 剧情绑定的世界书 id（frontmatter `worldbook_id`）；空串 = 未声明。选中剧情时自动绑定 */
  worldbook_id?: string;
  /** 剧情默认主控角色（frontmatter `player_identity`）；空串 = 未声明，回退开场角色首位 */
  player_identity?: string;
}

/** 战斗单位 */
export interface CombatUnitDTO {
  unit_id: string;
  name: string;
  team: "player" | "enemy";
  char_class: string;
  hp: number;
  max_hp: number;
  personal_ap: number;
  max_personal_ap: number;
  patk: number;
  matk: number;
  def: number;
  res: number;
  spd: number;
  hit: number;
  eva: number;
  mobility: number;
  pos: [number, number];
  is_alive: boolean;
  attributes?: Record<string, number>;
  /** 运行时状态效果：shield/slow/bind/weaken/strengthen */
  status?: Record<string, number>;
  skin_url: string;
  skin_crop: SkinCrop | null;
}

/** 卡面裁剪参数（百分比，0-100） */
export interface SkinCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 卡牌 */
export interface CardDTO {
  card_id: string;
  name: string;
  damage_type: "physical" | "arts" | "healing" | "mixed";
  min_damage: number;
  max_damage: number;
  atk_scale: number;
  target: string;
  range: number;
  cost: number;
  tier: "basic" | "elite";
  class_required: string;
  owner: string | null;
  description: string;
}

/** 战斗卡牌（扩展字段 — combat.json schema） */
export interface CombatCardDTO extends CardDTO {
  rarity: number;
  category: "exclusive" | "class";
  card_type: string[];
  cost_type: "sp" | "passive";
  base_value: number | null;
  base_value_formula: string | null;
  effect: string;
  check: {
    description?: string;
    roll?: string;
    vs?: string;
  } | null;
  plot_impact: string | null;
  usage_limit: { scope: string; count: number } | null;
  condition: string | null;
  tags: string[];
  _needs_review?: boolean;
  _review_reasons?: string[];
}

/** 角色卡牌集合（combat.json 结构） */
export interface CombatCardsDTO {
  version: number;
  exclusive_cards: CombatCardDTO[];
  class_cards: CombatCardDTO[];
  class_name: string | null;
  _hash: string;
}

/** 职业卡牌（cards.json 简化 schema） */
export interface ClassCardDTO {
  card_id: string;
  name: string;
  description: string;
  damage_type: string;
  min_damage: number;
  max_damage: number;
  atk_scale: number;
  target: string;
  range: number;
  cost: number;
  tier: string;
  class_required: string;
  owner: string | null;
}

/** 职业卡牌集合（cards.json 结构） */
export interface ClassCardsDTO {
  version: number;
  class_name: string;
  cards: ClassCardDTO[];
  _hash: string;
}

/** 卡牌管理导航树 */
export interface CardsTreeDTO {
  characters: string[];
  classes: string[];
  character_class_map: Record<string, string>;
  /** 来源世界书标注（读实体 index.md frontmatter，未标注为空串） */
  worldbook_map?: { characters: Record<string, string>; classes: Record<string, string> };
}

/** 角色卡池（手牌 + 抽牌堆 + 弃牌堆 + 消耗堆） */
export interface PlayerPoolDTO {
  deck: CardDTO[];
  hand: CardDTO[];
  discard: CardDTO[];
  exhaust: CardDTO[];
}

/** 敌人意图的单段动作（v1：精英/Boss 每轮可有多个动作） */
export interface EnemyIntentActionDTO {
  type: "attack" | "heavy" | "aoe" | "move" | "defend";
  label: string;
  card_id: string;
  card_name: string;
  target_id: string;
  target_name: string;
  damage_min: number | null;
  damage_max: number | null;
}

/** 敌人意图（ROUND_START 计算，供玩家读取敌方计划）
 *
 * v1（balance_version 1）起包含行动槽与多段动作计划：首段动作同时平铺在
 * 顶层字段（向后兼容旧组件），完整计划见 `actions`。
 */
export interface EnemyIntentDTO {
  type: "attack" | "heavy" | "aoe" | "move" | "defend";
  label: string;
  target_id: string;
  target_name: string;
  card_id: string;
  card_name: string;
  damage_min: number | null;
  damage_max: number | null;
  /** 该敌人每轮行动槽数（普通 1，精英/Boss 2） */
  action_slots?: number;
  /** 每轮计划：预告与执行使用同一计划 */
  actions?: EnemyIntentActionDTO[];
  /** 计划生成时的剩余 AP */
  ap?: number;
}

/** 战前打法（Approach）选项 */
export interface ApproachDTO {
  id: string;
  label: string;
  hint: string;
  kind: "combat" | "check" | "avoid";
}

/** 战前简报（含打法列表，SSE combat_briefing 事件） */
export interface CombatBriefingDTO {
  encounter_id: string;
  session_id: string;
  name: string;
  approaches: ApproachDTO[];
}

/** 战场格子类型（服务端 `combat_map.TileType` 的镜像） */
export interface TileTypeDTO {
  tile_id: string;
  name: string;
  glyph: string;
  color: string;
  blocks_movement: boolean;
  blocks_los: boolean;
  move_cost: number;
  defense_bonus: number;
  evasion_bonus: number;
  damage_bonus: number;
  deployable_player: boolean;
  deployable_enemy: boolean;
  on_enter: Record<string, number | string>;
  on_round_start: Record<string, number | string>;
  tags: string[];
}

/** 战斗状态快照 */
export interface CombatStateDTO {
  round_num: number;
  phase: string;
  winner: string | null;
  /** 战场行列（自由尺寸，非正方形） */
  rows: number;
  cols: number;
  /** 每格的 tile_id（tiles[row][col]） */
  tiles: string[][];
  /** 地图上用到的格子定义 */
  tile_defs: Record<string, TileTypeDTO>;
  /** 部署区（已展开为坐标列表） */
  deploy: { player: [number, number][]; enemy: [number, number][] };
  /** 地图校验警告（软锁/越界等，非阻断） */
  map_warnings: string[];
  /** 距离度量（默认 manhattan） */
  range_metric: "manhattan" | "chebyshev";
  /** 战斗背景图 URL（无图时为 null，前端回退纯色背景） */
  background_url?: string | null;
  units: CombatUnitDTO[];
  shared_hand: CardDTO[];
  player_hands: Record<string, CardDTO[]>;
  shared_pool: PlayerPoolDTO;
  shared_ap: number;
  shared_ap_max: number;
  /** 回合上限（0 = 无限制） */
  max_rounds: number;
  /** 是否允许撤退（fail-forward） */
  escape_enabled: boolean;
  valid_targets: [number, number][];
  valid_moves: [number, number][];
  /** valid_moves 对应的单位（未选择时为行动中的单位） */
  valid_moves_unit?: string | null;
  active_unit_id: string | null;
  grid: Record<string, string>;
  /** 敌人意图：unit_id → intent（玩家回合内读取敌方计划） */
  enemy_intents: Record<string, EnemyIntentDTO>;
  battle_over: boolean;
  inventory: { name: string; count: number }[];
}

/** 战斗 SSE 事件 */
export interface CombatEventDTO {
  type: "battle_start" | "round_start" | "turn_start" | "damage" | "heal"
    | "death" | "battle_end" | "move" | "card_played" | "turn_end"
    | "error" | "block_attempt" | "block_success" | "block_fail"
    | "intercept_prompt" | "meta" | "heartbeat" | "done"
    | "status" | "cleanse" | "wave_start" | "card_drawn" | "suspend";
  data: Record<string, any>;
}

// ── 战斗结算（胜负判定成立后自动进入） ──

/** 单次升级记录 */
export interface LevelUpDTO {
  level: number;
  attribute: string;
  value: number;
  delta: number;
}

/** 升级导致的属性变化 */
export interface AttributeChangeDTO {
  name: string;
  before: number;
  after: number;
  delta: number;
}

/** 单个参战角色的结算条目 */
export interface CharacterSettlementDTO {
  name: string;
  in_battle: boolean;
  alive: boolean;
  xp_gained: number;
  level_before: number;
  level_after: number;
  level_delta: number;
  xp_before: number;
  xp_after: number;
  /** 升级前等级升到下一级所需经验 */
  xp_needed_before: number;
  /** 结算后等级升到下一级所需经验 */
  xp_needed: number;
  level_ups: LevelUpDTO[];
  attribute_changes: AttributeChangeDTO[];
  /** 本次升级发放的属性点（批次 3 起；默认自动分配到最低属性） */
  attribute_points_gained?: number;
  attribute_points_allocated?: number;
  /** 关闭自动分配时累积的待分配属性点 */
  attribute_points_pending?: number;
  specialization_points_gained?: number;
  specialization_points_after?: number;
  /** 属性已满值 → 无法继续成长 */
  capped: boolean;
  cap_reason: string;
}

/** 结算奖励汇总 */
export interface SettlementRewardsDTO {
  xp_total: number;
  enemy_xp: number;
  items: { name: string; count: number }[];
  cards: CardDTO[];
  /** 遭遇声明但尚未接入的奖励字段（如 unlock） */
  unwired: string[];
  xp_formula: string;
}

/** 战斗结算 DTO（GET/POST /combat/settlement、SSE battle_end.data.settlement） */
export interface CombatSettlementDTO {
  engine?: "sideview";
  durationMs?: number;
  settlement_id: string;
  encounter_id: string;
  encounter_name: string;
  winner: string;
  rounds: number;
  reward_mult: number;
  victory: boolean;
  characters: CharacterSettlementDTO[];
  rewards: SettlementRewardsDTO;
  has_reward: boolean;
  /** 无经验无奖励时的明确提示文案 */
  empty_message: string | null;
  created_at: number;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

// ── 索引管理（基于 imports 的新系统） ──

export interface IndexDocSummary {
  path: string;
  id: string;
  name: string;
  imports: { path: string; name: string }[];
  imported_by: { path: string; name: string; category: string }[];
}

export interface IndexOverviewCategory {
  category: string;
  label: string;
  level: number;
  docs: IndexDocSummary[];
}

export interface IndexOverview {
  categories: IndexOverviewCategory[];
  hierarchy: { level: number; label: string; categories: string[] }[];
}

export interface SessionIndexConfig {
  mode: "all" | "whitelist";
  enabled_categories: string[];
  enabled_entities: Record<string, string[]>;
}

export interface BrokenImport {
  import_path: string;
  name: string;
  type?: "missing" | "broken";
}

export interface BrokenRefDoc {
  doc_path: string;
  doc_name: string;
  broken_imports: BrokenImport[];
}

export interface IndexVerifyResult {
  total_docs: number;
  total_imports: number;
  broken_refs: BrokenRefDoc[];
  mode?: string;
}

// ── 会话资源空间 ──

/** 会话资源条目（背景覆盖 / 角色形象覆盖） */
export interface SessionResourceDTO {
  type: "background" | "character_media";
  key: string;
  /** character_media 时存在：avatar | skin | card_face */
  media_type?: string;
  name: string;
  /** 会话覆盖图 URL（带 session_id，覆盖优先于全局） */
  url: string;
  /** 全局原图 URL（不带 session_id） */
  global_url: string | null;
  size: number;
  has_global: boolean;
}

/** 会话资源总览（GET /api/sessions/<id>/resources） */
export interface SessionResourcesDTO {
  session_id: string;
  backgrounds: SessionResourceDTO[];
  available_background_ids: string[];
  character_media: SessionResourceDTO[];
  scene_characters: string[];
  resources_dir: string;
  backgrounds_dir: string;
}

// ── 世界书（酒馆 Lorebook 兼容） ──

/** 世界书用途：story 剧情世界书（可绑定会话/设为默认/参与解析）；reference 资料库（只浏览、检索、摘录） */
export type WorldBookType = "story" | "reference";

/** 世界书摘要（列表项） */
export interface WorldBookSummary {
  id: string;
  name: string;
  description?: string;
  cover_image?: string;
  source_format: string;
  /** 来源：preinstalled（预装整合包）/ imported（用户导入）——统一管理，均可编辑 */
  source: "preinstalled" | "imported";
  /** 用途：剧情世界书 / 资料库。缺字段的旧数据按 story 读取 */
  book_type: WorldBookType;
  /** `book_type === "reference"` 的便捷标记 */
  is_reference?: boolean;
  /** 是否存在分发源（预装包可一键重装还原） */
  is_preinstalled: boolean;
  /** 书级启用开关，停用不参与解析 */
  enabled: boolean;
  budget_tokens: number;
  /**
   * 展示用 token 估算：只统计**启用的非系统条目**（停用条目与系统层条目都不注入）。
   * 界面上的 `bookEntryStats(detail.entries)` 给出同一口径的实时值。
   */
  estimated_tokens?: number;
  /** 会进候选的条目数 = 启用的非系统条目（`entry_count` 是含系统层的总数） */
  injectable_entry_count?: number;
  /** 已停用条目数 */
  disabled_entry_count?: number;
  /** 系统层条目数：节点图 / 节点绑定，永不注入也不计 token */
  system_entry_count?: number;
  edit_revision?: number;
  entry_count: number;
  /**
   * 书内角色花名册：**启用且非系统**条目上非空的 `character_id`（去重保序）。
   * 新建会话按它取「这本书的角色」做候选与自动选中 —— 角色卡 frontmatter 的
   * `worldbook_id` 可能仍记拆分前的来源书（如 `arknights`），不能当书内名单用。
   */
  character_ids?: string[];
  created_at: number;
  updated_at: number;
  is_default: boolean;
}

/** 世界书检索命中（GET /api/worldbook/search） */
export interface WorldBookSearchHit {
  book: WorldBookSummary;
  matches: WorldBookEntryDTO[];
  match_count: number;
}

/** 摘录来源追踪（从资料库/其它书摘录时保留的可追溯来源） */
export interface WorldBookExcerptSourceDTO {
  source_book_id: string;
  source_entry_uid: string;
  source_content_hash: string;
  source_book_name?: string;
  source_entry_name?: string;
  excerpted_at?: number;
}

/** 世界书条目（规范化格式） */
export interface WorldBookEntryDTO {
  uid: string;
  name: string;
  content: string;
  trigger_keys: string[];
  secondary_keys: string[];
  always_active: boolean;
  selective: boolean;
  enabled: boolean;
  position: number;
  depth: number;
  scan_depth: number;
  probability: number;
  group: string;
  group_weight: number;
  case_sensitive: boolean;
  match_whole_words: boolean;
  category_id?: string;
  character_id?: string;
  /** 摘录来源（仅摘录进来的条目有） */
  excerpt_source?: WorldBookExcerptSourceDTO;
  /** 酒馆原始字段（导出回灌用） */
  raw?: Record<string, any>;
}

/** 一条摘录请求：来源定位 + 可选编辑字段（省略即原文照搬） */
export interface WorldBookExcerptItemDTO {
  source_book_id: string;
  source_entry_uid: string;
  name?: string;
  content?: string;
  trigger_keys?: string[];
  secondary_keys?: string[];
  always_active?: boolean;
  position?: number;
  depth?: number;
  probability?: number;
  category_id?: string;
  character_id?: string;
  enabled?: boolean;
}

/** 摘录结果：创建条目 + 目标书新修订 */
export interface WorldBookExcerptResultDTO {
  entries: WorldBookEntryDTO[];
  target: WorldBookSummary;
  revision: number;
  warnings: string[];
}

/** 世界书详情（含条目） */
export interface WorldBookDetail extends WorldBookSummary {
  entries: WorldBookEntryDTO[];
  /** 条目管理视图的文件夹；触发互斥组另由条目 group 字段管理。 */
  entry_groups?: WorldBookEntryGroupDTO[];
  /** 条目 UID 到管理文件夹 ID 的映射；缺省条目显示在未分组。 */
  entry_group_map?: Record<string, string>;
  /** 顶层文件夹与未分组条目的共同排序；组内条目由 entry_order 排序。 */
  entry_layout?: WorldBookEntryLayoutItemDTO[];
  entry_order?: string[];
  has_explicit_entry_order?: boolean;
  schema_version?: number;
  scope_mode?: "legacy" | "selective";
  categories?: WorldBookCategoryDTO[];
  dependency_edges?: WorldBookDependencyEdgeDTO[];
  import_config?: WorldBookImportConfigDTO;
  /** v3：全书底层有向图的条件起点；null/缺省表示这本书仍是 v2 语义 */
  dependency_rules?: WorldBookRulesDTO | null;
  related_edges?: WorldBookDependencyEdgeDTO[];
  content_revision?: string;
  resolver_version?: number;
  policy_revisions?: WorldBookPolicyRevisionDTO[];
  /** AI 构建专属；字段保留停写不删，UI 不再展示 */
  evidence_issues?: WorldBookIssueDTO[];
  /** 统一数值字段：同一本书下的角色共用（角色页「数值」/ 场景面板「数值」按它渲染） */
  stat_fields?: StatFieldDTO[];
}

export interface WorldBookEntryGroupDTO {
  id: string;
  name: string;
}

export type WorldBookEntryLayoutItemDTO = { kind: "group"; id: string } | { kind: "entry"; uid: string };

export type WorldBookScopeType = "worldview" | "character" | "other";
export interface WorldBookCategoryDTO {
  id: string;
  parent_id: string | null;
  name: string;
  scope_type: WorldBookScopeType;
  sort_order: number;
}
export interface WorldBookDependencyEdgeDTO { from_uid: string; to_uid: string; }
export interface SessionWorldbookEntryOverridesDTO {
  session_id: string;
  book_id: string;
  book_name: string;
  scope_revision: number;
  overrides: Record<string, boolean>;
  entries: Array<{ uid: string; name: string; category_id: string; default_enabled: boolean; effective_enabled: boolean }>;
}
export interface SessionWorldbookDependenciesDTO {
  session_id: string;
  book_id: string;
  book_name: string;
  scope_revision: number;
  revision_hash: string;
  content_revision: string;
  inheritance: Record<string, any>;
  local_overrides: {
    requires_edges: WorldBookDependencyEdgeDTO[];
    related_edges: WorldBookDependencyEdgeDTO[];
    root_expansions?: Record<string, WorldBookExpansion>;
  };
  suppressed_edges: Array<WorldBookDependencyEdgeDTO & { relation: "requires" | "related" }>;
  effective_requires_edges: WorldBookDependencyEdgeDTO[];
  effective_related_edges: WorldBookDependencyEdgeDTO[];
  effective_rules: WorldBookRulesDTO;
  edge_origins: Record<string, "inherited" | "local">;
  conflicts: Array<WorldBookDependencyEdgeDTO & {
    inherited_relation: string; local_relation: string; resolution: string;
  }>;
  resolved_entry_uids: string[];
  selection_reasons: Record<string, string[]>;
  entries: Array<{ uid: string; name: string; selected: boolean; reasons: string[] }>;
}
export interface SessionInheritancePreviewDTO {
  expected_scope_revision: number;
  from_policy_revision: number;
  to_policy_revision: number;
  changes: Array<WorldBookDependencyEdgeDTO & { kind: "added" | "removed"; relation: string }>;
  rule_changes: Array<{ entry_uid: string; kind: "added" | "removed" | "changed"; before?: WorldBookRootDTO; after?: WorldBookRootDTO }>;
  scope_added: string[];
  scope_removed: string[];
  conflicts: SessionWorldbookDependenciesDTO["conflicts"];
  preview_hash: string;
}
export interface WorldBookImportConfigDTO {
  fixed_entry_uids: string[];
  dependency_sources: Array<{ entry_uid: string; max_depth: number }>;
  revision: number;
}

/** v3 起点激活方式：always 恒为候选 / roster_any 入队任一角色即候选 / manual 只手动追加 */
export type WorldBookActivation = "always" | "roster_any" | "manual";
/** v3 展开方式：none 只含自身 / requires_closure 完整必要闭包 / legacy_depth 旧深度语义 */
export type WorldBookExpansion = "none" | "requires_closure" | "legacy_depth";
export interface WorldBookRootDTO {
  entry_uid: string;
  activation: WorldBookActivation;
  expansion: WorldBookExpansion;
  character_ids?: string[];
  max_depth?: number;
  /** AI 构建专属；字段保留停写不删，UI 不再展示 */
  locked?: boolean;
  /** AI 构建专属；字段保留停写不删，UI 不再展示 */
  origin?: string;
  /** AI 构建专属；字段保留停写不删，UI 不再展示 */
  model?: string;
  /** AI 构建专属；字段保留停写不删，UI 不再展示 */
  prompt_version?: string;
  /** AI 构建专属；字段保留停写不删，UI 不再展示 */
  source_content_hash?: string;
  /** AI 构建专属；字段保留停写不删，UI 不再展示 */
  evidence?: string;
  /** AI 构建专属；字段保留停写不删，UI 不再展示 */
  review_status?: string;
  /** AI 构建专属；字段保留停写不删，UI 不再展示 */
  job_id?: string;
}
/** v3 规则集：分类只负责组织，起点与展开决定候选 */
export interface WorldBookRulesDTO {
  roots: WorldBookRootDTO[];
  root_rule?: { entry_uids: string[] };
  requires_edges?: WorldBookDependencyEdgeDTO[];
  related_edges?: WorldBookDependencyEdgeDTO[];
  /** AI 构建专属；字段保留停写不删，UI 不再展示（人工拒绝记录兼容透传） */
  rejected?: WorldBookDependencyEdgeDTO[];
  /** AI 构建专属；字段保留停写不删，UI 不再展示 */
  edge_meta?: Record<string, Record<string, string | boolean>>;
}
export interface WorldBookPolicyRevisionDTO {
  revision: number;
  resolver_version: number;
  created_at: number;
}
export interface WorldBookDisplayNodeDTO {
  uid: string;
  name: string;
  root_uid: string;
  depth: number;
  parent_uid: string | null;
  child_uids: string[];
  remaining: number | null;
  is_root: boolean;
  /**
   * 该 uid 在闭包内是否有**多于一次到达**（服务端读时派生）。
   *
   * 到达次数 = 被实际遍历的 `requires` 入边条数（`used_edges`）+ 它自己作为起点被激活的那一次。
   * `display_tree` 每个 uid 只有一行，所以这里**不是**「在 display_tree 里是否非首次出现」——
   * 那个字面读法恒为 false。
   *
   * ⚠ 不要把它当成「是否会出现重复行」的唯一依据：前端 `utils/worldbookDependencyTree.ts`
   * 另按「本次出现是否是该 uid 在当前树里的首个出现」标记重复行，两者只是**单向**关系——
   * `repeated === true` ⟹ 一定有第二次到达，但反向不成立（`repeated === false` 的 uid
   * 仍可能沿另一条路径再次出现）。主/次归属以 `first_parent_uid` 与
   * `resolved_edges[].status === "cross"` 为准。
   */
  repeated: boolean;
  /** 该 uid 的**主路径父**（即上方的 `parent_uid`；根为 `null`）。前端用它判断「哪一次到达是主到达」。 */
  first_parent_uid: string | null;
  /** 该 uid 在 `display_tree` 中的 0-based 位次（树按 `(depth, uid)` 稳定排序，位次因此也稳定） */
  display_index: number;
}
export interface WorldBookIssueDTO {
  code: string;
  severity: "error" | "warning" | "info";
  uid?: string;
  message: string;
}
/** 统一配置写入（PUT /api/worldbook/<id>/configuration）的请求体 */
export interface WorldBookConfigurationDraft {
  expected_revision?: number;
  /**
   * 显式启用 v3 按需载入规则。**只有用户明确选择时才传**：
   * v2 书的普通分类 / 角色编辑不能顺手把书切成按需载入（预装书 fixed/sources
   * 都是空的，一旦隐式启用候选会被清成空集）。服务端也只认这个显式开关。
   */
  adopt_v3?: boolean;
  categories?: WorldBookCategoryDTO[];
  entry_moves?: Record<string, string>;
  entry_updates?: Record<string, { category_id?: string; character_id?: string }>;
  scope_mode?: "legacy" | "selective";
  roots?: WorldBookRootDTO[];
  requires_edges?: WorldBookDependencyEdgeDTO[];
  related_edges?: WorldBookDependencyEdgeDTO[];
  /**
   * 人工拒绝记录：兼容透传字段（R-8）。AI 构建已删除，不再产生新值，
   * 但旧书已经写入的值照旧传回，避免旧数据在往返中被抹掉。
   */
  rejected?: WorldBookDependencyEdgeDTO[];
}
export interface WorldBookConfigurationResultDTO {
  book: WorldBookDetail;
  policy_revision: number;
  content_revision: string;
  applied: { categories: number; roots: number; requires_edges: number; related_edges: number };
}

export interface WorldBookScopeDTO {
  book_id: string | null;
  policy_revision?: number;
  roster_character_ids?: string[];
  resolved_entry_uids: string[];
  legacy_full_scope?: boolean;
  resolved_at?: number;
  selection_reasons?: Record<string, string[]>;
  excluded_entries?: Array<{ uid: string; name: string; reason: string }>;
}
export interface WorldBookPolicyDraft {
  fixed_entry_uids: string[];
  dependency_sources: WorldBookImportConfigDTO["dependency_sources"];
  dependency_edges: WorldBookDependencyEdgeDTO[];
  scope_mode: "legacy" | "selective";
  expected_revision?: number;
}
/** 自动分类：单个候选分类（含条目数） */
export interface WorldBookClassificationCategoryDTO extends WorldBookCategoryDTO {
  count: number;
}
/** 自动分类方案（POST /api/worldbook/<id>/auto-classify，apply=false 时只读） */
export interface WorldBookClassificationDTO {
  matched: number;
  unmatched_count: number;
  total: number;
  /** 结论采用了哪类线索 → 条目数（uid-prefix / group / name-suffix） */
  signals: Record<string, number>;
  categories: WorldBookClassificationCategoryDTO[];
  character_links: number;
  /** 未识别出类别的条目 UID（截断） */
  unmatched: string[];
  /** 各线索给出不同结论的条目 */
  conflicts: Array<{ uid: string; votes: Record<string, string> }>;
  unlinked_characters: string[];
  /** 将要写入的完整分类数组 */
  proposal: WorldBookCategoryDTO[];
  /**
   * 统一草稿补丁：分类 + 条目归属 + 角色关联。统一模式下「应用分类」把这份补丁
   * 并进草稿，与其它改动共用同一次保存，而不是绕过草稿直接写盘。
   */
  draft_patch?: {
    categories: WorldBookCategoryDTO[];
    entry_moves: Record<string, string>;
    entry_updates: Record<string, { category_id?: string; character_id?: string }>;
  } | null;
  apply: boolean;
  reason?: string;
}
export interface WorldBookClassificationAppliedDTO {
  classification: WorldBookClassificationDTO;
  book: WorldBookDetail;
}

export interface WorldBookScopePreviewDTO {
  scope: WorldBookScopeDTO;
  entry_count: number;
  full_entry_count: number;
  full_estimated_tokens: number;
  resolved_estimated_tokens: number;
  saved_estimated_tokens: number;
  saved_percent: number;
  breakdown: Record<string, { entry_count: number; estimated_tokens: number }>;
  source_expansions?: Array<{ entry_uid: string; name: string; max_depth: number; entries: Array<{ uid: string; name: string }> }>;
  warnings: string[];
  // ── v3 解释字段（未启用 v3 的书不返回）──
  schema_version?: number;
  resolver_version?: number;
  /** 本次会话是否显式选择「全量兼容」（只影响本会话） */
  full_scope?: boolean;
  active_roots?: WorldBookRootDTO[];
  resolved_edges?: WorldBookResolvedEdgeDTO[];
  selection_reasons?: Record<string, string[]>;
  display_tree?: WorldBookDisplayNodeDTO[];
  cross_references?: WorldBookDependencyEdgeDTO[];
  issues?: WorldBookIssueDTO[];
  /** 草稿指纹：创建会话时用它校验「预览与创建一致」 */
  draft_hash?: string;
  policy_revision?: number;
  content_revision?: string;
  manual_entry_uids?: string[];
  unselected_entries?: Array<{ uid: string; name: string; category_id: string }>;
  unselected_count?: number;
  entry_names?: Record<string, string>;
}

// ── 世界书工作台：Prompt 预览（A-2）与条目依赖树（A-3）─────────────────────────

export type WorldBookPreviewMode = "narrative" | "free";
export type WorldBookPromptLayer = "stable" | "dynamic";

export type WorldBookDropReason =
  | "not_in_scope" | "keyword_miss" | "secondary_miss" | "selective_reject"
  | "probability_miss" | "disabled" | "empty_content"
  | "budget_exceeded" | "node_binding_demoted";

export interface WorldBookPromptPreviewOrderDTO {
  uid: string;
  name: string;
  seq: number;
  layer: WorldBookPromptLayer;
  position: number;
  group_weight: number;
  depth: number;
  estimated_tokens: number;
  /** 全书预览时与本条目对应的实际注入文本（包含名称标题与宏替换）。 */
  text?: string;
  reasons: string[];
  matched_keys: string[];
  override_from_node?: { node_id?: string; position?: number; depth?: number; group_weight?: number } | null;
}

export interface WorldBookPromptPreviewSiteDTO {
  layer: WorldBookPromptLayer;
  host: "reference" | "world_book" | "system_parts";
  after_block: string;
  before_block: string;
  description: string;
}

export interface WorldBookPromptPreviewSkeletonDTO {
  id: string;
  label: string;
  is_worldbook: boolean;
  insert?: "before" | "after" | null;
}

export interface WorldBookPromptPreviewDroppedDTO {
  uid: string;
  name: string;
  reason: WorldBookDropReason;
}

export interface WorldBookPromptPreviewTotalsDTO {
  stable_tokens: number;
  dynamic_tokens: number;
  budget_tokens: number;
  truncated: boolean;
  candidate_count: number;
  matched_count: number;
}

export interface WorldBookPromptPreviewDTO {
  mode: WorldBookPreviewMode;
  order: WorldBookPromptPreviewOrderDTO[];
  stable_text: string;
  dynamic_text: string;
  sites: WorldBookPromptPreviewSiteDTO[];
  skeleton: WorldBookPromptPreviewSkeletonDTO[];
  dropped: WorldBookPromptPreviewDroppedDTO[];
  totals: WorldBookPromptPreviewTotalsDTO;
}

/** 节点作用域快照（形状同 overlay.get_active_lore_scope()）；见 contract R-18 */
export interface WorldBookNodeLoreScopeDTO {
  book_id?: string;
  node_id?: string;
  allowed: string[];
  pinned?: string[];
  overrides?: Record<string, { position?: number; depth?: number; group_weight?: number }>;
}

export interface WorldBookPromptPreviewRequest {
  /** 全书内容预览：启用条目按已触发展示，不受单轮筛选或预算截断。 */
  all_entries?: boolean;
  mode: WorldBookPreviewMode;
  input_text?: string;
  recent_text?: string;
  roster_character_ids?: string[];
  manual_entry_uids?: string[];
  full_scope?: boolean;
  identity?: string;
  active_char?: string | null;
  seed?: number;
  budget_tokens?: number;
  policy?: WorldBookConfigurationDraft;
  /** 可选：节点作用域快照（R-18）。提供时预览叠加该节点绑定；不提供时按纯书级预览。 */
  lore_scope?: WorldBookNodeLoreScopeDTO | null;
}

export type WorldBookEdgeStatus = "skeleton" | "cross" | "capped" | "idle";

export interface WorldBookResolvedEdgeDTO {
  from_uid: string;
  to_uid: string;
  relation: "requires" | "related";
  active: boolean;
  status: WorldBookEdgeStatus;
}

export interface WorldBookDependencyTreeNodeDTO {
  uid: string;
  name: string;
  parent_uid: string | null;
  child_uids: string[];
  depth: number;
  remaining: number | null;
  is_root: boolean;
  /** 到达该节点的边关系：根为 requires */
  relation: "requires" | "related";
}

export interface WorldBookDependencyTreeEdgeDTO {
  from_uid: string;
  to_uid: string;
  relation: "requires" | "related";
  status: WorldBookEdgeStatus;
}

export interface WorldBookDependencyTreeDTO {
  book_id: string;
  entry_uids: string[];
  nodes: WorldBookDependencyTreeNodeDTO[];
  edges: WorldBookDependencyTreeEdgeDTO[];
  /**
   * 依赖环清单（契约 R-26）：每个元素是**一条环**，环上节点按环序排列且**首尾同一 uid**，
   * 例如 `[["a","b","c","a"]]`；自环为 `["x","x"]`；无环为 `[]`。
   * 前端按相邻对推出环内边（供依赖展开树标红）。同一强连通分量只产出一条环。
   */
  cycles: string[][];
  issues: WorldBookIssueDTO[];
}

/** 导入报告 */
export interface WorldBookImportReport {
  source_format: string;
  imported: number;
  skipped: number;
  warnings: string[];
}

/** 导入结果 */
export interface WorldBookImportResult {
  book: WorldBookSummary | null;
  report: WorldBookImportReport;
  /** 角色卡导入时连带创建的角色（PNG/JSON 角色卡） */
  character?: { name: string; slug: string; path: string; source: string; has_avatar: boolean } | null;
}

/** 会话当前生效世界书查询结果 */
export interface WorldBookResolveResult {
  book: WorldBookSummary | null;
  books?: WorldBookSummary[];
  default_book_id: string | null;
}

// ── 战斗节点编辑器（batch 2）─────────────────────────────────────────────────

/** 节点里的一波敌人条目 */
export interface BattleWaveEntryDTO {
  enemy: string;
  count: number;
  /** 声明站位；缺失会自动落到部署区空格 */
  positions?: [number, number][];
  /** 逐实例数值覆盖（如 {hp: 150}） */
  stats?: Record<string, number>;
}

export interface BattleWaveDTO {
  enemies: BattleWaveEntryDTO[];
}

/** 地图部署区写法（rect 为 [r0,c0,r1,c1] 对角；cells 为显式坐标） */
export interface DeployZoneDTO {
  rect?: [number, number, number, number];
  cells?: [number, number][];
}

export interface BattleMapDTO {
  rows: number;
  cols: number;
  /** 二维 tile_id 数组，或整图统一填充的字符串简写 */
  tiles: string[][] | string;
  tile_defs?: Record<string, Partial<TileTypeDTO>>;
  deploy?: {
    player?: DeployZoneDTO;
    enemy?: DeployZoneDTO;
    enemy_random_shift?: boolean;
  };
}

/** 战斗节点 JSON（与后端 data/worldbooks/content/combat/nodes/<id>.json 一一对应） */
export interface BattleNodeDTO {
  schema_version?: number;
  node_id: string;
  name: string;
  summary?: string;
  description?: string;
  bind?: { plot_id?: string; chapter_id?: string; beat_id?: string };
  rules?: { range_metric?: "manhattan" | "chebyshev"; allow_corner_cut?: boolean };
  map: BattleMapDTO;
  waves: BattleWaveDTO[];
  enemies_def?: Record<string, any>;
  conditions?: { max_rounds?: number; escape_enabled?: boolean };
  rewards?: { xp?: number; items?: string[]; unlock?: string[] };
  difficulty?: {
    category?: string; encounter_type?: string; band?: string;
    threat_budget?: number; target_rounds?: number; difficulty?: number;
  };
  background?: string;
  balance_version?: number;
  source?: { type?: string; book_id?: string; entry_uid?: string };
  /** 归属世界书（节点图按书组织；世界书导入的节点自动标注） */
  worldbook_id?: string;
  _hash?: string;
  warnings?: string[];
}

/** 节点列表行（含剧情节拍绑定与会话进度） */
export interface BattleNodeOverviewDTO {
  node_id: string;
  name: string;
  summary: string;
  rows: number | null;
  cols: number | null;
  wave_count: number;
  unit_total: number;
  bind: { plot_id?: string; chapter_id?: string; beat_id?: string };
  markers: { plot_id: string; chapter_id?: string; beat_id?: string }[];
  progress?: {
    state: "done" | "current" | "locked";
    plot_id: string;
    chapter_idx: number;
    chapter_title?: string;
    beat_id: string;
    beat_summary?: string;
  } | null;
  source_worldbook?: string;
  /** 归属世界书 id（空串 = 未标注） */
  worldbook_id?: string;
  hash?: string;
  /** 剧情引用了但注册表里还没有配置 → 编辑器可一键创建 */
  missing?: boolean;
}

/** 节点图剧情节拍（来自 data/worldbooks/content/plots/<id>/index.md 的叙述区，或参考大纲） */
export interface PlotFlowBeatDTO {
  id: string;
  /** 大纲节拍的标题；正文 `#### beat_id` 骨架没有标题时为空串 */
  title: string;
  keep_on_deviate: boolean;
  summary: string;
  combat_nodes: string[];
}

/** 节点图剧情章节 */
export interface PlotFlowChapterDTO {
  idx: number;
  /** 章节 id：正文骨架 `ch_N`；大纲章节用大纲里的 id（act_1 / route_a / dev_1） */
  id: string;
  title: string;
  /** 展示标题：`章节 1：…` / `第一幕：…` / `路线 A：…` */
  label: string;
  /** main = 主线；branch = 续写路线 / 偏离分支（只有大纲章节会出现） */
  kind: "main" | "branch";
  combat_nodes: string[];
  beats: PlotFlowBeatDTO[];
}

/** 参考大纲生成结果（POST /api/worldbooks/<book>/story-outline）：节点图「LLM 分析剧情结构」用 */
export interface StoryOutlineGenerateDTO {
  book_id: string;
  plot_id: string;
  /** 已存书的大纲；`source` 为 llm 或 heuristic（LLM 解析失败回落时） */
  outline: { source: "llm" | "heuristic"; chapters: { id: string; kind?: string; beats: { id: string }[] }[] } & Record<string, unknown>;
  /** 生成过程：ok=false 时 error 说明 LLM 为何失败（结果已回落启发式，不是伪装成功） */
  generation: { ok: boolean; error: string | null } | null;
  /** 大纲里标了需要战斗的节拍现场生成的战斗节点 */
  combat_nodes: { beat_id: string; node_id: string | null; error?: string | null }[];
}

/** 节点图剧情流程（一个 plot = 一条横向分支） */
export interface PlotFlowDTO {
  plot_id: string;
  name: string;
  summary: string;
  worldbook_id: string;
  /** narrative = 正文 `## 章节 N` 骨架；outline = 护栏式剧情，章节来自参考大纲 */
  source: "narrative" | "outline";
  combat_nodes: string[];
  chapters: PlotFlowChapterDTO[];
}

/** 节点图数据（GET /api/combat/nodes/graph?book_id=） */
export interface CombatNodeGraphDTO {
  book_id: string;
  plots: PlotFlowDTO[];
  nodes: BattleNodeOverviewDTO[];
  meta: { plot: any; bindings: number; plot_count: number; node_count: number };
}

/** ── 剧情节点图（自由画布布局；保存为世界书条目 plot_graph_<plot_id>） ── */

export type PlotGraphNodeType = "plot" | "chapter" | "beat" | "combat" | "note";

/** 图节点：引用型节点（beat/combat）通过 ref 指向底层数据，note 承载自由文本 */
export interface PlotGraphNodeDTO {
  id: string;
  type: PlotGraphNodeType;
  title: string;
  content?: string;
  x: number;
  y: number;
  ref?: { chapter_idx?: number; beat_id?: string; node_id?: string } | null;
}

/** 有向连线（一个节点允许分出多条路线：from 可重复出现） */
export interface PlotGraphEdgeDTO {
  id: string;
  from: string;
  to: string;
}

/** 图文档（一剧情一张图，整图存入世界书条目） */
export interface PlotGraphDocDTO {
  schema_version: number;
  plot_id: string;
  title?: string;
  worldbook_id?: string;
  nodes: PlotGraphNodeDTO[];
  edges: PlotGraphEdgeDTO[];
  updated_at?: number;
}

/** 资产实体组（一个实体目录的图片集合；parent_dir = 上级目录，worldbook_id = 来源世界书） */
export interface AssetEntityGroupDTO {
  category: string;
  entity: string;
  entity_name: string;
  parent_dir: string;
  worldbook_id: string;
  images: {
    name: string;
    path: string;
    url: string;
    size: number;
    subdir: string;
    parent_dir?: string;
  }[];
}

/** 校验报告（只读，不阻断保存以外的行为） */
export interface ValidationReportDTO {
  errors: string[];
  warnings: string[];
}

/** 敌人图鉴条目 */
export interface EnemyCatalogEntryDTO {
  name: string;
  summary: string;
  race: string;
  faction: string;
  class: string;
  level: number;
  power_tier: string;
  role: string;
  action_slots: number;
  threat_points: number;
  ai_behavior: string;
  ai_skills: string[];
  drop_items: string[];
  drop_rate: number;
  xp_reward: number;
  derived_from_attributes: boolean;
  combat_stats: Record<string, number>;
}

// ── 角色数值（世界书统一字段 × 角色全局值 × 会话值，见 docs/design/session-scene-plugins.md） ──

export type StatFieldType = "number" | "text" | "bool" | "select";

/** 世界书上定义的一个统一数值字段 */
export interface StatFieldDTO {
  key: string;
  label: string;
  type: StatFieldType;
  min?: number;
  max?: number;
  step?: number;
  default?: number | string | boolean;
  /** select 类型的可选项 */
  options?: string[];
  group?: string;
  description?: string;
}

export type StatValue = number | string | boolean;
/** 某个键的当前值来自哪一层 */
export type StatSource = "default" | "global" | "session";

/** GET/PUT /api/characters/<name>/stats：角色全局数值 */
export interface CharacterStatsDTO {
  name: string;
  worldbook_id: string;
  worldbook_name: string;
  fields: StatFieldDTO[];
  values: Record<string, StatValue>;
  sources: Record<string, StatSource>;
  /** frontmatter `stats` 里实际存的值（不含字段默认） */
  stored: Record<string, StatValue>;
}

/** 会话内某角色的合并数值（默认 → 全局 → 会话） */
export interface SessionCharacterStatsDTO {
  name: string;
  is_player: boolean;
  worldbook_id: string;
  worldbook_name: string;
  fields: StatFieldDTO[];
  values: Record<string, StatValue>;
  sources: Record<string, StatSource>;
  /** 只在本会话写过的值 */
  session_values: Record<string, StatValue>;
}

export interface SessionCharacterStatsListDTO {
  session_id: string;
  characters: SessionCharacterStatsDTO[];
}

/** 插件命名空间数据（GET/PUT /api/sessions/<id>/plugin-data/<ns>） */
export interface PluginDataDTO {
  session_id: string;
  namespace: string;
  data: Record<string, unknown>;
  updated_at: number | null;
}

// ── 对话舞台（视觉小说视图，GET /api/sessions/<id>/stage） ──

export interface StageCharacterDTO {
  name: string;
  /** 立绘地址（会话覆盖优先）；没有立绘时为 null，前端退回头像牌 */
  skin_url: string | null;
  avatar_url: string | null;
  color: string | null;
  active: boolean;
}

export interface StageDTO {
  session_id: string;
  location: string;
  weather: string;
  time: string;
  atmosphere: string[];
  background: {
    url: string | null;
    source: "session" | "location" | "default" | "none";
    bg_id: string;
  };
  characters: StageCharacterDTO[];
  player: { name: string; skin_url: string | null; avatar_url: string | null; color: string | null };
}
