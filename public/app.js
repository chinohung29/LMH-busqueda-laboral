// LMH Empleo — interfaz. Sin build: JS plano. Todo el contenido externo se inserta con textContent.
'use strict';

const root = document.getElementById('root');
const state = { user: null, profile: null, blocks: [], offers: [], block: 'A', poll: null, billing: null, notice: '' };

/* ---------- utilidades ---------- */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}
const $ = (sel, el = document) => el.querySelector(sel);

async function api(path, { method = 'GET', body, form } = {}) {
  const init = { method, credentials: 'same-origin', headers: {} };
  if (form) init.body = form;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.user) { state.user = null; render(); }
    if (res.status === 402 && state.billing) { state.billing = { ...state.billing, access: false, state: state.billing.state === 'pending' ? 'pending' : 'expired' }; render(); }
    const err = new Error(data.error || 'Ocurrió un error. Probá de nuevo.');
    err.status = res.status;
    throw err;
  }
  return data;
}

function msg(el, text, kind) {
  el.className = `msg ${kind || ''}`;
  el.textContent = text;
  el.hidden = !text;
}
const fmtDate = (iso) => (iso ? iso.split('-').reverse().slice(0, 2).join('/') : null);
const route = () => (location.hash.replace(/^#\/?/, '') || '').split('/');

const WORK_MODES = [['indiferente', 'Indiferente'], ['remoto', 'Remoto'], ['hibrido', 'Híbrido'], ['presencial', 'Presencial']];
const SCHEDULES = [['full_time', 'Full time'], ['part_time', 'Part time'], ['freelancer', 'Freelancer']];

/* ---------- enlaces de búsqueda a portales que bloquean la lectura automática ---------- */
function portalLinks(query, mode) {
  const slug = query.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const q = encodeURIComponent(query);
  const wt = mode === 'remoto' ? '&f_WT=2' : mode === 'hibrido' ? '&f_WT=2%2C3' : '';
  return [
    ['Bumeran', `https://www.bumeran.com.ar/empleos-busqueda-${slug}.html`],
    ['Computrabajo', `https://ar.computrabajo.com/trabajo-de-${slug}`],
    ['LinkedIn', `https://www.linkedin.com/jobs/search/?keywords=${q}&location=Argentina&f_TPR=r1296000${wt}`],
    ['Indeed', `https://ar.indeed.com/jobs?q=${q}&l=Argentina&fromage=14`],
    ['ZonaJobs', `https://www.zonajobs.com.ar/empleos-busqueda-${slug}.html`],
  ];
}

/* ---------- pie y botón de arrepentimiento ---------- */
function arrepentimientoBtn() {
  return h('a', { class: 'btn arrep', href: '/arrepentimiento.html' }, 'Botón de arrepentimiento');
}
function siteFooter() {
  return h('footer', { class: 'site' },
    h('div', { class: 'links' },
      h('a', { href: '/terminos.html' }, 'Términos y Condiciones'),
      h('a', { href: '/privacidad.html' }, 'Política de Privacidad'),
      h('a', { href: '/arrepentimiento.html' }, 'Botón de arrepentimiento'),
      h('a', { href: 'https://www.argentina.gob.ar/produccion/defensadelconsumidor', target: '_blank', rel: 'noopener noreferrer' }, 'Defensa del Consumidor')),
    h('span', {}, 'LMH Empleo · una app de LMH Apps'));
}
function brand() {
  return h('a', { class: 'brand', href: '#/' }, h('img', { src: '/icons/logo-wide.png', alt: 'LMH' }), h('span', {}, 'LMH Empleo', h('small', {}, 'por LMH Apps')));
}

/* ---------- acceso ---------- */
function viewAuth() {
  const [r0, token] = route();
  if ((r0 === 'activar' || r0 === 'restablecer') && token) return viewPassword(r0, token);
  let mode = 'login';
  const box = h('div');
  const draw = () => {
    box.replaceChildren(mode === 'login' ? loginForm() : mode === 'signup' ? signupForm() : forgotForm());
  };
  const tabs = h('nav', { class: 'tabs' });
  const drawTabs = () => tabs.replaceChildren(...[['login', 'Ingresar'], ['signup', 'Crear cuenta']].map(([k, t]) =>
    h('a', { href: '#', 'aria-current': mode === k ? 'page' : null, onclick: (e) => { e.preventDefault(); mode = k; drawTabs(); draw(); } }, t)));
  const goForgot = () => { mode = 'forgot'; draw(); };
  function loginForm() {
    const out = h('p', { hidden: true });
    const email = h('input', { type: 'email', required: true, autocomplete: 'username', id: 'le' });
    const pass = h('input', { type: 'password', required: true, autocomplete: 'current-password', id: 'lp' });
    const btn = h('button', { class: 'primary', type: 'submit' }, 'Ingresar');
    return h('form', { onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true; msg(out, '');
      try { await api('/api/auth/login', { method: 'POST', body: { email: email.value, password: pass.value } }); await boot(); }
      catch (err) { msg(out, err.message, 'err'); btn.disabled = false; }
    } }, h('label', { for: 'le' }, 'Email'), email, h('label', { for: 'lp' }, 'Contraseña'), pass, out,
      h('p', {}, btn, ' ', h('button', { type: 'button', class: 'link', onclick: goForgot }, 'Olvidé mi contraseña')));
  }
  function signupForm() {
    const out = h('p', { hidden: true });
    const email = h('input', { type: 'email', required: true, autocomplete: 'email', id: 'se' });
    const t = h('input', { type: 'checkbox', required: true, id: 'tc' });
    const p = h('input', { type: 'checkbox', required: true, id: 'pp' });
    const btn = h('button', { class: 'primary', type: 'submit' }, 'Crear cuenta');
    return h('form', { onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true; msg(out, '');
      try {
        const r = await api('/api/auth/signup', { method: 'POST', body: { email: email.value, accept_terms: t.checked, accept_privacy: p.checked } });
        box.replaceChildren(h('div', { class: 'msg ok' }, r.message), h('p', { class: 'muted' }, 'Desde el enlace del mail vas a crear tu contraseña de acceso.'));
      } catch (err) { msg(out, err.message, 'err'); btn.disabled = false; }
    } },
      h('p', { class: 'muted' }, 'Te enviamos un enlace para validar tu email. Desde ahí creás tu contraseña.'),
      h('label', { for: 'se' }, 'Email'), email,
      h('label', { class: 'check', for: 'tc' }, t, h('span', {}, 'Leí y acepto los ', h('a', { href: '/terminos.html', target: '_blank' }, 'Términos y Condiciones'), '.')),
      h('label', { class: 'check', for: 'pp' }, p, h('span', {}, 'Leí y acepto la ', h('a', { href: '/privacidad.html', target: '_blank' }, 'Política de Privacidad'), '.')),
      out, h('p', {}, btn));
  }
  function forgotForm() {
    const out = h('p', { hidden: true });
    const email = h('input', { type: 'email', required: true, id: 'fe' });
    return h('form', { onsubmit: async (e) => {
      e.preventDefault();
      try { const r = await api('/api/auth/forgot', { method: 'POST', body: { email: email.value } }); msg(out, r.message, 'ok'); }
      catch (err) { msg(out, err.message, 'err'); }
    } }, h('p', { class: 'muted' }, 'Ingresá tu email y te enviamos un enlace para crear una contraseña nueva.'),
      h('label', { for: 'fe' }, 'Email'), email, out,
      h('p', {}, h('button', { class: 'primary', type: 'submit' }, 'Enviar enlace'), ' ', h('button', { type: 'button', class: 'link', onclick: () => { mode = 'login'; draw(); } }, 'Volver')));
  }
  drawTabs();
  draw();
  return h('div', {},
    h('div', { class: 'top' }, brand(), h('div', { class: 'right' }, arrepentimientoBtn())),
    h('div', { class: 'auth' },
      h('img', { class: 'brand-hero', src: '/icons/logo-wide.png', alt: 'LMH Apps' }),
      h('h1', {}, 'Tu búsqueda laboral, en tres bloques y sin repetidos'),
      h('p', { class: 'sub' }, 'Subí tu CV y nuestros agentes lo leen, buscan ofertas de empleo en Argentina que encajan con tu perfil y las actualizan todos los días después de las 7:00.'),
      h('div', { class: 'card' }, tabs, box)),
    siteFooter());
}

