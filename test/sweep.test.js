// Prueba del barrido contra el esquema real (SQLite en memoria) con los portales simulados.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { sweepUser, runDailySweep } from '../src/sweep.js';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return {
    raw: db,
    prepare: (sql) => wrap(sql),
    batch: async (stmts) => { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
  };
}

const jobs = (list) => ({ data: list.map(([title, company, mode, date, id]) => ({ id, attributes: { title, description: 'cobranzas facturación odoo administración', remote_modality: mode, published_at: date, countries: ['Argentina'], company: { data: { attributes: { name: company } } } }, links: { public_url: `https://www.getonbrd.com/empleos/${id}` } })) });
const epoch = (d) => Math.floor(Date.parse(d) / 1000);

function setup() {
  const DB = makeDb();
  const now = 1790000000;
  DB.raw.exec(`INSERT INTO users (id,email,status,created_at) VALUES ('u1','a@b.co','active',${now}), ('u2','c@d.co','active',${now})`);
  const analysis = { bloques: [
    { nombre: 'Admin', descripcion: '', consultas: ['cobranzas'], palabras_clave: ['cobranzas', 'facturación', 'administración'], excluir: ['junior'] },
    { nombre: 'Odoo', descripcion: '', consultas: ['odoo'], palabras_clave: ['odoo'], excluir: ['junior'] }] };
  for (const u of ['u1', 'u2']) {
    DB.raw.prepare("INSERT INTO profiles (user_id, analysis, analysis_status, work_mode, custom_keywords, custom_exclusions) VALUES (?, ?, 'ready', 'remoto', '[\"contador\"]', '[\"junior\"]')").run(u, JSON.stringify(analysis));
  }
  return { env: { DB, JOOBLE_API_KEY: '' }, DB };
}

test('barrido: carga ofertas, respeta filtros y nunca repite enviadas ni descartadas', async () => {
  const { env, DB } = setup();
  const today = '2026-10-17';
  let payload = jobs([
    ['Analista de Cobranzas SSR', 'ACME', 'fully_remote', epoch('2026-10-14'), 'a1'],
    ['Responsable Administración', 'Beta', 'fully_remote', epoch('2026-10-15'), 'a2'],
    ['Cobranzas Junior', 'Gamma', 'fully_remote', epoch('2026-10-15'), 'a3'],        // excluida (junior)
    ['Analista de Cobranzas', 'Vieja SA', 'fully_remote', epoch('2026-09-01'), 'a4'], // > 15 días
    ['Administrativo contable', 'Presencial SA', 'no_remote', epoch('2026-10-15'), 'a5'], // presencial y la persona pidió remoto
  ]);
  globalThis.fetch = async () => new Response(JSON.stringify(payload), { status: 200 });

  const r1 = await sweepUser(env, 'u1', { today });
  const rows = DB.raw.prepare("SELECT title, status, block FROM offers WHERE user_id='u1'").all();
  const titles = new Set(rows.map((x) => x.title));
  assert.ok(titles.has('Analista de Cobranzas SSR') && titles.has('Responsable Administración'));
  assert.ok(!titles.has('Cobranzas Junior') && !titles.has('Analista de Cobranzas') && !titles.has('Administrativo contable'));
  assert.ok(r1.added.A > 0);
  assert.equal(DB.raw.prepare("SELECT last_sweep_date d FROM profiles WHERE user_id='u1'").get().d, today);

  // la persona marca una como enviada y otra como descartada
  DB.raw.exec("UPDATE offers SET status='enviado' WHERE title='Analista de Cobranzas SSR'");
  DB.raw.exec("UPDATE offers SET status='descartado' WHERE title='Responsable Administración'");
  const before = DB.raw.prepare("SELECT COUNT(*) n FROM offers WHERE user_id='u1'").get().n;

  // segundo barrido con los mismos resultados + una oferta nueva
  payload = jobs([
    ['Analista de Cobranzas SSR', 'ACME', 'fully_remote', epoch('2026-10-14'), 'a1'],
    ['Responsable Administración', 'Beta', 'fully_remote', epoch('2026-10-15'), 'a2'],
    ['Analista de Facturación y cobranzas', 'Delta', 'fully_remote', epoch('2026-10-16'), 'a6'],
  ]);
  await sweepUser(env, 'u1', { today });
  const after = DB.raw.prepare("SELECT title, status FROM offers WHERE user_id='u1' ORDER BY title").all();
  assert.equal(after.length, before + 1, 'solo se suma la oferta nueva');
  assert.equal(after.find((x) => x.title === 'Analista de Cobranzas SSR').status, 'enviado');
  assert.equal(after.find((x) => x.title === 'Responsable Administración').status, 'descartado');
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM offers WHERE user_id='u1' AND is_new=1").get().n, 1, 'solo la del último barrido figura como nueva');
  // aislamiento entre personas
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM offers WHERE user_id='u2'").get().n, 0);
});

test('si todos los portales fallan no se marca el día y se reintenta', async () => {
  const { env, DB } = setup();
  globalThis.fetch = async () => new Response('forbidden', { status: 403 });
  const r = await sweepUser(env, 'u1', { today: '2026-10-17' });
  assert.ok(r.errors.length > 0);
  assert.equal(DB.raw.prepare("SELECT last_sweep_date d FROM profiles WHERE user_id='u1'").get().d, null);
});

test('cron diario: solo procesa a quienes no se actualizaron hoy', async () => {
  const { env, DB } = setup();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify(jobs([])), { status: 200 }); };
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
  DB.raw.prepare("UPDATE profiles SET last_sweep_date=? WHERE user_id='u2'").run(today);
  await runDailySweep(env);
  assert.ok(DB.raw.prepare("SELECT last_sweep_date d FROM profiles WHERE user_id='u1'").get().d === today);
  const callsFirst = calls;
  await runDailySweep(env);
  assert.equal(calls, callsFirst, 'la segunda corrida del día no repite el trabajo');
});
