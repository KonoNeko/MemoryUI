import { icon as defaultIcon } from './icons.js';

export const CODEX_IMPORT_INVOCATION = '$memoryui 导入 Codex 已有记忆';
const escape = (value = '') => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const isoDate = value => typeof value === 'string' && value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const countNames = ['total', 'confirmed', 'references', 'created', 'updated', 'unchanged'];
const reportNames = ['discoveredFiles', 'readFiles', 'skippedFiles', 'truncatedFiles'];

function cleanCounts(value) {
  if (!value || countNames.some(name => count(value[name]) === null)) return null;
  if (value.confirmed + value.references !== value.total || value.created + value.updated + value.unchanged !== value.total) return null;
  return Object.fromEntries(countNames.map(name => [name, value[name]]));
}

/** Keep bodies, paths, file names, facts, categories and provider errors out of UI state. */
export function normalizeCodexImportStatus(value) {
  if (!value || typeof value.available !== 'boolean') throw new TypeError('Invalid Codex import metadata.');
  const source = value.source && typeof value.source === 'object' ? value.source : {};
  const latest = value.import && typeof value.import === 'object' ? value.import : Array.isArray(value.imports) ? value.imports[0] : null;
  const report = latest?.report && typeof latest.report === 'object' ? latest.report : {};
  const status = latest && ['pending', 'completed', 'expired', 'cancelled', 'failed', 'partial'].includes(latest.status) ? latest.status : null;
  const rawFileCount = source.fileCount ?? value.fileCount ?? (Array.isArray(source.files) ? source.files.length : Array.isArray(value.files) ? value.files.length : null);
  return {
    available: value.available,
    configured: value.configured === true,
    source: { kind: 'codex_local', fileCount: count(rawFileCount), lastScannedAt: isoDate(source.lastScannedAt ?? value.lastScannedAt) },
    import: status ? {
      status,
      requestId: typeof (latest.requestId ?? latest.id) === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(latest.requestId ?? latest.id) ? latest.requestId ?? latest.id : null,
      sourceCount: count(latest.sourceCount),
      counts: cleanCounts(latest.counts),
      completedAt: isoDate(latest.completedAt),
      report: Object.fromEntries(reportNames.map(name => [name, count(report[name])])),
    } : null,
  };
}

const timestamp = (value, esc) => value ? `<time datetime="${esc(value)}">${esc(new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }))}</time>` : '尚未检查';

