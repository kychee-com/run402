CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  avatar_tone TEXT NOT NULL DEFAULT 'ember',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS boards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  theme TEXT NOT NULL DEFAULT 'sunrise',
  accent TEXT NOT NULL DEFAULT 'ember',
  template_kind TEXT NOT NULL DEFAULT 'blank',
  archived BOOLEAN NOT NULL DEFAULT false,
  member_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  editor_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  admin_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS board_members (
  board_id UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, user_id)
);

CREATE TABLE IF NOT EXISTS board_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  token UUID NOT NULL UNIQUE,
  created_by UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  max_uses INTEGER NOT NULL DEFAULT 10 CHECK (max_uses > 0),
  uses_count INTEGER NOT NULL DEFAULT 0 CHECK (uses_count >= 0),
  note TEXT NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '14 days',
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'ember',
  position DOUBLE PRECISION NOT NULL DEFAULT 1024,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (board_id, name)
);

CREATE TABLE IF NOT EXISTS lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'canvas',
  position DOUBLE PRECISION NOT NULL DEFAULT 1024,
  archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  list_id UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cover_style TEXT NOT NULL DEFAULT 'sand',
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  estimate_points INTEGER NOT NULL DEFAULT 0 CHECK (estimate_points >= 0),
  due_at TIMESTAMPTZ,
  position DOUBLE PRECISION NOT NULL DEFAULT 1024,
  archived BOOLEAN NOT NULL DEFAULT false,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS card_labels (
  card_id UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  label_id UUID NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (card_id, label_id)
);

