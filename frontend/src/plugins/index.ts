/**
 * 插件入口：先注册内置面板，再自动加载 `custom/` 下的第三方面板。
 *
 * 由 `components/ChatView.tsx` 引入一次即可；`import.meta.glob` 在构建期展开为静态导入，
 * 新增 / 删除 `custom/*.tsx` 后重新构建（开发服务器会热更新）。
 */
import "./builtin";

const customPanels = import.meta.glob("./custom/*.tsx", { eager: true });

/** 已加载的第三方面板模块路径（调试 / 断言用） */
export const CUSTOM_PANEL_MODULES = Object.keys(customPanels);