/** Pure renderer: source discovery is never presented as a completed import. */
export function renderCodexImportCard({ status = null, loading = false, copying = false, error = '', notice = '', copyError = false, expanded = false } = {}, { icon = defaultIcon, escapeHtml = escape } = {}) {
  const esc = escapeHtml;
  let data = null;
  try { if (status) data = normalizeCodexImportStatus(status); } catch { error = true; }
  const last = data?.import, completed = last?.status === 'completed' && last.counts !== null;
  const sourceLabel = loading ? '检查本机来源中' : error ? '本机来源待检查' : !data ? '尚未检查来源' : data.available ? '本机来源可用' : '未发现本机来源';
  const progressLabel = !last ? '尚未导入' : last.status === 'pending' ? '等待 Codex 整理' : last.status === 'completed' ? completed ? last.counts.total ? '已收到保存回执' : '已整理，未提取到符合范围的资料' : '整理已完成，数量回执待更新' : ({ expired: '上次授权已过期', cancelled: '上次任务已撤销', failed: '上次导入未完成', partial: '上次仅完成部分整理' })[last.status];
  const report = last?.report;
  const incomplete = count(report?.skippedFiles) > 0 || count(report?.truncatedFiles) > 0;
  const disabled = copying || loading && !data || data?.available === false;
  const btn = (name, label, symbol, primary = false, inactive = false) => `<button type="button" id="codex-import-${name}" class="codex-import-button${primary ? ' is-primary' : ''}" data-action="codex-import-${name}"${inactive ? ' disabled' : ''}>${icon(symbol, 16)}<span>${esc(label)}</span></button>`;
  return `<section class="codex-import-card${completed ? ' has-receipt' : ''}" aria-labelledby="codex-import-title" aria-busy="${loading || copying}">
    <header class="codex-import-heading"><span class="codex-import-symbol">${icon('notebook', 25)}</span><div><h2 id="codex-import-title">导入 Codex 已有记忆</h2><p>把这台电脑中 Codex 已保存的资料，整理进记忆库。</p></div><span class="codex-import-local">${icon('shield', 14)}仅限本机</span></header>
    <div class="codex-import-overview"><div class="codex-import-source"><span class="codex-import-source-label">${icon('file', 17)}本机来源</span><p><strong>${data?.source.fileCount === null || !data ? '—' : esc(data.source.fileCount)}</strong><span>个记忆文件</span></p><span class="codex-import-source-status">${esc(sourceLabel)}</span></div><div class="codex-import-progress"><span class="codex-import-progress-label">${icon(completed ? 'check' : 'clock', 17)}上次整理</span><p class="codex-import-progress-title">${esc(progressLabel)}</p>${completed ? `<p class="codex-import-counts">新增 <strong>${esc(last.counts.created)}</strong> · 参考 <strong>${esc(last.counts.references)}</strong> · 不重复 <strong>${esc(last.counts.unchanged)}</strong></p>` : '<p class="codex-import-counts">发现文件后，仍需由当前 Codex 执行整理。</p>'}${completed && last.completedAt ? `<p class="codex-import-date">${timestamp(last.completedAt, esc)}</p>` : ''}</div></div>
    ${error ? `<p class="codex-import-feedback is-error" role="alert">${icon('info', 16)}暂时无法检查本机记忆，请刷新重试。已有记忆不受影响。</p>` : data?.available === false ? '<p class="codex-import-feedback">这台电脑尚未发现可用记忆文件。确认 Codex 已保存过记忆，再刷新。</p>' : ''}
    ${incomplete ? `<p class="codex-import-feedback is-warning">${icon('info', 16)}部分来源未完整处理：${count(report.skippedFiles) !== null ? `跳过 ${esc(report.skippedFiles)} 个` : ''}${count(report.skippedFiles) !== null && count(report.truncatedFiles) !== null ? ' · ' : ''}${count(report.truncatedFiles) !== null ? `截断 ${esc(report.truncatedFiles)} 个` : ''}。可在 Codex 查看导入报告。</p>` : ''}
    <div class="codex-import-actions">${btn('copy', copying ? '正在复制…' : '复制导入指令', 'file', true, disabled)}${btn('refresh', loading ? '正在检查…' : '刷新状态', 'refresh', false, loading)}</div>
    <p class="codex-import-next">${icon('message', 16)}复制后，发送到当前 Codex 对话；执行完成后刷新查看回执。</p>
    <code class="codex-import-invocation" aria-label="可手动复制的 Codex 导入指令">${esc(CODEX_IMPORT_INVOCATION)}</code>
    ${notice ? `<p class="codex-import-feedback${copyError ? ' is-error' : ''}" role="${copyError ? 'alert' : 'status'}">${icon(copyError ? 'info' : 'check', 16)}${copyError ? '复制未成功，可选中上方指令手动复制。' : '指令已复制，请在当前 Codex 对话发送。'}</p>` : ''}
    <details class="codex-import-details" data-key="codex-import-sources"${expanded === true ? ' open' : ''}><summary><span>来源与导入范围</span>${icon('down', 15)}</summary><div><dl><div><dt>上次检查来源</dt><dd>${timestamp(data?.source.lastScannedAt, esc)}</dd></div>${count(report?.readFiles) !== null ? `<div><dt>上次实际读取</dt><dd>${esc(report.readFiles)} 个文件</dd></div>` : ''}${completed ? `<div><dt>上次处理条目</dt><dd>${esc(last.counts.total)} 条 · 已确认 ${esc(last.counts.confirmed)} · 参考 ${esc(last.counts.references)}</dd></div><div><dt>上次保存结果</dt><dd>新增 ${esc(last.counts.created)} · 更新 ${esc(last.counts.updated)} · 不重复 ${esc(last.counts.unchanged)}</dd></div>` : ''}</dl><p>文件数表示本机候选，保存量以整理回执为准。Codex Skill 在当前对话处理原文；面板只展示状态，不显示原始记忆与文件路径。</p><p>只读取这台电脑上的 Codex 记忆文件，不包含云端账户隐藏记忆。摘要资料保留参考标记；新增记忆默认仅自己，AI 读取授权单独设置。</p></div></details>
  </section>`;
}

/** GET status + explicit clipboard write only; no task creation, import, or permission mutation. */
export function createCodexImportController({ request, fetch: fetchImpl = globalThis.fetch, clipboard = globalThis.navigator?.clipboard, onChange = () => {} } = {}) {
  if (request !== undefined && typeof request !== 'function') throw new TypeError('request must be a function.');
  if (!request && typeof fetchImpl !== 'function') throw new TypeError('A request function is required.');
  const read = request || (async path => {
    const response = await fetchImpl(path, { cache: 'no-store' });
    if (!response.ok) throw new Error('Codex import status unavailable.');
    return response.json();
  });
  let state = { status: null, loading: false, copying: false, error: '', notice: '', copyError: false };
  let inFlight = null;
  const getState = () => structuredClone(state);
  const notify = () => onChange(getState());
  async function load() {
    if (inFlight) return inFlight;
    state = { ...state, loading: true, error: '' };
    inFlight = Promise.resolve().then(async () => {
      try { state.status = normalizeCodexImportStatus(await read('/api/codex-memory/status?client=codex')); return true; }
      catch { state.error = '暂时无法检查本机记忆，请刷新重试。'; return false; }
      finally { state.loading = false; inFlight = null; notify(); }
    });
    notify();
    return inFlight;
  }
  async function copyInstruction() {
    if (state.copying) return false;
    state = { ...state, copying: true, notice: '', copyError: false };
    notify();
    try {
      if (typeof clipboard?.writeText !== 'function') throw new Error('Clipboard unavailable.');
      await clipboard.writeText(CODEX_IMPORT_INVOCATION);
      state.notice = 'copied';
      return true;
    } catch { state.notice = 'manual_copy'; state.copyError = true; return false; }
    finally { state.copying = false; notify(); }
  }
  return {
    getState, load, copyInstruction,
    handleAction(action) { return action === 'codex-import-refresh' ? load() : action === 'codex-import-copy' ? copyInstruction() : Promise.resolve(false); },
  };
}
