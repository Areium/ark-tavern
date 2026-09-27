# 世界书内容目录

`content/` 保存角色、剧情、规则和配套资源；`packs/` 保存可选的离线内容包。
`content_manifest.json` 记录仓库分发资源归属。内容包须显式安装；停用或删除后，
它独占的内容不再通过运行时目录和素材接口提供。分发源保留以供再次安装。
根目录的书 JSON、settings.json 和恢复备份是本地数据，不纳入 Git。
完整目录、管理边界及升级命令见 [data/README.md](../README.md)。
