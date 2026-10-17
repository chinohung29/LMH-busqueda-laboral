// Barrido de ofertas: lo ejecuta el cron diario (después de las 7:00 hora de Argentina) y el botón "Actualizar".
import { sha256, nowSec, todayART, safeJsonParse } from './util.js';
import { blocksOf } from './ai.js';
import { CONNECTORS } from './sources.js';
import { hasAccess } from './billing.js';

export const MAX_AGE_DAYS = 15;
const MAX_NEW_PER_BLOCK = 15;
const MAX_QUERIES_PER_BLOCK = 5;

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Clave para no repetir una oferta: título + empresa (o el enlace si falta la empresa).
export async function dedupeKey(offer) {
  const base = offer.company ? `${norm(offer.title)}|${norm(offer.company)}` : (() => { try { const u = new URL(offer.url); return `${u.host}${u.pathname}`; } catch { return offer.url; } })();
  return sha256(base);
}

export function ageDays(isoDate, today) {
  if (!isoDate) return null;
  return Math.floor((Date.parse(today) - Date.parse(isoDate)) / 86400000);
}

const hasWord = (text, term) => new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(norm(text));

// ¿La oferta sirve? Devuelve { ok, reason } según antigüedad, modalidad y exclusiones.
export function passesFilters(offer, block, prefs, today) {
  const age = ageDays(offer.publishedAt, today);
  if (age !== null && age > MAX_AGE_DAYS) return { ok: false, reason: 'vieja' };
  if (age !== null && age < -1) return { ok: false, reason: 'fecha' };
  if (prefs.work_mode === 'remoto' && (offer.modality === 'Presencial' || offer.modality === 'Híbrido')) return { ok: false, reason: 'modalidad' };
  if (prefs.work_mode === 'hibrido' && offer.modality === 'Presencial') return { ok: false, reason: 'modalidad' };
  for (const term of block.exclude) if (term && hasWord(offer.title, norm(term))) return { ok: false, reason: 'excluida' };
  return { ok: true };
}

// Puntaje 0-100 por coincidencia con las palabras clave del bloque y los tipos de horario elegidos.
export function scoreOffer(offer, block, prefs) {
  const hay = norm(`${offer.title} ${offer.text}`);
  const title = norm(offer.title);
  const kws = [...new Set(block.keywords.map(norm).filter(Boolean))];
  if (!kws.length) return 0;
  let hits = 0;
  for (const k of kws) {
    if (title.includes(k)) hits += 2;
    else if (hay.includes(k)) hits += 1;
  }
  let score = Math.min(100, Math.round((hits / (kws.length * 1.2)) * 100));
  const sched = safeJsonParse(prefs.schedule_types, []);
  if (sched.includes('freelancer') && /freelance|independiente|por proyecto/.test(hay)) score = Math.min(100, score + 8);
  if (sched.includes('part_time') && /part ?time|media jornada|medio tiempo/.test(hay)) score = Math.min(100, score + 8);
  if (sched.includes('full_time') && /full ?time|jornada completa|tiempo completo/.test(hay)) score = Math.min(100, score + 5);
  return score;
}

// true si el sueldo publicado (misma moneda) queda claramente por debajo de lo pretendido.
export function belowExpectation(offer, prefs) {
  if (!offer.salary || !prefs.salary_gross || offer.salary.currency !== prefs.salary_currency) return false;
  return offer.salary.max < prefs.salary_gross * 0.85;
}

async function collect(env, block) {
  const found = new Map();
  const errors = [];
  for (const q of block.queries.slice(0, MAX_QUERIES_PER_BLOCK)) {
    for (const c of CONNECTORS) {
      try {
        for (const o of await c.run(q, env)) if (!found.has(o.url)) found.set(o.url, o);
      } catch (err) {
        errors.push(`${c.name}: ${String(err?.message || err).slice(0, 80)}`);
      }
    }
  }
  return { offers: [...found.values()], errors };
}

