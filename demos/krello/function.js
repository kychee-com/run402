import { db } from "@run402/functions";

const API_BASE = process.env.RUN402_API_BASE || "https://api.run402.com";
const APP_URL = process.env.KRELLO_APP_URL || "https://krello.run402.com";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLE_RANK = { viewer: 0, member: 1, admin: 2, owner: 3 };
const BOARD_TEMPLATES = {
  blank: {
    description: "A clean workspace for product plans, design sprints, and side projects.",
    theme: "sunrise",
    accent: "ember",
    labels: [
      ["Now", "ember"],
      ["Focus", "cobalt"],
      ["Blocked", "rose"],
      ["Later", "moss"],
    ],
    lists: [
      { title: "Ideas", color: "sand", cards: [] },
      { title: "Up Next", color: "mist", cards: [] },
      { title: "Doing", color: "cobalt", cards: [] },
      { title: "Done", color: "moss", cards: [] },
    ],
  },
  sprint: {
    description: "A fast product sprint board with a built-in cadence and clear handoff points.",
    theme: "cobalt",
    accent: "gold",
    labels: [
      ["Frontend", "cobalt"],
      ["Backend", "moss"],
      ["Polish", "gold"],
      ["Risk", "rose"],
    ],
    lists: [
      {
        title: "Backlog",
        color: "mist",
        cards: [
          {
            title: "Instrument the signup funnel",
            description: "Track every step from landing page to account creation so conversion gaps are visible.",
            priority: "high",
            points: 3,
            labels: ["Backend"],
            checklist: ["Define events", "Wire dashboard", "QA edge cases"],
          },
          {
            title: "Refresh empty states",
            description: "Design a friendlier first-run experience with sharper copy and visual hierarchy.",
            priority: "medium",
            points: 2,
            labels: ["Frontend", "Polish"],
          },
        ],
      },
      {
        title: "In Flight",
        color: "cobalt",
        cards: [
          {
            title: "Revise command palette",
            description: "Tighten keyboard-first flows and make search result groups easier to scan.",
            priority: "high",
            points: 5,
            labels: ["Frontend"],
            due_days: 3,
            checklist: ["Keyboard shortcuts", "Recent actions", "Search ranking"],
          },
        ],
      },
      {
        title: "Review",
        color: "gold",
        cards: [
          {
            title: "Ship design QA pass",
            description: "Audit spacing, animation timing, and mobile treatment before launch.",
            priority: "medium",
            points: 2,
            labels: ["Polish"],
          },
        ],
      },
      { title: "Shipped", color: "moss", cards: [] },
    ],
  },
  roadmap: {
    description: "A strategic board for multi-quarter planning, release themes, and stakeholder visibility.",
    theme: "aurora",
    accent: "moss",
    labels: [
      ["Quarter 2", "moss"],
      ["Quarter 3", "cobalt"],
      ["Nice to have", "gold"],
      ["Needs research", "rose"],
    ],
    lists: [
      {
        title: "Now",
        color: "moss",
        cards: [
          {
            title: "Publish the public app gallery",
            description: "Make forkable apps discoverable and easier to clone without leaving the product.",
            priority: "urgent",
            points: 8,
            labels: ["Quarter 2"],
          },
        ],
      },
      {
        title: "Next",
        color: "cobalt",
        cards: [
          {
            title: "Release analytics dashboard",
            description: "Give builders a quick read on calls, storage, and live deployment health.",
            priority: "high",
            points: 5,
            labels: ["Quarter 2"],
            checklist: ["Core metrics", "Usage trends", "Retention notes"],
          },
        ],
      },
      {
        title: "Later",
        color: "gold",
        cards: [
          {
            title: "Experiment with template packs",
            description: "Curate app categories that are easier for agents to fork and adapt.",
            priority: "medium",
            points: 3,
            labels: ["Quarter 3", "Nice to have"],
          },
        ],
      },
      { title: "Icebox", color: "rose", cards: [] },
    ],
  },
  studio: {
    description: "A launchpad board that shows off labels, checklists, comments, and link attachments.",
    theme: "gallery",
    accent: "rose",
    labels: [
      ["Design", "rose"],
      ["Build", "cobalt"],
      ["Story", "gold"],
      ["Ops", "moss"],
    ],
    lists: [
      {
        title: "Vision",
        color: "sand",
        cards: [
          {
            title: "Shape the product story",
            description: "Explain what Krello is, why the workflow feels premium, and what makes it clonable on run402.",
            priority: "high",
            points: 2,
            labels: ["Story"],
            checklist: ["Headline", "Core promise", "Launch bullets"],
            links: [{ title: "run402 docs", url: "https://run402.com/apps" }],
          },
        ],
      },
      {
        title: "Compose",
        color: "rose",
        cards: [
          {
            title: "Design the board chrome",
            description: "Balance dense productivity with warm visuals, strong typography, and confident spacing.",
            priority: "high",
            points: 5,
            labels: ["Design", "Build"],
            due_days: 2,
          },
          {
            title: "Add invite-driven collaboration",
            description: "Support multi-user boards without a central admin dashboard.",
            priority: "urgent",
            points: 3,
            labels: ["Build", "Ops"],
          },
        ],
      },
      {
        title: "Polish",
        color: "gold",
        cards: [
          {
            title: "Tune the card modal",
            description: "Make details editing fast: assignees, checklists, due dates, links, comments, and labels.",
            priority: "medium",
            points: 3,
            labels: ["Design", "Build"],
          },
        ],
      },
      {
        title: "Celebrate",
        color: "moss",
        cards: [
          {
            title: "Publish to krello.run402.com",
            description: "Pin the project, publish the version, and make it forkable.",
            priority: "medium",
            points: 1,
            labels: ["Ops"],
          },
        ],
      },
    ],
  },
};