function viewPassword(kind, token) {
  const out = h('p', { hidden: true });
  const p1 = h('input', { type: 'password', minlength: 8, maxlength: 128, required: true, autocomplete: 'new-password', id: 'p1' });
  const p2 = h('input', { type: 'password', minlength: 8, maxlength: 128, required: true, autocomplete: 'new-password', id: 'p2' });
  const btn = h('button', { class: 'primary', type: 'submit' }, kind === 'activar' ? 'Crear contraseña y entrar' : 'Guardar contraseña');
  return h('div', {},
    h('div', { class: 'top' }, brand()),
    h('div', { class: 'auth' }, h('div', { class: 'card' },
      h('h1', {}, kind === 'activar' ? 'Email validado' : 'Nueva contraseña'),
      h('p', { class: 'sub' }, 'Creá tu contraseña de acceso (mínimo 8 caracteres).'),
      h('form', { onsubmit: async (e) => {
        e.preventDefault(); msg(out, '');
        if (p1.value !== p2.value) return msg(out, 'Las contraseñas no coinciden.', 'err');
        btn.disabled = true;
        try { await api('/api/auth/activate', { method: 'POST', body: { token, password: p1.value } }); location.hash = '#/'; await boot(); }
        catch (err) { msg(out, err.message, 'err'); btn.disabled = false; }
      } }, h('label', { for: 'p1' }, 'Contraseña'), p1, h('label', { for: 'p2' }, 'Repetí la contraseña'), p2, out, h('p', {}, btn)))),
    siteFooter());
}

