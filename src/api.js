// Endpoints autenticados: perfil, CV, bloques, ofertas; y el botón de arrepentimiento (público).
import { json, fail, nowSec, safeJsonParse, cleanUrl, rateLimit, clientIp, isEmail, randomToken, sendMail, mailLayout, esc } from './util.js';
import { analyzeCv, blocksOf } from './ai.js';
import { sweepUser, dedupeKey } from './sweep.js';

const WORK_MODES = ['presencial', 'hibrido', 'remoto', 'indiferente'];
const SCHEDULES = ['part_time', 'full_time', 'freelancer'];
const STATUSES = ['pendiente', 'enviado', 'descartado'];
const CV_MAX_BYTES = 8 * 1024 * 1024;
const CV_EXT = /\.(pdf|docx|txt|md)$/i;

const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const strList = (v, n, max) => (Array.isArray(v) ? v : []).map((x) => text(x, max)).filter(Boolean).slice(0, n);

function profileView(p) {
  return {
    cv_name: p.cv_name, cv_updated_at: p.cv_updated_at,
    analysis: safeJsonParse(p.analysis, null),
    analysis_status: p.analysis_status, analysis_error: p.analysis_error, analysis_at: p.analysis_at,
    salary_gross: p.salary_gross, salary_currency: p.salary_currency,
    work_mode: p.work_mode, schedule_types: safeJsonParse(p.schedule_types, []),
    custom_block_name: p.custom_block_name,
    custom_keywords: safeJsonParse(p.custom_keywords, []),
    custom_exclusions: safeJsonParse(p.custom_exclusions, []),
    tutorial_done: !!p.tutorial_done, onboarded: !!p.onboarded,
    last_sweep_date: p.last_sweep_date, last_sweep_at: p.last_sweep_at,
    last_sweep_summary: safeJsonParse(p.last_sweep_summary, null),
  };
}

const getProfile = (env, userId) => env.DB.prepare('SELECT * FROM profiles WHERE user_id = ?').bind(userId).first();

export async function me(env, user) {
  const p = await getProfile(env, user.id);
  return json({ user: { email: user.email }, profile: profileView(p) });
}

export async function updateProfile(env, request, user) {
  const b = await request.json().catch(() => ({}));
  const sets = [];
  const vals = [];
  const set = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };

  if ('salary_gross' in b) {
    const n = b.salary_gross === null || b.salary_gross === '' ? null : Math.round(Number(b.salary_gross));
    if (n !== null && (!Number.isFinite(n) || n < 0 || n > 1e9)) return fail('El sueldo pretendido no es válido.');
    set('salary_gross', n);
  }
  if ('salary_currency' in b) {
    if (!['ARS', 'USD'].includes(b.salary_currency)) return fail('Moneda no válida.');
    set('salary_currency', b.salary_currency);
  }
  if ('work_mode' in b) {
    if (!WORK_MODES.includes(b.work_mode)) return fail('Esquema de trabajo no válido.');
    set('work_mode', b.work_mode);
  }
  if ('schedule_types' in b) set('schedule_types', JSON.stringify(strList(b.schedule_types, 3, 20).filter((s) => SCHEDULES.includes(s))));
  if ('custom_block_name' in b) set('custom_block_name', text(b.custom_block_name, 60) || null);
  if ('custom_keywords' in b) set('custom_keywords', JSON.stringify(strList(b.custom_keywords, 8, 60)));
  if ('custom_exclusions' in b) set('custom_exclusions', JSON.stringify(strList(b.custom_exclusions, 10, 40)));
  if ('tutorial_done' in b) set('tutorial_done', b.tutorial_done ? 1 : 0);
  if ('onboarded' in b) set('onboarded', b.onboarded ? 1 : 0);
  if (!sets.length) return fail('Nada para actualizar.');

  await env.DB.prepare(`UPDATE profiles SET ${sets.join(', ')} WHERE user_id = ?`).bind(...vals, user.id).run();
  return json({ ok: true, profile: profileView(await getProfile(env, user.id)) });
}

// Análisis del CV por el agente y primer barrido. Corre en segundo plano.
async function processCv(env, userId) {
  try {
    await env.DB.prepare("UPDATE profiles SET analysis_status = 'running', analysis_error = NULL WHERE user_id = ?").bind(userId).run();
    const p = await getProfile(env, userId);
    const analysis = await analyzeCv(env, p.cv_text || '');
    await env.DB.prepare("UPDATE profiles SET analysis = ?, analysis_status = 'ready', analysis_at = ? WHERE user_id = ?")
      .bind(JSON.stringify(analysis), nowSec(), userId).run();
    await sweepUser(env, userId);
  } catch (err) {
    console.error(JSON.stringify({ evt: 'process_cv_error', userId, msg: String(err?.message || err) }));
    await env.DB.prepare("UPDATE profiles SET analysis_status = 'error', analysis_error = ? WHERE user_id = ?")
      .bind('No se pudo analizar el CV. Probá de nuevo en unos minutos.', userId).run();
  }
}

