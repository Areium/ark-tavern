# 战斗界面：交互、播放与资源

本页供前端开发者调整网格战斗的布局、操作、事件播放与资源回退。数值与结算规则见[战斗集成](combat-design.md)，内容字段见[战斗规格](battle-spec.md)。视觉示意不是可直接复制的完整实现，组件和样式源码是实际参数来源。

> 最近核对：2026-10-11（主线 `7344cea` 的 CombatView、网格、手牌、Pixi/Spine、播放投影、日志与配置的静态核对；未执行浏览器、Electron、真实模型或听感验收）。
> 早期视觉方案：2026-05-23，v2.0。保留必要的设计细节，旧 Phase 完成清单不作为当前验收结果。

项目只面向 PC：按[前端设计约定](../frontend-design-guidelines.md)的 1280×720、1400×900、1600×900、1920×1080、2560×1440 内容区与窗口/窗口全屏/全屏验证。无需新增手机适配。战斗页 `.bg-combat-bg` 保持独立配色，不随主页皮肤切换。

## 查询入口

| 调整任务 | 主要入口 |
|---|---|
| 操作、请求、战前/战后交接 | [CombatView](../../../frontend/src/components/combat/CombatView.tsx)、[战斗集成](combat-design.md) |
| 格子、透视、目标与拖动落点 | [CombatGrid](../../../frontend/src/components/combat/CombatGrid.tsx)、gridUtils、GridCell |
| 尺寸和 1–9/0 快捷键 | [combatConfig](../../../frontend/src/components/combat/combatConfig.ts) |
| 卡面、手牌与状态提示 | CombatCard、CombatHand、UnitStatusPanel、CombatUnitTooltip |
| 起手、命中、退场及状态投影 | [combatPresentation](../../../frontend/src/components/combat/combatPresentation.ts)、PixiCombatScene |
| Spine 归一、令牌回退与素材 | spineAnimSpecs、fallbackToken、Spine 资源接口 |
| 地图、节点与剧情图编辑 | BattleNodeForm、BattleMapCanvas、StoryBeatEditor、PlotGraphPage |

## 概述

CSS 3D 地面提供轻微俯视，PixiJS/Spine 覆盖层绘制角色，Canvas 粒子与数字反馈命中；无素材时显示职业令牌或其他回退，战斗逻辑不依赖美术加载。卡面优先用角色 skin/crop，缺图才用按伤害类型生成的渐变；没有 card_id hash 生成独立插图的保证。

操作栏显示回合、玩家/敌人阶段与共享 AP；个人 AP 用于移动。左右状态面板、中央战场、下方手牌和日志构成主要布局。界面显示意图而不改写后端行动判定；战前打法与战后结算通过会话接口交接。

## 一、网格/地图系统

### 1.1 透视与双模式尺寸

`perspective: 1000px`、`perspective-origin: 50% 45%` 和 `rotateX(33deg)` 提供轻微深度感；角色覆盖层必须使用网格测量所得中心点定位，不能假定地图恒为 7×7 或正方形。

| 配置 | fullscreen | windowed |
|---|---:|---:|
| 单元格边长 | 72px | 56px |
| 地图上边距 | 80px | 24px |
| 卡面 | 192×259px | 122×166px |
| 手牌扇形上边距 | −36px | −24px |
| 底栏上边距 | −72px | −48px |
| 敌人 Spine 相对比例 | 0.9 | 0.9 |

尺寸读取 `combatConfig.ts`；双模式不代替五组 PC 内容区验收。地图 rows/cols 由节点声明，上限 40×40、1200 格。空格显示 0 基真实行列坐标，随地图自适应。

### 1.2 地形、高亮与背景

移动高亮用蓝色边框，攻击目标用橙红，选中与拖动光标用金色；玩家与敌人部署区用不同边框色。旧方案的格子过渡为 200ms、选中脉冲为 1.5s，仅作视觉调参参考，不能据 CSS 高亮认定操作合法。

背景通过后端 URL 与会话/地点/节点选择，不只切换 CSS class。缺资源时用程序化渐变；旧“多地图背景未接入”的待办已过时。地形效果、阻挡与视线由后端执行，前端高亮用于反馈。

## 二、战斗小人系统

