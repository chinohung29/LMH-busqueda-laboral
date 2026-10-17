import test from 'node:test';
import assert from 'node:assert/strict';
import { computeAccess, settings, syncPreapproval, checkout, webhook } from '../src/billing.js';

const NOW = 1_800_000_000;
const DAY = 86400;
const sub = (o = {}) => ({ trial_ends_at: NOW + 2 * DAY, mp_status: null, mp_preapproval_id: null, paid_until: null, ...o });

test('prueba vigente da acceso', () => {
  assert.deepEqual(computeAccess(sub(), NOW), { access: true, state: 'trial' });
});
test('prueba vencida sin suscripción: sin acceso', () => {
  assert.deepEqual(computeAccess(sub({ trial_ends_at: NOW - 1 }), NOW), { access: false, state: 'expired' });
});
test('suscripción autorizada da acceso aunque la prueba haya vencido', () => {
  assert.deepEqual(computeAccess(sub({ trial_ends_at: NOW - DAY, mp_status: 'authorized', mp_preapproval_id: 'a1' }), NOW), { access: true, state: 'active' });
});
test('pago pendiente tras la prueba: sin acceso; durante la prueba sigue teniendo', () => {
  assert.deepEqual(computeAccess(sub({ trial_ends_at: NOW - 1, mp_status: 'pending', mp_preapproval_id: 'a1' }), NOW), { access: false, state: 'pending' });
  assert.equal(computeAccess(sub({ mp_status: 'pending', mp_preapproval_id: 'a1' }), NOW).access, true);
});
test('cancelada: acceso hasta fin del período pago, después no', () => {
  const s = sub({ trial_ends_at: NOW - DAY, mp_status: 'cancelled', mp_preapproval_id: 'a1', paid_until: NOW + 5 * DAY });
  assert.deepEqual(computeAccess(s, NOW), { access: true, state: 'cancelling' });
  assert.equal(computeAccess(s, NOW + 6 * DAY).access, false);
  assert.equal(computeAccess({ ...s, paid_until: null }, NOW).access, false);
});
test('configuración por defecto: $10.000 ARS y 3 días', () => {
  assert.deepEqual(settings({}), { price: 10000, currency: 'ARS', trialDays: 3 });
  assert.deepEqual(settings({ BILLING_PRICE: '12500', TRIAL_DAYS: '7', BILLING_CURRENCY: 'ARS' }), { price: 12500, currency: 'ARS', trialDays: 7 });
  assert.equal(settings({ BILLING_PRICE: 'abc', TRIAL_DAYS: '-1' }).price, 10000);
  assert.equal(settings({ TRIAL_DAYS: '-1' }).trialDays, 3);
});

// --- Base de datos y Mercado Pago simulados ---
function fakeEnv(row = null) {
  const db = { row, writes: [], rate: new Map() };
  const stmt = (sql) => ({
    bind: (...args) => ({
      first: async () => (/FROM subscriptions/.test(sql) ? db.row : /FROM rate/.test(sql) ? db.rate.get(args[0]) ?? null : null),
      run: async () => {
        db.writes.push({ sql, args });
        if (/INSERT OR IGNORE INTO subscriptions/.test(sql)) db.row = db.row ?? { user_id: args[0], trial_started_at: args[1], trial_ends_at: args[2], mp_status: null, mp_preapproval_id: null, paid_until: null };
        if (/UPDATE subscriptions SET mp_preapproval_id/.test(sql) && db.row) Object.assign(db.row, { mp_preapproval_id: args[0], mp_status: args[1] });
      },
    }),
  });
  return { db, env: { DB: { prepare: stmt }, MP_ACCESS_TOKEN: 'TEST-token', APP_URL: 'https://app.test' } };
}
function mockFetch(handler) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.authorization };
    calls.push(call);
    const r = await handler(call);
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
const user = { id: 'u-1', email: 'ana@test.com' };

