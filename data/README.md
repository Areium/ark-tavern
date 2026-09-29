# Data 目录

项目不内置或分发世界书内容。新检出的项目书架为空；每本书及其资源由用户保存在
`data/worldbooks/books/<book_id>/`，其中 `book.json` 保存书籍条目和设置，
`characters/`、`plots/`、`combat/`、`audio/` 等子目录按需保存该书自己的资源。

```text
data/
├── categories.yaml        类别注册表：逻辑类别 → 书内物理目录
├── tactical_practice/     显式网格演练示例；不安装到书架、不参与会话内容解析
├── sideview_levels/       横版演练示例
├── worldbooks/
│   └── books/             忽略的本地世界书数据；每本书一个文件夹
│       └── <book_id>/
│           ├── book.json
│           ├── characters/
│           ├── plots/
│           ├── combat/
│           └── audio/
├── memory/                运行时创建的会话、向量记忆、战斗恢复（本地数据）
└── archive/               按需创建的归档目录
```

## 世界书管理

- 应用内导入酒馆 `.json` / `.jsonl` 或含世界书的角色卡时，会自动创建 `books/<book_id>/`。
  酒馆文件通常只包含条目，不包含独立图片、音乐、剧情和战斗资源。
- 分享完整世界书时复制整个 `books/<book_id>/` 文件夹，再将其放入接收方的 `books/` 并刷新书架。
  文件夹名须与 `book.json` 内的 `id` 一致；刷新不会覆盖已有同 ID 的书。修改已安装文件后也要刷新书架。
- `categories.yaml` 定义书内类别目录的相对路径。会话按绑定书籍顺序查找资源，同名文件优先取顺序靠前的书。
- 旧版共享内容目录、内容包、散装书 JSON 和 `inbox/` 不属于当前导入或资源分发流程；整理旧本地数据前请先备份，并按完整书文件夹手动整理。
