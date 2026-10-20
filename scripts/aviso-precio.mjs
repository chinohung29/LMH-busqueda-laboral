// Uso:  npm run aviso-precio -- 12000 2026-12-01     → avisa un precio nuevo desde esa fecha (mínimo 15 días)
//       npm run aviso-precio -- cancelar              → cancela el aviso vigente
// Muestra el aviso en la app y manda el mail a quienes están suscriptos (lo envía el cron diario).
import { execSync } from 'node:child_process';
import { validateNotice } from '../src/pricing.js';

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
const [a, b] = process.argv.slice(2);
const run = (sql) => execSync(`npx wrangler d1 execute lmh-empleo --remote --command "${sql}"`, { stdio: 'inherit' });

if (a === 'cancelar') {
  run('UPDATE price_notices SET cancelled = 1 WHERE cancelled = 0');
  console.log('Aviso cancelado.');
} else {
  const price = Number(a);
  const err = validateNotice(price, String(b || ''), today);
  if (err) { console.error(`${err}\nEjemplo: npm run aviso-precio -- 12000 ${today.slice(0, 5)}12-01`); process.exit(1); }
  run(`UPDATE price_notices SET cancelled = 1 WHERE cancelled = 0; INSERT INTO price_notices (id, new_price, effective_on, created_at) VALUES (lower(hex(randomblob(8))), ${price}, '${b}', CAST(strftime('%s','now') AS INTEGER))`);
  console.log(`Aviso cargado: $ ${price} desde el ${b}. Se muestra en la app y se envía por mail en la próxima ejecución diaria.`);
  console.log(`Ese día tenés que cambiar BILLING_PRICE a "${price}" en wrangler.jsonc y desplegar.`);
}