export default async function handler(req) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/functions\/v1\/krello/, "") || "/";
  const method = req.method;

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  try {
    if (method === "POST" && path === "/bootstrap") {
      return await handleBootstrap(req);
    }
    if (method === "POST" && path === "/boards") {
      return await handleCreateBoard(req);
    }
    if (method === "POST" && path === "/invites/accept") {
      return await handleAcceptInvite(req);
    }

    const inviteMatch = path.match(/^\/boards\/([0-9a-f-]+)\/invites$/i);
    if (method === "POST" && inviteMatch) {
      return await handleCreateInvite(req, inviteMatch[1]);
    }

    const roleMatch = path.match(/^\/boards\/([0-9a-f-]+)\/members\/role$/i);
    if (method === "POST" && roleMatch) {
      return await handleUpdateMemberRole(req, roleMatch[1]);
    }

    const removeMatch = path.match(/^\/boards\/([0-9a-f-]+)\/members\/remove$/i);
    if (method === "POST" && removeMatch) {
      return await handleRemoveMember(req, removeMatch[1]);
    }

    const duplicateMatch = path.match(/^\/boards\/([0-9a-f-]+)\/duplicate$/i);
    if (method === "POST" && duplicateMatch) {
      return await handleDuplicateBoard(req, duplicateMatch[1]);
    }

    const exportMatch = path.match(/^\/boards\/([0-9a-f-]+)\/export$/i);
    if (method === "POST" && exportMatch) {
      return await handleExportBoard(req, exportMatch[1]);
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    if (err && err.statusCode) {
      return json({ error: err.message }, err.statusCode);
    }
    console.error("krello function error:", err && err.stack ? err.stack : err);
    return json({ error: "Internal function error" }, 500);
  }
}

