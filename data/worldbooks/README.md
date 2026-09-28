# 世界书内容目录

`books/` 中每本已安装世界书对应一个 `<book_id>.json`；`content/` 保存角色、剧情、
战斗和配套资源；`packs/` 保存可选的离线内容包。
`content_manifest.json` 记录仓库分发资源归属。内容包须显式安装；停用或删除后，
它独占的内容不再通过运行时目录和素材接口提供。分发源保留以供再次安装。
`local_content_manifest.json` 记录从完整包导入的资源归属。

完整复制：工作台「导出完整包」生成 `.arkwb`，下载之外也保存在 `exports/`。
直接导入：把 `.arkwb` 或酒馆 `.json` / `.jsonl` 复制到 `inbox/` 后刷新书架；
文件会保留，处理记录防止重复导入。完整包会校验资源且不覆盖不同内容的同名文件。
符合当前 schema 的旧根目录书 JSON 仍可读，用 `scripts/migrate_worldbook_layout.py` 迁移到 `books/`；不兼容副本先在示例页备份并修复。
`books/`、`inbox/`、`exports/`、设置和恢复备份均是本地数据，不纳入 Git。
完整目录、管理边界及升级命令见 [data/README.md](../README.md)。