/* ---------- formularios de perfil (se usan en el asistente y en "Mi perfil") ---------- */
function cvForm(onDone) {
  const out = h('p', { hidden: true });
  const file = h('input', { type: 'file', accept: '.pdf,.docx,.txt,.md', id: 'cvf' });
  const paste = h('textarea', { rows: 8, placeholder: 'O pegá acá el texto de tu CV', 'aria-label': 'Texto del CV' });
  const btn = h('button', { class: 'primary', type: 'submit' }, 'Analizar mi CV');
  return h('form', { onsubmit: async (e) => {
    e.preventDefault(); msg(out, ''); btn.disabled = true;
    try {
      const f = file.files[0];
      let text = paste.value.trim();
      if (f) text = await cvExtraer(f);
      if (!text) throw new Error('Adjuntá un archivo o pegá el texto de tu CV.');
      const fd = new FormData();
      fd.set('text', text);
      if (f) fd.set('file', f, f.name); else fd.set('name', 'CV pegado');
      await api('/api/cv', { method: 'POST', form: fd });
      await refreshMe();
      onDone && onDone();
    } catch (err) { msg(out, err.message, 'err'); btn.disabled = false; }
  } },
    h('p', { class: 'muted' }, 'PDF, DOCX, TXT o MD de hasta 8 MB. El texto se lee en tu dispositivo y el archivo se guarda cifrado en tu cuenta.'),
    h('label', { for: 'cvf' }, 'Archivo del CV'), file, paste, out, h('p', {}, btn));
}

function prefsForm(p, onDone) {
  const out = h('p', { hidden: true });
  const sal = h('input', { type: 'number', min: 0, step: 1000, inputmode: 'numeric', value: p.salary_gross ?? '', id: 'sg', placeholder: 'Ej: 2500000' });
  const cur = h('select', { 'aria-label': 'Moneda' }, ...['ARS', 'USD'].map((c) => h('option', { value: c, selected: p.salary_currency === c }, c)));
  const modes = WORK_MODES.map(([v, t]) => h('input', { type: 'radio', name: 'wm', value: v, checked: p.work_mode === v }));
  const scheds = SCHEDULES.map(([v]) => h('input', { type: 'checkbox', value: v, checked: p.schedule_types.includes(v) }));
  return h('form', { onsubmit: async (e) => {
    e.preventDefault(); msg(out, '');
    try {
      await api('/api/profile', { method: 'PUT', body: {
        salary_gross: sal.value === '' ? null : Number(sal.value), salary_currency: cur.value,
        work_mode: modes.find((m) => m.checked)?.value || 'indiferente', schedule_types: scheds.filter((s) => s.checked).map((s) => s.value),
      } });
      await refreshMe(); msg(out, 'Preferencias guardadas.', 'ok'); onDone && onDone();
    } catch (err) { msg(out, err.message, 'err'); }
  } },
    h('label', { for: 'sg' }, 'Sueldo pretendido bruto (mensual)'),
    h('div', { class: 'row' }, sal, cur),
    h('label', {}, 'Esquema de trabajo'),
    ...WORK_MODES.map(([, t], i) => h('label', { class: 'radio' }, modes[i], t)),
    h('label', {}, 'Tipo de horario (podés elegir más de uno)'),
    ...SCHEDULES.map(([, t], i) => h('label', { class: 'check' }, scheds[i], t)),
    out, h('p', {}, h('button', { class: 'primary', type: 'submit' }, 'Guardar preferencias')));
}

function customBlockForm(p, onDone) {
  const out = h('p', { hidden: true });
  const name = h('input', { type: 'text', maxlength: 60, value: p.custom_block_name || '', id: 'cbn', placeholder: 'Ej: Mi búsqueda de administración' });
  const kw = h('textarea', { rows: 3, id: 'cbk', placeholder: 'Una por línea o separadas por coma. Ej: analista contable, cobranzas, facturación' }, p.custom_keywords.join('\n'));
  const ex = h('textarea', { rows: 2, id: 'cbe', placeholder: 'Palabras que NO querés en el título. Ej: junior, call center' }, p.custom_exclusions.join('\n'));
  const split = (s) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
  return h('form', { onsubmit: async (e) => {
    e.preventDefault(); msg(out, '');
    try {
      await api('/api/profile', { method: 'PUT', body: { custom_block_name: name.value, custom_keywords: split(kw.value), custom_exclusions: split(ex.value) } });
      await refreshMe(); await loadAll(); msg(out, 'Bloque guardado. Se usa en la próxima actualización.', 'ok'); onDone && onDone();
    } catch (err) { msg(out, err.message, 'err'); }
  } },
    h('p', { class: 'muted' }, 'Los bloques A y B los arman los agentes leyendo tu CV. Este tercero lo definís vos.'),
    h('label', { for: 'cbn' }, 'Nombre del bloque'), name,
    h('label', { for: 'cbk' }, 'Qué querés buscar'), kw,
    h('label', { for: 'cbe' }, 'Qué querés excluir'), ex,
    out, h('p', {}, h('button', { class: 'primary', type: 'submit' }, 'Guardar mi bloque')));
}

