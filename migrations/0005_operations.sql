CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  parent TEXT,
  chain_id INTEGER NOT NULL,
  calls_json TEXT NOT NULL,
  challenge TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('challenged', 'prepared', 'submitting', 'broadcast', 'awaiting_batch', 'included', 'reverted', 'partial', 'failed', 'expired')),
  phase TEXT NOT NULL CHECK (phase IN ('activation', 'batch')),
  preparation_json TEXT,
  signed_raw TEXT,
  tx_hash TEXT,
  activation_tx_hash TEXT,
  receipt_json TEXT,
  error TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX operations_live_agent_chain_idx ON operations(agent, chain_id)
  WHERE status IN ('prepared', 'submitting', 'broadcast', 'awaiting_batch');
