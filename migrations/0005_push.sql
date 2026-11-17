-- Notificaciones push (Web Push) al celular. Una fila por dispositivo suscripto.
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  fail_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_push_user ON push_subscriptions(user_id);