CREATE TABLE IF NOT EXISTS card_members (
  card_id UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  PRIMARY KEY (card_id, user_id)
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  position DOUBLE PRECISION NOT NULL DEFAULT 1024,
  done BOOLEAN NOT NULL DEFAULT false,
  done_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  done_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  card_id UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS card_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  card_id UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS board_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  card_id UUID REFERENCES cards(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  summary TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_boards_owner_id ON boards(owner_id);
CREATE INDEX IF NOT EXISTS idx_boards_updated_at ON boards(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_boards_member_ids_gin ON boards USING GIN(member_ids);
CREATE INDEX IF NOT EXISTS idx_boards_editor_ids_gin ON boards USING GIN(editor_ids);
CREATE INDEX IF NOT EXISTS idx_boards_admin_ids_gin ON boards USING GIN(admin_ids);
CREATE INDEX IF NOT EXISTS idx_board_members_user_id ON board_members(user_id);
CREATE INDEX IF NOT EXISTS idx_board_invites_board_id ON board_invites(board_id);
CREATE INDEX IF NOT EXISTS idx_board_invites_token ON board_invites(token);
CREATE INDEX IF NOT EXISTS idx_labels_board_id ON labels(board_id, position);
CREATE INDEX IF NOT EXISTS idx_lists_board_id ON lists(board_id, position);
CREATE INDEX IF NOT EXISTS idx_cards_board_list_pos ON cards(board_id, list_id, position);
CREATE INDEX IF NOT EXISTS idx_cards_due_at ON cards(board_id, due_at);
CREATE INDEX IF NOT EXISTS idx_card_members_user_id ON card_members(user_id);
CREATE INDEX IF NOT EXISTS idx_checklist_items_card_id ON checklist_items(card_id, position);
CREATE INDEX IF NOT EXISTS idx_comments_card_id ON comments(card_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_card_links_card_id ON card_links(card_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_board_activity_board_id ON board_activity(board_id, created_at DESC);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE boards FORCE ROW LEVEL SECURITY;
ALTER TABLE board_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_members FORCE ROW LEVEL SECURITY;
ALTER TABLE board_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_invites FORCE ROW LEVEL SECURITY;
ALTER TABLE labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE labels FORCE ROW LEVEL SECURITY;
ALTER TABLE lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE lists FORCE ROW LEVEL SECURITY;
ALTER TABLE cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE cards FORCE ROW LEVEL SECURITY;
ALTER TABLE card_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_labels FORCE ROW LEVEL SECURITY;
ALTER TABLE card_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_members FORCE ROW LEVEL SECURITY;
ALTER TABLE checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_items FORCE ROW LEVEL SECURITY;
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments FORCE ROW LEVEL SECURITY;
ALTER TABLE card_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_links FORCE ROW LEVEL SECURITY;
ALTER TABLE board_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_activity FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profiles_select_shared ON profiles;
DROP POLICY IF EXISTS profiles_insert_self ON profiles;
DROP POLICY IF EXISTS profiles_update_self ON profiles;
DROP POLICY IF EXISTS boards_select_members ON boards;
DROP POLICY IF EXISTS boards_insert_owner ON boards;
DROP POLICY IF EXISTS boards_update_admins ON boards;
DROP POLICY IF EXISTS boards_delete_owner ON boards;
DROP POLICY IF EXISTS board_members_select_members ON board_members;
DROP POLICY IF EXISTS board_members_insert_admins ON board_members;
DROP POLICY IF EXISTS board_members_update_admins ON board_members;
DROP POLICY IF EXISTS board_members_delete_admins ON board_members;
DROP POLICY IF EXISTS board_invites_select_admins ON board_invites;
DROP POLICY IF EXISTS board_invites_insert_admins ON board_invites;
DROP POLICY IF EXISTS board_invites_update_admins ON board_invites;
DROP POLICY IF EXISTS board_invites_delete_admins ON board_invites;
DROP POLICY IF EXISTS labels_select_members ON labels;
DROP POLICY IF EXISTS labels_insert_editors ON labels;
DROP POLICY IF EXISTS labels_update_editors ON labels;
DROP POLICY IF EXISTS labels_delete_editors ON labels;
DROP POLICY IF EXISTS lists_select_members ON lists;
DROP POLICY IF EXISTS lists_insert_editors ON lists;
DROP POLICY IF EXISTS lists_update_editors ON lists;
DROP POLICY IF EXISTS lists_delete_editors ON lists;
DROP POLICY IF EXISTS cards_select_members ON cards;
DROP POLICY IF EXISTS cards_insert_editors ON cards;
DROP POLICY IF EXISTS cards_update_editors ON cards;
DROP POLICY IF EXISTS cards_delete_editors ON cards;
DROP POLICY IF EXISTS card_labels_select_members ON card_labels;
DROP POLICY IF EXISTS card_labels_insert_editors ON card_labels;
DROP POLICY IF EXISTS card_labels_delete_editors ON card_labels;
DROP POLICY IF EXISTS card_members_select_members ON card_members;
DROP POLICY IF EXISTS card_members_insert_editors ON card_members;
DROP POLICY IF EXISTS card_members_delete_editors ON card_members;
DROP POLICY IF EXISTS checklist_select_members ON checklist_items;
DROP POLICY IF EXISTS checklist_insert_editors ON checklist_items;
DROP POLICY IF EXISTS checklist_update_editors ON checklist_items;
DROP POLICY IF EXISTS checklist_delete_editors ON checklist_items;
DROP POLICY IF EXISTS comments_select_members ON comments;
DROP POLICY IF EXISTS comments_insert_editors ON comments;
DROP POLICY IF EXISTS comments_update_author ON comments;
DROP POLICY IF EXISTS comments_delete_author_or_admin ON comments;
DROP POLICY IF EXISTS card_links_select_members ON card_links;
DROP POLICY IF EXISTS card_links_insert_editors ON card_links;
DROP POLICY IF EXISTS card_links_update_author ON card_links;
DROP POLICY IF EXISTS card_links_delete_author_or_admin ON card_links;
DROP POLICY IF EXISTS board_activity_select_members ON board_activity;
DROP POLICY IF EXISTS board_activity_insert_editors ON board_activity;

CREATE POLICY profiles_select_shared ON profiles
  FOR SELECT
  USING (
    id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM board_members bm
      JOIN boards b ON b.id = bm.board_id
      WHERE bm.user_id = profiles.id
        AND auth.uid() = ANY(b.member_ids)
    )
  );

CREATE POLICY profiles_insert_self ON profiles
  FOR INSERT
  WITH CHECK (id = auth.uid());

CREATE POLICY profiles_update_self ON profiles
  FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

CREATE POLICY boards_select_members ON boards
  FOR SELECT
  USING (
    owner_id = auth.uid()
    OR auth.uid() = ANY(member_ids)
  );

CREATE POLICY boards_insert_owner ON boards
  FOR INSERT
  WITH CHECK (
    owner_id = auth.uid()
    AND auth.uid() = ANY(member_ids)
    AND auth.uid() = ANY(editor_ids)
    AND auth.uid() = ANY(admin_ids)
  );

CREATE POLICY boards_update_admins ON boards
  FOR UPDATE
  USING (
    owner_id = auth.uid()
    OR auth.uid() = ANY(admin_ids)
  )
  WITH CHECK (
    owner_id = auth.uid()
    OR auth.uid() = ANY(admin_ids)
  );

CREATE POLICY boards_delete_owner ON boards
  FOR DELETE
  USING (owner_id = auth.uid());

CREATE POLICY board_members_select_members ON board_members
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = board_members.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.member_ids))
    )
  );

CREATE POLICY board_members_insert_admins ON board_members
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = board_members.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.admin_ids))
    )
  );

CREATE POLICY board_members_update_admins ON board_members
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = board_members.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.admin_ids))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = board_members.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.admin_ids))
    )
  );

CREATE POLICY board_members_delete_admins ON board_members
  FOR DELETE
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = board_members.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.admin_ids))
    )
  );

CREATE POLICY board_invites_select_admins ON board_invites
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = board_invites.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.admin_ids))
    )
  );

CREATE POLICY board_invites_insert_admins ON board_invites
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = board_invites.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.admin_ids))
    )
  );

