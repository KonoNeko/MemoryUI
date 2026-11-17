# MemoryUI · 记忆间

给 Codex 使用的本机记忆插件：个人资料、沟通偏好、对话记录、摘录压缩和项目记忆可在网页中查看，并按授权范围召回。

## 复制给 Codex 安装

将下面整段发给具有本机执行能力的 Codex：

> 请阅读并执行 https://raw.githubusercontent.com/KonoNeko/MemoryUI/main/INSTALL.md ，自动安装 MemoryUI，开启当前对话记录，加载我已授权的相关记忆，并打开个人主页。已有安装请复用原资料库，不重新建立档案。

Codex 会下载固定版本、校验文件、安装插件、检查服务和 MCP，再加载已授权记忆。新用户的历史读取按首次选择的范围执行；新增或修改的 Hook 按 Codex 提示审阅并信任。

- [安装说明](INSTALL.md)
- [v0.17.1 安装包](https://github.com/KonoNeko/MemoryUI/releases/download/v0.17.1/memoryui-codex-install-0.17.1.zip)
- [安装包 SHA-256](https://github.com/KonoNeko/MemoryUI/releases/download/v0.17.1/memoryui-codex-install-0.17.1.zip.sha256)
- [安装与记忆加载验收](docs/CODEX_INSTALL_ACCEPTANCE.md)

## 使用条件

当前需要 Codex 本机执行环境和 Node.js 20+，不需要 npm install、Git、Python、Docker 或外部数据库。软件包未内置 Node，缺少运行环境时按官方安装流程准备。Windows 已完成实际隔离安装与记忆加载验证；macOS/Linux 尚未做完整实机验收。纯网页或手机无法直接执行用户电脑上的本机安装。

## 记忆与资料

插件和用户资料分别保存。已有资料库、授权和停止状态在重装时沿用；不会因为安装而自动扫描全部历史。此仓库及发行包仅包含运行和安装所需文件，不包含用户记忆、登录凭据、环境配置或测试资料库。

本仓库是安装发行内容；开发区测试与私人运行文件不在发行包内。原生 Codex 入口统一安装为 memoryui@memoryui-local，包含三阶段六条 Hook。安装状态、MCP 可用、资料已加载和 Hook 已信任分别检查。
