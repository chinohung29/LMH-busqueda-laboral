// Notificaciones push (Web Push + VAPID, RFC 8030 y RFC 8292), sin servicios de terceros y sin costo.
// El aviso viaja SIN contenido (no hace falta cifrar nada): el service worker, al recibirlo, pide el resumen
// a /api/push/summary con la sesión de la persona y arma el texto. Así el servicio de push nunca ve las ofertas.
//
// Claves: VAPID_PUBLIC_KEY (punto P-256 sin comprimir, 65 bytes, base64url) y VAPID_PRIVATE_KEY (32 bytes, base64url)
// viven como secretos del Worker (nunca en el repositorio).
import { json, fail, nowSec, rateLimit, isEmail } from './util.js';

const MAX_DEVICES = 5;
const MAX_FAILS = 5;
const enc = new TextEncoder();

export const b64u = {
  enc: (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(s).length / 4) * 4, '=')), (c) => c.charCodeAt(0)),
};

export const pushConfigured = (env) => !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

async function signingKey(env) {
  const pub = b64u.dec(env.VAPID_PUBLIC_KEY);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY no es un punto P-256 sin comprimir');
  const jwk = { kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE_KEY, x: b64u.enc(pub.slice(1, 33)), y: b64u.enc(pub.slice(33, 65)), ext: true };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

// JWT ES256 firmado con la clave VAPID. `audience` = origen del servicio de push (https://fcm.googleapis.com, etc.).
export async function vapidJwt(env, audience, now = nowSec()) {
  const head = b64u.enc(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u.enc(enc.encode(JSON.stringify({ aud: audience, exp: now + 12 * 3600, sub: `mailto:${isEmail(env.ADMIN_EMAIL) ? env.ADMIN_EMAIL : 'no-reply@lmhapps.com'}` })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey(env), enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64u.enc(sig)}`;
}

const validEndpoint = (e) => { try { const u = new URL(e); return u.protocol === 'https:' && e.length <= 600; } catch { return false; } };

// Envía un aviso vacío a un dispositivo. Devuelve 'ok' | 'gone' (dispositivo dado de baja) | 'error'.
export async function sendPush(env, sub, { ttl = 6 * 3600 } = {}) {
  const url = new URL(sub.endpoint);
  const jwt = await vapidJwt(env, url.origin);
  let res;
  try {
    res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: { authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`, ttl: String(ttl), urgency: 'normal' },
      signal: AbortSignal.timeout(10000),
    });
  } catch { return 'error'; }
  if (res.status === 404 || res.status === 410) return 'gone';
  return res.ok ? 'ok' : 'error';
}

// Avisa a todos los dispositivos de una persona. Limpia los dados de baja y los que fallan seguido.
export async function notifyUser(env, userId) {
  if (!pushConfigured(env)) return { sent: 0, skipped: 'sin claves' };
  const { results } = await env.DB.prepare('SELECT id, endpoint, fail_count FROM push_subscriptions WHERE user_id = ?').bind(userId).all();
  let sent = 0;
  for (const s of results) {
    const r = await sendPush(env, s);
    if (r === 'ok') { sent++; await env.DB.prepare('UPDATE push_subscriptions SET last_ok_at = ?, fail_count = 0 WHERE id = ?').bind(nowSec(), s.id).run(); }
    else if (r === 'gone' || s.fail_count + 1 >= MAX_FAILS) await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(s.id).run();
    else await env.DB.prepare('UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE id = ?').bind(s.id).run();
  }
  return { sent, devices: results.length };
}

/* ---------- API ---------- */

export async function key(env) {
  return json({ key: pushConfigured(env) ? env.VAPID_PUBLIC_KEY : null });
}

export async function status(env, user) {
  const n = (await env.DB.prepare('SELECT count(*) AS n FROM push_subscriptions WHERE user_id = ?').bind(user.id).first())?.n ?? 0;
  return json({ configured: pushConfigured(env), devices: n });
}

export async function subscribe(env, request, user) {
  if (!pushConfigured(env)) return fail('Las notificaciones todavía no están disponibles.', 503);
  const b = await request.json().catch(() => ({}));
  if (!validEndpoint(b.endpoint)) return fail('El dispositivo no es válido.');
  const mine = (await env.DB.prepare('SELECT count(*) AS n FROM push_subscriptions WHERE user_id = ? AND endpoint <> ?').bind(user.id, b.endpoint).first())?.n ?? 0;
  if (mine >= MAX_DEVICES) return fail(`Ya tenés ${MAX_DEVICES} dispositivos con notificaciones. Desactivá alguno primero.`);
  const ua = String(request.headers.get('user-agent') || '').slice(0, 200);
  // Un mismo dispositivo puede cambiar de cuenta: el endpoint es único.
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, user_agent, created_at, fail_count) VALUES (?, ?, ?, ?, ?, 0)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, user_agent = excluded.user_agent, fail_count = 0`,
  ).bind(crypto.randomUUID(), user.id, b.endpoint, ua, nowSec()).run();
  return json({ ok: true });
}

export async function unsubscribe(env, request, user) {
  const b = await request.json().catch(() => ({}));
  if (!validEndpoint(b.endpoint)) return fail('El dispositivo no es válido.');
  await env.DB.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').bind(user.id, b.endpoint).run();
  return json({ ok: true });
}

export async function test(env, user) {
  if (!pushConfigured(env)) return fail('Las notificaciones todavía no están disponibles.', 503);
  if (!(await rateLimit(env, `pushtest:${user.id}`, 5, 86400))) return fail('Llegaste al límite de pruebas por hoy.', 429);
  const r = await notifyUser(env, user.id);
  if (!r.devices) return fail('Todavía no activaste las notificaciones en este dispositivo.');
  return json({ ok: true, sent: r.sent });
}

// Lo pide el service worker al recibir un aviso: arma el texto con las ofertas nuevas de esa persona.
export async function summary(env, user) {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM offers WHERE user_id = ? AND is_new = 1 AND status = 'pendiente'").bind(user.id).first();
  const n = row?.n ?? 0;
  const body = n > 0 ? `${n} ${n === 1 ? 'oferta nueva' : 'ofertas nuevas'} para revisar.` : 'Revisá tus ofertas de hoy.';
  return json({ title: 'LMH Búsqueda Laboral', body, url: '/#/ofertas', count: n });
}

