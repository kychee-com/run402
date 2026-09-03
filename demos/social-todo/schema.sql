-- Social Todo: shared todo list with Google login
-- Users get their name + avatar from Google. Todos are shared (anyone logged in can see all).

CREATE TABLE todos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  text TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: any authenticated user can read all todos, but only the owner can modify
ALTER TABLE todos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read todos"
  ON todos FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can insert their own todos"
  ON todos FOR INSERT
  TO authenticated
  WITH CHECK (user_id = (current_setting('request.jwt.claims', true)::json->>'sub')::uuid);

CREATE POLICY "Users can update their own todos"
  ON todos FOR UPDATE
  TO authenticated
  USING (user_id = (current_setting('request.jwt.claims', true)::json->>'sub')::uuid);

CREATE POLICY "Users can delete their own todos"
  ON todos FOR DELETE
  TO authenticated
  USING (user_id = (current_setting('request.jwt.claims', true)::json->>'sub')::uuid);
