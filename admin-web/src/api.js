function defaultBase() {
  const path = window.location.pathname || '';
  if (path.startsWith('/deskagent/admin')) return '/deskagent';
  return '';
}

const BASE = (import.meta.env.VITE_API_BASE || defaultBase()).replace(/\/+$/, '');

export function getToken() {
  return localStorage.getItem('admin_token') || '';
}
export function setToken(t) {
  localStorage.setItem('admin_token', t);
}
export function clearToken() {
  localStorage.removeItem('admin_token');
}

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `请求失败 (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}
