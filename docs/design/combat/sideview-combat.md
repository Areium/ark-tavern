# 横版实时动作关卡（第一阶段）

## 边界

会话创建时选择 `narrative`、`tactical` 或 `sideview`；模式创建后不可切换。剧情探索、战前简报、角色名册与世界书仍由原会话系统提供。`tactical` 继续使用 `CombatSession`、回合/卡牌/网格接口；`sideview` 使用独立运行记录和浏览器内的固定 60 Hz 模拟，不调用旧战斗的出牌或结束回合接口。

第一阶段提供一张可通关的“街区突破”关卡。其他遭遇暂回退到该关卡模板；剧情中的遭遇 ID 仍进入战斗历史。平台、障碍、危险区、敌人、出生点、出口和奖励由 `data/sideview_levels/default.json` 描述。反复往返的大地图与能力解锁开路不在本阶段。

## 交接契约

- 剧情战前简报选择打法后调用 `POST /api/sessions/<id>/sideview/start`，提交 `encounter_id`、可选的 `approach_id` 与 `operator_name`。返回 `kind: sideview` 和 `state`：`runId`、冻结的 `level`、主控战斗数值、援护者名称、初始快照及状态。避战与检定沿用现有 `approaches/check/avoid` 响应形状。`enemy_scale` 在横版中缩放敌人 HP/伤害，`first_strike` 提供开局先手优势，主控 `hp_penalty` 改变初始 HP。
- 前端 `features/sideview/` 独立执行输入、重力、平台/障碍碰撞、闪避、攻击、技能、敌人 AI、镜头与 PixiJS 7 绘制。固定步长为 1/60 秒；渲染帧与模拟步长分离。首版单人主控，队友通过援护技能参与。
- `POST /sideview/save` 存储版本化快照：主控与敌人位置/HP、冷却、累计时间及出口状态；`suspended: true` 表示保存并离开。`GET /sideview/state` 返回持久快照，恢复时再以 `suspended: false` 进入活动态。运行记录保存在该会话 `overrides.json.sideview_run`，后端重启后仍可读取。
- `POST /sideview/complete` 接收 `runId`、`levelId`、胜败、时长、击杀、受伤、剩余 HP 和终局快照。服务端以保存的关卡配置决定奖励，校验身份、边界、敌人集合、生命值单调性、出口与存活条件及保守可达时间。前端提交的奖励字段不起作用。`POST /sideview/abandon` 放弃本次行动，不发奖励。
- 结算以 `pending_settlement` 记录进度，角色成长、背包和战斗历史对同一 `runId` 只写一次；失败可重试。主控 HP、最大 HP 与胜负写到 `sideview_status`，下次关卡同角色继承 HP；战败为保证剧情继续，下一场按最大 HP 的 25% 复苏。完成后返回剧情自动叙述指令。

浏览器模拟意味着本地客户端拥有位置和命中状态。服务端能拒绝结构无效、即时或明显不可能的终局，无法证明玩家输入轨迹；若未来需要防恶意客户端刷奖励，应采用服务端复算或可信事件记录。本阶段的结算幂等约束针对同一运行记录，重新开始一局仍是新的战斗。

## 美术资源

横版场景使用为“废城边界 · 雨幕行动”生成的雨夜废城背景、石钢地表、运输障碍箱和红色晶体危险带。素材位于 `frontend/public/assets/sideview/`，由 PixiJS 直接加载；原第三方工业视差图层与金属图集已从项目移除。背景是通用街区突破场景的美术方向，不表示所有剧情遭遇都发生在同一地点。

玩家与守卫优先复用项目现有的 Spine 战斗小人及动画。Spine 文件位于 `data/worldbooks/content/characters/<角色>/spine/`，由现有资源接口提供；这些第三方角色素材被 `.gitignore` 排除，不随代码仓库分发。没有对应文件或加载失败时，横版关卡保留可识别的后备角色显示，碰撞与结算不依赖美术资源。
