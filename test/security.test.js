// Seguridad: cabeceras, CSRF, HTTPS, firma del webhook, servicios de push permitidos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { timingSafeEqual } from 'node:crypto';
import worker from '../src/index.js';
import { withSecurityHeaders, csrfOk, mpSignatureValid, pushEndpointOk, CSP } from '../src/util.js';

// Workers trae crypto.subtle.timingSafeEqual; Node no. Solo para correr la prueba fuera de Cloudflare.
if (!crypto.subtle.timingSafeEqual) crypto.subtle.timingSafeEqual = (a, b) => a.byteLength === b.byteLength && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const env = { APP_URL: 'https://app.test', ASSETS: { fetch: async () => new Response('estático') } };
const ctx = { waitUntil() {} };

test('todas las respuestas llevan las cabeceras de seguridad', async () => {
  const res = await worker.fetch(new Request('https://app.test/'), env, ctx);
  assert.match(res.headers.get('strict-transport-security'), /max-age=31536000/);
  assert.equal(res.headers.get('content-security-policy'), CSP);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.ok(res.headers.get('referrer-policy'));
  const api = await worker.fetch(new Request('https://app.test/api/health'), env, ctx);
  assert.equal(api.status, 200);
  assert.equal(api.headers.get('x-frame-options'), 'DENY');
  assert.equal(withSecurityHeaders(new Response('x')).headers.get('x-frame-options'), 'DENY');
  assert.match(CSP, /script-src 'self'(;|$)/);
  assert.doesNotMatch(CSP, /unsafe-eval|script-src[^;]*unsafe-inline/);
});

test('HTTP se redirige a HTTPS', async () => {
  const res = await worker.fetch(new Request('http://app.test/ofertas?x=1'), env, ctx);
  assert.equal(res.status, 308);
  assert.equal(res.headers.get('location'), 'https://app.test/ofertas?x=1');
});

test('CSRF: las escrituras necesitan el mismo origen; el webhook se exceptúa; sin CORS', async () => {
  const mk = (method, path, headers = {}) => new Request(`https://app.test${path}`, { method, headers });
  assert.equal(csrfOk(mk('GET', '/api/me'), '/api/me'), true);
  assert.equal(csrfOk(mk('POST', '/api/cv'), '/api/cv'), false, 'sin Origin ni Sec-Fetch-Site');
  assert.equal(csrfOk(mk('POST', '/api/cv', { origin: 'https://malo.example' }), '/api/cv'), false);
  assert.equal(csrfOk(mk('POST', '/api/cv', { origin: 'https://app.test' }), '/api/cv'), true);
  assert.equal(csrfOk(mk('POST', '/api/cv', { 'sec-fetch-site': 'cross-site' }), '/api/cv'), false);
  assert.equal(csrfOk(mk('POST', '/api/cv', { 'sec-fetch-site': 'same-origin' }), '/api/cv'), true);
  assert.equal(csrfOk(mk('POST', '/api/billing/webhook'), '/api/billing/webhook'), true);
  const blocked = await worker.fetch(new Request('https://app.test/api/auth/logout', { method: 'POST', headers: { origin: 'https://malo.example' } }), env, ctx);
  assert.equal(blocked.status, 403);
  const pre = await worker.fetch(new Request('https://app.test/api/me', { method: 'OPTIONS', headers: { origin: 'https://malo.example' } }), env, ctx);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), null);
});

test('firma del webhook de Mercado Pago', async () => {
  const secret = 'secreto-de-prueba';
  const ts = '1704908010', rid = 'req-1', id = 'ABC123';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`id:abc123;request-id:${rid};ts:${ts};`)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  assert.equal(await mpSignatureValid(secret, `ts=${ts},v1=${mac}`, rid, id), true);
  assert.equal(await mpSignatureValid(secret, `ts=${ts},v1=${mac}`, rid, 'otro'), false, 'otro id');
  assert.equal(await mpSignatureValid('otro-secreto', `ts=${ts},v1=${mac}`, rid, id), false, 'otro secreto');
  assert.equal(await mpSignatureValid(secret, `ts=${ts},v1=${'0'.repeat(64)}`, rid, id), false);
  assert.equal(await mpSignatureValid(secret, null, rid, id), false);
  assert.equal(await mpSignatureValid(secret, 'basura', rid, id), false);
  // el Worker rechaza con 401 un aviso sin firma válida cuando hay secreto configurado
  const res = await worker.fetch(new Request('https://app.test/api/billing/webhook?data.id=abc123', { method: 'POST', body: '{}' }), { ...env, MP_WEBHOOK_SECRET: secret }, ctx);
  assert.equal(res.status, 401);
});

test('push: solo servicios de notificaciones de los navegadores', () => {
  for (const ok of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/Q', 'https://wns2-par02p.notify.windows.com/w/?token=x']) assert.equal(pushEndpointOk(ok), true, ok);
  for (const bad of ['http://fcm.googleapis.com/x', 'https://malo.example/x', 'https://fcm.googleapis.com.malo.example/x', 'https://fcm.googleapis.com:8443/x', 'https://user@fcm.googleapis.com/x', 'no es url']) assert.equal(pushEndpointOk(bad), false, bad);
});