CREATE POLICY board_invites_update_admins ON board_invites
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = board_invites.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.admin_ids))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = board_invites.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.admin_ids))
    )
  );

CREATE POLICY board_invites_delete_admins ON board_invites
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = board_invites.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.admin_ids))
    )
  );

CREATE POLICY labels_select_members ON labels
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = labels.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.member_ids))
    )
  );

CREATE POLICY labels_insert_editors ON labels
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = labels.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.editor_ids))
    )
  );

CREATE POLICY labels_update_editors ON labels
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = labels.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.editor_ids))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = labels.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.editor_ids))
    )
  );

CREATE POLICY labels_delete_editors ON labels
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = labels.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.editor_ids))
    )
  );

CREATE POLICY lists_select_members ON lists
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = lists.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.member_ids))
    )
  );

CREATE POLICY lists_insert_editors ON lists
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = lists.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.editor_ids))
    )
  );

CREATE POLICY lists_update_editors ON lists
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = lists.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.editor_ids))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = lists.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.editor_ids))
    )
  );

CREATE POLICY lists_delete_editors ON lists
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = lists.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.editor_ids))
    )
  );

CREATE POLICY cards_select_members ON cards
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = cards.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.member_ids))
    )
  );

CREATE POLICY cards_insert_editors ON cards
  FOR INSERT
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = cards.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.editor_ids))
    )
  );

CREATE POLICY cards_update_editors ON cards
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = cards.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.editor_ids))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = cards.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.editor_ids))
    )
  );

CREATE POLICY cards_delete_editors ON cards
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = cards.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.editor_ids))
    )
  );

CREATE POLICY card_labels_select_members ON card_labels
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM cards c
      JOIN boards b ON b.id = c.board_id
      WHERE c.id = card_labels.card_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.member_ids))
    )
  );

CREATE POLICY card_labels_insert_editors ON card_labels
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM cards c
      JOIN boards b ON b.id = c.board_id
      WHERE c.id = card_labels.card_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.editor_ids))
    )
  );

CREATE POLICY card_labels_delete_editors ON card_labels
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM cards c
      JOIN boards b ON b.id = c.board_id
      WHERE c.id = card_labels.card_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.editor_ids))
    )
  );

CREATE POLICY card_members_select_members ON card_members
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM cards c
      JOIN boards b ON b.id = c.board_id
      WHERE c.id = card_members.card_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.member_ids))
    )
  );

CREATE POLICY card_members_insert_editors ON card_members
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM cards c
      JOIN boards b ON b.id = c.board_id
      WHERE c.id = card_members.card_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.editor_ids))
    )
  );

CREATE POLICY card_members_delete_editors ON card_members
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM cards c
      JOIN boards b ON b.id = c.board_id
      WHERE c.id = card_members.card_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.editor_ids))
    )
  );

CREATE POLICY checklist_select_members ON checklist_items
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM cards c
      JOIN boards b ON b.id = c.board_id
      WHERE c.id = checklist_items.card_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.member_ids))
    )
  );

CREATE POLICY checklist_insert_editors ON checklist_items
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM cards c
      JOIN boards b ON b.id = c.board_id
      WHERE c.id = checklist_items.card_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.editor_ids))
    )
  );

CREATE POLICY checklist_update_editors ON checklist_items
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM cards c
      JOIN boards b ON b.id = c.board_id
      WHERE c.id = checklist_items.card_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.editor_ids))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM cards c
      JOIN boards b ON b.id = c.board_id
      WHERE c.id = checklist_items.card_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.editor_ids))
    )
  );

CREATE POLICY checklist_delete_editors ON checklist_items
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM cards c
      JOIN boards b ON b.id = c.board_id
      WHERE c.id = checklist_items.card_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.editor_ids))
    )
  );

CREATE POLICY comments_select_members ON comments
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = comments.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.member_ids))
    )
  );

CREATE POLICY comments_insert_editors ON comments
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = comments.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.editor_ids))
    )
  );

CREATE POLICY comments_update_author ON comments
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY comments_delete_author_or_admin ON comments
  FOR DELETE
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = comments.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.admin_ids))
    )
  );

CREATE POLICY card_links_select_members ON card_links
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = card_links.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.member_ids))
    )
  );

CREATE POLICY card_links_insert_editors ON card_links
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = card_links.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.editor_ids))
    )
  );

CREATE POLICY card_links_update_author ON card_links
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY card_links_delete_author_or_admin ON card_links
  FOR DELETE
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = card_links.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.admin_ids))
    )
  );

CREATE POLICY board_activity_select_members ON board_activity
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = board_activity.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.member_ids))
    )
  );

CREATE POLICY board_activity_insert_editors ON board_activity
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM boards b
      WHERE b.id = board_activity.board_id
        AND (b.owner_id = auth.uid() OR auth.uid() = ANY(b.editor_ids))
    )
  );
