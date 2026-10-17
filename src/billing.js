// Suscripción mensual con Mercado Pago (preapproval) + prueba gratuita que maneja la app.
// Acceso = prueba vigente, o suscripción autorizada, o suscripción cancelada/pausada con el período ya pago.
import { json, fail, nowSec, rateLimit, clientIp } from './util.js';

const MP = 'https://api.mercadopago.com';
const DAY = 86400;

export function settings(env) {
  const price = Number(env.BILLING_PRICE);
  const trial = Number(env.TRIAL_DAYS);
  return {
    price: price > 0 ? price : 10000,
    currency: env.BILLING_CURRENCY || 'ARS',
    trialDays: Number.isFinite(trial) && trial >= 0 ? Math.floor(trial) : 3,
  };
}

// Pura (se prueba en test/billing.test.js). Devuelve { access, state }.
export function computeAccess(sub, now) {
  if (!sub) return { access: false, state: 'expired' };
  if (sub.mp_status === 'authorized') return { access: true, state: 'active' };
  if (now < sub.trial_ends_at) return { access: true, state: 'trial' };
  if ((sub.mp_status === 'cancelled' || sub.mp_status === 'paused') && sub.paid_until && now < sub.paid_until) {
    return { access: true, state: sub.mp_status === 'paused' ? 'paused' : 'cancelling' };
  }
  if (sub.mp_status === 'pending' && sub.mp_preapproval_id) return { access: false, state: 'pending' };
  return { access: false, state: 'expired' };
}

async function ensureSub(env, userId, now = nowSec()) {
  let sub = await env.DB.prepare('SELECT * FROM subscriptions WHERE user_id = ?').bind(userId).first();
  if (!sub) {
    const { trialDays } = settings(env);
    await env.DB.prepare('INSERT OR IGNORE INTO subscriptions (user_id, trial_started_at, trial_ends_at, updated_at) VALUES (?, ?, ?, ?)')
      .bind(userId, now, now + trialDays * DAY, now).run();
    sub = await env.DB.prepare('SELECT * FROM subscriptions WHERE user_id = ?').bind(userId).first();
  }
  return sub;
}

export async function view(env, userId) {
  const now = nowSec();
  const sub = await ensureSub(env, userId, now);
  const { access, state } = computeAccess(sub, now);
  const s = settings(env);
  return {
    access, state, price: s.price, currency: s.currency, trial_days: s.trialDays,
    trial_ends_at: sub.trial_ends_at,
    trial_days_left: state === 'trial' ? Math.max(1, Math.ceil((sub.trial_ends_at - now) / DAY)) : 0,
    paid_until: sub.paid_until,
    can_cancel: sub.mp_status === 'authorized',
    payments_enabled: !!env.MP_ACCESS_TOKEN,
  };
}

export const hasAccess = async (env, userId) => (await view(env, userId)).access;

