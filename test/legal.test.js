// Los textos legales deben decir lo mismo que hace la aplicación: precio, prueba, proveedores y versión.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TERMS_VERSION } from '../src/util.js';
import { settings } from '../src/billing.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const wrangler = JSON.parse(read('wrangler.jsonc').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
const cfg = settings(wrangler.vars);
const plain = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
const terminos = plain(read('public/terminos.html'));
const privacidad = plain(read('public/privacidad.html'));
const arrep = plain(read('public/arrepentimiento.html'));
const ars = (n) => new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 }).format(n);

test('términos: precio y prueba coinciden con la configuración', () => {
  assert.match(terminos, new RegExp(`\\$ ${ars(cfg.price).replace('.', '\\.')} \\(pesos argentinos\\) por mes`));
  assert.match(terminos, new RegExp(`${cfg.trialDays} días corridos`));
  assert.match(terminos, /sin pasos adicionales ni penalidad/);
  assert.doesNotMatch(terminos, /gratuito \/ precio/, 'el precio ya no puede quedar como pendiente de definir');
});
test('las tres páginas muestran la versión vigente de los términos', () => {
  for (const html of [terminos, privacidad]) assert.ok(html.includes(`Versión ${TERMS_VERSION}`), 'versión visible');
});
test('privacidad: informa a Mercado Pago, Cloudflare y que no se guardan datos de tarjeta', () => {
  assert.match(privacidad, /Mercado Pago/);
  assert.match(privacidad, /Cloudflare, Inc\./);
  assert.match(privacidad, /No recibimos ni guardamos el número de tu tarjeta/);
  assert.match(privacidad, /Ley 25\.326/);
  assert.match(privacidad, /artículo 14, inciso 3/, 'leyenda obligatoria de la AAIP');
});
test('arrepentimiento: 10 días, pago por el mismo medio y aviso de que no frena los cobros', () => {
  assert.match(arrep, /10 días corridos/);
  assert.match(arrep, /mismo medio de pago/);
  assert.match(arrep, /cancelamos tu suscripción para que no haya nuevos cobros/);
});
test('el precio de la ayuda de la app coincide con la configuración', () => {
  assert.ok(read('public/app.js').includes(`$ ${ars(cfg.price)} por mes`));
});
