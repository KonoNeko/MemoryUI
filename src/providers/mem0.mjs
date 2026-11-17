// Hosted Mem0 API, checked 2026-10-12:
// https://docs.mem0.ai/api-reference/memory/get-memories
// https://docs.mem0.ai/migration/platform-v2-to-v3
// V2 get-all is deprecated; V3 has an explicit paginated response envelope.
// POST /v3/memories/ only reads memories. No create/update/delete route exists here.

const DEFAULT_BASE_URL = 'https://api.mem0.ai';
const PAGE_SIZE = 50;
const MAX_PAGES = 20;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_LENGTH = 20_000;

export class ProviderError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
  }
}

function configuration(env) {
  const apiKey = typeof env.MEM0_API_KEY === 'string' ? env.MEM0_API_KEY.trim() : '';
  const userId = typeof env.MEM0_USER_ID === 'string' ? env.MEM0_USER_ID.trim() : '';
  const missing = [];
  if (!apiKey) missing.push('MEM0_API_KEY');
  if (!userId) missing.push('MEM0_USER_ID');
  let baseUrl;
  try {
    const url = new URL(env.MEM0_API_BASE_URL || DEFAULT_BASE_URL);
    // This adapter targets the hosted Mem0 service, not the different OSS API.
    if (url.protocol !== 'https:' || url.hostname !== 'api.mem0.ai' ||
        url.username || url.password || url.port || url.search || url.hash ||
        (url.pathname !== '/' && url.pathname !== '')) throw new Error('Invalid URL');
    baseUrl = url.origin;
  } catch {
    missing.push('MEM0_API_BASE_URL');
  }
  if (/[\r\n]/.test(apiKey) || apiKey.length > 4096) missing.push('MEM0_API_KEY');
  if (/[\r\n]/.test(userId) || userId.length > 256) missing.push('MEM0_USER_ID');
  return { apiKey, userId, baseUrl, missing: [...new Set(missing)] };
}

export function getProviderStatus(env = process.env) {
  const { missing } = configuration(env);
  return {
    provider: 'mem0',
    configured: missing.length === 0,
    mode: 'read-only',
    missing,
    message: missing.length
      ? 'Mem0 尚未配置。请在服务器的 .env 文件中设置所列变量。'
      : 'Mem0 已配置为只读导入。导入会创建本地副本，不会修改远端记忆。',
  };
}

function dateOrNull(value) {
  if (typeof value !== 'string' || !value || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

export function normalizeMem0Memory(memory) {
  if (!memory || typeof memory !== 'object' || Array.isArray(memory) ||
      typeof memory.id !== 'string' || !memory.id || memory.id.length > 256 ||
      typeof memory.memory !== 'string' || !memory.memory.trim()) return null;
  const content = memory.memory.trim().slice(0, MAX_TEXT_LENGTH);
  const categories = Array.isArray(memory.categories)
    ? memory.categories.filter(item => typeof item === 'string').slice(0, 20).map(item => item.slice(0, 100))
    : [];
  return {
    id: `mem0:${memory.id}`,
    remoteId: memory.id,
    provider: 'mem0',
    title: [...content.split('\n')[0]].slice(0, 48).join(''),
    content,
    categories,
    tags: categories,
    space: 'personal',
    status: 'pending',
    confirmed: false,
    source: 'Mem0',
    createdAt: dateOrNull(memory.created_at),
    updatedAt: dateOrNull(memory.updated_at),
    expiresAt: dateOrNull(memory.expiration_date),
    readOnly: true,
  };
}

function upstreamFailure(status) {
  if (status === 401 || status === 403) return new ProviderError('MEM0_AUTH_FAILED', 'Mem0 验证失败，请检查服务器上的 API Key 与访问权限。');
  if (status === 429) return new ProviderError('MEM0_RATE_LIMITED', 'Mem0 请求频率已达限制，请稍后重试。', 503);
  return new ProviderError('MEM0_REQUEST_FAILED', '暂时无法读取 Mem0 记忆，请稍后重试。');
}

export async function fetchMem0Memories({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const { apiKey, userId, baseUrl, missing } = configuration(env);
  if (missing.length) throw new ProviderError('MEM0_NOT_CONFIGURED', 'Mem0 尚未配置，请先在服务器上设置连接信息。', 503);
  const memories = [];
  const seen = new Set();
  const deadline = Date.now() + 40_000;
  let total = 0;
  let truncated = false;
  let skipped = 0;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ProviderError('MEM0_TIMEOUT', 'Mem0 读取超时，请稍后重试。', 504);
    const url = new URL('/v3/memories/', baseUrl);
    url.searchParams.set('page', String(page));
    url.searchParams.set('page_size', String(PAGE_SIZE));
    const signal = AbortSignal.timeout(Math.min(8_000, remaining));
    let response;
    let payload;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ filters: { user_id: userId }, show_expired: true }),
        signal,
        redirect: 'error',
      });
      if (!response.ok) throw upstreamFailure(response.status);
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new ProviderError('MEM0_INVALID_RESPONSE', 'Mem0 返回的数据过大，无法安全导入。');
      // Stream with a byte bound rather than buffering an unbounded upstream body.
      const reader = response.body?.getReader();
      if (!reader) throw new ProviderError('MEM0_INVALID_RESPONSE', 'Mem0 返回了无法识别的数据格式。');
      const chunks = [];
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new ProviderError('MEM0_INVALID_RESPONSE', 'Mem0 返回的数据过大，无法安全导入。');
        }
        chunks.push(value);
      }
      const buffer = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
      payload = JSON.parse(new TextDecoder().decode(buffer));
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (signal.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new ProviderError('MEM0_TIMEOUT', 'Mem0 读取超时，请稍后重试。', 504);
      }
      // Never forward upstream bodies, exception strings, credentials or URLs.
      throw new ProviderError('MEM0_REQUEST_FAILED', '暂时无法读取 Mem0 记忆，请检查网络后重试。');
    }
    if (!payload || !Array.isArray(payload.results) || payload.results.length > PAGE_SIZE ||
        !Number.isInteger(payload.count) || payload.count < 0 ||
        (payload.next !== null && typeof payload.next !== 'string')) {
      throw new ProviderError('MEM0_INVALID_RESPONSE', 'Mem0 返回了无法识别的数据格式。');
    }
    total = payload.count;
    for (const item of payload.results) {
      // Defensive tenant check when the upstream response includes a user ID.
      if (item?.user_id != null && item.user_id !== userId) { skipped += 1; continue; }
      const memory = normalizeMem0Memory(item);
      if (!memory) { skipped += 1; continue; }
      if (!seen.has(memory.remoteId)) { seen.add(memory.remoteId); memories.push(memory); }
    }
    if (!payload.next) break;
    // Ignore the returned next URL; construct all requests from the fixed API origin.
    if (page === MAX_PAGES) truncated = true;
  }
  const notices = [];
  if (truncated) notices.push('本次最多读取 1000 条记忆，结果尚未完整。');
  if (skipped) notices.push(`已跳过 ${skipped} 条格式不完整或不属于当前用户的记录。`);
  return {
    provider: 'mem0', mode: 'read-only', memories, count: memories.length, total, truncated,
    message: notices.join(' ') || '只读导入已完成。导入内容是本地副本，不会与远端自动同步。',
  };
}