export async function sweepUser(env, userId, { today = todayART() } = {}) {
  const profile = await env.DB.prepare('SELECT * FROM profiles WHERE user_id = ?').bind(userId).first();
  if (!profile) return { skipped: 'sin perfil' };
  const blocks = blocksOf(profile).filter((b) => b.queries.length);
  if (!blocks.length) return { skipped: 'sin búsquedas' };

  const added = { A: 0, B: 0, C: 0 };
  const errors = [];
  let collected = 0;
  const now = nowSec();
  // Todo lo que la persona ya tiene (pendiente, enviado o descartado) no se vuelve a cargar.
  const known = new Set((await env.DB.prepare('SELECT dedupe_key FROM offers WHERE user_id = ?').bind(userId).all()).results.map((r) => r.dedupe_key));
  // Lo que se ve como "nuevo" es lo de este barrido.
  await env.DB.prepare('UPDATE offers SET is_new = 0 WHERE user_id = ? AND is_new = 1').bind(userId).run();

  for (const block of blocks) {
    const { offers, errors: errs } = await collect(env, block);
    errors.push(...errs);
    collected += offers.length;
    const ranked = [];
    for (const o of offers) {
      if (!passesFilters(o, block, profile, today).ok) continue;
      const score = scoreOffer(o, block, profile);
      if (block.key !== 'C' && score < 10) continue;
      const key = await dedupeKey(o);
      if (known.has(key)) continue;
      known.add(key);
      ranked.push({ o, score, key });
    }
    ranked.sort((a, b) => b.score - a.score);
    const stmts = [];
    for (const { o, score, key } of ranked.slice(0, MAX_NEW_PER_BLOCK)) {
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO offers (id, user_id, block, title, company, modality, salary_text, below_salary, published_at, url, source, score, status, is_new, dedupe_key, first_seen_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', 1, ?, ?, ?)`,
        ).bind(crypto.randomUUID(), userId, block.key, o.title.slice(0, 200), o.company.slice(0, 120), o.modality, o.salaryText, belowExpectation(o, profile) ? 1 : 0,
          o.publishedAt, o.url, o.source, score, key, now, now),
      );
    }
    if (stmts.length) {
      const res = await env.DB.batch(stmts);
      let n = 0;
      for (const r of res) if (r.meta?.changes) n++;
      added[block.key] = n;
    }
  }

  const summary = JSON.stringify({ added, errors: errors.slice(0, 5) });
  // Si todas las fuentes fallaron, no se marca el día como hecho: la próxima ejecución del cron reintenta.
  const failedAll = collected === 0 && errors.length > 0;
  await env.DB.prepare('UPDATE profiles SET last_sweep_date = ?, last_sweep_at = ?, last_sweep_summary = ? WHERE user_id = ?')
    .bind(failedAll ? profile.last_sweep_date : today, now, summary, userId).run();
  console.log(JSON.stringify({ evt: 'sweep_done', userId, added, errors: errors.length }));
  return { added, errors };
}

// Cron: procesa a quienes todavía no se actualizaron hoy (hora de Argentina), en tandas.
export async function runDailySweep(env) {
  const today = todayART();
  const limit = Math.max(1, Math.min(50, Number(env.SWEEP_USERS_PER_RUN) || 20));
  const { results } = await env.DB.prepare(
    `SELECT p.user_id FROM profiles p JOIN users u ON u.id = p.user_id
     WHERE u.status = 'active' AND p.analysis_status = 'ready' AND (p.last_sweep_date IS NULL OR p.last_sweep_date < ?)
     ORDER BY p.last_sweep_at ASC NULLS FIRST LIMIT ?`,
  ).bind(today, limit).all();
  for (const row of results) {
    try {
      if (!(await hasAccess(env, row.user_id))) {   // sin prueba ni suscripción: no se gasta el barrido
        await env.DB.prepare('UPDATE profiles SET last_sweep_date = ?, last_sweep_at = ? WHERE user_id = ?').bind(today, nowSec(), row.user_id).run();
        continue;
      }
      await sweepUser(env, row.user_id, { today });
    } catch (err) {
      console.error(JSON.stringify({ evt: 'sweep_error', userId: row.user_id, msg: String(err?.message || err) }));
      await env.DB.prepare('UPDATE profiles SET last_sweep_date = ?, last_sweep_at = ? WHERE user_id = ?').bind(today, nowSec(), row.user_id).run();
    }
  }
  console.log(JSON.stringify({ evt: 'daily_sweep', today, processed: results.length }));
}