async function handleBootstrap(req) {
  const user = await requireUser(req);
  const body = await readJson(req);
  const profile = await ensureProfile(user, body.display_name);
  const memberships = await db.from("board_members").select("board_id").eq("user_id", user.id).limit(1);
  let starterBoardId = null;

  if (memberships.length === 0) {
    const created = await createBoardFromTemplate({
      ownerId: user.id,
      title: "Krello Studio",
      description: "A polished starter board that shows off cards, labels, links, checklists, comments, and board sharing.",
      template: "studio",
      theme: "gallery",
      accent: "rose",
    });
    starterBoardId = created.boardId;
    await insertActivity(
      created.boardId,
      user.id,
      "board.created",
      `${profile.display_name} opened the studio board.`,
      null,
      { template: "studio" },
    );
  }

  return json({
    profile,
    created_starter: Boolean(starterBoardId),
    starter_board_id: starterBoardId,
  });
}

async function handleCreateBoard(req) {
  const user = await requireUser(req);
  const body = await readJson(req);
  await ensureProfile(user, body.display_name);

  const template = normalizeTemplate(body.template);
  const title = sanitizeText(body.title, 2, 80, "Board title is required");
  const created = await createBoardFromTemplate({
    ownerId: user.id,
    title,
    description: sanitizeOptionalText(body.description, 240),
    template,
    theme: normalizeTheme(body.theme || BOARD_TEMPLATES[template].theme),
    accent: normalizeAccent(body.accent || BOARD_TEMPLATES[template].accent),
  });

  await insertActivity(
    created.boardId,
    user.id,
    "board.created",
    `Created board "${created.board.title}".`,
    null,
    { template },
  );

  return json({
    board_id: created.boardId,
    board: created.board,
  });
}

async function handleCreateInvite(req, boardId) {
  const user = await requireUser(req);
  const board = await requireBoardRole(boardId, user.id, "admin");
  const body = await readJson(req);
  const role = normalizeInviteRole(body.role);
  const maxUses = Math.max(1, Math.min(100, Number(body.max_uses || 10)));
  const now = nowIso();
  const invite = {
    id: crypto.randomUUID(),
    board_id: boardId,
    token: crypto.randomUUID(),
    created_by: user.id,
    role,
    max_uses: maxUses,
    uses_count: 0,
    note: sanitizeOptionalText(body.note, 140),
    expires_at: normalizeExpiry(body.expires_at),
    created_at: now,
    updated_at: now,
  };

  await db.from("board_invites").insert(invite);
  await touchBoard(boardId);
  await insertActivity(
    boardId,
    user.id,
    "invite.created",
    `Created a ${role} invite for "${board.title}".`,
    null,
    { role, max_uses: maxUses },
  );

  return json({
    invite: {
      ...invite,
      invite_url: `${APP_URL}?invite=${invite.token}`,
    },
  });
}

async function handleAcceptInvite(req) {
  const user = await requireUser(req);
  await ensureProfile(user);
  const body = await readJson(req);
  const token = assertUuid(body.token, "Invite token");
  const invites = await db.from("board_invites").select("*").eq("token", token).limit(1);
  const invite = invites[0];

  if (!invite) {
    throw httpError(404, "Invite not found");
  }
  if (invite.disabled_at) {
    throw httpError(410, "Invite is no longer active");
  }
  if (new Date(invite.expires_at) < new Date()) {
    throw httpError(410, "Invite has expired");
  }
  if (invite.uses_count >= invite.max_uses) {
    throw httpError(410, "Invite has no remaining uses");
  }

  const existing = await db.from("board_members").select("*").eq("board_id", invite.board_id).eq("user_id", user.id).limit(1);
  if (existing[0]) {
    return json({ board_id: invite.board_id, role: existing[0].role, already_member: true });
  }

  await db.from("board_members").insert({
    board_id: invite.board_id,
    user_id: user.id,
    role: invite.role,
    joined_at: nowIso(),
  });

  const nextUses = invite.uses_count + 1;
  const invitePatch = {
    uses_count: nextUses,
    updated_at: nowIso(),
  };
  if (nextUses >= invite.max_uses) {
    invitePatch.disabled_at = nowIso();
  }
  await db.from("board_invites").update(invitePatch).eq("id", invite.id);
  await syncBoardAccess(invite.board_id);
  await touchBoard(invite.board_id);
  await insertActivity(
    invite.board_id,
    user.id,
    "member.joined",
    `${user.email} joined via an invite link.`,
    null,
    { role: invite.role },
  );

  return json({ board_id: invite.board_id, role: invite.role, already_member: false });
}

