# LMH Búsqueda Laboral — SaaS PWA de búsqueda laboral (Cloudflare)

Continuación de la app "Seguimiento de búsqueda laboral" (respaldo 2026-10-08, Supabase + Netlify, una sola cuenta), convertida en un SaaS multiusuario sobre Cloudflare. Conserva la interfaz, el lector de CV en el navegador y la paleta del respaldo.

## Qué incluye (los 10 requisitos)
| # | Requisito | Dónde está |
|---|-----------|-----------|
| 1 | Registro por mail con enlace de validación y creación de contraseña | `src/auth.js`, pantalla de acceso en `public/app.js` |
| 2 | Casillas de Términos y Condiciones y Política de Privacidad (obligatorias, se guarda versión y fecha) | registro + `public/terminos.html`, `privacidad.html` |
| 3 | Botón de arrepentimiento (Ley 24.240 art. 34, Res. 424/2020): en la cabecera y el pie de todas las pantallas, formulario público, constancia por mail y aviso a `ADMIN_EMAIL` | `public/arrepentimiento.html`, `api.withdrawal` |
| 4 | Carga del CV (PDF, DOCX, TXT; el texto se extrae en el dispositivo y el archivo va a R2 privado) | `public/cv.js`, `api.uploadCv` |
| 5 | Sección **Enviadas** con notas y fecha de seguimiento | `viewSent` |
| 6 | Sección **Descartadas** (se pueden devolver a Pendiente) | `viewDiscarded` |
| 7 | Actualización diaria después de las 7:00 (hora Argentina) sin duplicar lo ya enviado o descartado | cron en `wrangler.jsonc` + `src/sweep.js` |
| 8 | Botones Pendiente / Enviado / Descartado junto a cada oferta | `offerItem` |
| 9 | Preguntas al registrar el CV: sueldo pretendido bruto, esquema (presencial, híbrido, remoto, indiferente), horario (part time, full time, freelancer) | asistente inicial y "Mi perfil" |
| 10 | Tutorial en el primer ingreso y manual de uso | `showTutorial`, pestaña Ayuda |

**Tres bloques:** A y B los arma el agente leyendo el CV (Workers AI); C lo define la persona (nombre, palabras clave, exclusiones) y admite ofertas cargadas a mano.

**Sin duplicados:** `UNIQUE(user_id, dedupe_key)` en la tabla `offers` (clave = título + empresa normalizados). Una oferta que existe en cualquier estado no se vuelve a insertar, aunque aparezca en otro portal.

## Arquitectura
Un solo Worker (`src/index.js`) sirve la API en `/api/*` y la PWA estática (`public/`) con Workers Assets. D1 guarda cuentas, perfiles y ofertas; R2 guarda los CV; Workers AI analiza el CV; Cron Triggers corre el barrido; Email Service envía los mails.

Cron `5 10-13 * * *` (UTC) = 07:05 a 10:05 hora de Argentina. Cada corrida atiende a quienes aún no se actualizaron hoy (`SWEEP_USERS_PER_RUN`, 20 por defecto), así que si una corrida no alcanza, la siguiente continúa y si todos los portales fallan se reintenta.

## Puesta en marcha (necesita tu cuenta de Cloudflare)
```bash
npm install
npx wrangler login
npx wrangler d1 create lmh-empleo          # copiar el database_id en wrangler.jsonc
npx wrangler r2 bucket create lmh-empleo-cvs
npm run db:remote                           # crea las tablas
npx wrangler email sending enable lmhapps.com   # dominio desde el que se envían los mails (ver skill/docs de Email Service)
# opcional, suma portales vía Jooble (clave gratuita):
npx wrangler secret put JOOBLE_API_KEY
npm run deploy
```
Antes de desplegar, ajustar en `wrangler.jsonc` los `vars` (`APP_URL`, `MAIL_FROM`, `ADMIN_EMAIL`) y agregar el dominio propio; el dominio propio ya está en `routes`.

Desarrollo local sin cuenta: `npm run db:local && npm run dev` (D1 y R2 simulados; el enlace de validación se imprime en la consola; sin IA real se usa el análisis de respaldo).

## Pruebas
- `npm test`: 11 pruebas (filtros, puntaje, duplicados, y el barrido completo sobre el esquema real con portales simulados: no repite enviadas ni descartadas, reintenta si todo falla, el cron no repite en el día).
- `node test/e2e.mjs <log-del-dev>` con `npm run dev` corriendo: 33 verificaciones de la API (registro, sesión, CV, estados, arrepentimiento, borrado de cuenta, CSRF).
- Se recorrió también la interfaz completa en Chromium (registro, asistente, tutorial, ofertas, enviadas, perfil, arrepentimiento, móvil).

## Qué NO está verificado o está pendiente
1. **Fuentes de ofertas.** Bumeran, Computrabajo, LinkedIn y ZonaJobs bloquean la lectura automatizada: para ellos la app muestra enlaces de búsqueda ya armados en cada bloque. Los conectores automáticos son Get on Board (API pública) y Jooble (con clave). Desde el entorno donde armé esto no pude llamar a esas APIs (bloqueadas), así que **el formato de respuesta que usa `src/sources.js` está escrito según su documentación y no fue probado contra datos reales**. Probalo con un barrido real tras desplegar y ajustá el conector si hace falta. Los enlaces de búsqueda a portales (`portalLinks` en `public/app.js`) también conviene abrirlos una vez.
2. **IA.** El modelo se configura en `AI_MODEL`; verificá que siga disponible en tu cuenta. Si el modelo falla, la app usa un análisis de respaldo (se avisa en el perfil).
3. **Email.** Hay que dar de alta el dominio en Cloudflare Email Service antes de que lleguen los mails de validación.
4. **Textos legales.** Son un borrador con campos `[COMPLETAR]` (titular, CUIT, domicilio, contacto, precio). Deben ser revisados por un abogado. Si hay datos personales en bases, evaluá la inscripción ante la AAIP.
5. **Cobros.** No hay pasarela de pago. El botón de arrepentimiento y la baja ya existen, pero la devolución de dinero la gestionás vos con los pedidos registrados (tabla `withdrawals`, más el mail a `ADMIN_EMAIL`).
6. **Escala.** El barrido corre dentro del Worker: unas 80 personas por día con la configuración actual. Para más, pasar el barrido a Cloudflare Queues (una tarea por persona).
7. **Marca.** No encontré una paleta oficial de LMH Apps guardada; se usó la del respaldo. Para cambiarla, editar las variables de `:root` en `public/styles.css` y `theme_color` en `public/manifest.webmanifest`.
8. Los datos del respaldo de Supabase (ofertas y CV de uso personal) no se migraron.