/* ---------- asistente inicial ---------- */
function viewWizard() {
  const p = state.profile;
  let step = p.cv_name ? 1 : 0;
  const body = h('div');
  const titles = ['1. Cargá tu CV', '2. Contanos qué buscás', '3. Armá tu propio bloque'];
  const draw = () => {
    const forms = [
      () => p.cv_name ? h('div', {}, h('div', { class: 'msg ok' }, `CV cargado: ${p.cv_name}`), h('p', {}, h('button', { class: 'primary', onclick: () => { step = 1; draw(); } }, 'Continuar'))) : cvForm(() => { step = 1; draw(); }),
      () => prefsForm(state.profile, () => { step = 2; draw(); }),
      () => customBlockForm(state.profile, async () => { await api('/api/profile', { method: 'PUT', body: { onboarded: true } }); await refreshMe(); await loadAll(); render(); }),
    ];
    body.replaceChildren(h('h2', {}, titles[step]), forms[step](),
      step === 2 ? h('p', {}, h('button', { class: 'link', onclick: async () => { await api('/api/profile', { method: 'PUT', body: { onboarded: true } }); await refreshMe(); await loadAll(); render(); } }, 'Omitir por ahora')) : null);
  };
  draw();
  return h('div', {}, topBar(), h('h1', {}, 'Armemos tu búsqueda'), h('p', { class: 'sub' }, 'Tres pasos y tus agentes empiezan a trabajar.'), h('div', { class: 'card' }, body), siteFooter());
}

/* ---------- barra superior y navegación ---------- */
/* ---------- suscripción ---------- */
const money = (n, cur) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: cur || 'ARS', maximumFractionDigits: 0 }).format(n);
const fmtEpoch = (sec) => new Date(sec * 1000).toLocaleDateString('es-AR');
async function startCheckout(btn) {
  btn.disabled = true;
  try { location.href = (await api('/api/billing/checkout', { method: 'POST' })).url; }
  catch (e) { btn.disabled = false; alert(e.message); }
}
async function refreshBilling(btn) {
  btn.disabled = true;
  try { state.billing = (await api('/api/billing/refresh', { method: 'POST' })).billing; if (state.billing.access) await loadAll(); render(); }
  catch (e) { alert(e.message); } finally { btn.disabled = false; }
}
async function cancelSub() {
  if (!confirm('¿Cancelar la suscripción? Vas a poder seguir usando LMH Empleo hasta el final del período que ya pagaste.')) return;
  try { state.billing = (await api('/api/billing/cancel', { method: 'POST' })).billing; render(); } catch (e) { alert(e.message); }
}
function action(label, fn, cls) { const b = h('button', cls ? { class: cls } : {}, label); b.onclick = () => fn(b); return b; }
function billingBanner() {
  const b = state.billing;
  if (!b) return null;
  if (state.notice) { const n = state.notice; state.notice = ''; return h('p', { class: 'msg ok' }, n); }
  if (b.state === 'trial') {
    return h('div', { class: 'card banner' },
      h('div', {}, h('strong', {}, b.trial_days_left === 1 ? 'Prueba gratis: te queda 1 día.' : `Prueba gratis: te quedan ${b.trial_days_left} días.`),
        h('span', { class: 'muted' }, ` Después son ${money(b.price, b.currency)} por mes y cancelás cuando quieras.`)),
      action('Suscribirme', startCheckout, 'primary'));
  }
  if (b.state === 'cancelling' || b.state === 'paused') return h('p', { class: 'msg' }, `Tu suscripción está ${b.state === 'paused' ? 'pausada' : 'cancelada'}. Podés usar LMH Empleo hasta el ${fmtEpoch(b.paid_until)}.`);
  return null;
}
function viewPaywall() {
  const b = state.billing;
  const pending = b.state === 'pending';
  const n = state.notice; state.notice = '';
  return h('div', { class: 'auth paywall' },
    n ? h('p', { class: 'msg ok' }, n) : null,
    h('div', { class: 'card' },
      h('h1', {}, pending ? 'Esperando la confirmación del pago' : 'Terminó tu prueba gratuita'),
      pending
        ? h('p', { class: 'sub' }, 'Todavía no recibimos la confirmación de Mercado Pago. Si ya pagaste, puede demorar unos minutos: tocá «Actualizar estado».')
        : h('p', { class: 'sub' }, `Para seguir recibiendo tus ofertas todos los días, suscribite por ${money(b.price, b.currency)} al mes. Tu CV y tus ofertas guardadas se conservan.`),
      h('p', { class: 'price' }, money(b.price, b.currency), h('span', { class: 'muted' }, ' / mes')),
      b.payments_enabled ? null : h('p', { class: 'msg err' }, 'Los pagos todavía no están disponibles. Probá más tarde.'),
      h('p', {}, b.payments_enabled ? action(pending ? 'Reintentar el pago' : 'Suscribirme con Mercado Pago', startCheckout, 'primary') : null, ' ', action('Actualizar estado', refreshBilling)),
      h('p', { class: 'muted' }, 'Pagás con Mercado Pago. Cancelás cuando quieras desde tu perfil.')));
}
function subscriptionCard() {
  const b = state.billing;
  if (!b) return null;
  const price = money(b.price, b.currency);
  const lines = {
    trial: `Prueba gratis hasta el ${fmtEpoch(b.trial_ends_at)}. Después ${price} por mes.`,
    active: `Suscripción activa: ${price} por mes.${b.paid_until ? ` Próximo cobro: ${fmtEpoch(b.paid_until)}.` : ''}`,
    cancelling: `Suscripción cancelada. Tenés acceso hasta el ${b.paid_until ? fmtEpoch(b.paid_until) : 'final del período pago'}.`,
    paused: 'Suscripción pausada.',
  };
  return h('div', { class: 'card' }, h('h2', {}, 'Mi suscripción'), h('p', {}, lines[b.state] || ''),
    h('p', {}, b.state !== 'active' && b.payments_enabled ? action(`Suscribirme por ${price}/mes`, startCheckout, 'primary') : null, ' ',
      action('Actualizar estado', refreshBilling), ' ', b.can_cancel ? action('Cancelar suscripción', cancelSub, 'danger') : null));
}

