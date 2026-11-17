// Utilidades compartidas del Worker.

export const TERMS_VERSION = '2026-10-17.2';

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

export const fail = (message, status = 400) => json({ error: message }, status);

const enc = new TextEncoder();

export const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const fromHex = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

export async function sha256(text) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export function randomToken(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return toHex(a);
}

// PBKDF2-SHA256, 100.000 iteraciones (máximo que admite Workers).
export async function hashPassword(password, saltHex) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return { hash: toHex(bits), salt: toHex(salt) };
}

export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.subtle.timingSafeEqual(fromHex(a), fromHex(b));
}

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const nowSec = () => Math.floor(Date.now() / 1000);

// Fecha de hoy en Argentina (YYYY-MM-DD).
export function todayART(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(date);
}

export function isEmail(s) {
  return typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

export function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'local';
}

export function safeJsonParse(text, fallback) {
  try {
    const v = JSON.parse(text);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

// true si se puede seguir; false si se superó el límite.
export async function rateLimit(env, key, max, windowSec) {
  const now = nowSec();
  const row = await env.DB.prepare('SELECT count, reset_at FROM rate WHERE key = ?').bind(key).first();
  if (!row || row.reset_at <= now) {
    await env.DB.prepare('INSERT OR REPLACE INTO rate (key, count, reset_at) VALUES (?, 1, ?)').bind(key, now + windowSec).run();
    return true;
  }
  if (row.count >= max) return false;
  await env.DB.prepare('UPDATE rate SET count = count + 1 WHERE key = ?').bind(key).run();
  return true;
}

export async function sendMail(env, { to, subject, html, text }) {
  if (!env.EMAIL) {
    if (env.DEV_LOG_MAIL === '1') {
      console.log(JSON.stringify({ mail_dev: true, to, subject, text }));
      return;
    }
    throw new Error('Servicio de email no configurado');
  }
  await env.EMAIL.send({ to, from: { email: env.MAIL_FROM, name: 'LMH Búsqueda Laboral' }, subject, html, text });
}

export function mailLayout(title, bodyHtml) {
  return `<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#E7E3D8;padding:24px">
<div style="max-width:520px;margin:0 auto;background:#F1EEE4;border:1px solid #C9C2AC;border-radius:4px;padding:24px;color:#21261F">
<h1 style="font-family:Georgia,serif;font-size:22px;margin:0 0 14px">${esc(title)}</h1>${bodyHtml}
<p style="font-size:12px;color:#5B5F52;margin-top:24px">LMH Búsqueda Laboral · LMH Apps</p></div></div>`;
}

export function cleanUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString().slice(0, 1000);
  } catch {
    return null;
  }
}

// ---------- Seguridad ----------

// Registro de eventos sospechosos (queda en los logs del Worker; ver README → Seguridad).
export function secEvent(type, details = {}) {
  console.warn(JSON.stringify({ evt: 'security', type, ...details }));
}

// La PWA no usa scripts en línea, ni recursos de terceros: todo es del propio origen.
export const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
  "font-src 'self'", "connect-src 'self'", "worker-src 'self' blob:", "manifest-src 'self'",
  "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

export function withSecurityHeaders(res) {
  const h = new Headers(res.headers);
  h.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  h.set('content-security-policy', CSP);
  h.set('x-content-type-options', 'nosniff');
  h.set('x-frame-options', 'DENY');
  h.set('referrer-policy', 'strict-origin-when-cross-origin');
  h.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  h.set('cross-origin-opener-policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

// Protección CSRF: las escrituras solo valen si el navegador indica que vienen de esta misma página.
// El webhook de Mercado Pago (servidor a servidor, sin Origin) se exceptúa y se protege con su firma.
export function csrfOk(request, pathname) {
  const m = request.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  if (pathname === '/api/billing/webhook') return true;
  const origin = request.headers.get('origin');
  if (origin) return origin === new URL(request.url).origin;
  const site = request.headers.get('sec-fetch-site');
  return site === 'same-origin' || site === 'none';
}

// Firma de los avisos de Mercado Pago: HMAC-SHA256 de "id:<data.id>;request-id:<x-request-id>;ts:<ts>;".
export async function mpSignatureValid(secret, xSignature, xRequestId, dataId) {
  if (!secret || !xSignature || !dataId) return false;
  const parts = Object.fromEntries(String(xSignature).split(',').map((p) => p.trim().split('=')).filter((p) => p.length === 2));
  if (!parts.ts || !/^[0-9a-f]{64}$/.test(parts.v1 || '')) return false;
  const id = /^[A-Za-z0-9]+$/.test(dataId) ? dataId.toLowerCase() : dataId;
  const manifest = `id:${id};request-id:${xRequestId || ''};ts:${parts.ts};`;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = toHex(await crypto.subtle.sign('HMAC', key, enc.encode(manifest)));
  return safeEqualHex(mac, parts.v1);
}

// Solo se aceptan los servicios de notificaciones de los navegadores (evita que el servidor llame a direcciones arbitrarias).
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /\.push\.apple\.com$/, /\.notify\.windows\.com$/, /^push\.services\.mozilla\.com$/];
export function pushEndpointOk(e) {
  try {
    const u = new URL(e);
    return u.protocol === 'https:' && e.length <= 600 && !u.port && !u.username && PUSH_HOSTS.some((r) => r.test(u.hostname));
  } catch { return false; }
}
