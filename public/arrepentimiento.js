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
    done.append(h, p1, p2);
  } catch (err) {
    show(err.message, 'err');
    btn.disabled = false;
  }
});
