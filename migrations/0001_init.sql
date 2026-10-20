-- LMH Búsqueda Laboral: esquema inicial (D1 / SQLite)

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT,
  pass_salt TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active')),
  terms_version TEXT,
  terms_accepted_at INTEGER,
  privacy_accepted_at INTEGER,
  email_verified_at INTEGER,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

-- Enlaces de validación / restablecimiento. Se guarda solo el hash del token.
CREATE TABLE tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('verify','reset')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_tokens_user ON tokens(user_id);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cv_name TEXT,
  cv_key TEXT,
  cv_text TEXT,
  cv_updated_at INTEGER,
  analysis TEXT,                        -- JSON que escribe el agente
  analysis_status TEXT NOT NULL DEFAULT 'none' CHECK (analysis_status IN ('none','pending','running','ready','error')),
  analysis_error TEXT,
  analysis_at INTEGER,
  salary_gross INTEGER,                 -- sueldo pretendido bruto mensual
  salary_currency TEXT NOT NULL DEFAULT 'ARS' CHECK (salary_currency IN ('ARS','USD')),
  work_mode TEXT NOT NULL DEFAULT 'indiferente' CHECK (work_mode IN ('presencial','hibrido','remoto','indiferente')),
  schedule_types TEXT NOT NULL DEFAULT '[]',   -- JSON: part_time, full_time, freelancer
  custom_block_name TEXT,
  custom_keywords TEXT NOT NULL DEFAULT '[]',  -- JSON
  custom_exclusions TEXT NOT NULL DEFAULT '[]',-- JSON
  tutorial_done INTEGER NOT NULL DEFAULT 0,
  onboarded INTEGER NOT NULL DEFAULT 0,
  last_sweep_date TEXT,                 -- YYYY-MM-DD en hora de Argentina
  last_sweep_at INTEGER,
  last_sweep_summary TEXT
);

-- Ofertas. UNIQUE(user_id, dedupe_key) impide volver a cargar una oferta que ya existe
-- en cualquier estado (pendiente, enviado o descartado).
CREATE TABLE offers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  block TEXT NOT NULL CHECK (block IN ('A','B','C')),
  title TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  modality TEXT NOT NULL DEFAULT '',
  salary_text TEXT,
  below_salary INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,                    -- YYYY-MM-DD o NULL si no se pudo verificar
  url TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  score INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente','enviado','descartado')),
  is_new INTEGER NOT NULL DEFAULT 1,
  manual INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  followup_date TEXT,
  dedupe_key TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER,
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX idx_offers_user_status ON offers(user_id, status, block);

-- Botón de arrepentimiento (Ley 24.240 art. 34, Res. SCI 424/2020)
CREATE TABLE withdrawals (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  service TEXT NOT NULL,
  contracted_on TEXT,
  comment TEXT,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'recibida'
);

-- Limitador de frecuencia simple
CREATE TABLE rate (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
