// 供应商 API 请求的小工具：统一超时、错误信息、Bearer 认证。
export async function getJson(url, { token, headers = {}, timeout = 20000 } = {}) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  if (!res.ok) {
    const msg = body?.error?.message || body?.error || body?.message || body?.errors?.[0]?.reason || body?.raw || res.statusText;
    throw new Error(`HTTP ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return body;
}
