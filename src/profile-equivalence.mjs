import { parseProfileContent } from './profile-model.js';

// Only unqualified measurements with explicit, unambiguous metric units are
// comparable. This is a comparison key, never a replacement for the user's text.
const units = Object.freeze({
  height: new Map([['m', 1000n], ['米', 1000n], ['cm', 10n], ['厘米', 10n], ['mm', 1n], ['毫米', 1n]]),
  weight: new Map([['kg', 1000n], ['千克', 1000n], ['公斤', 1000n], ['g', 1n], ['克', 1n]]),
});
const measurement = /^([0-9]+(?:\.[0-9]+)?|\.[0-9]+)[ \t\u00a0\u3000]*(m|cm|mm|米|厘米|毫米|kg|g|千克|公斤|克)$/;

function exactMeasurement(memory) {
  if (memory?.category !== '关于我' || typeof memory.content !== 'string' || memory.content.length > 4000) return null;
  const parsed = parseProfileContent(memory.content);
  if (!parsed || !Object.hasOwn(units, parsed.key)) return null;
  const match = measurement.exec(parsed.value);
  if (!match) return null;
  const factor = units[parsed.key].get(match[2]);
  if (factor === undefined) return null;
  const [whole, fraction = ''] = match[1].split('.');
  const numerator = BigInt(`${whole || '0'}${fraction}`) * factor;
  if (numerator <= 0n) return null;
  return { key: parsed.key, numerator, denominator: 10n ** BigInt(fraction.length) };
}

/**
 * Proves equality only for single positive metric height/weight measurements.
 * Unknown units, dates, qualifiers, ranges, shoe systems and other categories
 * return false. False means "not proven equivalent", not "different in life".
 */
export function equivalentProfileMeasurement(left, right) {
  const a = exactMeasurement(left);
  const b = exactMeasurement(right);
  return Boolean(a && b && a.key === b.key && a.numerator * b.denominator === b.numerator * a.denominator);
}
