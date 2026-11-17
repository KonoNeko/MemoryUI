---
name: setup
description: 首次启用 MemoryUI，经一次来源与范围授权让后台Codex自动建立40字段个人档案，保留当前对话按需整理，并打开个人主页。Use for guided MemoryUI profile onboarding and first-run setup.
---

# 启用 MemoryUI

这是 MemoryUI 插件的首次设置入口。使用本包 MCP 工具；先 `memory_status` 核对绑定，Codex 新版再以 `memory_profile_status` 检查来源与任务。已经批准的相同范围不重复询问，已有仅当前对话授权不自动扩大为历史读取。新配置一次明确选择来源、历史日期和工作区、保存主题、是否后续按需记录及是否允许本次起新增读取；默认选项不是已获授权。

优先读取同包 [个人资料建立](../memoryui/references/profile-onboarding.md)。获准后一次 `memory_profile_start` 启动后台：按实际来源逐项核对40字段、分批保存、展示进度与缺失项；不先重复 enable/capture/native import，不让用户填40问或逐批提交。当前对话 ID 不可用就保留 `needs_host_context`，不能假装已读取。历史和原生摘要保持参考，未知留空，当前本人修改不被旧值覆盖。

只整理当前可见对话、非 Codex 宿主或新能力确实缺失时，按同包 [兼容设置](../memoryui/references/setup.md) 继续。MCP 确实不可用才使用同一安装包 runner；宿主审批或拒绝不能改走 CLI、网页或其他身份绕过。当前是本机共享版本，不声称云账号或跨设备同步。

自然对话更新还需明确后续当前消息来源授权和 Codex 平台对本机 Hook 定义的审阅与信任。未信任时只按需记录，不代写信任配置或声称后台采集已开始；消息排队不等于保存。按实际任务回执报告新增、复用、参考和缺失，再打开个人主页。用户无需复制提示词、逐条确认或填写完整档案。
