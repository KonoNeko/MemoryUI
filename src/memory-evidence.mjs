const CONTENT_ACTIONS = new Set(['created', 'stated', 'updated', 'proposed', 'imported', 'confirmed']);

// A locator for the current content's recorded revision, not proof that a claim
// is true and not permission to disclose the source quotation or old content.
export function memoryEvidenceRef(memory) {
  let latest = null;
  for (const entry of Array.isArray(memory?.history) ? memory.history : []) {
    if (!Number.isSafeInteger(entry?.revision) || entry.revision < 1 || entry.revision > memory.revision
      || typeof entry.changes?.content?.to !== 'string') continue;
    if (!latest || entry.revision > latest.revision) latest = entry;
  }
  const consistent = latest?.changes.content.to === memory?.content;
  const located = consistent && CONTENT_ACTIONS.has(latest.action)
    && typeof latest.at === 'string' && Number.isFinite(Date.parse(latest.at));
  return {
    memoryId: memory.id,
    revision: memory.revision,
    contentRevision: located ? latest.revision : null,
    contentAction: located ? latest.action : 'unknown',
    recordedAt: located ? latest.at : null,
    access: 'owner_panel',
  };
}
