// Notificaciones push: firma VAPID, envío, limpieza de dispositivos, API y aviso tras el barrido de la mañana.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { b64u, vapidJwt, sendPush, notifyUser, subscribe, unsubscribe, summary, test as pushTest, key, status } from '../src/push.js';
import { runDailySweep } from '../src/sweep.js';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).filter((n) => n.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return { raw: db, prepare: (sql) => wrap(sql), batch: async (stmts) => { const out = []; for (const s of stmts) out.push(await s.run()); return out; } };
}

async function vapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { VAPID_PUBLIC_KEY: b64u.enc(pub), VAPID_PRIVATE_KEY: jwk.d, publicKey: kp.publicKey };
}

async function setup() {
  const k = await vapidKeys();
  const DB = makeDb();
  DB.raw.exec("INSERT INTO users (id,email,status,created_at) VALUES ('u1','a@b.co','active',1), ('u2','c@d.co','active',1)");
  return { env: { DB, VAPID_PUBLIC_KEY: k.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: k.VAPID_PRIVATE_KEY, ADMIN_EMAIL: 'admin@example.com' }, DB, k };
}
const addSub = (DB, user, endpoint) => DB.raw.prepare("INSERT INTO push_subscriptions (id,user_id,endpoint,created_at) VALUES (?,?,?,1)").run(crypto.randomUUID(), user, endpoint);
const req = (body) => new Request('https://x.test/api/push/subscribe', { method: 'POST', body: JSON.stringify(body), headers: { 'user-agent': 'Chrome Android' } });

test('VAPID: el JWT es ES256, trae audiencia y vencimiento, y la firma verifica con la clave pública', async () => {
  const { env, k } = await setup();
  const jwt = await vapidJwt(env, 'https://fcm.googleapis.com', 1000);
  const [h, p, s] = jwt.split('.');
  const head = JSON.parse(new TextDecoder().decode(b64u.dec(h)));
  const body = JSON.parse(new TextDecoder().decode(b64u.dec(p)));
  assert.deepEqual(head, { typ: 'JWT', alg: 'ES256' });
  assert.equal(body.aud, 'https://fcm.googleapis.com');
  assert.equal(body.exp, 1000 + 12 * 3600);
  assert.equal(body.sub, 'mailto:admin@example.com');
  const sig = b64u.dec(s);
  assert.equal(sig.length, 64, 'firma cruda r||s');
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k.publicKey, sig, new TextEncoder().encode(`${h}.${p}`)));
});