function topBar() {
  const right = h('div', { class: 'right' }, arrepentimientoBtn());
  if (window.lmhInstall && window.lmhInstall.canPrompt()) right.append(h('button', { onclick: () => window.lmhInstall.prompt() }, 'Instalar app'));
  right.append(h('button', { onclick: async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); state.user = null; state.profile = null; render(); } }, 'Salir'));
  return h('div', { class: 'top' }, brand(), right);
}
function navTabs(cur) {
  const c = (s) => state.offers.filter((o) => o.status === s).length;
  const items = [['ofertas', 'Ofertas', c('pendiente')], ['enviadas', 'Enviadas', c('enviado')], ['descartadas', 'Descartadas', c('descartado')], ['perfil', 'Mi perfil'], ['ayuda', 'Ayuda']];
  return h('nav', { class: 'tabs' }, ...items.map(([k, t, n]) => h('a', { href: `#/${k}`, 'aria-current': cur === k ? 'page' : null }, t, n != null ? h('span', { class: 'n' }, String(n)) : null)));
}

/* ---------- ofertas ---------- */
async function setStatus(o, status) {
  const prev = { status: o.status, sent_at: o.sent_at, is_new: o.is_new };
  o.status = status; o.is_new = 0; o.sent_at = status === 'enviado' ? Math.floor(Date.now() / 1000) : null; o.updated_at = Math.floor(Date.now() / 1000);
  render();
  try { await api(`/api/offers/${o.id}`, { method: 'PATCH', body: { status } }); }
  catch (err) { Object.assign(o, prev); render(); alert(err.message); }
}

function offerItem(o, mode) {
  const meta = [o.company, o.modality, o.salary_text || (o.manual ? null : 'Sueldo a convenir'), o.published_at ? `Publicada ${fmtDate(o.published_at)}` : (o.manual ? null : 'Fecha sin verificar'), o.source].filter(Boolean).join(' · ');
  const btns = h('div', { class: 'status' }, ...[['pendiente', 'Pendiente'], ['enviado', 'Enviado'], ['descartado', 'Descartado']].map(([s, t]) =>
    h('button', { type: 'button', 'data-s': s, class: o.status === s ? 'active' : '', 'aria-pressed': String(o.status === s), onclick: () => o.status !== s && setStatus(o, s) }, t)));
  if (o.manual) btns.append(h('button', { type: 'button', title: 'Eliminar', 'aria-label': 'Eliminar oferta', onclick: async () => {
    if (!confirm('¿Eliminar esta oferta?')) return;
    await api(`/api/offers/${o.id}`, { method: 'DELETE' }).catch((e) => alert(e.message));
    state.offers = state.offers.filter((x) => x.id !== o.id); render();
  } }, '✕'));
  const info = h('div', { class: 'info' },
    h('div', { class: 'titulo' }, h('a', { href: o.url, target: '_blank', rel: 'noopener noreferrer' }, o.title)),
    h('div', { class: 'meta' }, o.is_new ? h('span', { class: 'tag new' }, 'Nueva') : null, o.below_salary ? h('span', { class: 'tag warn' }, 'Sueldo bajo tu pretensión') : null, meta));
  if (mode === 'enviadas') {
    const notes = h('textarea', { rows: 2, maxlength: 2000, placeholder: 'Notas del seguimiento (contacto, entrevista, respuesta…)', 'aria-label': 'Notas', value: o.notes || '' });
    notes.addEventListener('change', () => { o.notes = notes.value; api(`/api/offers/${o.id}`, { method: 'PATCH', body: { notes: notes.value } }).catch((e) => alert(e.message)); });
    const date = h('input', { type: 'date', 'aria-label': 'Fecha de seguimiento', value: o.followup_date || '' });
    date.addEventListener('change', () => { o.followup_date = date.value || null; api(`/api/offers/${o.id}`, { method: 'PATCH', body: { followup_date: date.value || null } }).catch((e) => alert(e.message)); });
    info.append(h('div', { class: 'extra' }, notes, h('div', {}, h('div', { class: 'muted' }, 'Próximo seguimiento'), date)));
  }
  return h('div', { class: `item ${o.status}` }, info, btns);
}