Spine 使用 runtime-3.8，动作名由 `spineAnimSpecs.ts` 归一；缺文件、缺动作或加载失败时使用带朝向的令牌回退。旧 CSS `ChibiSprite` 是早期占位方案，不能作为当前 Pixi 回退契约。

原设计资源建议为 PNG 序列帧或 Spine、128×128/256×256、idle/attack/hit/death；这是资产制作参考，不是导入 schema 或已提供 PNG 播放器的保证。方向编码为 0 上（row 减）、1 右（col 增）、2 下（row 增）、3 左（col 减）。角色起手、受击和死亡必须跟随事件播放，不能提前按终态把角色移除。

## 三、卡牌展示系统

卡面展示名称、费用、基础区间与倍率、目标形状、射程、职业/拥有者及快捷键；左侧职业色带 4px，elite 用金边。立绘资源缺失或错误时回退渐变，而不是阻断出牌。术法、物理、治疗和混合分别使用稳定伤害色。

手牌为扇形：`fanAngle=3.5°`、`fanY=8px`，每张相对中心偏移决定旋转与垂直位移。React key 为 `${card_id}-${owner || 'none'}`，打出后保留剩余节点，便于重排过渡。

旧调参参考：悬停上移 8px/scale 1.05，选中上移 14px，手牌容器悬停上移 16px/scale 1.08；不可用牌降低透明度与灰度并禁操作。实际动画值以当前样式为准，示意数值不是请求完成时长。

## 四、单位状态面板

左右分别显示玩家与敌方状态，顶部显示共享 AP；角色行含头像/职业、HP 数字与三级色条、个人 AP 点阵及选中反馈。HP 低值可提示危险，但减少动态效果设置应控制脉冲和位移。角色名与职业示例只解释布局，不表示默认安装特定角色。

## 五、战斗事件与特效

### 5.1 状态与事件播放契约

一次行动的反馈按“起手 → 命中/扣血 → 死亡退场 → 最终状态/结果”执行。HTTP 事件批次与 SSE 按事件 ID 去重；播放期间锁定后续战斗操作，离开页面取消等待。AOE 每次行动只起手一次。旧后端缺完整批次时仅能尽力播放，完整顺序依赖前后端共同支持。

