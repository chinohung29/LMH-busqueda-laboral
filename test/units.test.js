import test from 'node:test';
import assert from 'node:assert/strict';
import { passesFilters, scoreOffer, belowExpectation, dedupeKey, ageDays } from '../src/sweep.js';
import { parseSalary, guessModality } from '../src/sources.js';
import { sanitizeAnalysis, fallbackAnalysis, blocksOf } from '../src/ai.js';
import { todayART, isEmail, cleanUrl } from '../src/util.js';

const block = { key: 'A', keywords: ['cobranzas', 'facturación', 'odoo'], exclude: ['junior', 'trainee'] };
const prefs = { work_mode: 'remoto', schedule_types: '["full_time"]', salary_gross: 2500000, salary_currency: 'ARS' };
const offer = (o = {}) => ({ title: 'Analista de Cobranzas SSR', company: 'ACME', modality: 'Remoto', text: 'Cobranzas y facturación en Odoo. Full time.', publishedAt: '2026-10-14', url: 'https://x.com/1', ...o });

test('antigüedad: hasta 15 días pasa, más no; sin fecha pasa', () => {
  assert.equal(passesFilters(offer({ publishedAt: '2026-10-02' }), block, prefs, '2026-10-17').ok, true);
  assert.equal(passesFilters(offer({ publishedAt: '2026-10-01' }), block, prefs, '2026-10-17').ok, false);
  assert.equal(passesFilters(offer({ publishedAt: null }), block, prefs, '2026-10-17').ok, true);
});
test('modalidad según preferencia', () => {
  assert.equal(passesFilters(offer({ modality: 'Presencial' }), block, prefs, '2026-10-17').ok, false);
  assert.equal(passesFilters(offer({ modality: 'Híbrido' }), block, prefs, '2026-10-17').ok, false);
  assert.equal(passesFilters(offer({ modality: '' }), block, prefs, '2026-10-17').ok, true);
  assert.equal(passesFilters(offer({ modality: 'Híbrido' }), block, { ...prefs, work_mode: 'hibrido' }, '2026-10-17').ok, true);
  assert.equal(passesFilters(offer({ modality: 'Presencial' }), block, { ...prefs, work_mode: 'indiferente' }, '2026-10-17').ok, true);
});
test('exclusiones por título (palabra completa)', () => {
  assert.equal(passesFilters(offer({ title: 'Cobranzas Junior' }), block, prefs, '2026-10-17').ok, false);
  assert.equal(passesFilters(offer({ title: 'Analista Juniorizado' }), block, prefs, '2026-10-17').ok, true);
});
test('puntaje y sueldo', () => {
  assert.ok(scoreOffer(offer(), block, prefs) > scoreOffer(offer({ title: 'Chofer', text: 'Manejar' }), block, prefs));
  assert.equal(belowExpectation({ salary: { currency: 'ARS', max: 1000000 } }, prefs), true);
  assert.equal(belowExpectation({ salary: { currency: 'USD', max: 10 } }, prefs), false);
  assert.equal(belowExpectation({ salary: null }, prefs), false);
});
test('duplicados: misma oferta en distinto portal da la misma clave', async () => {
  const a = await dedupeKey(offer({ url: 'https://a.com/1' }));
  const b = await dedupeKey(offer({ url: 'https://b.com/zz', title: 'ANALISTA de cobranzas  SSR', company: 'acme' }));
  const c = await dedupeKey(offer({ company: 'OTRA' }));
  assert.equal(a, b);
  assert.notEqual(a, c);
});
test('parseSalary y modalidad', () => {
  assert.deepEqual(parseSalary('$ 1.200.000 - 1.500.000'), { currency: 'ARS', min: 1200000, max: 1500000 });
  assert.deepEqual(parseSalary('USD 2.500 a 3.500 por mes'), { currency: 'USD', min: 2500, max: 3500 });
  assert.equal(parseSalary('A convenir'), null);
  assert.equal(guessModality('Trabajo híbrido en CABA'), 'Híbrido');
  assert.equal(guessModality('100% remoto'), 'Remoto');
});
test('análisis: saneado, bloques y fallback', () => {
  assert.equal(sanitizeAnalysis({ bloques: [{ consultas: ['a'] }] }), null);
  const ok = sanitizeAnalysis({ seniority: 'senior', bloques: [{ nombre: 'X', consultas: ['cobranzas'] }, { nombre: 'Y', consultas: ['odoo funcional'] }] });
  assert.equal(ok.bloques.length, 2);
  assert.ok(ok.bloques[0].excluir.includes('junior'));
  const fb = fallbackAnalysis('Experiencia en cobranzas, facturación electrónica, Odoo, contabilidad, cobranzas, Odoo, facturación, proveedores, tesorería.');
  assert.equal(fb.bloques.length, 2);
  const blocks = blocksOf({ analysis: JSON.stringify(ok), custom_keywords: '["contador"]', custom_exclusions: '[]', custom_block_name: 'Mía' });
  assert.deepEqual(blocks.map((b) => b.key), ['A', 'B', 'C']);
  assert.equal(blocks[2].origin, 'user');
});
test('utilidades', () => {
  assert.match(todayART(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(todayART(new Date('2026-10-17T02:30:00Z')), '2026-10-16'); // 23:30 ART del día anterior
  assert.equal(todayART(new Date('2026-10-17T10:05:00Z')), '2026-10-17'); // 07:05 ART
  assert.equal(isEmail('a@b.co'), true);
  assert.equal(isEmail('a@b'), false);
  assert.equal(cleanUrl('javascript:alert(1)'), null);
  assert.ok(cleanUrl('https://x.com/a'));
  assert.equal(ageDays('2026-10-10', '2026-10-17'), 7);
});