export async function uploadCv(env, request, user, ctx) {
  if (!(await rateLimit(env, `cv:${user.id}`, 10, 86400))) return fail('Llegaste al límite de cargas de CV por hoy.', 429);
  const form = await request.formData().catch(() => null);
  if (!form) return fail('No pudimos leer el formulario.');
  const cvText = String(form.get('text') || '').replace(/\r/g, '').trim().slice(0, 60000);
  if (cvText.length < 80) return fail('No se pudo leer texto del CV. Pegá el contenido a mano o probá con otro archivo.');
  const file = form.get('file');
  const prev = await getProfile(env, user.id);
  let key = null;
  let name = text(form.get('name'), 120) || 'CV pegado';

  if (file && typeof file === 'object' && file.size > 0) {
    if (file.size > CV_MAX_BYTES) return fail('El archivo supera los 8 MB.');
    if (!CV_EXT.test(file.name)) return fail('Formato no soportado. Usá PDF, DOCX, TXT o MD.');
    name = text(file.name, 120);
    key = `cv/${user.id}/${Date.now()}-${randomToken(4)}`;
    await env.CVS.put(key, file.stream(), { httpMetadata: { contentType: file.type || 'application/octet-stream' }, customMetadata: { name } });
  }
  if (prev?.cv_key) await env.CVS.delete(prev.cv_key);

  await env.DB.prepare("UPDATE profiles SET cv_name = ?, cv_key = ?, cv_text = ?, cv_updated_at = ?, analysis_status = 'pending', analysis_error = NULL WHERE user_id = ?")
    .bind(name, key, cvText, nowSec(), user.id).run();
  ctx.waitUntil(processCv(env, user.id));
  return json({ ok: true, status: 'pending' }, 202);
}

export async function reanalyze(env, user, ctx) {
  const p = await getProfile(env, user.id);
  if (!p?.cv_text) return fail('Primero cargá tu CV.');
  if (!(await rateLimit(env, `reanalyze:${user.id}`, 5, 86400))) return fail('Llegaste al límite de reintentos por hoy.', 429);
  await env.DB.prepare("UPDATE profiles SET analysis_status = 'pending' WHERE user_id = ?").bind(user.id).run();
  ctx.waitUntil(processCv(env, user.id));
  return json({ ok: true }, 202);
}

export async function blocks(env, user) {
  const p = await getProfile(env, user.id);
  const counts = await env.DB.prepare("SELECT block, COUNT(*) n FROM offers WHERE user_id = ? AND status = 'pendiente' GROUP BY block").bind(user.id).all();
  const byBlock = Object.fromEntries(counts.results.map((r) => [r.block, r.n]));
  return json({
    blocks: blocksOf(p).map((b) => ({ key: b.key, origin: b.origin, name: b.name, description: b.description, queries: b.queries, pending: byBlock[b.key] || 0 })),
  });
}

export async function manualSweep(env, user, ctx) {
  const p = await getProfile(env, user.id);
  if (p?.analysis_status !== 'ready') return fail('Primero tenemos que terminar de analizar tu CV.');
  if (!(await rateLimit(env, `sweep:${user.id}`, 4, 86400))) return fail('Llegaste al límite de actualizaciones manuales por hoy. La actualización automática corre todos los días después de las 7:00.', 429);
  const result = await sweepUser(env, user.id);
  return json({ ok: true, result });
}

export async function listOffers(env, user, url) {
  const status = url.searchParams.get('status');
  const where = ['user_id = ?'];
  const args = [user.id];
  if (STATUSES.includes(status)) { where.push('status = ?'); args.push(status); }
  const order = status === 'enviado' ? 'sent_at DESC' : status === 'descartado' ? 'updated_at DESC' : 'is_new DESC, score DESC, first_seen_at DESC';
  const { results } = await env.DB.prepare(
    `SELECT id, block, title, company, modality, salary_text, below_salary, published_at, url, source, score, status, is_new, manual, notes, followup_date, first_seen_at, sent_at, updated_at
     FROM offers WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 500`,
  ).bind(...args).all();
  return json({ offers: results });
}

