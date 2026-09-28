ALTER TABLE rescues ADD COLUMN deploy_raw TEXT;
ALTER TABLE rescues ADD COLUMN activation_raw TEXT;
CREATE UNIQUE INDEX rescues_one_pending_per_chain ON rescues(chain_id)
  WHERE state IN ('quoted', 'activating');
