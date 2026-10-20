// Registro por email con enlace de validación, creación de contraseña, sesiones.
import {
  TERMS_VERSION, json, fail, sha256, randomToken, hashPassword, safeEqualHex, nowSec, isEmail,
  parseCookies, clientIp, rateLimit, sendMail, mailLayout, esc,
} from './util.js';
import { cancelForDeletion } from './billing.js';

const SESSION_DAYS = 30;
const VERIFY_HOURS = 48;
const RESET_HOURS = 2;

async function issueToken(env, userId, kind, hours) {
  const token = randomToken(32);
  await env.DB.prepare('DELETE FROM tokens WHERE user_id = ? AND kind = ?').bind(userId, kind).run();
  await env.DB.prepare('INSERT INTO tokens (token_hash, user_id, kind, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), userId, kind, nowSec() + hours * 3600).run();
  return token;
}

function sessionCookie(request, value, maxAgeSec) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `sid=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

async function startSession(env, request, userId) {
  const sid = randomToken(32);
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(sid), userId, nowSec() + SESSION_DAYS * 86400).run();
  await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(nowSec(), userId).run();
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(nowSec()).run();
  return sessionCookie(request, sid, SESSION_DAYS * 86400);
}

export async function getUser(env, request) {
  const sid = parseCookies(request.headers.get('cookie')).sid;
  if (!sid) return null;
  return env.DB.prepare(
    `SELECT u.id, u.email, u.status FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'`,
  ).bind(await sha256(sid), nowSec()).first();
}

export async function signup(env, request) {
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  if (!isEmail(email)) return fail('Ingresá un email válido.');
  if (body.accept_terms !== true || body.accept_privacy !== true) {
    return fail('Para crear la cuenta tenés que aceptar los Términos y Condiciones y la Política de Privacidad.');
  }
  if (!(await rateLimit(env, `signup:ip:${clientIp(request)}`, 10, 3600)) ||
      !(await rateLimit(env, `signup:mail:${email}`, 3, 3600))) {
    return fail('Demasiados intentos. Probá de nuevo en un rato.', 429);
  }

  const now = nowSec();
  let user = await env.DB.prepare('SELECT id, status FROM users WHERE email = ?').bind(email).first();
  const generic = { ok: true, message: 'Si el email es válido, te enviamos un enlace para validarlo. Revisá también la carpeta de spam.' };

  try {
    if (user?.status === 'active') {
      const token = await issueToken(env, user.id, 'reset', RESET_HOURS);
      const link = `${env.APP_URL}/#/restablecer/${token}`;
      await sendMail(env, {
        to: email,
        subject: 'Ya tenés una cuenta en LMH Búsqueda Laboral',
        text: `Alguien intentó registrar este email, pero ya tenés cuenta. Si querés cambiar tu contraseña usá este enlace (vale ${RESET_HOURS} horas): ${link}`,
        html: mailLayout('Ya tenés una cuenta', `<p>Alguien intentó registrar este email, pero ya tenés cuenta.</p><p>Si querés cambiar tu contraseña, usá este enlace (vale ${RESET_HOURS} horas):</p><p><a href="${esc(link)}">Crear una contraseña nueva</a></p>`),
      });
      return json(generic);
    }
    if (!user) {
      const id = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare('INSERT INTO users (id, email, status, terms_version, terms_accepted_at, privacy_accepted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(id, email, 'pending', TERMS_VERSION, now, now, now),
        env.DB.prepare('INSERT INTO profiles (user_id) VALUES (?)').bind(id),
      ]);
      user = { id };
    } else {
      await env.DB.prepare('UPDATE users SET terms_version = ?, terms_accepted_at = ?, privacy_accepted_at = ? WHERE id = ?')
        .bind(TERMS_VERSION, now, now, user.id).run();
    }
    const token = await issueToken(env, user.id, 'verify', VERIFY_HOURS);
    const link = `${env.APP_URL}/#/activar/${token}`;
    await sendMail(env, {
      to: email,
      subject: 'Validá tu email y creá tu contraseña — LMH Búsqueda Laboral',
      text: `Hola. Para validar tu email y crear tu contraseña de acceso a LMH Búsqueda Laboral, abrí este enlace (vale ${VERIFY_HOURS} horas): ${link}\n\nSi no fuiste vos, ignorá este mensaje.`,
      html: mailLayout('Validá tu email', `<p>Para activar tu cuenta de LMH Búsqueda Laboral, validá tu email y creá tu contraseña de acceso.</p><p><a href="${esc(link)}" style="display:inline-block;background:#21261F;color:#F1EEE4;padding:10px 16px;border-radius:4px;text-decoration:none">Validar email y crear contraseña</a></p><p style="font-size:13px;color:#5B5F52">El enlace vale ${VERIFY_HOURS} horas. Si no fuiste vos, ignorá este mensaje.</p>`),
    });
  } catch (err) {
    console.error(JSON.stringify({ evt: 'signup_mail_error', msg: String(err?.message || err) }));
    return fail('No pudimos enviar el email en este momento. Probá de nuevo más tarde.', 502);
  }
  return json(generic);
}

