// Verification and usability are separate: an unconfirmed reference can help
// an agent without being represented as an established personal fact.
export const REVIEW_REASONS = Object.freeze({
  conflict: '与已有资料有冲突',
  weak_evidence: '依据较弱',
  possibly_outdated: '可能已经过时',
});

export function isUsableMemory(memory) {
  return Boolean(memory && ['active', 'pending'].includes(memory.status)
    && (!memory.validUntil || Date.parse(memory.validUntil) > Date.now()));
}

export function memoryReview(memory) {
  const confirmed = memory?.confirmed === true;
  const reviewReasons = confirmed ? [] : [...new Set([
    ...(Array.isArray(memory?.reviewReasons) ? memory.reviewReasons.filter(reason => Object.hasOwn(REVIEW_REASONS, reason)) : []),
    ...(memory?.supersedes ? ['conflict'] : []),
  ])];
  return { verification: confirmed ? 'confirmed' : 'reference', reviewNeeded: !confirmed && reviewReasons.length > 0, reviewReasons };
}
