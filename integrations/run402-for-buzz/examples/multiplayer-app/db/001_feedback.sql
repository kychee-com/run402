CREATE TABLE IF NOT EXISTS feedback_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID NOT NULL,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  attachment_url TEXT CHECK (attachment_url IS NULL OR attachment_url ~ '^https://'),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'planned', 'shipped', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS feedback_votes (
  feedback_id UUID NOT NULL REFERENCES feedback_items(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (feedback_id, user_id)
);

CREATE TABLE IF NOT EXISTS feedback_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_id UUID NOT NULL REFERENCES feedback_items(id) ON DELETE CASCADE,
  author_id UUID NOT NULL,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS feedback_items_created_at_idx ON feedback_items(created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_comments_feedback_idx ON feedback_comments(feedback_id, created_at);

INSERT INTO feedback_items (id, author_id, title, body, status)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  'Welcome to the beta board',
  'Vote, comment, and tell us what would make the product better.',
  'open'
)
ON CONFLICT (id) DO NOTHING;