function viewOffers() {
  const p = state.profile;
  const st = p.analysis_status;
  const busy = st === 'pending' || st === 'running';
  const last = p.last_sweep_summary;
  const out = h('p', { hidden: true });
  const refresh = h('button', { disabled: st !== 'ready', onclick: async (e) => {
    e.target.disabled = true; msg(out, 'Buscando en los portales…', '');
    try { await api('/api/sweep', { method: 'POST' }); await loadAll(); render(); }
    catch (err) { msg(out, err.message, 'err'); e.target.disabled = false; }
  } }, 'Actualizar ahora');
  const lastTxt = p.last_sweep_at ? `Última actualización: ${new Date(p.last_sweep_at * 1000).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })}` : 'Todavía no hubo actualizaciones';
  const warn = last?.errors?.length && !Object.values(last.added || {}).some(Boolean) ? 'Algunos portales no respondieron; reintentamos automáticamente.' : null;

  const blk = state.blocks.find((b) => b.key === state.block) || state.blocks[0];
  const list = state.offers.filter((o) => o.status === 'pendiente' && o.block === blk?.key).sort((a, b) => b.is_new - a.is_new || b.score - a.score || b.first_seen_at - a.first_seen_at);

  const btabs = h('div', { class: 'blocktabs', role: 'group', 'aria-label': 'Bloques' }, ...state.blocks.map((b) =>
    h('button', { 'aria-pressed': String(b.key === state.block), onclick: () => { state.block = b.key; render(); } }, `${b.key === 'C' ? '★ ' : ''}${b.name} (${state.offers.filter((o) => o.status === 'pendiente' && o.block === b.key).length})`)));

  const links = blk?.queries.length ? h('details', {}, h('summary', { class: 'muted', style: 'cursor:pointer' }, 'Buscar a mano en los portales (Bumeran, Computrabajo, LinkedIn…)'),
    ...blk.queries.map((q) => h('div', { class: 'chips' }, h('span', { class: 'muted' }, `“${q}”`), ...portalLinks(q, p.work_mode).map(([n, u]) => h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, n))))) : null;

  const addForm = blk?.key === 'C' ? (() => {
    const o = (ph, t) => h('input', { type: t || 'text', placeholder: ph, required: ph.startsWith('Puesto') || ph.startsWith('Enlace'), 'aria-label': ph });
    const [ti, co, ur] = [o('Puesto'), o('Empresa'), o('Enlace del aviso (https://…)', 'url')];
    return h('form', { class: 'add', onsubmit: async (e) => {
      e.preventDefault();
      try { await api('/api/offers', { method: 'POST', body: { title: ti.value, company: co.value, url: ur.value, block: 'C' } }); await loadAll(); render(); }
      catch (err) { alert(err.message); }
    } }, ti, co, ur, h('button', { type: 'submit' }, 'Agregar oferta'));
  })() : null;

  return h('div', {},
    h('div', { class: 'status-line' }, h('span', {}, busy ? h('span', {}, h('span', { class: 'spinner' }), 'Los agentes están leyendo tu CV y buscando ofertas…') : lastTxt), refresh),
    out, warn ? h('p', { class: 'msg' }, warn) : null,
    st === 'error' ? h('p', { class: 'msg err' }, p.analysis_error || 'No se pudo analizar el CV.') : null,
    !p.cv_name ? h('div', { class: 'msg' }, 'Todavía no cargaste tu CV. ', h('a', { href: '#/perfil' }, 'Cargalo en Mi perfil'), ' para que los agentes busquen por vos.') : null,
    btabs,
    blk ? h('div', {}, h('p', { class: 'muted' }, (blk.origin === 'agent' ? 'Armado por los agentes a partir de tu CV. ' : '') + (blk.description || '')), links) : null,
    list.length ? list.map((o) => offerItem(o, 'ofertas')) : h('div', { class: 'empty' }, busy ? 'Enseguida aparecen las primeras ofertas.' : 'No hay ofertas pendientes en este bloque. Se actualiza todos los días después de las 7:00.'),
    addForm);
}

function viewSent() {
  const list = state.offers.filter((o) => o.status === 'enviado').sort((a, b) => (b.sent_at || 0) - (a.sent_at || 0));
  return h('div', {}, h('h2', {}, 'Postulaciones enviadas'), h('p', { class: 'sub' }, 'Las ofertas en las que ya completaste el proceso. Anotá cómo va cada una y cuándo hacer seguimiento.'),
    list.length ? list.map((o) => offerItem(o, 'enviadas')) : h('div', { class: 'empty' }, 'Todavía no marcaste ninguna oferta como enviada.'));
}
function viewDiscarded() {
  const list = state.offers.filter((o) => o.status === 'descartado').sort((a, b) => b.updated_at - a.updated_at);
  return h('div', {}, h('h2', {}, 'Ofertas descartadas'), h('p', { class: 'sub' }, 'No vuelven a aparecer en las actualizaciones diarias. Si cambiás de opinión, devolvelas a Pendiente.'),
    list.length ? list.map((o) => offerItem(o, 'descartadas')) : h('div', { class: 'empty' }, 'No descartaste ninguna oferta.'));
}