export async function patchOffer(env, request, user, id) {
  const b = await request.json().catch(() => ({}));
  const sets = ['updated_at = ?'];
  const vals = [nowSec()];
  if ('status' in b) {
    if (!STATUSES.includes(b.status)) return fail('Estado no válido.');
    sets.push('status = ?', 'is_new = 0');
    vals.push(b.status);
    sets.push('sent_at = ?');
    vals.push(b.status === 'enviado' ? nowSec() : null);
  }
  if ('notes' in b) { sets.push('notes = ?'); vals.push(String(b.notes ?? '').slice(0, 2000) || null); }
  if ('followup_date' in b) {
    const d = b.followup_date ? String(b.followup_date) : null;
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return fail('Fecha no válida.');
    sets.push('followup_date = ?'); vals.push(d);
  }
  const res = await env.DB.prepare(`UPDATE offers SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...vals, id, user.id).run();
  if (!res.meta.changes) return fail('Oferta no encontrada.', 404);
  return json({ ok: true });
}

export async function addOffer(env, request, user) {
  const b = await request.json().catch(() => ({}));
  const title = text(b.title, 200);
  const url = cleanUrl(b.url);
  if (!title || !url) return fail('Ingresá el puesto y un enlace válido (http o https).');
  const block = ['A', 'B', 'C'].includes(b.block) ? b.block : 'C';
  const offer = { title, company: text(b.company, 120), url };
  const now = nowSec();
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO offers (id, user_id, block, title, company, modality, url, source, status, is_new, manual, dedupe_key, first_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Agregada por mí', 'pendiente', 0, 1, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), user.id, block, title, offer.company, text(b.modality, 20), url, await dedupeKey(offer), now, now).run();
  if (!res.meta.changes) return fail('Esa oferta ya está en tu lista (en cualquier estado).', 409);
  return json({ ok: true }, 201);
}

export async function deleteOffer(env, user, id) {
  const res = await env.DB.prepare('DELETE FROM offers WHERE id = ? AND user_id = ? AND manual = 1').bind(id, user.id).run();
  if (!res.meta.changes) return fail('Solo se pueden eliminar las ofertas agregadas a mano.', 404);
  return json({ ok: true });
}

// Botón de arrepentimiento. Público: lo puede usar cualquiera, con o sin sesión.
export async function withdrawal(env, request) {
  const b = await request.json().catch(() => ({}));
  const fullName = text(b.full_name, 120);
  const email = String(b.email || '').trim().toLowerCase();
  const service = text(b.service, 160);
  if (!fullName || !isEmail(email) || !service) return fail('Completá nombre, email y el servicio contratado.');
  if (!(await rateLimit(env, `withdrawal:ip:${clientIp(request)}`, 10, 3600))) return fail('Demasiados intentos. Probá más tarde.', 429);

  const code = `ARR-${new Date().getFullYear()}-${randomToken(4).toUpperCase()}`;
  const contracted = /^\d{4}-\d{2}-\d{2}$/.test(String(b.contracted_on || '')) ? b.contracted_on : null;
  const comment = text(b.comment, 1000) || null;
  await env.DB.prepare('INSERT INTO withdrawals (id, code, full_name, email, service, contracted_on, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), code, fullName, email, service, contracted, comment, nowSec()).run();

  const when = new Intl.DateTimeFormat('es-AR', { dateStyle: 'full', timeStyle: 'short', timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
  // Constancia al consumidor y aviso interno. Si el mail falla igual queda registrado el pedido.
  const jobs = [
    sendMail(env, {
      to: email,
      subject: `Constancia de arrepentimiento ${code} — LMH Empleo`,
      text: `Recibimos tu solicitud de arrepentimiento.\nCódigo: ${code}\nFecha y hora: ${when}\nServicio: ${service}\nNos comunicaremos a este email para dar curso a la revocación y, si corresponde, a la devolución.`,
      html: mailLayout('Constancia de arrepentimiento', `<p>Recibimos tu solicitud de arrepentimiento.</p><p><b>Código:</b> ${esc(code)}<br><b>Fecha y hora:</b> ${esc(when)}<br><b>Servicio:</b> ${esc(service)}</p><p>Nos comunicaremos a este email para dar curso a la revocación y, si corresponde, a la devolución.</p>`),
    }),
    sendMail(env, {
      to: env.ADMIN_EMAIL,
      subject: `[Arrepentimiento] ${code}`,
      text: `Nueva solicitud ${code}\nNombre: ${fullName}\nEmail: ${email}\nServicio: ${service}\nContratado el: ${contracted ?? '-'}\nComentario: ${comment ?? '-'}\nRecibida: ${when}`,
      html: mailLayout(`Arrepentimiento ${code}`, `<p><b>${esc(fullName)}</b> &lt;${esc(email)}&gt;<br>Servicio: ${esc(service)}<br>Contratado el: ${esc(contracted ?? '-')}<br>Comentario: ${esc(comment ?? '-')}<br>Recibida: ${esc(when)}</p>`),
    }),
  ];
  const settled = await Promise.allSettled(jobs);
  settled.forEach((r) => r.status === 'rejected' && console.error(JSON.stringify({ evt: 'withdrawal_mail_error', msg: String(r.reason?.message || r.reason) })));
  return json({ ok: true, code, when });
}
