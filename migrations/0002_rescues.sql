CREATE TABLE rescues (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  parent TEXT NOT NULL,
  delegate TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  recipient TEXT NOT NULL,
  amount_wei TEXT NOT NULL,
  funding_wei TEXT NOT NULL,
  relayer TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('quoted', 'activating', 'active', 'active_partial', 'failed', 'completed')),
  expires_at INTEGER NOT NULL,
  funding_tx_hash TEXT UNIQUE,
  deploy_tx_hash TEXT,
  activation_tx_hash TEXT,
  refund_tx_hash TEXT,
  refund_wei TEXT,
  rescue_tx_hash TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX rescues_account_chain_idx ON rescues(agent, chain_id, state);
