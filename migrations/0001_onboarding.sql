CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'finalize')),
  attempt_id TEXT,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  challenge TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'awaiting_authorization', 'ready')),
  parent TEXT,
  delegate TEXT,
  consent_chain_id INTEGER,
  consent_signature TEXT,
  authorization_json TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX attempts_agent_idx ON attempts(agent);

CREATE TABLE accounts (
  agent TEXT PRIMARY KEY,
  parent TEXT NOT NULL,
  delegate TEXT NOT NULL,
  consent_chain_id INTEGER NOT NULL,
  consent_signature TEXT NOT NULL,
  authorization_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
