// El Worker completo contra el esquema real: la prueba gratuita y la suscripción deciden el acceso.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { timingSafeEqual } from 'node:crypto';
import { sha256 } from '../src/util.js';

// Workers trae crypto.subtle.timingSafeEqual; Node no. Solo para que la prueba corra fuera de Cloudflare.
if (!crypto.subtle.timingSafeEqual) crypto.subtle.timingSafeEqual = (a, b) => a.byteLength === b.byteLength && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function setup(extraEnv = {}) {
  const db = new DatabaseSync(':memory:');
  for (const f of ['0001_init.sql', '0002_billing.sql']) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  const DB = { raw: db, prepare: (sql) => wrap(sql), batch: async (s) => { const o = []; for (const x of s) o.push(await x.run()); return o; } };
  return { db, env: { DB, APP_URL: 'https://app.test', ASSETS: { fetch: async () => new Response('estático') }, ...extraEnv } };
}
async function login(db) {
  const sid = 'sesion-de-prueba';
  db.exec("INSERT INTO users (id,email,status,created_at) VALUES ('u1','ana@test.com','active',1)");
  db.exec("INSERT INTO profiles (user_id) VALUES ('u1')");
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(await sha256(sid), 'u1', 4_000_000_000);
  return { cookie: `sid=${sid}` };
}
const call = (env, path, { method = 'GET', cookie, body } = {}) =>
  worker.fetch(new Request(`https://app.test${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil() {} });

test('con la prueba vigente se usa la app y /api/me informa los días que quedan', async () => {
  const { db, env } = setup();
  const { cookie } = await login(db);
  assert.equal((await call(env, '/api/blocks', { cookie })).status, 200);
  const me = await (await call(env, '/api/me', { cookie })).json();
  assert.equal(me.billing.access, true);
  assert.equal(me.billing.state, 'trial');
  assert.equal(me.billing.trial_days_left, 3);
  assert.equal(me.billing.price, 10000);
});
test('vencida la prueba y sin suscripción: 402 en la app, pero /api/me y la facturación siguen abiertas', async () => {
  const { db, env } = setup();
  const { cookie } = await login(db);
  await call(env, '/api/me', { cookie });                       // crea la prueba
  db.exec("UPDATE subscriptions SET trial_ends_at = 5 WHERE user_id = 'u1'");
  for (const path of ['/api/blocks', '/api/offers']) {
    const r = await call(env, path, { cookie });
    assert.equal(r.status, 402, path);
    assert.equal((await r.json()).code, 'subscription_required');
  }
  assert.equal((await call(env, '/api/sweep', { method: 'POST', cookie })).status, 402);
  assert.equal((await call(env, '/api/cv', { method: 'POST', cookie })).status, 402);
  const me = await (await call(env, '/api/me', { cookie })).json();
  assert.deepEqual([me.billing.access, me.billing.state], [false, 'expired']);
  const co = await call(env, '/api/billing/checkout', { method: 'POST', cookie });
  assert.equal(co.status, 503, 'sin credenciales de Mercado Pago avisa que los pagos no están disponibles');
});
test('con suscripción autorizada vuelve el acceso', async () => {
  const { db, env } = setup();
  const { cookie } = await login(db);
  await call(env, '/api/me', { cookie });
  db.exec("UPDATE subscriptions SET trial_ends_at = 5, mp_status = 'authorized', mp_preapproval_id = 'p1' WHERE user_id = 'u1'");
  assert.equal((await call(env, '/api/blocks', { cookie })).status, 200);
});
test('sin sesión: 401; el webhook es público y no falla con contenido basura', async () => {
  const { env } = setup();
  assert.equal((await call(env, '/api/blocks')).status, 401);
  assert.equal((await call(env, '/api/billing/checkout', { method: 'POST' })).status, 401);
  const wh = await call(env, '/api/billing/webhook', { method: 'POST', body: { type: 'subscription_preapproval', data: { id: 'no-importa' } } });
  assert.equal(wh.status, 200);
});
test('borrar la cuenta elimina también la suscripción', async () => {
  const { db, env } = setup();
  const { cookie } = await login(db);
  await call(env, '/api/me', { cookie });
  const { hashPassword } = await import('../src/util.js');
  const { hash, salt } = await hashPassword('clave-segura-1');
  db.prepare('UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?').run(hash, salt, 'u1');
  env.CVS = { delete: async () => {} };
  const r = await call(env, '/api/account', { method: 'DELETE', cookie, body: { password: 'clave-segura-1' } });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM subscriptions').get().n, 0);
});
