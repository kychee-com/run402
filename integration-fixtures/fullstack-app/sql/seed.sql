INSERT INTO fs_accounts (slug, label)
VALUES
  ('alpha', 'Alpha Account'),
  ('beta', 'Beta Account')
ON CONFLICT (slug) DO UPDATE SET label = EXCLUDED.label;

INSERT INTO fs_items (account_id, marker, title, done)
SELECT a.id, 'RUN402_FULLSTACK_SEED_ALPHA', 'Alpha launch checklist', false
FROM fs_accounts a
WHERE a.slug = 'alpha'
ON CONFLICT (marker) DO UPDATE
SET title = EXCLUDED.title,
    done = EXCLUDED.done,
    account_id = EXCLUDED.account_id;

INSERT INTO fs_items (account_id, marker, title, done)
SELECT a.id, 'RUN402_FULLSTACK_SEED_BETA', 'Beta operational note', true
FROM fs_accounts a
WHERE a.slug = 'beta'
ON CONFLICT (marker) DO UPDATE
SET title = EXCLUDED.title,
    done = EXCLUDED.done,
    account_id = EXCLUDED.account_id;

INSERT INTO fs_runtime_events (kind, actor, details)
VALUES ('seed', 'migration', '{"marker":"RUN402_FULLSTACK_SEED_EVENT"}'::jsonb)
ON CONFLICT DO NOTHING;