async function handleUpdateMemberRole(req, boardId) {
  const user = await requireUser(req);
  const actor = await requireBoardRole(boardId, user.id, "owner");
  const body = await readJson(req);
  const targetUserId = assertUuid(body.user_id, "Member");
  const nextRole = normalizeRole(body.role);
  const memberships = await db.from("board_members").select("*").eq("board_id", boardId).eq("user_id", targetUserId).limit(1);
  const membership = memberships[0];

  if (!membership) {
    throw httpError(404, "Board member not found");
  }
  if (membership.role === "owner") {
    throw httpError(400, "The board owner role cannot be changed");
  }
  if (membership.role === nextRole) {
    return json({ status: "unchanged" });
  }

  await db.from("board_members").update({ role: nextRole }).eq("board_id", boardId).eq("user_id", targetUserId);
  await syncBoardAccess(boardId);
  await touchBoard(boardId);
  await insertActivity(
    boardId,
    user.id,
    "member.role",
    `Updated a teammate from ${membership.role} to ${nextRole} on "${actor.title}".`,
    null,
    { target_user_id: targetUserId, role: nextRole },
  );

  return json({ status: "ok", role: nextRole });
}

async function handleRemoveMember(req, boardId) {
  const user = await requireUser(req);
  await requireBoardRole(boardId, user.id, "admin");
  const body = await readJson(req);
  const targetUserId = assertUuid(body.user_id, "Member");
  const memberships = await db.from("board_members").select("*").eq("board_id", boardId).eq("user_id", targetUserId).limit(1);
  const membership = memberships[0];

  if (!membership) {
    throw httpError(404, "Board member not found");
  }
  if (membership.role === "owner") {
    throw httpError(400, "The board owner cannot be removed");
  }

  await db.from("board_members").delete().eq("board_id", boardId).eq("user_id", targetUserId);
  await db.sql(
    `DELETE FROM card_members cm
     USING cards c
     WHERE cm.card_id = c.id
       AND c.board_id = '${boardId}'
       AND cm.user_id = '${targetUserId}'`
  );
  await syncBoardAccess(boardId);
  await touchBoard(boardId);
  await insertActivity(
    boardId,
    user.id,
    "member.removed",
    `Removed a teammate from the board.`,
    null,
    { target_user_id: targetUserId },
  );

  return json({ status: "ok" });
}

async function handleDuplicateBoard(req, boardId) {
  const user = await requireUser(req);
  await requireBoardRole(boardId, user.id, "viewer");
  const body = await readJson(req);
  const bundle = await fetchBoardBundle(boardId);
  const sourceBoard = bundle.board;

  if (!sourceBoard) {
    throw httpError(404, "Board not found");
  }

  const duplicated = await createBoardFromTemplate({
    ownerId: user.id,
    title: sanitizeText(body.title || `${sourceBoard.title} Copy`, 2, 80, "Board title is required"),
    description: sourceBoard.description,
    template: "blank",
    theme: normalizeTheme(sourceBoard.theme),
    accent: normalizeAccent(sourceBoard.accent),
    seed: bundle,
  });

  await insertActivity(
    duplicated.boardId,
    user.id,
    "board.duplicated",
    `Duplicated "${sourceBoard.title}" into a fresh board.`,
    null,
    { source_board_id: boardId },
  );

  return json({ board_id: duplicated.boardId, board: duplicated.board });
}

