import { MEMORY_TYPES, memoryTypeOf } from './memory-types.js';
import { icon } from './icons.js';

// Presentation metadata only. A visual never infers or changes a stored type.
export const TYPE_VISUALS = Object.freeze({
  semantic: Object.freeze({ icon: 'user', hint: '资料 · 偏好' }),
  episodic: Object.freeze({ icon: 'calendar', hint: '经历 · 事件' }),
  procedural: Object.freeze({ icon: 'route', hint: '方法 · 约定' }),
  working: Object.freeze({ icon: 'target', hint: '目标 · 临时' }),
  unclassified: Object.freeze({ icon: 'layers', hint: '稍后整理' }),
});

export function typeVisualOf(memory) {
  const key = memoryTypeOf(memory);
  return { key, label: MEMORY_TYPES[key].label, ...TYPE_VISUALS[key] };
}

export function typeBadge(memory) {
  const type = typeVisualOf(memory);
  return `<span class="memory-kind kind-${type.key}">${icon(type.icon, 13)}${type.label}</span>`;
}
