/**
 * 项目元信息 — 版本、仓库地址、许可标识与许可全文位置的唯一来源。
 *
 * 渲染进程（设置页「关于」、主页页脚）与原生测试共用这一份，
 * 避免版本号或许可标识在多处各写一遍而分叉。
 */

/** 版本号：与 `frontend/package.json` 的 `version` 保持一致 */
export const PROJECT_VERSION = "0.1.0";

/** 上游仓库（也是 AGPL 第 13 条所指的对应源码位置） */
export const REPOSITORY_URL = "https://github.com/Areium/ark-tavern";

/** 界面上的许可标识（许可正文声明「或更新版本」，SPDX 写作 AGPL-3.0-or-later） */
export const LICENSE_SHORT = "AGPL-3.0";
/** 许可全称，用作悬停提示 */
export const LICENSE_NAME = "GNU Affero General Public License v3.0 or later";
/** 许可全文位置 */
export const LICENSE_FILE_URL = `${REPOSITORY_URL}/blob/main/LICENSE`;