/* ---------- mi perfil ---------- */
function viewProfile() {
  const p = state.profile;
  const a = p.analysis;
  const del = () => {
    const pw = prompt('Para borrar tu cuenta y todos tus datos (incluido el CV), escribí tu contraseña:');
    if (!pw) return;
    api('/api/account', { method: 'DELETE', body: { password: pw } }).then(() => { state.user = null; render(); }).catch((e) => alert(e.message));
  };
  return h('div', {},
    h('div', { class: 'card' }, h('h2', {}, 'Mi CV'),
      p.cv_name ? h('p', {}, `Cargado: ${p.cv_name}`, p.cv_updated_at ? ` (${new Date(p.cv_updated_at * 1000).toLocaleDateString('es-AR')})` : '') : h('p', { class: 'muted' }, 'Todavía no cargaste tu CV.'),
      a ? h('div', {}, h('p', {}, a.resumen), h('p', { class: 'muted' }, `Nivel: ${a.seniority}${a.anios_experiencia != null ? ` · ${a.anios_experiencia} años de experiencia` : ''}`),
        a.habilidades.length ? h('p', {}, a.habilidades.map((s) => h('span', { class: 'tag' }, s))) : null,
        a.estudios.length ? h('p', { class: 'muted' }, 'Estudios: ' + a.estudios.join(' · ')) : null,
        a.fortalezas.length ? h('p', { class: 'muted' }, 'Fortalezas: ' + a.fortalezas.join(' · ')) : null,
        a.oportunidades.length ? h('p', { class: 'muted' }, 'Para reforzar: ' + a.oportunidades.join(' · ')) : null) : null,
      h('h3', {}, p.cv_name ? 'Reemplazar mi CV' : 'Cargar mi CV'), cvForm(() => { location.hash = '#/ofertas'; }),
      p.cv_name ? h('p', {}, h('button', { onclick: async () => { try { await api('/api/cv/reanalyze', { method: 'POST' }); await refreshMe(); location.hash = '#/ofertas'; } catch (e) { alert(e.message); } } }, 'Volver a analizar el CV')) : null),
    h('div', { class: 'card' }, h('h2', {}, 'Qué estoy buscando'), prefsForm(p)),
    h('div', { class: 'card' }, h('h2', {}, 'Mi bloque de búsqueda'), customBlockForm(p)),
    subscriptionCard(),
    h('div', { class: 'card' }, h('h2', {}, 'Mi cuenta'), h('p', { class: 'muted' }, state.user.email),
      h('p', {}, h('button', { class: 'danger', onclick: del }, 'Borrar mi cuenta y mis datos'))));
}

/* ---------- ayuda y tutorial ---------- */
const TUTORIAL = [
  ['Bienvenido/a a LMH Empleo', 'Cargás tu CV una vez y los agentes buscan por vos, todos los días, en portales de empleo de Argentina. Vos solo revisás y te postulás.'],
  ['1. Tu CV', 'Subí tu CV en PDF, DOCX o TXT. Los agentes leen tu perfil, habilidades, experiencia y estudios, y entienden qué te conviene buscar.'],
  ['2. Tres bloques de búsqueda', 'Los bloques A y B los arman los agentes a partir de tu CV. El bloque ★ lo definís vos con tus propias palabras clave y exclusiones.'],
  ['3. Pendiente, Enviado, Descartado', 'Al lado de cada oferta tenés tres botones. Pendiente: para revisar. Enviado: ya te postulaste. Descartado: no te interesa.'],
  ['4. Enviadas y Descartadas', 'En “Enviadas” seguís cada postulación con notas y fecha de seguimiento. “Descartadas” guarda lo que no querés volver a ver.'],
  ['5. Actualización diaria', 'Todos los días después de las 7:00 (hora de Argentina) los agentes buscan ofertas nuevas. Nunca repiten las que ya enviaste o descartaste.'],
  ['6. Instalala en tu celular', 'Desde el menú de tu navegador elegí “Agregar a pantalla de inicio” o el botón “Instalar app”. Podés repetir este tutorial desde Ayuda.'],
];

function showTutorial(onClose) {
  let i = 0;
  const body = h('div');
  const close = async () => { ov.remove(); try { await api('/api/profile', { method: 'PUT', body: { tutorial_done: true } }); await refreshMe(); } catch {} onClose && onClose(); };
  const draw = () => {
    const [t, d] = TUTORIAL[i];
    body.replaceChildren(h('h2', {}, t), h('p', {}, d), h('div', { class: 'dots' }, ...TUTORIAL.map((_, k) => h('i', { class: k === i ? 'on' : '' }))),
      h('div', { class: 'actions' }, h('button', { class: 'link', onclick: close }, 'Saltar tutorial'),
        h('div', {}, i > 0 ? h('button', { onclick: () => { i--; draw(); } }, 'Atrás') : null, ' ',
          i < TUTORIAL.length - 1 ? h('button', { class: 'primary', onclick: () => { i++; draw(); } }, 'Siguiente') : h('button', { class: 'primary', onclick: close }, 'Empezar'))));
  };
  const ov = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Tutorial' }, h('div', { class: 'modal' }, body));
  document.body.append(ov);
  draw();
  $('button.primary', ov)?.focus();
}