test('sendPush: manda el aviso vacío con VAPID y clasifica la respuesta', async () => {
  const { env } = await setup();
  let seen;
  globalThis.fetch = async (url, init) => { seen = { url, init }; return new Response(null, { status: 201 }); };
  assert.equal(await sendPush(env, { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' }), 'ok');
  assert.equal(seen.url, 'https://fcm.googleapis.com/fcm/send/abc');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.body, undefined, 'sin contenido: no viaja ninguna oferta por el servicio de push');
  assert.match(seen.init.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
  assert.ok(seen.init.headers.authorization.endsWith(`k=${env.VAPID_PUBLIC_KEY}`));
  for (const [status, out] of [[410, 'gone'], [404, 'gone'], [500, 'error'], [429, 'error']]) {
    globalThis.fetch = async () => new Response(null, { status });
    assert.equal(await sendPush(env, { endpoint: 'https://push.example/x' }), out);
  }
  globalThis.fetch = async () => { throw new Error('red caída'); };
  assert.equal(await sendPush(env, { endpoint: 'https://push.example/x' }), 'error');
});

test('notifyUser: da de baja los dispositivos muertos y los que fallan 5 veces seguidas', async () => {
  const { env, DB } = await setup();
  addSub(DB, 'u1', 'https://push.example/vivo');
  addSub(DB, 'u1', 'https://push.example/muerto');
  addSub(DB, 'u1', 'https://push.example/roto');
  DB.raw.exec("UPDATE push_subscriptions SET fail_count = 4 WHERE endpoint LIKE '%roto'");
  addSub(DB, 'u2', 'https://push.example/otra-persona');
  const llamados = [];
  globalThis.fetch = async (url) => { llamados.push(url); return new Response(null, { status: url.endsWith('vivo') ? 201 : url.endsWith('muerto') ? 410 : 500 }); };
  const r = await notifyUser(env, 'u1');
  assert.equal(r.sent, 1);
  assert.ok(!llamados.some((u) => u.endsWith('otra-persona')), 'solo se avisa a los dispositivos de esa persona');
  const left = DB.raw.prepare("SELECT endpoint FROM push_subscriptions WHERE user_id='u1'").all().map((x) => x.endpoint);
  assert.deepEqual(left, ['https://push.example/vivo']);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM push_subscriptions WHERE user_id='u2'").get().n, 1);
});

test('sin claves VAPID no se envía nada y la API avisa que no está disponible', async () => {
  const { DB } = await setup();
  const env = { DB };
  addSub(DB, 'u1', 'https://push.example/a');
  let llamado = false;
  globalThis.fetch = async () => { llamado = true; return new Response(null, { status: 201 }); };
  assert.equal((await notifyUser(env, 'u1')).sent, 0);
  assert.equal(llamado, false);
  assert.equal((await (await key(env)).json()).key, null);
  assert.equal((await subscribe(env, req({ endpoint: 'https://push.example/b' }), { id: 'u1' })).status, 503);
  assert.equal((await pushTest(env, { id: 'u1' })).status, 503);
});

test('API: valida el endpoint, limita dispositivos y permite cambiar de cuenta en el mismo celular', async () => {
  const { env, DB } = await setup();
  assert.equal((await subscribe(env, req({ endpoint: 'http://inseguro.example/x' }), { id: 'u1' })).status, 400);
  assert.equal((await subscribe(env, req({ endpoint: 'no es una url' }), { id: 'u1' })).status, 400);
  assert.equal((await subscribe(env, req({ endpoint: 'https://push.example/' + 'a'.repeat(700) }), { id: 'u1' })).status, 400);
  for (let i = 0; i < 5; i++) assert.equal((await subscribe(env, req({ endpoint: `https://push.example/d${i}` }), { id: 'u1' })).status, 200);
  assert.equal((await subscribe(env, req({ endpoint: 'https://push.example/d5' }), { id: 'u1' })).status, 400, 'tope de 5 dispositivos');
  assert.equal((await subscribe(env, req({ endpoint: 'https://push.example/d0' }), { id: 'u1' })).status, 200, 'volver a suscribir el mismo no cuenta de más');
  assert.equal((await (await status(env, { id: 'u1' })).json()).devices, 5);
  // el mismo celular entra con otra cuenta: el aviso pasa a esa cuenta
  assert.equal((await subscribe(env, req({ endpoint: 'https://push.example/d1' }), { id: 'u2' })).status, 200);
  assert.equal(DB.raw.prepare("SELECT user_id u FROM push_subscriptions WHERE endpoint='https://push.example/d1'").get().u, 'u2');
  // baja
  assert.equal((await unsubscribe(env, req({ endpoint: 'https://push.example/d2' }), { id: 'u1' })).status, 200);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint='https://push.example/d2'").get().n, 0);
  // otra persona no puede dar de baja el dispositivo ajeno
  await unsubscribe(env, req({ endpoint: 'https://push.example/d3' }), { id: 'u2' });
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint='https://push.example/d3'").get().n, 1);
});

test('summary: cuenta solo las ofertas nuevas pendientes de esa persona', async () => {
  const { env, DB } = await setup();
  const ins = DB.raw.prepare("INSERT INTO offers (id,user_id,block,title,company,url,dedupe_key,status,is_new,first_seen_at,updated_at,score) VALUES (?,?,?,?,?,?,?,?,?,1,1,50)");
  ins.run('o1', 'u1', 'A', 'a', 'x', 'https://a', 'k1', 'pendiente', 1);
  ins.run('o2', 'u1', 'A', 'b', 'x', 'https://b', 'k2', 'pendiente', 1);
  ins.run('o3', 'u1', 'A', 'c', 'x', 'https://c', 'k3', 'descartado', 1);
  ins.run('o4', 'u2', 'A', 'd', 'x', 'https://d', 'k4', 'pendiente', 1);
  const d = await (await summary(env, { id: 'u1' })).json();
  assert.equal(d.count, 2);
  assert.match(d.body, /2 ofertas nuevas/);
  const d2 = await (await summary(env, { id: 'nadie' })).json();
  assert.equal(d2.count, 0);
  assert.doesNotMatch(d2.body, /0 ofertas/);
});

test('cron de la mañana: avisa al celular solo a quien recibió ofertas nuevas', async () => {
  const { env, DB } = await setup();
  const analysis = { bloques: [
    { nombre: 'Admin', descripcion: '', consultas: ['cobranzas'], palabras_clave: ['cobranzas', 'facturación', 'administración'], excluir: ['junior'] },
    { nombre: 'Odoo', descripcion: '', consultas: ['odoo'], palabras_clave: ['odoo'], excluir: ['junior'] }] };
  for (const u of ['u1', 'u2']) DB.raw.prepare("INSERT INTO profiles (user_id, analysis, analysis_status, work_mode, custom_keywords, custom_exclusions) VALUES (?, ?, 'ready', 'remoto', '[\"contador\"]', '[\"junior\"]')").run(u, JSON.stringify(analysis));
  addSub(DB, 'u1', 'https://push.example/u1');
  addSub(DB, 'u2', 'https://push.example/u2');
  const ayer = Math.floor(Date.now() / 1000) - 86400;
  const trabajos = { data: [{ id: 'a1', attributes: { title: 'Analista de Cobranzas SSR', description: 'cobranzas facturación administración', remote_modality: 'fully_remote', published_at: ayer, countries: ['Argentina'], company: { data: { attributes: { name: 'ACME' } } } }, links: { public_url: 'https://www.getonbrd.com/empleos/a1' } }] };
  const avisos = [];
  globalThis.fetch = async (url) => {
    if (String(url).includes('push.example')) { avisos.push(String(url)); return new Response(null, { status: 201 }); }
    return new Response(JSON.stringify(trabajos), { status: 200 });
  };
  await runDailySweep(env);
  assert.equal(avisos.length, 2, 'se avisó a las dos personas que recibieron ofertas nuevas');
  const n1 = DB.raw.prepare("SELECT COUNT(*) n FROM offers WHERE user_id='u1'").get().n;
  assert.ok(n1 > 0);
  // segundo día: ya tienen todo cargado, así que no hay ofertas nuevas y no hay aviso
  avisos.length = 0;
  DB.raw.exec("UPDATE profiles SET last_sweep_date = NULL");
  globalThis.fetch = async (url) => {
    if (String(url).includes('push.example')) { avisos.push(String(url)); return new Response(null, { status: 201 }); }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  await runDailySweep(env);
  assert.equal(avisos.length, 0, 'sin ofertas nuevas no se molesta');
});
