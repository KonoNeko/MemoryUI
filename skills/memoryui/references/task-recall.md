# 按本次任务限定记忆范围

用户明确只要某类资料、排除某些字段，或任务明确只需少数个人属性时，由宿主自动选择本次 `scope`，不要求用户再配置一遍。它只在当前平台已有读取授权内收窄本次检索，不保存为新授权，也不更改记忆。

优先调用 `memory_recall`，例如用户要求“根据我的职业安排 TypeScript 练习，年龄不要查”：

```json
{
  "query": "根据我的职业安排 TypeScript 练习，年龄不要查",
  "scope": {
    "includeFields": ["occupation"],
    "excludeFields": ["age"],
    "includeCategories": ["关于我"]
  }
}
```

范围是宿主对本次请求的声明，不是用户资料；不要把此示例写进记忆。保留当前问题中的时间、归属与明确排除，不把第三人或技术字段请求改为本人的身体资料。

## 可选范围契约

scope 仅接受以下键，至少提供一个：

| 键 | 含义 |
| --- | --- |
| `includeFields` | 仅允许所列已识别字段；未识别字段记录与含其他已识别字段的整条记录不返回 |
| `excludeFields` | 含任一所列已识别字段时整条排除 |
| `includeCategories` | 仅允许所列主题 |
| `excludeCategories` | 排除所列主题 |

各维度同时生效。省略 include 表示该维度不设限制；**显式空数组表示该维度不读取任何记录**，不能改成省略。排除数组为空则没有额外排除。所有数组仅接受固定枚举，不重复，include 与 exclude 不能交叉。未知键、无效字段、客户端/路径/权限信息均拒绝；错误后修正实际参数，不删除范围绕过检查。

主题只有：`关于我`、`沟通偏好`、`当前项目`、`生活偏好`。普通项目/方法任务可只按主题收窄，避免用个人字段白名单意外排除有用的非档案规则。

字段使用以下 key，保留大小写，不发中文标签：

| 档案分类 | key 对应标签 |
| --- | --- |
| 基础身份 | `name` 称呼、`age` 年龄、`gender` 性别、`height` 身高、`weight` 体重、`shoeSize` 鞋码、`pronouns` 称谓与代词、`birthday` 出生日期、`location` 居住地、`timezone` 时区、`languages` 语言、`background` 成长与教育 |
| 职业与角色 | `occupation` 职业、`role` 职责与角色、`sidework` 副业、`workstyle` 工作方式 |
| 兴趣与能力 | `hobbies` 爱好、`skills` 技能与擅长、`learningstyle` 学习方式 |
| 价值观与边界 | `values` 核心价值观、`principles` 选择原则、`boundaries` 个人边界 |
| 目标与阶段 | `goal` 当前目标、`lifestage` 人生阶段、`motivation` 动力来源、`longterm` 长期方向、`constraints` 现实约束 |
| 性格与自述 | `mbti` MBTI、`traits` 性格特质、`description` 自我描述、`stress` 压力与应对 |
| 关系与支持 | `attachment` 依恋模式、`support` 支持需求、`relationship` 关系角色 |
| 人生经历 | `milestone` 人生经历、`meaning` 经历的意义 |
| 日常与使用需求 | `routine` 作息习惯、`diet` 饮食偏好、`activity` 活动习惯、`accessibility` 使用需求 |
| 沟通 | `communication` 沟通偏好 |

范围筛选依赖已识别的字段与主题，返回仍是**完整记录**，不是对任意自由文本的脱敏。已识别混合记录会被保守排除，可能减少结果；未识别的附带描述仍可能随完整记录返回。不要声称任意被排除信息绝不出现，也不要自行截句、丢掉限定条件或根据系统更新时间推断事实生效时间。

## CLI 回退

用途类型与主题、字段分开。MCP可传 `memoryType`，CLI用 `--memory-type`；值为all、semantic、episodic、procedural、working或unclassified。默认all保留未分类旧资料；任务明确只取已标记的方法规则时可筛procedural，不因职业看似长期资料就默认过滤掉未分类记录，也不为命中修改记忆类型。

本插件 MCP 缺失，或缓存的旧 schema 不支持 scope 时，使用**同一已安装技能**的 runner，保留客户端与资料库绑定。把 scope 对象写入自己创建的 UTF-8 JSON 临时文件（最多 8 KiB），再执行：

```text
node "<skill-path>/scripts/run.mjs" recall --query "当前实际任务与排除要求" --scope-file "<absolute-scope-json-path>" --limit "8" --budget "6000"
```

文件只包含 scope 对象，不包裹 query、scope、client、workspace。BOM 可接受。用实际工具的结构化参数或正确 shell 引号传路径，完成后仅清理自己创建的准确临时文件。

## 结果核对与停止条件

检查 `retrieval.scope` 与 `scopePolicy`，确认实际执行的范围；预算计完整记忆 JSON，不截断内容。结果里的 `verification`、`referenceOnly`、`reviewReasons`、`evidenceRef` 照常使用，参考不升级为确定事实。

面板的最近活动显示本机通道实际返回的条目版本、字段与数量，不证明宿主最后采用了这些资料。新增读取活动不存原始query、正文或来源摘录；旧活动没有范围时不根据当前记忆补造。MCP `memory_show` 或 CLI `show --id` 只向服务请求该条当前可读记录，更新前的版本核对也使用精确ID，不先读取完整context。

无结果或超预算时可以在**相同范围**内换更具体的正向关键词、调整预算或说明现有资料不足。用户明确的排除必须继续保留在查询与结构范围里；不要退回无 scope、完整 `context`、宽 `search` 或 `show` 收集范围外资料。维护某个已明确选中记录的更新时，仍按更新工作流读取该条准确 ID；不要用维护入口绕过任务范围。