export async function forgot(env, request) {
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const generic = { ok: true, message: 'Si existe una cuenta con ese email, te enviamos un enlace para crear una contraseña nueva.' };
  if (!isEmail(email)) return json(generic);
  if (!(await rateLimit(env, `forgot:mail:${email}`, 3, 3600)) || !(await rateLimit(env, `forgot:ip:${clientIp(request)}`, 10, 3600))) {
    return json(generic);
  }
  const user = await env.DB.prepare("SELECT id FROM users WHERE email = ? AND status = 'active'").bind(email).first();
  if (user) {
    try {
      const token = await issueToken(env, user.id, 'reset', RESET_HOURS);
      const link = `${env.APP_URL}/#/restablecer/${token}`;
      await sendMail(env, {
        to: email,
        subject: 'Restablecer contraseña — LMH Búsqueda Laboral',
        text: `Para crear una contraseña nueva abrí este enlace (vale ${RESET_HOURS} horas): ${link}`,
        html: mailLayout('Restablecer contraseña', `<p>Para crear una contraseña nueva usá este enlace (vale ${RESET_HOURS} horas):</p><p><a href="${esc(link)}">Crear contraseña nueva</a></p>`),
      });
    } catch (err) {
      console.error(JSON.stringify({ evt: 'forgot_mail_error', msg: String(err?.message || err) }));
    }
  }
  return json(generic);
}

// Consume el enlace (validación o restablecimiento), guarda la contraseña y abre sesión.
export async function activate(env, request) {
  const body = await request.json().catch(() => ({}));
  const token = String(body.token || '');
  const password = String(body.password || '');
  if (!/^[0-9a-f]{64}$/.test(token)) return fail('El enlace no es válido.');
  if (password.length < 8 || password.length > 128) return fail('La contraseña debe tener entre 8 y 128 caracteres.');
  if (!(await rateLimit(env, `activate:ip:${clientIp(request)}`, 20, 3600))) return fail('Demasiados intentos.', 429);

  const row = await env.DB.prepare('SELECT user_id, kind, expires_at FROM tokens WHERE token_hash = ?').bind(await sha256(token)).first();
  if (!row || row.expires_at < nowSec()) return fail('El enlace venció o ya fue usado. Pedí uno nuevo.', 410);

  const { hash, salt } = await hashPassword(password);
  const now = nowSec();
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET pass_hash = ?, pass_salt = ?, status = 'active', email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?")
      .bind(hash, salt, now, row.user_id),
    env.DB.prepare('DELETE FROM tokens WHERE user_id = ?').bind(row.user_id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.user_id),
  ]);
  const cookie = await startSession(env, request, row.user_id);
  return json({ ok: true }, 200, { 'set-cookie': cookie });
}

export async function login(env, request) {
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!isEmail(email) || !password) return fail('Email o contraseña incorrectos.', 401);
  if (!(await rateLimit(env, `login:mail:${email}`, 8, 900)) || !(await rateLimit(env, `login:ip:${clientIp(request)}`, 30, 900))) {
    return fail('Demasiados intentos. Esperá unos minutos.', 429);
  }
  const user = await env.DB.prepare("SELECT id, pass_hash, pass_salt FROM users WHERE email = ? AND status = 'active'").bind(email).first();
  // Se calcula el hash aunque el usuario no exista, para no revelar qué emails están registrados.
  const calc = await hashPassword(password, user?.pass_salt);
  if (!user || !safeEqualHex(calc.hash, user.pass_hash)) return fail('Email o contraseña incorrectos.', 401);
  const cookie = await startSession(env, request, user.id);
  return json({ ok: true }, 200, { 'set-cookie': cookie });
}

export async function logout(env, request) {
  const sid = parseCookies(request.headers.get('cookie')).sid;
  if (sid) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(sid)).run();
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(request, '', 0) });
}

// Borra la cuenta y todos sus datos (incluido el CV en R2). Pide la contraseña.
export async function deleteAccount(env, request, user) {
  const body = await request.json().catch(() => ({}));
  const row = await env.DB.prepare('SELECT pass_hash, pass_salt FROM users WHERE id = ?').bind(user.id).first();
  const calc = await hashPassword(String(body.password || ''), row?.pass_salt);
  if (!row || !safeEqualHex(calc.hash, row.pass_hash)) return fail('La contraseña no coincide.', 403);
  await cancelForDeletion(env, user.id);
  const prof = await env.DB.prepare('SELECT cv_key FROM profiles WHERE user_id = ?').bind(user.id).first();
  if (prof?.cv_key) await env.CVS.delete(prof.cv_key);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM offers WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM subscriptions WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM profiles WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM tokens WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
  ]);
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(request, '', 0) });
}
