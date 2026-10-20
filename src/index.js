// LMH Búsqueda Laboral — Worker principal: API (/api/*) + cron diario. La PWA estática la sirve Workers Assets.
import { json, fail } from './util.js';
import * as auth from './auth.js';
import * as api from './api.js';
import * as billing from './billing.js';
import { runDailySweep } from './sweep.js';
import { sendNoticeEmails } from './pricing.js';

// Defensa CSRF adicional: las escrituras solo se aceptan del mismo origen.
function sameOrigin(request) {
  const origin = request.headers.get('origin');
  return !origin || origin === new URL(request.url).origin;
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(request)) return fail('Origen no permitido.', 403);

  // Públicos
  if (method === 'POST' && pathname === '/api/auth/signup') return auth.signup(env, request);
  if (method === 'POST' && pathname === '/api/auth/activate') return auth.activate(env, request);
  if (method === 'POST' && pathname === '/api/auth/login') return auth.login(env, request);
  if (method === 'POST' && pathname === '/api/auth/forgot') return auth.forgot(env, request);
  if (method === 'POST' && pathname === '/api/auth/logout') return auth.logout(env, request);
  if (method === 'POST' && pathname === '/api/arrepentimiento') return api.withdrawal(env, request);
  if (method === 'POST' && pathname === '/api/arrepentimiento/confirmar') return api.withdrawalConfirm(env, request);
  if (method === 'POST' && pathname === '/api/billing/webhook') return billing.webhook(env, request);
  if (method === 'GET' && pathname === '/api/health') return json({ ok: true });

  // Autenticados
  const user = await auth.getUser(env, request);
  if (!user) return fail('Tu sesión venció. Ingresá de nuevo.', 401);

  if (method === 'GET' && pathname === '/api/me') return api.me(env, user);
  if (method === 'POST' && pathname === '/api/billing/checkout') return billing.checkout(env, request, user);
  if (method === 'POST' && pathname === '/api/billing/refresh') return billing.refresh(env, user);
  if (method === 'POST' && pathname === '/api/billing/cancel') return billing.cancel(env, user);
  if (method === 'DELETE' && pathname === '/api/account') return auth.deleteAccount(env, request, user);

  // Todo lo demás requiere prueba vigente o suscripción activa.
  if (!(await billing.hasAccess(env, user.id))) {
    return json({ error: 'Tu prueba gratuita terminó. Suscribite para seguir usando LMH Búsqueda Laboral.', code: 'subscription_required' }, 402);
  }

  if (method === 'PUT' && pathname === '/api/profile') return api.updateProfile(env, request, user);
  if (method === 'POST' && pathname === '/api/cv') return api.uploadCv(env, request, user, ctx);
  if (method === 'POST' && pathname === '/api/cv/reanalyze') return api.reanalyze(env, user, ctx);
  if (method === 'GET' && pathname === '/api/blocks') return api.blocks(env, user);
  if (method === 'POST' && pathname === '/api/sweep') return api.manualSweep(env, user, ctx);
  if (method === 'GET' && pathname === '/api/offers') return api.listOffers(env, user, url);
  if (method === 'POST' && pathname === '/api/offers') return api.addOffer(env, request, user);

  const m = pathname.match(/^\/api\/offers\/([0-9a-f-]{36})$/);
  if (m && method === 'PATCH') return api.patchOffer(env, request, user, m[1]);
  if (m && method === 'DELETE') return api.deleteOffer(env, user, m[1]);

  return fail('No encontrado.', 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // La dirección vieja (workers.dev) redirige al dominio propio: así no fallan links, marcadores ni apps instaladas.
    if (url.hostname.endsWith('.workers.dev') && env.APP_URL) {
      return Response.redirect(new URL(url.pathname + url.search, env.APP_URL).toString(), request.method === 'GET' || request.method === 'HEAD' ? 301 : 308);
    }
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, ctx);
    } catch (err) {
      console.error(JSON.stringify({ evt: 'unhandled', path: url.pathname, msg: String(err?.message || err) }));
      return fail('Error interno. Probá de nuevo.', 500);
    }
  },

  // Cron: 10:05–13:05 UTC (07:05–10:05 hora de Argentina). Ver wrangler.jsonc.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.allSettled([runDailySweep(env), sendNoticeEmails(env)]));
  },
};
