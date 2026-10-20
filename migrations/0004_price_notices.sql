-- Avisos de cambio de precio: se muestran en la app y se mandan por mail a quienes están suscriptos.
CREATE TABLE price_notices (
  id TEXT PRIMARY KEY,
  new_price INTEGER NOT NULL,
  effective_on TEXT NOT NULL,          -- YYYY-MM-DD, al menos 15 días después de created_at
  created_at INTEGER NOT NULL,
  cancelled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE price_notice_sent (
  notice_id TEXT NOT NULL REFERENCES price_notices(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (notice_id, user_id)
);