test('checkout: crea la suscripción mensual de $10.000 con los días de prueba que quedan', async () => {
  const { env, db } = fakeEnv({ user_id: 'u-1', trial_ends_at: Math.floor(Date.now() / 1000) + 2 * DAY - 60, mp_status: null });
  const m = mockFetch(() => ({ status: 201, body: { id: 'pre-1', status: 'pending', init_point: 'https://mp.test/checkout?preapproval_id=pre-1' } }));
  try {
    const res = await checkout(env, new Request('https://app.test/api/billing/checkout', { method: 'POST' }), user);
    const data = await res.json();
    assert.equal(data.url, 'https://mp.test/checkout?preapproval_id=pre-1');
    const c = m.calls[0];
    assert.equal(c.url, 'https://api.mercadopago.com/preapproval');
    assert.equal(c.auth, 'Bearer TEST-token');
    assert.equal(c.body.external_reference, 'u-1');
    assert.equal(c.body.payer_email, 'ana@test.com');
    assert.equal(c.body.status, 'pending');
    assert.equal(c.body.back_url, 'https://app.test/suscripcion');
    assert.deepEqual(c.body.auto_recurring, { frequency: 1, frequency_type: 'months', transaction_amount: 10000, currency_id: 'ARS', free_trial: { frequency: 2, frequency_type: 'days' } });
    assert.equal(db.row.mp_preapproval_id, 'pre-1');
  } finally { m.restore(); }
});
test('checkout: si Mercado Pago rechaza free_trial reintenta sin él', async () => {
  const { env } = fakeEnv({ user_id: 'u-1', trial_ends_at: Math.floor(Date.now() / 1000) + DAY, mp_status: null });
  let n = 0;
  const m = mockFetch((c) => (++n === 1 ? { status: 400, body: { message: 'free_trial no soportado' } } : { status: 201, body: { id: 'pre-2', status: 'pending', init_point: 'https://mp.test/x' } }));
  try {
    const res = await checkout(env, new Request('https://app.test/x', { method: 'POST' }), user);
    assert.equal((await res.json()).url, 'https://mp.test/x');
    assert.equal(m.calls.length, 2);
    assert.equal(m.calls[1].body.auto_recurring.free_trial, undefined);
  } finally { m.restore(); }
});
test('checkout: sin credenciales responde 503 y ya suscripto responde error', async () => {
  const { env } = fakeEnv({ user_id: 'u-1', trial_ends_at: 0, mp_status: 'authorized' });
  assert.equal((await checkout({ ...env, MP_ACCESS_TOKEN: undefined }, new Request('https://app.test/x', { method: 'POST' }), user)).status, 503);
  assert.equal((await checkout(env, new Request('https://app.test/x', { method: 'POST' }), user)).status, 400);
});
test('sincronización: authorized guarda next_payment_date; una pendiente vieja no pisa a la vigente', async () => {
  const { env, db } = fakeEnv({ user_id: 'u-1', trial_ends_at: 0, mp_status: 'authorized', mp_preapproval_id: 'vigente', paid_until: 111 });
  const m = mockFetch(() => ({ status: 200, body: { id: 'vieja', status: 'pending', external_reference: 'u-1' } }));
  try {
    const out = await syncPreapproval(env, 'vieja');
    assert.equal(out.mp_preapproval_id, 'vigente');
    assert.equal(db.writes.filter((w) => /UPDATE subscriptions SET mp_preapproval_id = \?, mp_status = \?, paid_until/.test(w.sql)).length, 0);
  } finally { m.restore(); }
  const m2 = mockFetch(() => ({ status: 200, body: { id: 'vigente', status: 'authorized', external_reference: 'u-1', next_payment_date: '2026-11-17T12:00:00.000-03:00', payer_email: 'ana@test.com' } }));
  try {
    const out = await syncPreapproval(env, 'vigente');
    assert.equal(out.mp_status, 'authorized');
    assert.equal(out.paid_until, Math.floor(Date.parse('2026-11-17T12:00:00.000-03:00') / 1000));
  } finally { m2.restore(); }
});
test('webhook: ignora ids inválidos y nunca falla por contenido no confiable', async () => {
  const { env } = fakeEnv();
  const m = mockFetch(() => ({ status: 200, body: {} }));
  try {
    const bad = await webhook(env, new Request('https://app.test/api/billing/webhook', { method: 'POST', body: JSON.stringify({ type: 'subscription_preapproval', data: { id: '../../x?y' } }) }));
    assert.equal(bad.status, 200);
    assert.equal(m.calls.length, 0);
    const noToken = await webhook({ ...env, MP_ACCESS_TOKEN: undefined }, new Request('https://app.test/api/billing/webhook', { method: 'POST', body: JSON.stringify({ type: 'subscription_preapproval', data: { id: 'abc123' } }) }));
    assert.equal(noToken.status, 200);
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
});
