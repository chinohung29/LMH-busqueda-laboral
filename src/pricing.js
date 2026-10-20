// Aviso de cambio de precio: banner en la app + mail a quienes están suscriptos (mínimo 15 días antes).
import { nowSec, todayART, sendMail, mailLayout, esc } from './util.js';
import { settings } from './billing.js';

export const MIN_NOTICE_DAYS = 15;
const DAY_MS = 86400000;

// Devuelve un texto de error o null si el aviso es válido. `today` es YYYY-MM-DD (hora de Argentina).
export function validateNotice(price, effectiveOn, today) {
  if (!Number.isInteger(price) || price < 1 || price > 10_000_000) return 'El precio tiene que ser un número entero de pesos.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveOn) || Number.isNaN(Date.parse(`${effectiveOn}T00:00:00Z`))) return 'La fecha tiene que ser AAAA-MM-DD.';
  const days = Math.round((Date.parse(`${effectiveOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
  if (days < MIN_NOTICE_DAYS) return `La fecha tiene que ser al menos ${MIN_NOTICE_DAYS} días después de hoy.`;
  return null;
}

// Aviso vigente: no cancelado, con fecha futura y creado con al menos 15 días de anticipación.
export async function activeNotice(env) {
  return env.DB.prepare(
    `SELECT id, new_price, effective_on FROM price_notices
     WHERE cancelled = 0 AND effective_on >= ? AND effective_on >= date(created_at, 'unixepoch', '+${MIN_NOTICE_DAYS} days')
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(todayART()).first();
}

export async function sendNoticeEmails(env, limit = 40) {
  const n = await activeNotice(env);
  if (!n) return 0;
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.email FROM users u JOIN subscriptions s ON s.user_id = u.id
     WHERE u.status = 'active' AND s.mp_status IN ('authorized', 'paused', 'pending')
       AND NOT EXISTS (SELECT 1 FROM price_notice_sent x WHERE x.notice_id = ? AND x.user_id = u.id)
     LIMIT ?`,
  ).bind(n.id, limit).all();
  const fmt = (v) => `$ ${Number(v).toLocaleString('es-AR')}`;
  const when = new Date(`${n.effective_on}T12:00:00Z`).toLocaleDateString('es-AR', { dateStyle: 'long', timeZone: 'UTC' });
  const now = settings(env).price;
  let sent = 0;
  for (const u of results) {
    try {
      const body = `El precio de tu suscripción a LMH Búsqueda Laboral cambia a ${fmt(n.new_price)} por mes (hoy es ${fmt(now)}), a partir del ${when}. Si no estás de acuerdo, podés cancelar antes de esa fecha desde “Mi perfil”, en “Mi suscripción”, sin penalidad.`;
      await sendMail(env, {
        to: u.email,
        subject: 'Cambio de precio de tu suscripción — LMH Búsqueda Laboral',
        text: body,
        html: mailLayout('Cambio de precio', `<p>${esc(body)}</p><p><a href="${esc(env.APP_URL)}">Abrir la aplicación</a></p>`),
      });
    } catch (err) {
      console.error(JSON.stringify({ evt: 'price_notice_mail_error', msg: String(err?.message || err) }));
    }
    // Se marca igual para no reintentar sin fin con una dirección que rebota.
    await env.DB.prepare('INSERT OR IGNORE INTO price_notice_sent (notice_id, user_id, sent_at) VALUES (?, ?, ?)').bind(n.id, u.id, nowSec()).run();
    sent += 1;
  }
  return sent;
}
