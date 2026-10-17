-- Suscripción mensual (Mercado Pago) y prueba gratuita.
-- La prueba la maneja la app (trial_ends_at); el cobro lo maneja Mercado Pago (mp_*).
CREATE TABLE subscriptions (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  trial_started_at INTEGER NOT NULL,
  trial_ends_at INTEGER NOT NULL,
  mp_preapproval_id TEXT UNIQUE,
  mp_status TEXT,            -- pending | authorized | paused | cancelled (estados de Mercado Pago)
  paid_until INTEGER,        -- hasta cuándo queda pago si se cancela o pausa
  payer_email TEXT,
  updated_at INTEGER NOT NULL
);