async function handleExportBoard(req, boardId) {
  const user = await requireUser(req);
  await requireBoardRole(boardId, user.id, "viewer");
  const bundle = await fetchBoardBundle(boardId);
  if (!bundle.board) {
    throw httpError(404, "Board not found");
  }
  return json({
    exported_at: nowIso(),
    app: "krello",
    board: bundle.board,
    members: bundle.members,
    profiles: bundle.profiles,
    labels: bundle.labels,
    lists: bundle.lists,
    cards: bundle.cards,
    card_labels: bundle.cardLabels,
    card_members: bundle.cardMembers,
    checklist_items: bundle.checklist,
    comments: bundle.comments,
    links: bundle.links,
    activity: bundle.activity,
  });
}

async function createBoardFromTemplate({ ownerId, title, description, template, theme, accent, seed }) {
  const now = nowIso();
  const boardId = crypto.randomUUID();
  const board = {
    id: boardId,
    owner_id: ownerId,
    title,
    description: description || BOARD_TEMPLATES[template].description,
    theme,
    accent,
    template_kind: template,
    archived: false,
    member_ids: [ownerId],
    editor_ids: [ownerId],
    admin_ids: [ownerId],
    created_at: now,
    updated_at: now,
  };

  await db.from("boards").insert(board);
  await db.from("board_members").insert({
    board_id: boardId,
    user_id: ownerId,
    role: "owner",
    joined_at: now,
  });

  if (seed) {
    await copyBoardSeed(seed, boardId, ownerId);
  } else {
    await insertTemplateSeed(template, boardId, ownerId);
  }

  await syncBoardAccess(boardId);
  const boards = await db.from("boards").select("*").eq("id", boardId).limit(1);
  return { boardId, board: boards[0] || board };
}

async function insertTemplateSeed(templateKey, boardId, ownerId) {
  const template = BOARD_TEMPLATES[templateKey] || BOARD_TEMPLATES.blank;
  const labelMap = new Map();
  const labels = template.labels.map(([name, color], index) => {
    const id = crypto.randomUUID();
    labelMap.set(name, id);
    return {
      id,
      board_id: boardId,
      name,
      color,
      position: (index + 1) * 1024,
      created_at: nowIso(),
    };
  });

  if (labels.length > 0) {
    await db.from("labels").insert(labels);
  }

  const listRows = [];
  const cardRows = [];
  const cardLabelRows = [];
  const checklistRows = [];
  const linkRows = [];

  template.lists.forEach((list, listIndex) => {
    const listId = crypto.randomUUID();
    listRows.push({
      id: listId,
      board_id: boardId,
      title: list.title,
      color: list.color,
      position: (listIndex + 1) * 1024,
      archived: false,
      created_at: nowIso(),
      updated_at: nowIso(),
    });

    list.cards.forEach((card, cardIndex) => {
      const cardId = crypto.randomUUID();
      cardRows.push({
        id: cardId,
        board_id: boardId,
        list_id: listId,
        created_by: ownerId,
        title: card.title,
        description: card.description || "",
        cover_style: normalizeCover(card.cover_style || list.color || "sand"),
        priority: normalizePriority(card.priority || "medium"),
        estimate_points: Math.max(0, Number(card.points || 0)),
        due_at: card.due_days ? futureIso(card.due_days) : null,
        position: (cardIndex + 1) * 1024,
        archived: false,
        started_at: null,
        completed_at: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      });

      for (const labelName of card.labels || []) {
        const labelId = labelMap.get(labelName);
        if (labelId) {
          cardLabelRows.push({ card_id: cardId, label_id: labelId });
        }
      }

      (card.checklist || []).forEach((item, itemIndex) => {
        checklistRows.push({
          id: crypto.randomUUID(),
          card_id: cardId,
          title: item,
          position: (itemIndex + 1) * 1024,
          done: false,
          done_by: null,
          done_at: null,
          created_at: nowIso(),
        });
      });

      (card.links || []).forEach((link) => {
        linkRows.push({
          id: crypto.randomUUID(),
          board_id: boardId,
          card_id: cardId,
          user_id: ownerId,
          title: sanitizeText(link.title, 2, 80, "Link title is required"),
          url: sanitizeUrl(link.url),
          created_at: nowIso(),
        });
      });
    });
  });

  if (listRows.length > 0) {
    await db.from("lists").insert(listRows);
  }
  if (cardRows.length > 0) {
    await db.from("cards").insert(cardRows);
  }
  if (cardLabelRows.length > 0) {
    await db.from("card_labels").insert(cardLabelRows);
  }
  if (checklistRows.length > 0) {
    await db.from("checklist_items").insert(checklistRows);
  }
  if (linkRows.length > 0) {
    await db.from("card_links").insert(linkRows);
  }
}

