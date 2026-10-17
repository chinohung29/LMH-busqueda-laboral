// Conectores de portales. Cada uno devuelve ofertas normalizadas:
// { title, company, modality, salaryText, salary:{currency,max,min}|null, publishedAt:'YYYY-MM-DD'|null, url, source, text }
//
// Bumeran, Computrabajo, ZonaJobs y LinkedIn bloquean la lectura automatizada: para ellos la app
// genera enlaces de búsqueda ya filtrados (ver portalLinks en public/app.js). Para sumar más
// portales con API oficial, agregar un conector acá y registrarlo en CONNECTORS.
import { cleanUrl } from './util.js';

const UA = 'LMH-Empleo/1.0 (+https://lmhapps.com)';

export function guessModality(...texts) {
  const t = texts.filter(Boolean).join(' ').toLowerCase();
  if (/h[ií]brid/.test(t)) return 'Híbrido';
  if (/remot|home ?office|teletrabajo|work from home/.test(t)) return 'Remoto';
  if (/presencial|on-?site/.test(t)) return 'Presencial';
  return '';
}

function toNumber(s) {
  const str = s.replace(/\s/g, '');
  if (/^\d{1,3}([.,]\d{3})+$/.test(str)) return Number(str.replace(/[.,]/g, ''));
  return Number(str.replace(',', '.'));
}

// "$ 1.200.000 - 1.500.000" / "USD 2.500 a 3.500" → { currency, min, max }
export function parseSalary(text) {
  if (!text) return null;
  const nums = (String(text).match(/\d[\d.,]*/g) ?? []).map(toNumber).filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) return null;
  const usd = /usd|u\$s|us\$|d[oó]lar/i.test(text);
  return { currency: usd ? 'USD' : 'ARS', min: Math.min(...nums), max: Math.max(...nums) };
}

function dateOnly(value) {
  if (value == null || value === '') return null;
  const d = typeof value === 'number' ? new Date(value * (value < 1e12 ? 1000 : 1)) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

async function getJson(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { 'user-agent': UA, accept: 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const stripHtml = (s) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

// Get on Board: API pública, orientada a tecnología / automatización / producto.
async function getOnBoard(query) {
  const url = `https://www.getonbrd.com/api/v0/search/jobs?query=${encodeURIComponent(query)}&per_page=25&expand=${encodeURIComponent('["company"]')}`;
  const data = await getJson(url);
  const out = [];
  for (const j of data?.data ?? []) {
    const a = j.attributes ?? {};
    const link = cleanUrl(j.links?.public_url);
    if (!a.title || !link) continue;
    const countries = Array.isArray(a.countries) ? a.countries.map((c) => String(c).toLowerCase()) : [];
    const modeRaw = String(a.remote_modality ?? '').toLowerCase();
    const modality = modeRaw.includes('fully') ? 'Remoto' : modeRaw.includes('hybrid') ? 'Híbrido' : modeRaw.includes('no_remote') ? 'Presencial' : guessModality(a.title);
    // Se descartan los avisos que declaran países y no incluyen Argentina (salvo remoto sin restricción).
    if (countries.length && !countries.some((c) => c.includes('argentina') || c === 'ar') && modality !== 'Remoto') continue;
    const min = a.min_salary, max = a.max_salary;
    out.push({
      title: stripHtml(a.title),
      company: stripHtml(a.company?.data?.attributes?.name ?? ''),
      modality,
      salaryText: min || max ? `USD ${min ?? ''}${min && max ? ' a ' : ''}${max ?? ''} por mes` : null,
      salary: min || max ? { currency: 'USD', min: Number(min || max), max: Number(max || min) } : null,
      publishedAt: dateOnly(a.published_at),
      url: link,
      source: 'Get on Board',
      text: stripHtml(`${a.title} ${a.description ?? ''} ${a.functions ?? ''} ${a.desirable ?? ''}`).slice(0, 4000),
    });
  }
  return out;
}

// Jooble: agrega varios portales. Requiere clave gratuita (secreto JOOBLE_API_KEY).
async function jooble(query, env) {
  if (!env.JOOBLE_API_KEY) return [];
  const data = await getJson(`https://jooble.org/api/${env.JOOBLE_API_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keywords: query, location: 'Argentina', page: 1 }),
  });
  const out = [];
  for (const j of data?.jobs ?? []) {
    const link = cleanUrl(j.link);
    if (!j.title || !link) continue;
    out.push({
      title: stripHtml(j.title),
      company: stripHtml(j.company ?? ''),
      modality: guessModality(j.title, j.location, j.snippet, j.type),
      salaryText: j.salary ? stripHtml(j.salary) : null,
      salary: parseSalary(j.salary),
      publishedAt: dateOnly(j.updated),
      url: link,
      source: j.source ? `Jooble · ${stripHtml(j.source)}` : 'Jooble',
      text: stripHtml(`${j.title} ${j.snippet ?? ''} ${j.type ?? ''}`).slice(0, 4000),
    });
  }
  return out;
}

export const CONNECTORS = [
  { name: 'getonboard', run: (q) => getOnBoard(q) },
  { name: 'jooble', run: (q, env) => jooble(q, env) },
];