function viewHelp() {
  const sec = (t, ...c) => h('details', { class: 'manual' }, h('summary', {}, t), ...c);
  return h('div', {},
    h('h2', {}, 'Manual de uso'),
    h('p', {}, h('button', { class: 'primary', onclick: () => showTutorial() }, 'Ver el tutorial de nuevo')),
    sec('¿Qué hace LMH Empleo?', h('p', {}, 'Lee tu CV, entiende tu perfil y busca ofertas de empleo en Argentina que encajan. Ordena todo en tres bloques y te ahorra repetir las mismas búsquedas todos los días.')),
    sec('Cargar o cambiar el CV', h('p', {}, 'En Mi perfil podés subir un CV nuevo cuando quieras. Los bloques A y B se rehacen y la próxima actualización busca con el perfil nuevo.')),
    sec('Preferencias de búsqueda', h('p', {}, 'Sueldo pretendido bruto, esquema de trabajo (presencial, híbrido, remoto o indiferente) y tipo de horario (part time, full time, freelancer). Las ofertas que no coinciden con el esquema se descartan solas; las que publican un sueldo por debajo de tu pretensión se marcan.')),
    sec('Los tres bloques', h('p', {}, 'A y B: armados por los agentes. ★: tu bloque, con tus palabras clave. También podés agregar a mano ofertas que encontraste por tu cuenta en el bloque ★.')),
    sec('Pendiente, Enviado, Descartado', h('ul', {}, h('li', {}, 'Pendiente: ofertas para revisar.'), h('li', {}, 'Enviado: ya te postulaste; pasa a la pestaña Enviadas.'), h('li', {}, 'Descartado: no te interesa; pasa a Descartadas y no vuelve a aparecer.'))),
    sec('Seguimiento de postulaciones', h('p', {}, 'En Enviadas anotá novedades y elegí una fecha para volver a contactar.')),
    sec('Actualización diaria', h('p', {}, 'Todos los días después de las 7:00 (hora de Argentina) los agentes actualizan tus bloques con ofertas de los últimos 15 días, sin repetir lo que ya está en tu lista. También podés tocar “Actualizar ahora” (hasta 4 veces por día).')),
    sec('Portales que no se pueden leer automáticamente', h('p', {}, 'Bumeran, Computrabajo, LinkedIn y ZonaJobs bloquean la lectura automática. En cada bloque tenés enlaces directos con tu búsqueda ya armada para abrirlos con un toque.')),
    sec('Tus datos', h('p', {}, 'Podés borrar tu cuenta y todos tus datos (incluido el CV) desde Mi perfil. Más detalles en la Política de Privacidad. Los avisos pertenecen a sus portales: confirmá modalidad y sueldo antes de postularte.')),
    sec('Arrepentimiento', h('p', {}, 'Si contrataste un servicio pago a distancia, tenés 10 días corridos para arrepentirte con el botón “Botón de arrepentimiento” (arriba y al pie de cada pantalla).')));
}

/* ---------- arranque ---------- */
async function refreshMe() {
  const d = await api('/api/me');
  state.user = d.user; state.profile = d.profile; state.billing = d.billing;
  schedulePoll();
}
async function loadAll() {
  const [b, o] = await Promise.all([api('/api/blocks'), api('/api/offers')]);
  state.blocks = b.blocks; state.offers = o.offers;
  if (!state.blocks.some((x) => x.key === state.block)) state.block = 'A';
}
function schedulePoll() {
  clearTimeout(state.poll);
  const s = state.profile?.analysis_status;
  if (s === 'pending' || s === 'running') {
    state.poll = setTimeout(async () => {
      try { await refreshMe(); await loadAll(); render(); } catch {}
    }, 4000);
  }
}

function render() {
  clearTimeout(state.poll);
  root.replaceChildren();
  if (!state.user) { root.append(viewAuth()); return; }
  if (state.billing && !state.billing.access) { root.append(topBar(), viewPaywall(), siteFooter()); return; }
  schedulePoll();
  if (!state.profile.onboarded) { root.append(viewWizard()); return; }
  const r = route()[0] || 'ofertas';
  const views = { ofertas: viewOffers, enviadas: viewSent, descartadas: viewDiscarded, perfil: viewProfile, ayuda: viewHelp };
  const cur = views[r] ? r : 'ofertas';
  root.append(...[topBar(), navTabs(cur), billingBanner(), views[cur](), siteFooter()].filter(Boolean));
  if (!state.profile.tutorial_done && !document.querySelector('.overlay')) showTutorial();
}

// Pantalla de carga (solo celular): se muestra un mínimo de 1,5 s y se desvanece al aparecer la primera vista.
function hideSplash() {
  const el = document.getElementById('splash');
  if (!el) return;
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 600); }, Math.max(0, 1500 - performance.now()));
}

async function boot() {
  const returning = location.pathname === '/suscripcion';   // vuelta desde Mercado Pago
  if (returning) history.replaceState(null, '', '/#/perfil');
  try {
    await refreshMe();
    if (returning) {
      try {
        state.billing = (await api('/api/billing/refresh', { method: 'POST' })).billing;
        state.notice = state.billing.state === 'active' ? '¡Listo! Tu suscripción está activa.'
          : 'Estamos esperando la confirmación de Mercado Pago. Si ya pagaste, tocá «Actualizar estado» en un minuto.';
      } catch { /* se puede reintentar desde «Actualizar estado» */ }
    }
    if (state.billing?.access) await loadAll();
  } catch { state.user = null; }
  render();
  hideSplash();
}

window.addEventListener('hashchange', render);
window.addEventListener('lmh-install-change', () => { if (state.user) render(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