异步 GET 在返回时检查状态版本、当前选中单位与播放状态，过期响应不能覆盖播放投影。最终快照在本批结束后校正 HP、状态、手牌与敌人意图；不按旧方案的 400/600/700ms 乐观时间线直接刷新。详细历史验收与限制见[第一轮表现报告](../../card-combat-presentation-qa.md)和[工程笔记](../../notes.md#62-状态事件与播放顺序)。

### 5.2 粒子、数字与日志

Canvas 2D 粒子分 spark/heal/death/victory，requestAnimationFrame 驱动并按存活时间衰减、清理，支持 devicePixelRatio。粒子层自身不需要 WebGL，但角色层使用 Pixi。旧视觉规格用于调参：spark 8–20 个/400–800ms，heal 6–10 个/600–1000ms，death 12–20 个/500–900ms，victory 30–50 个/800–1500ms。

伤害数字区分物理橙红、法术紫、治疗绿、混合色与暴击金；原方案普通 28px、暴击 38px、浮空 1s。血条带受伤拖尾，减少动态效果时缩短移动/退场。音效调用已接入，不能据代码声明主观听感通过。

日志显示最近 80 条，覆盖开始/回合、抽牌、出牌、移动、伤害、治疗、状态、净化、死亡、结束与错误。`block_attempt/block_success/block_fail/intercept_prompt` 的旧格式或显示分支不证明引擎已经提供挡刀/拦截机制。日志伤害不能用卡牌原始伤害总和冒充实际扣血，也不应直接展示原始事件 JSON。

### 5.3 结果与演出边界

VICTORY/DEFEAT overlay 用金/红与回合信息；旧进入过渡为 500ms。结果必须等待终局事件播放结束，胜利奖励由后端 DTO 提供。专属技能镜头、声音层次、Spine 命中帧与每种状态独立演出仍需逐项验证；通用起手时间不能保证所有动作准确同步。

## 六、整体布局与配色

旧视觉基线为深蓝黑 #0a0e17、面板 #111827、边框 #1e3a5f、分隔 #2a3a5e、玩家 #00b4d8、敌人 #e74c3c、金色 #f0c060、AP #00d4ff。职业色及伤害色在现有配置/样式维护，不复制一份生成样式。战斗页不跟随主页换肤，旧 `html.light` 全覆盖说明不适用于当前皮肤隔离。

字体设计使用 Orbitron（标题/数字）、Noto Sans SC（中文）、JetBrains Mono（数值/代码），保留后备字体；具体加载见前端样式。不要因字体声明存在就保证离线下载或所有机器渲染一致。

## 七、动画系统

CSS transition/keyframes 管理悬停、选择、血条和数字，Canvas 管粒子，Pixi/Spine 管角色。HTML5 Drag API 管鼠标拖牌；Framer Motion 仍只是旧方案预留，没有引入依赖。

旧视觉调参范围为 150/250/400ms（fast/normal/slow），卡牌打出约 0.45s、重排 0.3s、受击震动 0.3s、HP 过渡 400ms、低血闪烁 0.8s。它们不是后端时序保证；当前起手/命中/退场顺序以播放模块为准。

## 八、资源管线

角色 avatar/skin/card_face/Spine 与地图 backgrounds 从所属世界书和现有资源 API 解析。会话绑定及实际书籍路径决定归属，显示名不能代替目录 ID。素材未随代码分发时必须保留回退。

旧 `frontend/public/assets/combat/{chibis,cards,icons,backgrounds,avatars}` 树是静态资产规划，不表示当前角色资源都在该目录。图标遵循项目 SVG 约定；日志保留少量既有 Unicode 符号，不据此引入图标库。旧 PNG/序列帧播放器、Service Worker 缓存属于未承诺的扩展方向。

## 九、分阶段实施路线

早期 Phase 1–5（2026-05-23）记录了配色、透视、手牌、状态面板、粒子、拖动、提示与回写的实施过程；当前任务以组件能力与实际验收为准，不复制“全部完成”勾选清单。Spine、音效、卡面资源与背景加载现在均有代码入口；是否具备某本书的资源取决于安装内容。

后续调整应先覆盖五组 PC 内容区、焦点、错误、取消与减少动态效果，再做专属美术；手机/平板触屏不属于当前产品验收范围。

## 十、卡牌拖动交互

### 10.1 实现原理

HTML5 Drag and Drop API + React state 管理：

```tsx
// CombatCard.tsx — 拖动源
const handleDragStart = (e: React.DragEvent) => {
  if (!affordable) { e.preventDefault(); return; }
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", String(index));
  // 透明拖拽图片，不遮挡光标
  const img = new Image();
  img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  e.dataTransfer.setDragImage(img, 0, 0);
  onDragStart?.();
};

// CombatGrid.tsx — 放置目标
// 用每格预计算好的屏幕中心点做最近邻匹配，因此对非正方形地图同样成立
const findClosestByCenters = (clientX, clientY, centers, rows, cols) => {
  let best = null, bestDist = Infinity;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const pt = centers[r]?.[c];
      if (!pt) continue;
      const dx = clientX - pt.x, dy = clientY - pt.y;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) { bestDist = dist; best = [r, c]; }
    }
  }
  return best;   // 无可用格时返回 null
};

// CombatView.tsx — 拖放处理
handleCardDragStart → 设置 dragCardIndex + 进入 TARGETING 模式
handleGridDragMove  → 更新 dragCell 高亮
handleGridDrop      → 执行 play_card 动作（复用 TARGETING 点击逻辑）
handleCardDragEnd   → 清除拖拽状态
```

### 10.2 交互流程

1. 玩家按住可支付的卡牌开始拖动
2. 手牌保持原位，隐藏原生拖拽预览图
3. 鼠标移动到网格上时，对应格子高亮（金色光标）
4. 松开鼠标：执行卡牌打出动作，清除高亮
5. 拖到无效区域松开：取消拖动，清除状态

---

## 十一、单位悬浮提示框

### 11.1 CombatUnitTooltip

在 UnitStatusPanel 中悬停单位时，使用 `createPortal` 渲染到 body 的浮动提示框：

```
┌─────────────────────────────┐
│  阿米娅              [术师]  │  ← 名称 + 职业标签（team 色）
│  ─────────────────────────  │
│  属性                       │
│  物理强度  ████░░  8        │  ← 8 项属性，带进度条 + 数值
│  战场机动  ███░░░  6        │     颜色按值分级（>=8 黄, >=6 绿, >=4 蓝）
│  ...                        │
│  ─────────────────────────  │
│  战斗数值                   │
│  HP 154/198  物理攻击 28    │  ← 3 列网格排列
│  法术攻击 15  防御 12       │
│  法术抗性 5   速度 8        │
│  命中 7       闪避 3        │
│  AP 2/3                     │
│  ─────────────────────────  │
│  携带物品                   │
│  暂未携带物品               │  ← 预留
└─────────────────────────────┘
```

**定位**：智能避让视口边缘，优先显示在锚点右侧，空间不足时切换到左侧。

---

## 十二、战斗回写与会话覆盖

`combatComplete` 请求后端应用待结算、回写角色 HP/受伤/死亡、经验与掉落，成功后清理战斗并返回叙述动作。后端失败保留待结算以便重试；前端不能提前用动画结果发放奖励或删除记录。会话覆盖不改原书数据。

详细 DTO、幂等标记和属性成长见[战斗结算](combat-design.md#101-战斗结算流程combat_settlementpy)。临时返回使用挂起/恢复接口，不能当作 complete 或 abandon。

## 十三、战斗节点编辑器与剧情图 UI

战斗内容侧 UI（节点编辑 / 剧情图 / 会话战斗附加面板），均在 `frontend/src/components/combat/`：

- **BattleNodeForm.tsx**：单节点编辑表单（基本信息 / 地图绘制 / 敌人编成 / 难度奖励 / 校验），保存走 `_hash` 冲突检测
- **BattleMapCanvas.tsx**：节点内嵌地图绘制（`MapEditMode`：tile 刷子 + 玩家/敌方部署区，行列自由尺寸）
- **StoryBeatEditor.tsx**：剧情节拍编辑抽屉，直改 `data/worldbooks/books/<book_id>/plots/<plot_id>/index.md`（Markdown 手术 + `_hash` 保护）
- **nodeFactory.ts**：节点图唯一创建入口（手动 / 节拍引用 / LLM 生成共用 `createNodes` 契约）
- **PlotGraphPage.tsx** / **GraphCanvas.tsx** / **graphModel.ts**：剧情图整页（世界书 → 剧情二级选择）、自由平移缩放画布、图模型与撤销栈
- **CombatSettlement.tsx**：战斗结算面板（纯展示，渲染后端 `CombatSettlementDTO`）；**CombatQuestBar.tsx**：会话战斗顶部任务栏
- **AttackArrow.tsx** / **CardFlyOverlay.tsx**：攻击弧线指示 / 出牌飞向目标格动画；**CharacterIllustration.tsx**：角色立绘（缺图回退）
- **fallbackToken.ts** / **spineAnimSpecs.ts**：无 Spine 数据时的职业令牌回退 / Spine 动作名归一；**gridUtils.ts**：前端距离度量与格子几何

## 附录 A：技术栈推荐

当前采用 CSS、Canvas 2D、PixiJS 与 Spine runtime-3.8；音效由 audioManager 提供。没有额外动画框架或 Service Worker 缓存保证。

## 附录 B：样式变量定义（CSS custom properties）

旧方案使用 `--combat-*`、`--color-player/enemy/gold/ap`、`--hp-high/medium/low`、`--class-*`、`--dmg-*`、`--ease-combat`、`--duration-fast/normal/slow`、`--font-display/body/mono`、`--grid-perspective`、`--grid-rotate-x`、`--cell-size` 命名。配色与时长参考见上文；调参应修改现有配置/样式，不能直接粘贴旧 :root 定义覆盖生成区。

## 附录 C：实施记录

- 2026-05-23：v1.0 初始方案；同日 v2.0 记录基础视觉与交互实施。
- 2026-09-27：[第一轮表现验收](../../card-combat-presentation-qa.md)，保留当时提交、测试、浏览器与未覆盖边界。
- 2026-10-11：按主线静态核对更新播放、资源与 PC 范围；没有重跑实机或历史验收。