async function mp(env, method, path, body) {
  const res = await fetch(MP + path, {
    method,
    headers: { authorization: `Bearer ${env.MP_ACCESS_TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const cause = Array.isArray(data.cause) && data.cause[0] ? (data.cause[0].description || data.cause[0].code) : '';
    const err = new Error(`Mercado Pago ${res.status}: ${[data.message || data.error || 'error', cause].filter(Boolean).join(' — ')}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Trae la suscripción desde Mercado Pago (fuente de verdad) y actualiza la fila del usuario.
export async function syncPreapproval(env, preapprovalId) {
  const pa = await mp(env, 'GET', `/preapproval/${encodeURIComponent(preapprovalId)}`);
  const userId = pa.external_reference;
  if (!userId) return null;
  const sub = await env.DB.prepare('SELECT * FROM subscriptions WHERE user_id = ?').bind(userId).first();
  if (!sub) return null;
  // Un intento viejo (pendiente) no pisa a la suscripción vigente, salvo que este sí esté autorizado.
  if (sub.mp_preapproval_id && sub.mp_preapproval_id !== pa.id && !(pa.status === 'authorized' && sub.mp_status !== 'authorized')) return sub;
  const next = pa.next_payment_date ? Math.floor(Date.parse(pa.next_payment_date) / 1000) : null;
  const paidUntil = pa.status === 'authorized' && Number.isFinite(next) ? next : sub.paid_until;
  await env.DB.prepare('UPDATE subscriptions SET mp_preapproval_id = ?, mp_status = ?, paid_until = ?, payer_email = ?, updated_at = ? WHERE user_id = ?')
    .bind(pa.id, pa.status, paidUntil ?? null, typeof pa.payer_email === 'string' ? pa.payer_email : sub.payer_email, nowSec(), userId).run();
  return { ...sub, mp_preapproval_id: pa.id, mp_status: pa.status, paid_until: paidUntil };
}

// POST /api/billing/checkout → { url } para redirigir a Mercado Pago.
export async function checkout(env, request, user) {
  if (!env.MP_ACCESS_TOKEN) return fail('Los pagos todavía no están disponibles. Probá más tarde.', 503);
  if (!(await rateLimit(env, `checkout:${user.id}`, 10, 3600))) return fail('Demasiados intentos. Probá de nuevo en un rato.', 429);
  const now = nowSec();
  const sub = await ensureSub(env, user.id, now);
  if (sub.mp_status === 'authorized') return fail('Ya tenés una suscripción activa.');
  const { price, currency } = settings(env);
  const trialLeft = now < sub.trial_ends_at ? Math.ceil((sub.trial_ends_at - now) / DAY) : 0;
  const body = {
    reason: 'LMH Empleo — suscripción mensual',
    external_reference: user.id,
    payer_email: user.email,
    back_url: `${env.APP_URL}/suscripcion`,
    status: 'pending',
    auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: price, currency_id: currency },
  };
  // Si le quedan días de prueba, el primer cobro se difiere para no perderlos.
  if (trialLeft > 0) body.auto_recurring.free_trial = { frequency: trialLeft, frequency_type: 'days' };
  let pa;
  try {
    try {
      pa = await mp(env, 'POST', '/preapproval', body);
    } catch (err) {
      if (err.status === 400 && body.auto_recurring.free_trial) {
        console.error(JSON.stringify({ evt: 'mp_free_trial_rejected', msg: err.message }));
        delete body.auto_recurring.free_trial;
        pa = await mp(env, 'POST', '/preapproval', body);
      } else throw err;
    }
  } catch (err) {
    console.error(JSON.stringify({ evt: 'mp_checkout_error', msg: String(err.message) }));
    return fail(`No pudimos iniciar el pago. ${String(err.message).slice(0, 300)}`, 502);
  }
  if (!pa?.init_point) return fail('Mercado Pago no devolvió el enlace de pago. Probá de nuevo.', 502);
  await env.DB.prepare('UPDATE subscriptions SET mp_preapproval_id = ?, mp_status = ?, payer_email = ?, updated_at = ? WHERE user_id = ?')
    .bind(pa.id, pa.status || 'pending', user.email, nowSec(), user.id).run();
  return json({ url: pa.init_point });
}

// POST /api/billing/refresh → consulta a Mercado Pago el estado actual (sirve aunque falle el webhook).
export async function refresh(env, user) {
  const sub = await ensureSub(env, user.id);
  if (env.MP_ACCESS_TOKEN && sub.mp_preapproval_id) {
    try { await syncPreapproval(env, sub.mp_preapproval_id); }
    catch (err) { console.error(JSON.stringify({ evt: 'mp_refresh_error', msg: String(err.message) })); return fail('No pudimos consultar a Mercado Pago ahora. Probá en un momento.', 502); }
  }
  return json({ billing: await view(env, user.id) });
}

// POST /api/billing/cancel → cancela el cobro; el acceso sigue hasta el fin del período pago.
export async function cancel(env, user) {
  const sub = await ensureSub(env, user.id);
  if (!env.MP_ACCESS_TOKEN || !sub.mp_preapproval_id || !['authorized', 'paused', 'pending'].includes(sub.mp_status)) return fail('No tenés una suscripción para cancelar.');
  try {
    await mp(env, 'PUT', `/preapproval/${encodeURIComponent(sub.mp_preapproval_id)}`, { status: 'cancelled' });
    await syncPreapproval(env, sub.mp_preapproval_id);
  } catch (err) {
    console.error(JSON.stringify({ evt: 'mp_cancel_error', msg: String(err.message) }));
    return fail('No pudimos cancelar la suscripción ahora. Probá de nuevo en un momento.', 502);
  }
  return json({ billing: await view(env, user.id) });
}

// Se usa al borrar la cuenta: evita que siga cobrándose. No frena el borrado si falla.
export async function cancelForDeletion(env, userId) {
  try {
    const sub = await env.DB.prepare('SELECT mp_preapproval_id, mp_status FROM subscriptions WHERE user_id = ?').bind(userId).first();
    if (env.MP_ACCESS_TOKEN && sub?.mp_preapproval_id && ['authorized', 'paused', 'pending'].includes(sub.mp_status)) {
      await mp(env, 'PUT', `/preapproval/${encodeURIComponent(sub.mp_preapproval_id)}`, { status: 'cancelled' });
    }
  } catch (err) {
    console.error(JSON.stringify({ evt: 'mp_cancel_on_delete_error', msg: String(err.message) }));
  }
}

// POST /api/billing/webhook (público). No se confía en el contenido: solo se usa el id para
// volver a consultar a Mercado Pago con nuestro token y actualizar suscripciones que ya conocemos.
export async function webhook(env, request) {
  const url = new URL(request.url);
  const body = await request.json().catch(() => ({}));
  const type = String(body.type || body.topic || url.searchParams.get('type') || url.searchParams.get('topic') || '');
  const id = String(body?.data?.id ?? url.searchParams.get('data.id') ?? url.searchParams.get('id') ?? '');
  if (!env.MP_ACCESS_TOKEN || !/^[A-Za-z0-9_-]{4,64}$/.test(id)) return json({ ok: true });
  if (!(await rateLimit(env, `mpwh:${clientIp(request)}`, 300, 3600))) return json({ ok: true });
  try {
    if (type.includes('authorized_payment')) {
      const ap = await mp(env, 'GET', `/authorized_payments/${encodeURIComponent(id)}`);
      if (ap.preapproval_id) await syncPreapproval(env, String(ap.preapproval_id));
    } else if (type.includes('preapproval') && !type.includes('plan')) {
      await syncPreapproval(env, id);
    }
  } catch (err) {
    console.error(JSON.stringify({ evt: 'mp_webhook_error', type, msg: String(err.message) }));
    if (!err.status || err.status >= 500) return json({ ok: false }, 500);   // Mercado Pago reintenta
  }
  return json({ ok: true });
}
