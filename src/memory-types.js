// Memory type describes how a record is used, independently of its topic or
// sharing workspace. Existing records stay unclassified until explicitly set.
export const MEMORY_TYPES = Object.freeze(Object.fromEntries(Object.entries({
  semantic: { label: '长期资料', description: '相对稳定的本人资料、偏好与事实。' },
  episodic: { label: '经历事件', description: '发生过的经历、决定与事件，保留当时的情境。' },
  procedural: { label: '方法规则', description: '可重复使用的做事方式、步骤与协作规则。' },
  working: { label: '短期事项', description: '当前阶段的任务、目标与临时状态；到期时间另行设置。' },
  unclassified: { label: '待分类', description: '尚未明确记忆类型，保留原文供本人核对。' },
}).map(([key, value]) => [key, Object.freeze(value)])));

export function memoryTypeOf(memory) {
  return Object.hasOwn(MEMORY_TYPES, memory?.memoryType) ? memory.memoryType : 'unclassified';
}