async function copyBoardSeed(bundle, boardId, ownerId) {
  const labelIdMap = new Map();
  const listIdMap = new Map();
  const cardIdMap = new Map();
  const now = nowIso();

  const labels = bundle.labels.map((label) => {
    const nextId = crypto.randomUUID();
    labelIdMap.set(label.id, nextId);
    return {
      id: nextId,
      board_id: boardId,
      name: label.name,
      color: normalizeAccent(label.color),
      position: Number(label.position || 1024),
      created_at: now,
    };
  });

  const lists = bundle.lists.map((list) => {
    const nextId = crypto.randomUUID();
    listIdMap.set(list.id, nextId);
    return {
      id: nextId,
      board_id: boardId,
      title: list.title,
      color: normalizeCover(list.color || "sand"),
      position: Number(list.position || 1024),
      archived: Boolean(list.archived),
      created_at: now,
      updated_at: now,
    };
  });

  const cards = bundle.cards.map((card) => {
    const nextId = crypto.randomUUID();
    cardIdMap.set(card.id, nextId);
    return {
      id: nextId,
      board_id: boardId,
      list_id: listIdMap.get(card.list_id),
      created_by: ownerId,
      title: card.title,
      description: card.description || "",
      cover_style: normalizeCover(card.cover_style || "sand"),
      priority: normalizePriority(card.priority || "medium"),
      estimate_points: Math.max(0, Number(card.estimate_points || 0)),
      due_at: card.due_at || null,
      position: Number(card.position || 1024),
      archived: Boolean(card.archived),
      started_at: card.started_at || null,
      completed_at: card.completed_at || null,
      created_at: now,
      updated_at: now,
    };
  });

  const cardLabels = bundle.cardLabels
    .filter((row) => cardIdMap.has(row.card_id) && labelIdMap.has(row.label_id))
    .map((row) => ({ card_id: cardIdMap.get(row.card_id), label_id: labelIdMap.get(row.label_id) }));

  const checklist = bundle.checklist
    .filter((row) => cardIdMap.has(row.card_id))
    .map((row) => ({
      id: crypto.randomUUID(),
      card_id: cardIdMap.get(row.card_id),
      title: row.title,
      position: Number(row.position || 1024),
      done: Boolean(row.done),
      done_by: row.done ? ownerId : null,
      done_at: row.done ? now : null,
      created_at: now,
    }));

  const links = bundle.links
    .filter((row) => cardIdMap.has(row.card_id))
    .map((row) => ({
      id: crypto.randomUUID(),
      board_id: boardId,
      card_id: cardIdMap.get(row.card_id),
      user_id: ownerId,
      url: sanitizeUrl(row.url),
      title: sanitizeText(row.title, 2, 80, "Link title is required"),
      created_at: now,
    }));

  if (labels.length > 0) await db.from("labels").insert(labels);
  if (lists.length > 0) await db.from("lists").insert(lists);
  if (cards.length > 0) await db.from("cards").insert(cards);
  if (cardLabels.length > 0) await db.from("card_labels").insert(cardLabels);
  if (checklist.length > 0) await db.from("checklist_items").insert(checklist);
  if (links.length > 0) await db.from("card_links").insert(links);
}

