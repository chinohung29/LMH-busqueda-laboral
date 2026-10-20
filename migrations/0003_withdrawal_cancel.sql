-- Arrepentimiento: confirmación por mail para cancelar la suscripción sin sesión iniciada.
ALTER TABLE withdrawals ADD COLUMN confirm_hash TEXT;
ALTER TABLE withdrawals ADD COLUMN confirm_expires INTEGER;
