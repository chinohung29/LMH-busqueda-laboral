// Prueba de punta a punta contra `npm run dev` (http://localhost:8787). Uso: node test/e2e.mjs <ruta-al-log-del-dev>
import { readFileSync } from 'node:fs';
const BASE = 'http://localhost:8787';
const LOG = process.argv[2];
let cookie = '';
const results = [];
const ok = (name, cond, extra = '') => { results.push([cond, name, extra]); console.log(`${cond ? 'OK  ' : 'FAIL'} ${name} ${cond ? '' : extra}`); };

async function call(path, { method = 'GET', body, form, headers = {} } = {}) {
  const init = { method, headers: { ...headers, ...(cookie ? { cookie } : {}) } };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  if (form) init.body = form;
  const res = await fetch(BASE + path, init);
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, res };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const email = `test${Date.now()}@example.com`;

// Registro
let r = await call('/api/auth/signup', { method: 'POST', body: { email, accept_terms: false, accept_privacy: true } });
ok('registro exige aceptar términos y privacidad', r.status === 400);
r = await call('/api/auth/signup', { method: 'POST', body: { email, accept_terms: true, accept_privacy: true } });
ok('registro devuelve respuesta genérica', r.status === 200 && r.data.ok);
await sleep(800);
const log = readFileSync(LOG, 'utf8');
const m = [...log.matchAll(/#\/activar\/([0-9a-f]{64})/g)].pop();
ok('se genera enlace de validación', !!m);
const token = m[1];
r = await call('/api/me');
ok('sin sesión no se accede a la API', r.status === 401);
r = await call('/api/auth/login', { method: 'POST', body: { email, password: 'cualquiera123' } });
ok('no se puede entrar antes de validar el mail', r.status === 401);
r = await call('/api/auth/activate', { method: 'POST', body: { token, password: 'corta' } });
ok('contraseña corta rechazada', r.status === 400);
r = await call('/api/auth/activate', { method: 'POST', body: { token, password: 'MiClaveSegura1' } });
ok('activación crea contraseña y sesión', r.status === 200 && !!cookie);
r = await call('/api/auth/activate', { method: 'POST', body: { token, password: 'OtraClave12345' } });
ok('el enlace no se puede reutilizar', r.status === 410);
r = await call('/api/me');
ok('/api/me devuelve perfil', r.status === 200 && r.data.user.email === email && r.data.profile.onboarded === false);

// Preferencias
r = await call('/api/profile', { method: 'PUT', body: { salary_gross: 2500000, salary_currency: 'ARS', work_mode: 'remoto', schedule_types: ['full_time', 'freelancer', 'xx'], custom_block_name: 'Mi búsqueda', custom_keywords: ['contador', 'administración'], custom_exclusions: ['junior'] } });
ok('guarda preferencias', r.status === 200 && r.data.profile.work_mode === 'remoto' && r.data.profile.schedule_types.length === 2 && r.data.profile.salary_gross === 2500000);
r = await call('/api/profile', { method: 'PUT', body: { work_mode: 'volando' } });
ok('rechaza esquema inválido', r.status === 400);

// CV
const fd = new FormData();
fd.set('text', 'Luis Pérez. Administrativo contable senior con 10 años de experiencia en cobranzas, facturación electrónica, tesorería y Odoo. Licenciado en Administración. Automatización de procesos con Python.');
fd.set('file', new Blob(['CV de prueba']), 'cv.txt');
r = await call('/api/cv', { method: 'POST', form: fd });
ok('carga de CV aceptada', r.status === 202);
let st;
for (let i = 0; i < 20; i++) { await sleep(1000); st = (await call('/api/me')).data.profile; if (st.analysis_status === 'ready' || st.analysis_status === 'error') break; }
ok('el CV se analiza (plan B sin IA local)', st.analysis_status === 'ready' && st.analysis.bloques.length === 2, JSON.stringify(st).slice(0, 200));
r = await call('/api/blocks');
ok('hay 3 bloques: A y B de agentes, C del usuario', r.data.blocks.map((b) => b.key).join() === 'A,B,C' && r.data.blocks[2].origin === 'user' && r.data.blocks[2].name === 'Mi búsqueda');

// Ofertas manuales + estados + duplicados
r = await call('/api/offers', { method: 'POST', body: { title: 'Contador SSR', company: 'ACME', url: 'javascript:alert(1)' } });
ok('rechaza enlaces no http(s)', r.status === 400);
r = await call('/api/offers', { method: 'POST', body: { title: 'Contador SSR', company: 'ACME', url: 'https://example.com/a' } });
ok('agrega oferta manual', r.status === 201);
r = await call('/api/offers', { method: 'POST', body: { title: 'contador ssr', company: 'acme', url: 'https://otro.com/b' } });
ok('no duplica la misma oferta', r.status === 409);
let list = (await call('/api/offers')).data.offers;
const id = list.find((o) => o.title === 'Contador SSR').id;
r = await call(`/api/offers/${id}`, { method: 'PATCH', body: { status: 'enviado' } });
list = (await call('/api/offers?status=enviado')).data.offers;
ok('marcar Enviado la mueve a Enviadas', list.length === 1 && list[0].sent_at > 0);
await call(`/api/offers/${id}`, { method: 'PATCH', body: { notes: 'Me llamaron', followup_date: '2026-10-25' } });
list = (await call('/api/offers?status=enviado')).data.offers;
ok('notas y fecha de seguimiento', list[0].notes === 'Me llamaron' && list[0].followup_date === '2026-10-25');
r = await call(`/api/offers/${id}`, { method: 'PATCH', body: { status: 'descartado' } });
list = (await call('/api/offers?status=descartado')).data.offers;
ok('Descartado la mueve a Descartadas', list.length === 1);
r = await call('/api/offers', { method: 'POST', body: { title: 'Contador SSR', company: 'ACME', url: 'https://example.com/a' } });
ok('una oferta descartada no se puede volver a cargar', r.status === 409);
r = await call(`/api/offers/${id}`, { method: 'PATCH', body: { status: 'raro' } });
ok('estado inválido rechazado', r.status === 400);

// Actualización manual: sin acceso a portales debe fallar con gracia
r = await call('/api/sweep', { method: 'POST' });
ok('actualización manual responde sin romper', r.status === 200, JSON.stringify(r.data));

// Arrepentimiento (público)
const savedCookie = cookie; cookie = '';
r = await call('/api/arrepentimiento', { method: 'POST', body: { full_name: 'Ana Gómez', email: 'ana@example.com', service: 'LMH Búsqueda Laboral mensual', comment: '<b>x</b>' } });
ok('botón de arrepentimiento registra y devuelve código', r.status === 200 && /^ARR-\d{4}-[0-9A-F]{8}$/.test(r.data.code), JSON.stringify(r.data));
r = await call('/api/arrepentimiento', { method: 'POST', body: { full_name: '', email: 'x', service: '' } });
ok('arrepentimiento valida datos', r.status === 400);
cookie = savedCookie;

// Aislamiento y CSRF
r = await call('/api/offers/00000000-0000-0000-0000-000000000000', { method: 'PATCH', body: { status: 'enviado' } });
ok('no se puede tocar una oferta ajena/inexistente', r.status === 404);
r = await call('/api/profile', { method: 'PUT', body: { work_mode: 'remoto' }, headers: { origin: 'https://malo.example' } });
ok('rechaza origen distinto', r.status === 403);

// Login / logout / borrado de cuenta
await call('/api/auth/logout', { method: 'POST' });
r = await call('/api/me'); ok('logout cierra la sesión', r.status === 401);
r = await call('/api/auth/login', { method: 'POST', body: { email, password: 'incorrecta' } });
ok('login con clave incorrecta falla', r.status === 401);
r = await call('/api/auth/login', { method: 'POST', body: { email, password: 'MiClaveSegura1' } });
ok('login correcto', r.status === 200);
r = await call('/api/account', { method: 'DELETE', body: { password: 'incorrecta' } });
ok('borrar cuenta pide la contraseña', r.status === 403);
r = await call('/api/account', { method: 'DELETE', body: { password: 'MiClaveSegura1' } });
ok('borra la cuenta', r.status === 200);
r = await call('/api/auth/login', { method: 'POST', body: { email, password: 'MiClaveSegura1' } });
ok('la cuenta borrada ya no entra', r.status === 401);

const failed = results.filter((x) => !x[0]).length;
console.log(`\n${results.length - failed}/${results.length} OK`);
process.exit(failed ? 1 : 0);