async function fetchBoardBundle(boardId) {
  assertUuid(boardId, "Board");
  const [boardRows, memberRows, profileRows, labelRows, listRows, cardRows, cardLabelRows, cardMemberRows, checklistRows, commentRows, linkRows, activityRows] = await Promise.all([
    db.from("boards").select("*").eq("id", boardId).limit(1),
    db.from("board_members").select("*").eq("board_id", boardId),
    queryRows(
      `SELECT DISTINCT p.*
       FROM profiles p
       JOIN board_members bm ON bm.user_id = p.id
       WHERE bm.board_id = '${boardId}'
       ORDER BY p.display_name`
    ),
    db.from("labels").select("*").eq("board_id", boardId).order("position", { ascending: true }),
    db.from("lists").select("*").eq("board_id", boardId).order("position", { ascending: true }),
    db.from("cards").select("*").eq("board_id", boardId).order("position", { ascending: true }),
    queryRows(
      `SELECT cl.*
       FROM card_labels cl
       JOIN cards c ON c.id = cl.card_id
       WHERE c.board_id = '${boardId}'`
    ),
    queryRows(
      `SELECT cm.*
       FROM card_members cm
       JOIN cards c ON c.id = cm.card_id
       WHERE c.board_id = '${boardId}'`
    ),
    queryRows(
      `SELECT ci.*
       FROM checklist_items ci
       JOIN cards c ON c.id = ci.card_id
       WHERE c.board_id = '${boardId}'
       ORDER BY ci.position ASC`
    ),
    db.from("comments").select("*").eq("board_id", boardId).order("created_at", { ascending: true }),
    db.from("card_links").select("*").eq("board_id", boardId).order("created_at", { ascending: true }),
    db.from("board_activity").select("*").eq("board_id", boardId).order("created_at", { ascending: false }).limit(80),
  ]);

  return {
    board: boardRows[0] || null,
    members: memberRows,
    profiles: profileRows,
    labels: labelRows,
    lists: listRows,
    cards: cardRows,
    cardLabels: cardLabelRows,
    cardMembers: cardMemberRows,
    checklist: checklistRows,
    comments: commentRows,
    links: linkRows,
    activity: activityRows,
  };
}

async function ensureProfile(user, requestedName) {
  const rows = await db.from("profiles").select("*").eq("id", user.id).limit(1);
  const existing = rows[0];
  const requested = sanitizeOptionalText(requestedName, 48);
  const nextName = requested || inferDisplayName(user.email);
  const tone = "ember";

  if (!existing) {
    const profile = {
      id: user.id,
      email: user.email,
      display_name: nextName,
      bio: "",
      avatar_tone: tone,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    await db.from("profiles").insert(profile);
    return profile;
  }

  const patch = {};
  if (requested && requested !== existing.display_name) {
    patch.display_name = nextName;
  }
  if (existing.email !== user.email) {
    patch.email = user.email;
  }
  if (Object.keys(patch).length > 0) {
    patch.updated_at = nowIso();
    const updated = await db.from("profiles").update(patch).eq("id", user.id);
    return updated[0] || { ...existing, ...patch };
  }

  return existing;
}

async function syncBoardAccess(boardId) {
  const rows = await db.from("board_members").select("user_id, role").eq("board_id", boardId);
  const memberIds = unique(rows.map((row) => row.user_id));
  const editorIds = unique(rows.filter((row) => row.role !== "viewer").map((row) => row.user_id));
  const adminIds = unique(rows.filter((row) => row.role === "owner" || row.role === "admin").map((row) => row.user_id));

  await db.from("boards").update({
    member_ids: memberIds,
    editor_ids: editorIds,
    admin_ids: adminIds,
    updated_at: nowIso(),
  }).eq("id", boardId);
}

async function touchBoard(boardId) {
  await db.from("boards").update({ updated_at: nowIso() }).eq("id", boardId);
}

async function insertActivity(boardId, userId, action, summary, cardId = null, metadata = {}) {
  await db.from("board_activity").insert({
    id: crypto.randomUUID(),
    board_id: boardId,
    card_id: cardId,
    user_id: userId,
    action,
    summary,
    metadata,
    created_at: nowIso(),
  });
}

async function requireUser(req) {
  const apikey = req.headers.get("apikey");
  const authHeader = req.headers.get("authorization");

  if (!apikey || !authHeader || !authHeader.startsWith("Bearer ")) {
    throw httpError(401, "Login required");
  }

  const res = await fetch(`${API_BASE}/auth/v1/user`, {
    method: "GET",
    headers: {
      apikey,
      Authorization: authHeader,
    },
  });

  if (!res.ok) {
    throw httpError(401, "Login required");
  }

  return res.json();
}

async function requireBoardRole(boardId, userId, minimumRole) {
  const board = (await db.from("boards").select("*").eq("id", assertUuid(boardId, "Board")).limit(1))[0];
  if (!board) {
    throw httpError(404, "Board not found");
  }

  const membership = (await db.from("board_members").select("*").eq("board_id", boardId).eq("user_id", assertUuid(userId, "User")).limit(1))[0];
  if (!membership) {
    throw httpError(403, "Board access denied");
  }

  if (ROLE_RANK[membership.role] < ROLE_RANK[minimumRole]) {
    throw httpError(403, "Insufficient role");
  }

  return { ...board, membership };
}

async function queryRows(query) {
  const result = await db.sql(query);
  return result.rows || [];
}

async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, apikey, Authorization",
  };
}

