// 与 Hub 通信：REST + SSE。启用了 ADMIN_TOKEN 时自动带上本地保存的 token。
const TOKEN_KEY = 'np.adminToken';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}
export function setToken(t) {
  try {
    t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(method, path, body) {
  const headers = { Accept: 'application/json' };
  const tok = getToken();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) throw new ApiError(res.status, data?.error || res.statusText);
  return data;
}

/** 订阅实时推送；断线自动重连（EventSource 自带） */
export function subscribe({ onStatus, onChanged, onOpen, onError }) {
  const tok = getToken();
  const es = new EventSource(`/api/stream${tok ? `?token=${encodeURIComponent(tok)}` : ''}`);
  es.addEventListener('status', (e) => onStatus?.(JSON.parse(e.data)));
  es.addEventListener('changed', (e) => onChanged?.(JSON.parse(e.data)));
  es.onopen = () => onOpen?.();
  es.onerror = () => onError?.();
  return () => es.close();
}
