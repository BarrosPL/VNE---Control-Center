-- 0003_auth (up) — credenciais, sessoes e tentativas de login. Somente ADITIVA (objetos acc_*).
-- Segredos: apenas hashes. Senha em scrypt; token de sessao em sha256 (o token nunca e gravado).

CREATE TABLE acc_user_credentials (
  user_id uuid PRIMARY KEY REFERENCES acc_users (id),
  password_hash text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT false,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE acc_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES acc_users (id),
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  user_agent text
);
CREATE INDEX ix_acc_sessions_user_active ON acc_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX ix_acc_sessions_expires ON acc_sessions (expires_at);

-- identifier_hash = sha256 do e-mail normalizado (nao guarda e-mail nem IP em texto).
CREATE TABLE acc_login_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  identifier_hash text NOT NULL,
  succeeded boolean NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_acc_login_attempts_lookup ON acc_login_attempts (identifier_hash, attempted_at DESC);

CREATE TRIGGER trg_acc_user_credentials_updated_at BEFORE UPDATE ON acc_user_credentials
  FOR EACH ROW EXECUTE FUNCTION acc_set_updated_at();