function nowIso() {
  return new Date().toISOString();
}

function futureIso(days) {
  const next = new Date();
  next.setUTCDate(next.getUTCDate() + Number(days));
  return next.toISOString();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function assertUuid(value, label) {
  if (!UUID_RE.test(String(value || ""))) {
    throw httpError(400, `${label} is invalid`);
  }
  return String(value);
}

function normalizeTemplate(value) {
  return BOARD_TEMPLATES[value] ? value : "blank";
}

function normalizeRole(value) {
  if (!ROLE_RANK[value] && value !== "viewer") {
    throw httpError(400, "Role is invalid");
  }
  if (value === "owner") {
    throw httpError(400, "Owner role cannot be assigned via this action");
  }
  return value;
}

function normalizeInviteRole(value) {
  if (value === "admin" || value === "member" || value === "viewer") {
    return value;
  }
  return "member";
}

function normalizeTheme(value) {
  const themes = new Set(["sunrise", "cobalt", "gallery", "aurora", "ember", "harbor"]);
  return themes.has(value) ? value : "sunrise";
}

function normalizeAccent(value) {
  const accents = new Set(["ember", "gold", "rose", "moss", "cobalt", "sand", "mist"]);
  return accents.has(value) ? value : "ember";
}

function normalizeCover(value) {
  return normalizeAccent(value);
}

function normalizePriority(value) {
  return ["low", "medium", "high", "urgent"].includes(value) ? value : "medium";
}

function sanitizeText(value, min, max, message) {
  const text = String(value || "").trim();
  if (text.length < min || text.length > max) {
    throw httpError(400, message);
  }
  return text;
}

function sanitizeOptionalText(value, max) {
  const text = String(value || "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function sanitizeUrl(value) {
  const url = String(value || "").trim();
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("bad protocol");
    }
    return parsed.toString();
  } catch {
    throw httpError(400, "Link URL must be valid");
  }
}

function normalizeExpiry(value) {
  if (!value) {
    return futureIso(14);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw httpError(400, "Invite expiry is invalid");
  }
  return date.toISOString();
}

function inferDisplayName(email) {
  const local = String(email || "").split("@")[0] || "Builder";
  const spaced = local.replace(/[._-]+/g, " ").trim();
  return spaced
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ") || "Builder";
}
