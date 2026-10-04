# 架势对决：独立战斗模式示例

本示例是新的脚本玩法，不是对现有战术网格/横版玩法的简化替换。它展示无 npm 依赖、无宿主重建的文件夹安装与保存/恢复。

## 安装与操作

将完整 `stance-duel` 文件夹复制到项目的 `data/combat_modes/` 中（不要覆盖已有同名包），在应用主页进入“战斗模式”，刷新后点击“演练”，确认信任后运行。

也可以先制作安装包，再通过应用上传或命令行安装：

```powershell
Compress-Archive -LiteralPath examples/combat-modes/stance-duel -DestinationPath stance-duel.zip
python tools/combat_mode.py install stance-duel.zip
```

安装前不会执行脚本。每次动作等待宿主确认保存后才推进；返回模式库保留上次成功保存点。“继续演练”使用原版本快照，即使原安装包已被停用、升级或卸载也不改变已保存玩法。多个标签同时写同一保存点时，后到的陈旧版本会被拒绝。

进攻造成 18 伤害；防御减少当回合 18 伤害并增加 1 专注；蓄力回复 5 体力并增加 2 专注；爆发消耗 2 专注造成 34 伤害。守卫按“12 伤害 → 蓄势 → 24 重击”循环行动。观察意图，在蓄势回合恢复、在重击前防御。撤退可随时结束。

```powershell
node --test examples/combat-modes/stance-duel/main.test.mjs
```

## 作者接口（ark-combat/1）

`manifest.json` 指定入口与输入契约，`practice.json` 是演练输入。入口是自包含 ES module，不依赖相对 import；资源由 manifest.resources 声明并作为 data URL 传入。

```js
export default async function mount(ctx) {
  // ctx.root: 本 iframe 的 DOM 容器
  // ctx.input: 已冻结的遭遇输入
  // ctx.snapshot: 最近一次保存的对象，首次启动为 null
  // ctx.resources: { "art/token.png": "data:image/png;base64,..." }
  // 修改本地状态后必须等待保存确认，不可将失败保存视为成功。
  await ctx.save({ turn: 1 });
  // 最终结果：victory / defeat / retreat；snapshot 必须是纯 JSON 对象。
  // await ctx.complete("victory", { turn: 3 });
}
```

控制消息不超过 1 MiB，快照须为有限深度、无循环引用/NaN/Infinity 的 JSON 对象。初始化可携带更大的、经包上限校验的资源。异常/超时会停止 iframe，保留最后成功保存点；不能靠心跳检测保证所有浏览器死循环都可被中断。

运行环境只允许 iframe 的脚本执行，不开放父 DOM、宿主 import 或服务端 Python。CSP 限制 fetch、表单、子框架、Worker 等能力。但这不是可运行恶意代码的强隔离容器：恶意页面自导航和资源耗尽并非完整解决。仅运行可信来源，不向插件传入密钥或其他不必要的数据。

演练结果是脚本自报、未经宿主验证，**不发放剧情经验和物品**。世界书适配和正式会话生命周期尚在主任务开发中，不能把这个演练示例当作已完成的正式剧情集成。
