# 世界书文件夹

每本已安装书放在 `books/<书 ID>/`，其中 `book.json` 保存世界书条目和设置，
`characters/`、`plots/`、`combat/`、`audio/` 等目录保存该书自己的资源。
复制整个文件夹即可带走书和资源；把完整文件夹复制到 `books/` 后刷新书架即可导入。
文件夹名须与 `book.json` 内的 `id` 一致，已有同 ID 的书不会被覆盖。

在应用内导入酒馆 `.json` / `.jsonl` 时，应用会自动新建 `books/<书 ID>/book.json`。
酒馆文件通常只有条目，不包含独立图片、音乐、剧情和战斗文件；分享这些资源请复制完整书文件夹。

`content/` 是离线内容分发源。旧版散装书 JSON 和 `inbox/` 不再参与书架刷新。
目录示例见 [data/README.md](../README.md)。
