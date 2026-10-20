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
