'use strict';
const f = document.getElementById('f');
const out = document.getElementById('out');
const done = document.getElementById('done');
const show = (t, k) => { out.textContent = t; out.className = `msg ${k || ''}`; out.hidden = !t; };

f.addEventListener('submit', async (e) => {
  e.preventDefault();
  show('');
  const btn = document.getElementById('send');
  const body = {
    full_name: f.full_name.value, email: f.email.value, service: f.service.value,
    contracted_on: f.contracted_on.value || null, comment: f.comment.value,
  };
  if (!body.full_name.trim() || !body.email.trim() || !body.service.trim()) return show('Completá nombre, email y servicio.', 'err');
  btn.disabled = true;
  try {
    const res = await fetch('/api/arrepentimiento', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'No pudimos registrar el pedido. Probá de nuevo.');
    f.hidden = true;
    done.hidden = false;
    done.replaceChildren();
    const h = document.createElement('h2'); h.textContent = 'Pedido registrado';
    const p1 = document.createElement('p'); p1.textContent = `Tu código es ${data.code}. Fecha y hora: ${data.when}.`;
    const p2 = document.createElement('p'); p2.textContent = 'Te enviamos la constancia por email. Guardá el código.';
    const p3 = document.createElement('p');
    p3.textContent = data.cancelled ? 'Cancelamos tu suscripción: no se harán nuevos cobros.'
      : data.confirm_by_mail ? 'Para cancelar ahora mismo tu suscripción, confirmalo desde el enlace que te mandamos por email (vale 7 días).'
      : 'No encontramos una suscripción activa asociada a ese email.';
    done.append(h, p1, p2, p3);
  } catch (err) {
    show(err.message, 'err');
    btn.disabled = false;
  }
});

// Enlace del mail: ?confirmar=TOKEN → botón para cancelar la suscripción.
const token = new URLSearchParams(location.search).get('confirmar');
if (token && /^[0-9a-f]{64}$/.test(token)) {
  const box = document.getElementById('confirm');
  f.hidden = true; box.hidden = false;
  const h = document.createElement('h2'); h.textContent = 'Confirmar cancelación de la suscripción';
  const p = document.createElement('p'); p.textContent = 'Al confirmar, cancelamos tu suscripción y no se harán nuevos cobros.';
  const msg = document.createElement('p'); msg.className = 'msg'; msg.hidden = true;
  const b = document.createElement('button'); b.className = 'primary'; b.type = 'button'; b.textContent = 'Cancelar mi suscripción';
  b.addEventListener('click', async () => {
    b.disabled = true; msg.hidden = true;
    try {
      const res = await fetch('/api/arrepentimiento/confirmar', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'No pudimos confirmar. Probá de nuevo.');
      msg.textContent = data.cancelled ? `Listo: tu suscripción quedó cancelada (pedido ${data.code}).` : 'No pudimos cancelarla desde acá. Cancelala desde Mi perfil o escribinos y lo resolvemos.';
      msg.className = `msg ${data.cancelled ? 'ok' : 'err'}`; msg.hidden = false;
      if (data.cancelled) b.hidden = true; else b.disabled = false;
    } catch (err) { msg.textContent = err.message; msg.className = 'msg err'; msg.hidden = false; b.disabled = false; }
  });
  box.append(h, p, b, msg);
}
