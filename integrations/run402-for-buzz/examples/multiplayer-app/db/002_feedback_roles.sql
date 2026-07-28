CREATE TABLE IF NOT EXISTS feedback_roles (
  user_id UUID PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
