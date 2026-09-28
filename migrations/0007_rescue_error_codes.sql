UPDATE rescues SET error = 'RELAYER_STEP_FAILED' WHERE error IS NOT NULL AND state != 'quoted';
