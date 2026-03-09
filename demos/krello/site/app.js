const CONFIG = window.__KRELLO_CONFIG__ || {};
const APP = document.getElementById("app");
const SESSION_KEY = "krello.session";
const INVITE_KEY = "krello.pendingInvite";
const THEMES = ["sunrise", "cobalt", "gallery", "aurora", "ember", "harbor"];
const ACCENTS = ["ember", "gold", "rose", "moss", "cobalt", "sand", "mist"];
const TEMPLATES = [
  {
    id: "blank",
    title: "Blank board",
    description: "A clean board with airy columns and no starter cards.",
    theme: "sunrise",
    accent: "ember",
  },
  {
    id: "studio",
    title: "Studio launchpad",
    description: "A polished starter board that demonstrates the full Krello surface.",
    theme: "gallery",
    accent: "rose",
  },
  {
    id: "sprint",
    title: "Product sprint",
    description: "Backlog, in-flight, review, and shipped with realistic sample cards.",
    theme: "cobalt",
    accent: "gold",
  },
  {
    id: "roadmap",
    title: "Roadmap",
    description: "Strategic planning lanes for now, next, later, and icebox.",
    theme: "aurora",
    accent: "moss",
  },
];
const state = {
  session: readSession(),
  user: null,
  profile: null,
  boards: [],
  memberships: [],
  boardData: null,
  loading: true,
  loadingBoard: false,
  boardSearch: "",
  filters: {
    query: "",
    assignedOnly: false,
    overdueOnly: false,
    showArchived: false,
    labelIds: [],
  },
  ui: {
    modal: null,
    cardId: null,
    toast: "",
    toastTimer: null,
    busyLabel: "",
    cardComposerListId: null,
    showListComposer: false,
    createBoardTemplate: "studio",
    scrollLeft: 0,
    suppressClickUntil: 0,
  },
  drag: null,
  pollTimer: null,
};

wireEvents();
bootstrap();

async function bootstrap() {
  captureInviteTokenFromUrl();
  state.loading = true;
  render();

  if (!state.session) {
    state.loading = false;
    render();
    return;
  }

  try {
    await initializeSession();
  } catch (error) {
    console.error(error);
    clearSession();
    showToast(error.message || "Your session expired.");
    state.loading = false;
    render();
  }
}

async function initializeSession() {
  state.user = await getCurrentUser();
  const bootstrapResult = await functionRequest("/bootstrap", { method: "POST", body: {} });
  state.profile = bootstrapResult.profile;

  if (getPendingInviteToken()) {
    await acceptPendingInvite();
  }

  await loadBoards();
  const routeBoardId = getRouteBoardId();

  if (routeBoardId) {
    await openBoard(routeBoardId, { silent: true });
  } else if (bootstrapResult.starter_board_id) {
    setRouteBoard(bootstrapResult.starter_board_id);
    await openBoard(bootstrapResult.starter_board_id, { silent: true });
  }

  state.loading = false;
  startPolling();
  render();
}

async function loadBoards() {
  if (!state.user) return;
  const memberships = await restSelect("board_members", {
    user_id: `eq.${state.user.id}`,
    order: "joined_at.desc",
  });
  state.memberships = memberships;

  if (memberships.length === 0) {
    state.boards = [];
    state.boardData = null;
    render();
    return;
  }

  const boardIds = memberships.map((membership) => membership.board_id);
  const boards = await restSelect("boards", {
    id: buildInFilter(boardIds),
    order: "updated_at.desc",
  });
  state.boards = boards.sort((left, right) => {
    if (left.archived !== right.archived) return left.archived ? 1 : -1;
    return new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime();
  });
  render();
}

async function openBoard(boardId, { silent = false } = {}) {
  if (!boardId) return;
  if (!silent) setRouteBoard(boardId);
  state.loadingBoard = true;
  render();

  try {
    const board = await restMaybeSelectOne("boards", { id: `eq.${boardId}` });
    if (!board) {
      showToast("That board is unavailable.");
      clearRouteBoard();
      state.boardData = null;
      state.loadingBoard = false;
      render();
      return;
    }

    const members = await restSelect("board_members", { board_id: `eq.${boardId}` });
    const memberIds = unique([
      ...(Array.isArray(board.member_ids) ? board.member_ids : []),
      ...members.map((member) => member.user_id),
    ]);
    const [
      profiles,
      labels,
      lists,
      cards,
      cardLabels,
      cardMembers,
      checklist,
      comments,
      links,
      activity,
      invites,
    ] = await Promise.all([
      memberIds.length ? restSelect("profiles", { id: buildInFilter(memberIds) }) : [],
      restSelect("labels", { board_id: `eq.${boardId}`, order: "position.asc" }),
      restSelect("lists", { board_id: `eq.${boardId}`, order: "position.asc" }),
      restSelect("cards", { board_id: `eq.${boardId}`, order: "position.asc" }),
      restSelect("card_labels"),
      restSelect("card_members"),
      restSelect("checklist_items"),
      restSelect("comments", { board_id: `eq.${boardId}`, order: "created_at.asc" }),
      restSelect("card_links", { board_id: `eq.${boardId}`, order: "created_at.asc" }),
      restSelect("board_activity", { board_id: `eq.${boardId}`, order: "created_at.desc", limit: "60" }),
      isBoardAdmin(boardId) ? restSelect("board_invites", { board_id: `eq.${boardId}`, order: "created_at.desc" }) : [],
    ]);

    const cardIds = new Set(cards.map((card) => card.id));
    state.boardData = {
      board,
      members,
      profiles: profiles.sort((left, right) => left.display_name.localeCompare(right.display_name)),
      labels,
      lists,
      cards,
      cardLabels: cardLabels.filter((row) => cardIds.has(row.card_id)),
      cardMembers: cardMembers.filter((row) => cardIds.has(row.card_id)),
      checklist: checklist.filter((row) => cardIds.has(row.card_id)),
      comments,
      links,
      activity,
      invites,
    };
  } catch (error) {
    console.error(error);
    showToast(error.message || "Board load failed.");
  } finally {
    state.loadingBoard = false;
    render();
  }
}

function render() {
  captureScroll();
  APP.className = "";
  APP.innerHTML = state.session ? renderWorkspace() : renderLanding();
  if (state.ui.toast) {
    APP.insertAdjacentHTML("beforeend", `<div class="toast">${escapeHtml(state.ui.toast)}</div>`);
  }
  restoreScroll();
}

function renderLanding() {
  return `
    <div class="app-shell">
      <div class="landing">
        <section class="hero">
          <div class="hero-copy">
            <span class="eyebrow">run402 native collaboration</span>
            <div class="brand-wordmark">Krello</div>
            <h1>The Trello-style board built for beautiful agent-made software.</h1>
            <p>
              Multi-user boards, invite links, rich card details, comments, links, checklists,
              labels, assignments, and a forkable run402 deployment. Sign in to start on your own board.
            </p>
            ${
              getPendingInviteToken()
                ? `<div class="pill">An invite is waiting. Sign in to join the shared board.</div>`
                : ""
            }
            <div class="hero-grid">
              <div class="hero-stat">
                <strong>Multi-board</strong>
                <span>Move from launch plans to roadmap work without leaving the app.</span>
              </div>
              <div class="hero-stat">
                <strong>Invite-led collaboration</strong>
                <span>Bring teammates in with role-based board links and member controls.</span>
              </div>
              <div class="hero-stat">
                <strong>Forkable</strong>
                <span>Publish the full app natively on run402 and clone the whole stack.</span>
              </div>
            </div>
          </div>
        </section>
        <aside class="auth-panel">
          <div class="panel">
            <div class="inline-actions">
              <button class="btn ${authMode() === "login" ? "primary" : "ghost"}" data-action="show-login">Sign in</button>
              <button class="btn ${authMode() === "signup" ? "primary" : "ghost"}" data-action="show-signup">Create account</button>
            </div>
            <div class="divider"></div>
            ${
              authMode() === "login"
                ? `
                  <form data-form="login" class="field">
                    <label>Email<input name="email" type="email" required placeholder="you@team.com" /></label>
                    <label>Password<input name="password" type="password" required placeholder="A strong password" /></label>
                    <button class="btn primary block" type="submit">Enter Krello</button>
                  </form>
                `
                : `
                  <form data-form="signup" class="field">
                    <label>Email<input name="email" type="email" required placeholder="you@team.com" /></label>
                    <label>Password<input name="password" type="password" required minlength="8" placeholder="At least 8 characters" /></label>
                    <label>Display name<input name="display_name" placeholder="How your team sees you" /></label>
                    <button class="btn primary block" type="submit">Create account</button>
                  </form>
                `
            }
          </div>
          <div class="panel">
            <h2>What’s inside</h2>
            <div class="field">
              <div class="pill">Multi-user boards</div>
              <div class="pill">Assignments + labels</div>
              <div class="pill">Card comments + links</div>
              <div class="pill">Checklists + due dates</div>
              <div class="pill">Board export + duplicate</div>
              <div class="pill">Responsive drag-and-drop</div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  `;
}

function renderWorkspace() {
  const topbar = renderTopbar();
  const body = getRouteBoardId() && state.boardData ? renderBoardView() : renderDashboard();
  const overlays = [renderModal(), renderCardModal()].filter(Boolean).join("");
  return `<div class="app-shell">${topbar}${body}${overlays}</div>`;
}

function renderTopbar() {
  const boardId = getRouteBoardId();
  return `
    <div class="topbar">
      <div class="topbar-left">
        <button class="btn ghost" data-action="go-dashboard">${boardId ? "Dashboard" : "Krello"}</button>
        <span class="pill">${state.boards.length} board${state.boards.length === 1 ? "" : "s"}</span>
        ${state.ui.busyLabel ? `<span class="pill">${escapeHtml(state.ui.busyLabel)}</span>` : ""}
      </div>
      <div class="topbar-right">
        <button class="btn ghost" data-action="open-create-board">New board</button>
        <button class="btn ghost" data-action="open-profile">${escapeHtml(state.profile?.display_name || state.user?.email || "Profile")}</button>
        <button class="btn ghost" data-action="logout">Log out</button>
      </div>
    </div>
  `;
}

function renderDashboard() {
  const query = state.boardSearch.toLowerCase();
  const boards = state.boards.filter((board) => {
    if (!query) return true;
    return [board.title, board.description, board.template_kind].join(" ").toLowerCase().includes(query);
  });
  const activeBoards = boards.filter((board) => !board.archived);
  const archivedBoards = boards.filter((board) => board.archived);

  return `
    <div class="workspace-grid">
      <main class="dashboard-grid">
        <section class="panel">
          <div class="board-toolbar">
            <div class="board-heading">
              <span class="eyebrow">Workspace</span>
              <h1>${escapeHtml(state.profile?.display_name || "Boards")}</h1>
              <p>Pick a board, create a new one, or fork the starter layouts into something your team can move inside every day.</p>
            </div>
            <div class="field" style="min-width:min(320px,100%);">
              <label>
                Search boards
                <input data-input="board-search" type="search" value="${escapeHtmlAttr(state.boardSearch)}" placeholder="Search by title or description" />
              </label>
            </div>
          </div>
          ${
            activeBoards.length
              ? `<div class="board-grid">${activeBoards.map(renderBoardTile).join("")}</div>`
              : `<div class="empty-state">No boards yet. Create one from the button above or use one of the templates in the sidebar.</div>`
          }
        </section>
        ${
          archivedBoards.length
            ? `
              <section class="panel">
                <h2>Archived boards</h2>
                <div class="board-grid">${archivedBoards.map(renderBoardTile).join("")}</div>
              </section>
            `
            : ""
        }
      </main>
      <aside class="sidebar">
        <section class="sidebar-panel">
          <h2>Template starters</h2>
          <div class="template-grid">${TEMPLATES.map(renderTemplateCard).join("")}</div>
        </section>
        <section class="sidebar-panel">
          <h2>Snapshot</h2>
          <div class="field">
            <div class="mini-stat"><strong>${state.boards.filter((board) => !board.archived).length}</strong><div class="muted">Active boards</div></div>
            <div class="mini-stat"><strong>${unique(state.boards.flatMap((board) => board.member_ids || [])).length}</strong><div class="muted">Collaborators visible to you</div></div>
            <div class="mini-stat"><strong>${state.memberships.filter((membership) => membership.role === "owner").length}</strong><div class="muted">Boards you own</div></div>
          </div>
        </section>
      </aside>
    </div>
  `;
}

function renderBoardTile(board) {
  return `
    <button
      class="board-tile"
      style="--tile-accent:${themeGradient(board.theme, board.accent)}"
      data-action="open-board"
      data-board-id="${board.id}"
    >
      <div class="inline-actions">
        <span class="theme-chip">${formatTheme(board.theme)}</span>
        <span class="pill">${memberCount(board)} members</span>
      </div>
      <h3>${escapeHtml(board.title)}</h3>
      <p>${escapeHtml(board.description || "No board description yet.")}</p>
      <div class="meta inline-actions">
        <span class="pill">${escapeHtml(board.template_kind || "blank")}</span>
        <span class="pill">${formatRelative(board.updated_at)}</span>
      </div>
    </button>
  `;
}

function renderTemplateCard(template) {
  return `
    <button
      class="template-card"
      style="--tile-accent:${themeGradient(template.theme, template.accent)}"
      data-action="quick-create-template"
      data-template-id="${template.id}"
    >
      <div class="theme-chip">${escapeHtml(template.title)}</div>
      <h3>${escapeHtml(template.title)}</h3>
      <p>${escapeHtml(template.description)}</p>
    </button>
  `;
}

function renderBoardView() {
  const board = state.boardData.board;
  const role = getCurrentBoardRole();
  return `
    <section class="board-page" data-theme="${escapeHtmlAttr(board.theme)}">
      <div class="board-toolbar">
        <div class="board-heading">
          <span class="eyebrow">${escapeHtml(role)} access</span>
          <h1>${escapeHtml(board.title)}</h1>
          <p>${escapeHtml(board.description || "No board description yet.")}</p>
          <div class="inline-actions">
            <span class="pill">${memberCount(board)} collaborators</span>
            <span class="pill">${visibleCardCount()} visible cards</span>
            <span class="pill">${formatTheme(board.theme)}</span>
          </div>
        </div>
        <div class="field" style="min-width:min(320px,100%);">
          <label>
            Search cards
            <input data-input="board-filter" type="search" value="${escapeHtmlAttr(state.filters.query)}" placeholder="Search cards, descriptions, comments, or links" />
          </label>
          <div class="filters-row">
            <button class="btn ghost small" data-action="open-filters">Filters</button>
            ${isBoardAdmin(board.id) ? `<button class="btn ghost small" data-action="open-invite">Invite</button>` : ""}
            <button class="btn ghost small" data-action="duplicate-board">Duplicate</button>
            <button class="btn ghost small" data-action="export-board">Export</button>
            ${isBoardAdmin(board.id) ? `<button class="btn ghost small" data-action="open-board-settings">Board settings</button>` : ""}
          </div>
        </div>
      </div>
      <div class="board-layout">
        <div class="lists-scroller" data-board-scroll>
          ${
            state.loadingBoard
              ? `<div class="empty-state">Loading board…</div>`
              : renderListTrack()
          }
        </div>
        ${renderBoardSidebar()}
      </div>
    </section>
  `;
}

function renderListTrack() {
  const lists = visibleLists();
  const canEdit = isBoardEditor(getRouteBoardId());

  return `
    <div class="list-track" data-list-track="true">
      ${lists
        .map((list) => {
          const beforeZone = canEdit
            ? `<div class="list-drop-zone" data-list-drop-zone data-before-list-id="${list.id}"></div>`
            : "";
          return `${beforeZone}${renderListColumn(list)}`;
        })
        .join("")}
      ${
        canEdit
          ? `
            <div class="list-drop-zone" data-list-drop-zone></div>
            <div class="list-shell">
              <div class="list-column">
                ${
                  state.ui.showListComposer
                    ? `
                      <form data-form="create-list" class="composer">
                        <label>New list title<input name="title" required maxlength="80" placeholder="What’s next?" /></label>
                        <div class="inline-actions">
                          <button class="btn primary small" type="submit">Add list</button>
                          <button class="btn ghost small" data-action="cancel-list-composer" type="button">Cancel</button>
                        </div>
                      </form>
                    `
                    : `<button class="btn block ghost" data-action="show-list-composer">Add another list</button>`
                }
              </div>
            </div>
          `
          : ""
      }
    </div>
  `;
}

function renderListColumn(list) {
  const cards = cardsForList(list.id);
  const canEdit = isBoardEditor(getRouteBoardId());
  return `
    <div class="list-shell" draggable="${canEdit ? "true" : "false"}" data-drag-type="list" data-list-id="${list.id}">
      <div class="list-column">
        <div class="list-header">
          <div class="list-title">
            <span class="list-dot" style="--dot:${accentColor(list.color)}"></span>
            <span>${escapeHtml(list.title)}</span>
          </div>
          <div class="inline-actions">
            <span class="pill">${cards.length}</span>
            ${canEdit ? `<button class="btn ghost small" data-action="archive-list" data-list-id="${list.id}">Archive</button>` : ""}
          </div>
        </div>
        <div class="list-cards" data-card-container="true" data-list-id="${list.id}">
          ${cards
            .map((card) => {
              const drop = canEdit
                ? `<div class="card-drop-zone" data-card-drop-zone data-list-id="${list.id}" data-before-card-id="${card.id}"></div>`
                : "";
              return `${drop}${renderCard(card)}`;
            })
            .join("")}
          ${canEdit ? `<div class="card-drop-zone" data-card-drop-zone data-list-id="${list.id}"></div>` : ""}
        </div>
        ${
          canEdit
            ? state.ui.cardComposerListId === list.id
              ? `
                <form data-form="create-card" data-list-id="${list.id}" class="composer">
                  <label>Card title<input name="title" required maxlength="120" placeholder="A sharp next action" /></label>
                  <textarea name="description" placeholder="Optional description"></textarea>
                  <div class="inline-actions">
                    <button class="btn primary small" type="submit">Add card</button>
                    <button class="btn ghost small" data-action="cancel-card-composer" type="button">Cancel</button>
                  </div>
                </form>
              `
              : `<button class="btn block ghost" data-action="show-card-composer" data-list-id="${list.id}">Add a card</button>`
            : ""
        }
      </div>
    </div>
  `;
}

function renderCard(card) {
  const labels = cardLabelsFor(card.id);
  const assignees = cardAssigneesFor(card.id);
  const checklist = checklistFor(card.id);
  const comments = commentsFor(card.id);
  const links = linksFor(card.id);
  return `
    <button class="board-card" data-action="open-card" data-card-id="${card.id}" draggable="${isBoardEditor(getRouteBoardId()) ? "true" : "false"}" data-drag-type="card" data-list-id="${card.list_id}">
      <div class="inline-actions">
        ${labels.map((label) => renderLabelPill(label)).join("")}
      </div>
      <h4>${escapeHtml(card.title)}</h4>
      ${card.description ? `<p>${escapeHtml(trimTo(card.description, 110))}</p>` : ""}
      <div class="card-badges">
        <span class="priority-pill" data-priority="${escapeHtmlAttr(card.priority)}">${escapeHtml(card.priority)}</span>
        ${card.due_at ? renderDuePill(card) : ""}
        ${checklist.length ? `<span class="badge">${doneChecklistCount(checklist)}/${checklist.length} checks</span>` : ""}
        ${comments.length ? `<span class="badge">${comments.length} comments</span>` : ""}
        ${links.length ? `<span class="badge">${links.length} links</span>` : ""}
        ${Number(card.estimate_points || 0) ? `<span class="badge">${card.estimate_points} pts</span>` : ""}
      </div>
      ${assignees.length ? `<div class="member-stack">${assignees.map(renderAvatar).join("")}</div>` : ""}
    </button>
  `;
}

function renderBoardSidebar() {
  const board = state.boardData.board;
  const members = boardMembers();
  const invites = (state.boardData.invites || []).filter((invite) => !invite.disabled_at && new Date(invite.expires_at) > new Date());
  const dueSoon = dueSoonCards();

  return `
    <aside class="sidebar">
      <section class="sidebar-panel">
        <h2>Members</h2>
        <div class="activity-list">
          ${members.map(renderMemberRow).join("")}
        </div>
      </section>
      ${
        isBoardAdmin(board.id)
          ? `
            <section class="sidebar-panel">
              <div class="inline-actions" style="justify-content:space-between;">
                <h2>Active invites</h2>
                <button class="btn ghost small" data-action="open-invite">Create invite</button>
              </div>
              ${
                invites.length
                  ? `<div class="invite-list">${invites.map(renderInviteRow).join("")}</div>`
                  : `<div class="empty-state">No active invites.</div>`
              }
            </section>
          `
          : ""
      }
      <section class="sidebar-panel">
        <h2>Due soon</h2>
        ${
          dueSoon.length
            ? `<div class="activity-list">${dueSoon.map(renderDueSoonItem).join("")}</div>`
            : `<div class="empty-state">Nothing urgent right now.</div>`
        }
      </section>
      <section class="sidebar-panel">
        <h2>Activity</h2>
        ${
          state.boardData.activity.length
            ? `<div class="activity-list">${state.boardData.activity.slice(0, 10).map(renderActivity).join("")}</div>`
            : `<div class="empty-state">Board activity will appear here.</div>`
        }
      </section>
    </aside>
  `;
}

function renderMemberRow(member) {
  const profile = profileFor(member.user_id);
  const canManage = isBoardOwner(getRouteBoardId()) && member.role !== "owner";
  const canRemove = isBoardAdmin(getRouteBoardId()) && member.role !== "owner";

  return `
    <div class="member-row">
      <div class="inline-actions">
        ${renderAvatar(profile)}
        <div class="member-meta">
          <strong>${escapeHtml(profile.display_name)}</strong>
          <span class="muted">${escapeHtml(member.role)}</span>
        </div>
      </div>
      ${
        canManage
          ? `
            <form data-form="member-role" data-user-id="${member.user_id}" class="inline-actions">
              <select name="role">
                ${["viewer", "member", "admin"].map((role) => `<option value="${role}" ${role === member.role ? "selected" : ""}>${role}</option>`).join("")}
              </select>
              <button class="btn ghost small" type="submit">Save</button>
              ${canRemove ? `<button class="btn danger small" type="button" data-action="remove-member" data-user-id="${member.user_id}">Remove</button>` : ""}
            </form>
          `
          : `<span class="pill">${escapeHtml(member.role)}</span>`
      }
    </div>
  `;
}

function renderInviteRow(invite) {
  return `
    <div class="invite-row">
      <div class="invite-copy">
        <strong>${escapeHtml(invite.role)} invite</strong>
        <span class="muted">Uses ${invite.uses_count}/${invite.max_uses} • expires ${formatDate(invite.expires_at)}</span>
      </div>
      <div class="inline-actions">
        <button class="btn ghost small" data-action="copy-invite" data-token="${invite.token}">Copy</button>
        <button class="btn danger small" data-action="disable-invite" data-invite-id="${invite.id}">Disable</button>
      </div>
    </div>
  `;
}

function renderDueSoonItem(card) {
  const list = state.boardData.lists.find((item) => item.id === card.list_id);
  return `
    <button class="activity-item" data-action="open-card" data-card-id="${card.id}">
      <div class="activity-copy">
        <strong>${escapeHtml(card.title)}</strong>
        <span class="muted">${escapeHtml(list?.title || "Card")} • ${formatDate(card.due_at)}</span>
      </div>
      ${renderDuePill(card)}
    </button>
  `;
}

function renderActivity(item) {
  const actor = profileFor(item.user_id);
  return `
    <div class="activity-item">
      ${renderAvatar(actor)}
      <div class="activity-copy">
        <strong>${escapeHtml(actor.display_name)}</strong>
        <span>${escapeHtml(item.summary)}</span>
        <span class="muted">${formatRelative(item.created_at)}</span>
      </div>
    </div>
  `;
}

function renderModal() {
  if (!state.ui.modal) return "";
  if (state.ui.modal === "create-board") return renderCreateBoardModal();
  if (state.ui.modal === "invite") return renderInviteModal();
  if (state.ui.modal === "filters") return renderFiltersModal();
  if (state.ui.modal === "profile") return renderProfileModal();
  if (state.ui.modal === "board-settings") return renderBoardSettingsModal();
  return "";
}

function renderCreateBoardModal() {
  return `
    <div class="modal-backdrop" data-action="close-modal">
      <div class="modal" role="dialog" aria-modal="true" onclick="event.stopPropagation()">
        <div class="modal-header">
          <div>
            <h2>Create a board</h2>
            <p class="muted">Choose a starter layout and launch a fresh collaborative board.</p>
          </div>
          <button class="btn ghost small" data-action="close-modal">Close</button>
        </div>
        <form data-form="create-board" class="field">
          <div class="template-grid">
            ${TEMPLATES.map(
              (template) => `
                <button
                  class="template-card"
                  type="button"
                  style="--tile-accent:${themeGradient(template.theme, template.accent)}"
                  data-action="select-template"
                  data-template-id="${template.id}"
                >
                  <div class="theme-chip">${state.ui.createBoardTemplate === template.id ? "Selected" : "Template"}</div>
                  <h3>${escapeHtml(template.title)}</h3>
                  <p>${escapeHtml(template.description)}</p>
                </button>
              `
            ).join("")}
          </div>
          <label>Title<input name="title" required maxlength="80" placeholder="Q2 launch board" /></label>
          <label>Description<textarea name="description" maxlength="240" placeholder="A one-line note for your teammates"></textarea></label>
          <button class="btn primary" type="submit">Create board</button>
        </form>
      </div>
    </div>
  `;
}

function renderInviteModal() {
  const invites = state.boardData?.invites || [];
  return `
    <div class="modal-backdrop" data-action="close-modal">
      <div class="modal" role="dialog" aria-modal="true" onclick="event.stopPropagation()">
        <div class="modal-header">
          <div>
            <h2>Invite collaborators</h2>
            <p class="muted">Invite teammates with shareable links and role-based access.</p>
          </div>
          <button class="btn ghost small" data-action="close-modal">Close</button>
        </div>
        <div class="modal-grid">
          <form data-form="create-invite" class="modal-section field">
            <label>Role
              <select name="role">
                <option value="member">member</option>
                <option value="viewer">viewer</option>
                <option value="admin">admin</option>
              </select>
            </label>
            <label>Max uses<input name="max_uses" type="number" min="1" max="100" value="10" /></label>
            <label>Expires at<input name="expires_at" type="datetime-local" /></label>
            <label>Note<input name="note" maxlength="140" placeholder="Optional context for your team" /></label>
            <button class="btn primary" type="submit">Create invite</button>
          </form>
          <section class="modal-section">
            <h3 class="section-title">Active links</h3>
            ${
              invites.length
                ? `<div class="invite-list">${invites.map(renderInviteRow).join("")}</div>`
                : `<div class="empty-state">No invite links yet.</div>`
            }
          </section>
        </div>
      </div>
    </div>
  `;
}

function renderFiltersModal() {
  return `
    <div class="modal-backdrop" data-action="close-modal">
      <div class="modal" role="dialog" aria-modal="true" onclick="event.stopPropagation()">
        <div class="modal-header">
          <div>
            <h2>Filters</h2>
            <p class="muted">Trim the board to the cards that matter right now.</p>
          </div>
          <button class="btn ghost small" data-action="close-modal">Close</button>
        </div>
        <div class="modal-grid">
          <section class="modal-section field">
            <label>
              Search cards
              <input data-input="board-filter" type="search" value="${escapeHtmlAttr(state.filters.query)}" placeholder="Keywords, comments, or URLs" />
            </label>
            <label><input data-toggle="assigned-only" type="checkbox" ${state.filters.assignedOnly ? "checked" : ""} /> Only cards assigned to me</label>
            <label><input data-toggle="overdue-only" type="checkbox" ${state.filters.overdueOnly ? "checked" : ""} /> Only overdue or due soon</label>
            <label><input data-toggle="show-archived" type="checkbox" ${state.filters.showArchived ? "checked" : ""} /> Show archived cards and lists</label>
          </section>
          <section class="modal-section">
            <h3 class="section-title">Labels</h3>
            <div class="label-grid">
              ${state.boardData.labels.map((label) => renderFilterLabel(label)).join("") || `<div class="empty-state">No labels yet.</div>`}
            </div>
          </section>
        </div>
      </div>
    </div>
  `;
}

function renderProfileModal() {
  return `
    <div class="modal-backdrop" data-action="close-modal">
      <div class="modal" role="dialog" aria-modal="true" onclick="event.stopPropagation()">
        <div class="modal-header">
          <div>
            <h2>Your profile</h2>
            <p class="muted">Shape the name and tone that appear around the board.</p>
          </div>
          <button class="btn ghost small" data-action="close-modal">Close</button>
        </div>
        <form data-form="profile" class="field">
          <label>Display name<input name="display_name" required maxlength="48" value="${escapeHtmlAttr(state.profile?.display_name || "")}" /></label>
          <label>Bio<textarea name="bio" maxlength="180" placeholder="A short note about what you handle.">${escapeHtml(state.profile?.bio || "")}</textarea></label>
          <div class="inline-actions">
            ${ACCENTS.map((tone) => `<button type="button" class="tone-swatch cover-${tone} ${state.profile?.avatar_tone === tone ? "active" : ""}" data-action="pick-avatar-tone" data-tone="${tone}"></button>`).join("")}
          </div>
          <input type="hidden" name="avatar_tone" value="${escapeHtmlAttr(state.profile?.avatar_tone || "ember")}" />
          <button class="btn primary" type="submit">Save profile</button>
        </form>
      </div>
    </div>
  `;
}

function renderBoardSettingsModal() {
  const board = state.boardData.board;
  return `
    <div class="modal-backdrop" data-action="close-modal">
      <div class="modal" role="dialog" aria-modal="true" onclick="event.stopPropagation()">
        <div class="modal-header">
          <div>
            <h2>Board settings</h2>
            <p class="muted">Update board identity, manage labels, and archive when the work is complete.</p>
          </div>
          <button class="btn ghost small" data-action="close-modal">Close</button>
        </div>
        <div class="modal-grid">
          <form data-form="board-settings" class="modal-section field">
            <label>Title<input name="title" required maxlength="80" value="${escapeHtmlAttr(board.title)}" /></label>
            <label>Description<textarea name="description" maxlength="240">${escapeHtml(board.description || "")}</textarea></label>
            <label>Theme
              <select name="theme">${THEMES.map((theme) => `<option value="${theme}" ${board.theme === theme ? "selected" : ""}>${theme}</option>`).join("")}</select>
            </label>
            <label>Accent
              <select name="accent">${ACCENTS.map((accent) => `<option value="${accent}" ${board.accent === accent ? "selected" : ""}>${accent}</option>`).join("")}</select>
            </label>
            <label><input name="archived" type="checkbox" ${board.archived ? "checked" : ""} /> Archive this board</label>
            <button class="btn primary" type="submit">Save board</button>
          </form>
          <section class="modal-section section-stack">
            <div>
              <h3 class="section-title">Labels</h3>
              ${
                state.boardData.labels.length
                  ? `<div class="activity-list">${state.boardData.labels.map(renderManagedLabel).join("")}</div>`
                  : `<div class="empty-state">No labels yet.</div>`
              }
            </div>
            <form data-form="create-label" class="field">
              <label>Name<input name="name" required maxlength="40" placeholder="Copy" /></label>
              <label>Color
                <select name="color">${ACCENTS.map((accent) => `<option value="${accent}">${accent}</option>`).join("")}</select>
              </label>
              <button class="btn ghost" type="submit">Add label</button>
            </form>
          </section>
        </div>
      </div>
    </div>
  `;
}

function renderCardModal() {
  if (!state.ui.cardId || !state.boardData) return "";
  const card = state.boardData.cards.find((item) => item.id === state.ui.cardId);
  if (!card) return "";
  const list = state.boardData.lists.find((item) => item.id === card.list_id);
  const labels = cardLabelsFor(card.id);
  const assignees = cardAssigneesFor(card.id);
  const checklist = checklistFor(card.id);
  const comments = commentsFor(card.id);
  const links = linksFor(card.id);
  const canEdit = isBoardEditor(getRouteBoardId());

  return `
    <div class="modal-backdrop" data-action="close-card">
      <div class="card-modal" role="dialog" aria-modal="true" onclick="event.stopPropagation()">
        <div class="modal-header">
          <div>
            <span class="eyebrow">${escapeHtml(list?.title || "Card")}</span>
            <h2>${escapeHtml(card.title)}</h2>
            <p class="muted">Created ${formatRelative(card.created_at)} • ${escapeHtml(card.priority)} priority</p>
          </div>
          <div class="inline-actions">
            ${canEdit ? `<button class="btn ghost small" data-action="toggle-card-archive" data-card-id="${card.id}">${card.archived ? "Restore" : "Archive"}</button>` : ""}
            ${canEdit ? `<button class="btn danger small" data-action="delete-card" data-card-id="${card.id}">Delete</button>` : ""}
            <button class="btn ghost small" data-action="close-card">Close</button>
          </div>
        </div>
        <div class="modal-grid">
          <div class="section-stack">
            <form data-form="save-card" data-card-id="${card.id}" class="card-section field">
              <label>Title<input name="title" required maxlength="120" value="${escapeHtmlAttr(card.title)}" ${canEdit ? "" : "disabled"} /></label>
              <label>Description<textarea name="description" maxlength="2400" ${canEdit ? "" : "disabled"}>${escapeHtml(card.description || "")}</textarea></label>
              <div class="field-row">
                <label>List
                  <select name="list_id" ${canEdit ? "" : "disabled"}>
                    ${state.boardData.lists.map((item) => `<option value="${item.id}" ${item.id === card.list_id ? "selected" : ""}>${escapeHtml(item.title)}</option>`).join("")}
                  </select>
                </label>
                <label>Due date<input name="due_at" type="datetime-local" value="${card.due_at ? toLocalDateTimeInput(card.due_at) : ""}" ${canEdit ? "" : "disabled"} /></label>
              </div>
              <div class="field-row">
                <label>Priority
                  <select name="priority" ${canEdit ? "" : "disabled"}>
                    ${["low", "medium", "high", "urgent"].map((priority) => `<option value="${priority}" ${priority === card.priority ? "selected" : ""}>${priority}</option>`).join("")}
                  </select>
                </label>
                <label>Estimate points<input name="estimate_points" type="number" min="0" value="${Number(card.estimate_points || 0)}" ${canEdit ? "" : "disabled"} /></label>
              </div>
              <input type="hidden" name="cover_style" value="${escapeHtmlAttr(card.cover_style || "sand")}" />
              <div class="inline-actions">
                ${ACCENTS.map((accent) => `<button type="button" class="cover-swatch cover-${accent} ${(card.cover_style || "sand") === accent ? "active" : ""}" data-action="pick-cover" data-cover="${accent}"></button>`).join("")}
              </div>
              ${canEdit ? `<button class="btn primary" type="submit">Save card</button>` : ""}
            </form>
            <section class="card-section section-stack">
              <div>
                <div class="inline-actions" style="justify-content:space-between;">
                  <h3 class="section-title">Checklist</h3>
                  ${checklist.length ? `<span class="pill">${doneChecklistCount(checklist)}/${checklist.length}</span>` : ""}
                </div>
                <div class="checklist-list">
                  ${checklist.map((item) => renderChecklistRow(item, canEdit)).join("") || `<div class="empty-state">No checklist items yet.</div>`}
                </div>
              </div>
              ${
                canEdit
                  ? `
                    <form data-form="create-checklist" data-card-id="${card.id}" class="field">
                      <label>Add checklist item<input name="title" required maxlength="140" placeholder="A concrete next step" /></label>
                      <button class="btn ghost" type="submit">Add item</button>
                    </form>
                  `
                  : ""
              }
            </section>
            <section class="card-section section-stack">
              <h3 class="section-title">Comments</h3>
              <div class="comment-list">
                ${comments.map(renderCommentRow).join("") || `<div class="empty-state">No comments yet.</div>`}
              </div>
              ${
                canEdit
                  ? `
                    <form data-form="create-comment" data-card-id="${card.id}" class="field">
                      <label>Add comment<textarea name="body" required maxlength="1800" placeholder="Context, decisions, or blockers"></textarea></label>
                      <button class="btn ghost" type="submit">Post comment</button>
                    </form>
                  `
                  : ""
              }
            </section>
          </div>
          <div class="section-stack">
            <section class="card-section section-stack">
              <div>
                <h3 class="section-title">Labels</h3>
                <div class="inline-actions">
                  ${state.boardData.labels.map((label) => renderSelectableLabel(label, labels, canEdit)).join("") || `<div class="empty-state">Create labels in board settings.</div>`}
                </div>
              </div>
              <div>
                <h3 class="section-title">Assignees</h3>
                <div class="activity-list">
                  ${boardMembers().map((member) => renderAssignableMember(member, assignees, canEdit)).join("")}
                </div>
              </div>
            </section>
            <section class="card-section section-stack">
              <h3 class="section-title">Links</h3>
              <div class="link-list">
                ${links.map(renderLinkRow).join("") || `<div class="empty-state">Attach URLs for docs, mocks, or specs.</div>`}
              </div>
              ${
                canEdit
                  ? `
                    <form data-form="create-link" data-card-id="${card.id}" class="field">
                      <label>Title<input name="title" required maxlength="80" placeholder="Spec, doc, or ticket" /></label>
                      <label>URL<input name="url" type="url" required placeholder="https://…" /></label>
                      <button class="btn ghost" type="submit">Add link</button>
                    </form>
                  `
                  : ""
              }
            </section>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderChecklistRow(item, canEdit) {
  return `
    <label class="checklist-row ${item.done ? "done" : ""}">
      <input type="checkbox" data-action="toggle-checklist" data-item-id="${item.id}" ${item.done ? "checked" : ""} ${canEdit ? "" : "disabled"} />
      <span class="checklist-title">${escapeHtml(item.title)}</span>
      <span class="muted">${item.done_at ? formatRelative(item.done_at) : ""}</span>
    </label>
  `;
}

function renderCommentRow(comment) {
  const profile = profileFor(comment.user_id);
  const canDelete = comment.user_id === state.user.id || isBoardAdmin(getRouteBoardId());
  return `
    <div class="comment-row">
      ${renderAvatar(profile)}
      <div class="comment-copy">
        <strong>${escapeHtml(profile.display_name)}</strong>
        <span>${escapeHtml(comment.body)}</span>
        <span class="muted">${formatRelative(comment.created_at)}</span>
      </div>
      ${canDelete ? `<button class="btn danger small" data-action="delete-comment" data-comment-id="${comment.id}">Delete</button>` : ""}
    </div>
  `;
}

function renderLinkRow(link) {
  const canDelete = link.user_id === state.user.id || isBoardAdmin(getRouteBoardId());
  return `
    <div class="link-row">
      <a class="link-pill" href="${escapeHtmlAttr(link.url)}" target="_blank" rel="noreferrer">${escapeHtml(link.title)}</a>
      ${canDelete ? `<button class="btn danger small" data-action="delete-link" data-link-id="${link.id}">Remove</button>` : ""}
    </div>
  `;
}

function renderSelectableLabel(label, selected, canEdit) {
  const active = selected.some((item) => item.id === label.id);
  return `
    <button class="label-pill" type="button" style="background:${accentTint(label.color)};" data-action="toggle-card-label" data-label-id="${label.id}" ${canEdit ? "" : "disabled"}>
      ${active ? "✓" : ""} ${escapeHtml(label.name)}
    </button>
  `;
}

function renderAssignableMember(member, selected, canEdit) {
  const profile = profileFor(member.user_id);
  const active = selected.some((item) => item.id === member.user_id);
  return `
    <button class="member-row" type="button" data-action="toggle-card-assignee" data-user-id="${member.user_id}" ${canEdit ? "" : "disabled"}>
      <div class="inline-actions">
        ${renderAvatar(profile)}
        <div class="member-meta">
          <strong>${escapeHtml(profile.display_name)}</strong>
          <span class="muted">${escapeHtml(member.role)}</span>
        </div>
      </div>
      <span class="pill">${active ? "Assigned" : "Available"}</span>
    </button>
  `;
}

function renderManagedLabel(label) {
  return `
    <div class="member-row">
      <div class="inline-actions">
        <span class="list-dot" style="--dot:${accentColor(label.color)}"></span>
        <div class="member-meta">
          <strong>${escapeHtml(label.name)}</strong>
          <span class="muted">${escapeHtml(label.color)}</span>
        </div>
      </div>
      <button class="btn danger small" data-action="delete-label" data-label-id="${label.id}">Delete</button>
    </div>
  `;
}

function renderFilterLabel(label) {
  const active = state.filters.labelIds.includes(label.id);
  return `
    <button class="label-pill" type="button" data-action="toggle-filter-label" data-label-id="${label.id}" style="background:${accentTint(label.color)};">
      ${active ? "✓" : ""} ${escapeHtml(label.name)}
    </button>
  `;
}

function renderLabelPill(label) {
  return `<span class="label-pill" style="background:${accentTint(label.color)};">${escapeHtml(label.name)}</span>`;
}

function renderAvatar(profile) {
  const source = profile || {};
  return `<span class="avatar" data-tone="${escapeHtmlAttr(source.avatar_tone || "ember")}">${initials(source.display_name || source.email || "U")}</span>`;
}

function authMode() {
  return state.ui.modal === "signup" ? "signup" : "login";
}

function wireEvents() {
  document.addEventListener("click", handleClick);
  document.addEventListener("submit", handleSubmit);
  document.addEventListener("input", handleInput);
  document.addEventListener("change", handleChange);
  document.addEventListener("keydown", handleKeyDown);
  document.addEventListener("dragstart", handleDragStart);
  document.addEventListener("dragover", handleDragOver);
  document.addEventListener("dragleave", handleDragLeave);
  document.addEventListener("drop", handleDrop);
  document.addEventListener("dragend", clearDragState);
  window.addEventListener("hashchange", handleRouteChange);
}

function handleClick(event) {
  if (Date.now() < state.ui.suppressClickUntil) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const trigger = event.target.closest("[data-action]");
  if (!trigger) return;
  const action = trigger.dataset.action;

  if (action === "show-login") {
    state.ui.modal = null;
    render();
    return;
  }
  if (action === "show-signup") {
    state.ui.modal = "signup";
    render();
    return;
  }
  if (action === "logout") {
    logout();
    return;
  }
  if (action === "go-dashboard") {
    clearRouteBoard();
    state.boardData = null;
    state.ui.cardId = null;
    render();
    return;
  }
  if (action === "open-create-board") {
    state.ui.createBoardTemplate = state.ui.createBoardTemplate || "studio";
    state.ui.modal = "create-board";
    render();
    return;
  }
  if (action === "quick-create-template") {
    state.ui.createBoardTemplate = trigger.dataset.templateId;
    state.ui.modal = "create-board";
    render();
    return;
  }
  if (action === "select-template") {
    state.ui.createBoardTemplate = trigger.dataset.templateId;
    render();
    return;
  }
  if (action === "open-profile") {
    state.ui.modal = "profile";
    render();
    return;
  }
  if (action === "open-invite") {
    state.ui.modal = "invite";
    render();
    return;
  }
  if (action === "open-board-settings") {
    state.ui.modal = "board-settings";
    render();
    return;
  }
  if (action === "open-filters") {
    state.ui.modal = "filters";
    render();
    return;
  }
  if (action === "close-modal") {
    if (trigger === event.target || trigger.dataset.action === "close-modal") {
      state.ui.modal = null;
      render();
    }
    return;
  }
  if (action === "open-board") {
    openBoard(trigger.dataset.boardId);
    return;
  }
  if (action === "open-card") {
    state.ui.cardId = trigger.dataset.cardId;
    render();
    return;
  }
  if (action === "close-card") {
    state.ui.cardId = null;
    render();
    return;
  }
  if (action === "show-card-composer") {
    state.ui.cardComposerListId = trigger.dataset.listId;
    render();
    return;
  }
  if (action === "cancel-card-composer") {
    state.ui.cardComposerListId = null;
    render();
    return;
  }
  if (action === "show-list-composer") {
    state.ui.showListComposer = true;
    render();
    return;
  }
  if (action === "cancel-list-composer") {
    state.ui.showListComposer = false;
    render();
    return;
  }
  if (action === "copy-invite") {
    copyInvite(trigger.dataset.token);
    return;
  }
  if (action === "disable-invite") {
    disableInvite(trigger.dataset.inviteId);
    return;
  }
  if (action === "toggle-filter-label") {
    toggleFilterLabel(trigger.dataset.labelId);
    return;
  }
  if (action === "toggle-card-label") {
    toggleCardLabel(trigger.dataset.labelId);
    return;
  }
  if (action === "toggle-card-assignee") {
    toggleCardAssignee(trigger.dataset.userId);
    return;
  }
  if (action === "delete-comment") {
    deleteComment(trigger.dataset.commentId);
    return;
  }
  if (action === "delete-link") {
    deleteLink(trigger.dataset.linkId);
    return;
  }
  if (action === "toggle-card-archive") {
    toggleCardArchive(trigger.dataset.cardId);
    return;
  }
  if (action === "delete-card") {
    deleteCard(trigger.dataset.cardId);
    return;
  }
  if (action === "archive-list") {
    archiveList(trigger.dataset.listId);
    return;
  }
  if (action === "duplicate-board") {
    duplicateBoard();
    return;
  }
  if (action === "export-board") {
    exportBoard();
    return;
  }
  if (action === "pick-avatar-tone") {
    const input = APP.querySelector('input[name="avatar_tone"]');
    if (input) input.value = trigger.dataset.tone;
    state.profile = { ...state.profile, avatar_tone: trigger.dataset.tone };
    render();
    return;
  }
  if (action === "pick-cover") {
    const input = APP.querySelector('input[name="cover_style"]');
    if (input) input.value = trigger.dataset.cover;
    const card = currentCard();
    if (card) {
      card.cover_style = trigger.dataset.cover;
      render();
    }
    return;
  }
  if (action === "delete-label") {
    deleteLabel(trigger.dataset.labelId);
    return;
  }
  if (action === "remove-member") {
    removeMember(trigger.dataset.userId);
  }
}

async function handleSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const formName = form.dataset.form;
  if (!formName) return;
  const data = new FormData(form);

  if (formName === "login") {
    await login(data.get("email"), data.get("password"));
    return;
  }
  if (formName === "signup") {
    await signup(data.get("email"), data.get("password"), data.get("display_name"));
    return;
  }
  if (formName === "create-board") {
    await createBoard({
      title: data.get("title"),
      description: data.get("description"),
      template: state.ui.createBoardTemplate,
    });
    return;
  }
  if (formName === "profile") {
    await saveProfile({
      display_name: data.get("display_name"),
      bio: data.get("bio"),
      avatar_tone: data.get("avatar_tone"),
    });
    return;
  }
  if (formName === "board-settings") {
    await saveBoardSettings({
      title: data.get("title"),
      description: data.get("description"),
      theme: data.get("theme"),
      accent: data.get("accent"),
      archived: Boolean(data.get("archived")),
    });
    return;
  }
  if (formName === "create-label") {
    await createLabel({
      name: data.get("name"),
      color: data.get("color"),
    });
    form.reset();
    return;
  }
  if (formName === "create-invite") {
    await createInvite({
      role: data.get("role"),
      max_uses: Number(data.get("max_uses")),
      expires_at: datetimeLocalToIso(data.get("expires_at")),
      note: data.get("note"),
    });
    return;
  }
  if (formName === "create-card") {
    await createCard(form.dataset.listId, {
      title: data.get("title"),
      description: data.get("description"),
    });
    state.ui.cardComposerListId = null;
    return;
  }
  if (formName === "create-list") {
    await createList({ title: data.get("title") });
    state.ui.showListComposer = false;
    return;
  }
  if (formName === "save-card") {
    await saveCard(form.dataset.cardId, {
      title: data.get("title"),
      description: data.get("description"),
      list_id: data.get("list_id"),
      due_at: datetimeLocalToIso(data.get("due_at")),
      priority: data.get("priority"),
      estimate_points: Number(data.get("estimate_points") || 0),
      cover_style: data.get("cover_style"),
    });
    return;
  }
  if (formName === "create-checklist") {
    await createChecklistItem(form.dataset.cardId, { title: data.get("title") });
    form.reset();
    return;
  }
  if (formName === "create-comment") {
    await createComment(form.dataset.cardId, { body: data.get("body") });
    form.reset();
    return;
  }
  if (formName === "create-link") {
    await createLink(form.dataset.cardId, { title: data.get("title"), url: data.get("url") });
    form.reset();
    return;
  }
  if (formName === "member-role") {
    await updateMemberRole(form.dataset.userId, data.get("role"));
  }
}

function handleInput(event) {
  const input = event.target;
  if (input.dataset.input === "board-search") {
    state.boardSearch = input.value;
    render();
    return;
  }
  if (input.dataset.input === "board-filter") {
    state.filters.query = input.value;
    render();
  }
}

function handleChange(event) {
  const input = event.target;
  if (input.dataset.toggle === "assigned-only") {
    state.filters.assignedOnly = input.checked;
    render();
    return;
  }
  if (input.dataset.toggle === "overdue-only") {
    state.filters.overdueOnly = input.checked;
    render();
    return;
  }
  if (input.dataset.toggle === "show-archived") {
    state.filters.showArchived = input.checked;
    render();
    return;
  }
  if (input.dataset.action === "toggle-checklist") {
    toggleChecklistItem(input.dataset.itemId, input.checked);
  }
}

function handleKeyDown(event) {
  const isTyping = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName || "");
  if (event.key === "Escape") {
    if (state.ui.cardId) {
      state.ui.cardId = null;
      render();
      return;
    }
    if (state.ui.modal) {
      state.ui.modal = null;
      render();
    }
    return;
  }
  if (isTyping) return;
  if (event.key.toLowerCase() === "n" && state.session) {
    state.ui.modal = "create-board";
    render();
  }
  if (event.key === "/" && getRouteBoardId()) {
    event.preventDefault();
    APP.querySelector('[data-input="board-filter"]')?.focus();
  }
}

function handleDragStart(event) {
  const node = event.target.closest("[data-drag-type]");
  if (!node || !isBoardEditor(getRouteBoardId())) return;
  state.drag = {
    type: node.dataset.dragType,
    id: node.dataset.cardId || node.dataset.listId,
    fromListId: node.dataset.listId || null,
    sourceNode: node,
    activeNode: null,
  };
  if (event.dataTransfer) {
    event.dataTransfer.setData("text/plain", state.drag.id);
    event.dataTransfer.effectAllowed = "move";
  }
  node.classList.add("is-dragging");
}

function handleDragOver(event) {
  if (!state.drag) return;
  const target = state.drag.type === "card" ? resolveCardDropTarget(event) : resolveListDropTarget(event);
  if (target) {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    setActiveDropNode(target.node);
    return;
  }
  setActiveDropNode(null);
}

function handleDragLeave(event) {
  if (!state.drag) return;
  if (!(event.relatedTarget instanceof Element) || !APP.contains(event.relatedTarget)) {
    setActiveDropNode(null);
  }
}

async function handleDrop(event) {
  if (!state.drag) return;
  const drag = state.drag;
  const target = state.drag.type === "card" ? resolveCardDropTarget(event) : resolveListDropTarget(event);
  if (!target) {
    clearDragState();
    return;
  }
  event.preventDefault();
  clearDragState();
  if (drag.type === "card") {
    await moveCard(drag.id, target.listId, target.beforeCardId);
  } else if (drag.type === "list") {
    await moveList(drag.id, target.beforeListId);
  }
}

function clearDragState() {
  if (state.drag?.sourceNode) {
    state.drag.sourceNode.classList.remove("is-dragging");
  }
  if (state.drag) {
    state.ui.suppressClickUntil = Date.now() + 200;
  }
  state.drag = null;
  document
    .querySelectorAll(".active,.active-drop-target,.is-dragging")
    .forEach((node) => node.classList.remove("active", "active-drop-target", "is-dragging"));
}

function resolveCardDropTarget(event) {
  const zone = event.target.closest("[data-card-drop-zone]");
  if (zone) {
    if (zone.dataset.beforeCardId === state.drag?.id) return null;
    return {
      node: zone,
      listId: zone.dataset.listId,
      beforeCardId: zone.dataset.beforeCardId || null,
    };
  }

  const card = event.target.closest(".board-card[data-card-id][data-list-id]");
  if (card) {
    if (card.dataset.cardId === state.drag?.id) return null;
    const rect = card.getBoundingClientRect();
    const beforeCardId =
      event.clientY <= rect.top + rect.height / 2 ? card.dataset.cardId : nextCardId(card);
    return {
      node: card,
      listId: card.dataset.listId,
      beforeCardId,
    };
  }

  const list = event.target.closest('.list-shell[data-list-id]');
  if (list) {
    return {
      node: list,
      listId: list.dataset.listId,
      beforeCardId: null,
    };
  }

  const container = event.target.closest("[data-card-container][data-list-id]");
  if (container) {
    return {
      node: container,
      listId: container.dataset.listId,
      beforeCardId: null,
    };
  }

  return null;
}

function resolveListDropTarget(event) {
  const zone = event.target.closest("[data-list-drop-zone]");
  if (zone) {
    if (zone.dataset.beforeListId === state.drag?.id) return null;
    return {
      node: zone,
      beforeListId: zone.dataset.beforeListId || null,
    };
  }

  const list = event.target.closest('.list-shell[data-drag-type="list"][data-list-id]');
  if (list) {
    if (list.dataset.listId === state.drag?.id) return null;
    const rect = list.getBoundingClientRect();
    const beforeListId =
      event.clientX <= rect.left + rect.width / 2 ? list.dataset.listId : nextListId(list);
    return {
      node: list,
      beforeListId,
    };
  }

  const track = event.target.closest("[data-list-track]");
  if (track) {
    return {
      node: track,
      beforeListId: null,
    };
  }

  return null;
}

function nextCardId(cardNode) {
  const cards = [...cardNode.parentElement.querySelectorAll(".board-card[data-card-id]")];
  const index = cards.findIndex((node) => node === cardNode);
  const next = cards.slice(index + 1).find((node) => node.dataset.cardId !== state.drag?.id);
  return next?.dataset.cardId || null;
}

function nextListId(listNode) {
  const lists = [...listNode.parentElement.querySelectorAll('.list-shell[data-drag-type="list"][data-list-id]')];
  const index = lists.findIndex((node) => node === listNode);
  const next = lists.slice(index + 1).find((node) => node.dataset.listId !== state.drag?.id);
  return next?.dataset.listId || null;
}

function setActiveDropNode(node) {
  if (!state.drag) return;
  if (state.drag.activeNode === node) return;
  if (state.drag.activeNode) {
    state.drag.activeNode.classList.remove("active-drop-target");
  }
  state.drag.activeNode = node;
  if (node) {
    node.classList.add("active-drop-target");
  }
}

async function handleRouteChange() {
  const boardId = getRouteBoardId();
  if (!boardId) {
    state.boardData = null;
    state.ui.cardId = null;
    render();
    return;
  }
  if (state.session) {
    await openBoard(boardId, { silent: true });
  }
}

async function login(email, password) {
  await withBusy("Signing in", async () => {
    const response = await authRequest("/auth/v1/token", {
      method: "POST",
      body: { email, password },
    });
    state.session = response;
    writeSession(response);
    state.ui.modal = null;
    state.user = null;
    state.profile = null;
    await initializeSession();
  });
}

async function signup(email, password, displayName) {
  await withBusy("Creating account", async () => {
    await authRequest("/auth/v1/signup", {
      method: "POST",
      body: { email, password },
    });
    await login(email, password);
    if (displayName) {
      await saveProfile({ display_name: displayName, bio: "", avatar_tone: state.profile?.avatar_tone || "ember" });
    }
  });
}

function logout() {
  clearSession();
  stopPolling();
  state.user = null;
  state.profile = null;
  state.boards = [];
  state.memberships = [];
  state.boardData = null;
  state.loading = false;
  state.ui.cardId = null;
  state.ui.modal = null;
  clearRouteBoard();
  render();
}

async function saveProfile(payload) {
  const profile = await restPatchSingle("profiles", { id: `eq.${state.user.id}` }, {
    display_name: String(payload.display_name).trim(),
    bio: String(payload.bio || ""),
    avatar_tone: payload.avatar_tone || "ember",
    updated_at: isoNow(),
  });
  state.profile = profile;
  state.ui.modal = null;
  render();
  showToast("Profile updated.");
}

async function createBoard(payload) {
  await withBusy("Creating board", async () => {
    const response = await functionRequest("/boards", {
      method: "POST",
      body: payload,
    });
    await loadBoards();
    state.ui.modal = null;
    state.ui.createBoardTemplate = payload.template;
    setRouteBoard(response.board_id);
    await openBoard(response.board_id, { silent: true });
    showToast("Board created.");
  });
}

async function saveBoardSettings(payload) {
  const board = await restPatchSingle("boards", { id: `eq.${getRouteBoardId()}` }, {
    title: String(payload.title).trim(),
    description: String(payload.description || ""),
    theme: payload.theme,
    accent: payload.accent,
    archived: payload.archived,
    updated_at: isoNow(),
  });
  state.boardData.board = board;
  await loadBoards();
  state.ui.modal = null;
  render();
  showToast("Board settings saved.");
}

async function createLabel(payload) {
  const position = nextPosition(state.boardData.labels);
  await restInsert("labels", {
    id: crypto.randomUUID(),
    board_id: getRouteBoardId(),
    name: String(payload.name).trim(),
    color: payload.color,
    position,
    created_at: isoNow(),
  });
  await logBoardActivity("label.created", `Created the "${payload.name}" label.`);
  await openBoard(getRouteBoardId(), { silent: true });
  showToast("Label added.");
}

async function deleteLabel(labelId) {
  await restDelete("card_labels", { label_id: `eq.${labelId}` });
  await restDelete("labels", { id: `eq.${labelId}` });
  await logBoardActivity("label.deleted", "Removed a board label.");
  await openBoard(getRouteBoardId(), { silent: true });
  showToast("Label removed.");
}

async function createInvite(payload) {
  const response = await functionRequest(`/boards/${getRouteBoardId()}/invites`, {
    method: "POST",
    body: payload,
  });
  state.boardData.invites = [response.invite, ...(state.boardData.invites || [])];
  render();
  await navigator.clipboard.writeText(response.invite.invite_url);
  showToast("Invite created and copied.");
}

async function disableInvite(inviteId) {
  await restPatchSingle("board_invites", { id: `eq.${inviteId}` }, {
    disabled_at: isoNow(),
    updated_at: isoNow(),
  });
  await openBoard(getRouteBoardId(), { silent: true });
  showToast("Invite disabled.");
}

async function createCard(listId, payload) {
  const cards = state.boardData.cards.filter((card) => card.list_id === listId);
  const created = await restInsert("cards", {
    id: crypto.randomUUID(),
    board_id: getRouteBoardId(),
    list_id: listId,
    created_by: state.user.id,
    title: String(payload.title).trim(),
    description: String(payload.description || ""),
    cover_style: "sand",
    priority: "medium",
    estimate_points: 0,
    position: nextPosition(cards),
    archived: false,
    created_at: isoNow(),
    updated_at: isoNow(),
  });
  await logBoardActivity("card.created", `Added "${created[0].title}" to ${listTitle(listId)}.`, created[0].id);
  await openBoard(getRouteBoardId(), { silent: true });
  showToast("Card added.");
}

async function createList(payload) {
  const created = await restInsert("lists", {
    id: crypto.randomUUID(),
    board_id: getRouteBoardId(),
    title: String(payload.title).trim(),
    color: "sand",
    position: nextPosition(state.boardData.lists),
    archived: false,
    created_at: isoNow(),
    updated_at: isoNow(),
  });
  await logBoardActivity("list.created", `Created list "${created[0].title}".`);
  await openBoard(getRouteBoardId(), { silent: true });
  showToast("List added.");
}

async function saveCard(cardId, payload) {
  const patch = {
    title: String(payload.title).trim(),
    description: String(payload.description || ""),
    list_id: payload.list_id,
    due_at: payload.due_at || null,
    priority: payload.priority,
    estimate_points: Number(payload.estimate_points || 0),
    cover_style: payload.cover_style || "sand",
    updated_at: isoNow(),
  };
  await restPatchSingle("cards", { id: `eq.${cardId}` }, patch);
  await logBoardActivity("card.updated", `Updated "${patch.title}".`, cardId);
  await openBoard(getRouteBoardId(), { silent: true });
  showToast("Card saved.");
}

async function toggleCardLabel(labelId) {
  const card = currentCard();
  const active = state.boardData.cardLabels.find((row) => row.card_id === card.id && row.label_id === labelId);
  if (active) {
    await restDelete("card_labels", { card_id: `eq.${card.id}`, label_id: `eq.${labelId}` });
  } else {
    await restInsert("card_labels", { card_id: card.id, label_id: labelId });
  }
  await openBoard(getRouteBoardId(), { silent: true });
}

async function toggleCardAssignee(userId) {
  const card = currentCard();
  const active = state.boardData.cardMembers.find((row) => row.card_id === card.id && row.user_id === userId);
  if (active) {
    await restDelete("card_members", { card_id: `eq.${card.id}`, user_id: `eq.${userId}` });
  } else {
    await restInsert("card_members", { card_id: card.id, user_id: userId });
  }
  await logBoardActivity("card.assignment", `Updated assignees on "${card.title}".`, card.id);
  await openBoard(getRouteBoardId(), { silent: true });
}

async function createChecklistItem(cardId, payload) {
  await restInsert("checklist_items", {
    id: crypto.randomUUID(),
    card_id: cardId,
    title: String(payload.title).trim(),
    position: nextPosition(checklistFor(cardId)),
    done: false,
    done_by: null,
    done_at: null,
    created_at: isoNow(),
  });
  await openBoard(getRouteBoardId(), { silent: true });
}

async function toggleChecklistItem(itemId, done) {
  await restPatchSingle("checklist_items", { id: `eq.${itemId}` }, {
    done,
    done_by: done ? state.user.id : null,
    done_at: done ? isoNow() : null,
  });
  await openBoard(getRouteBoardId(), { silent: true });
}

async function createComment(cardId, payload) {
  await restInsert("comments", {
    id: crypto.randomUUID(),
    board_id: getRouteBoardId(),
    card_id: cardId,
    user_id: state.user.id,
    body: String(payload.body).trim(),
    created_at: isoNow(),
  });
  await logBoardActivity("comment.created", `Commented on "${cardTitle(cardId)}".`, cardId);
  await openBoard(getRouteBoardId(), { silent: true });
}

async function deleteComment(commentId) {
  await restDelete("comments", { id: `eq.${commentId}` });
  await openBoard(getRouteBoardId(), { silent: true });
}

async function createLink(cardId, payload) {
  await restInsert("card_links", {
    id: crypto.randomUUID(),
    board_id: getRouteBoardId(),
    card_id: cardId,
    user_id: state.user.id,
    title: String(payload.title).trim(),
    url: String(payload.url).trim(),
    created_at: isoNow(),
  });
  await openBoard(getRouteBoardId(), { silent: true });
}

async function deleteLink(linkId) {
  await restDelete("card_links", { id: `eq.${linkId}` });
  await openBoard(getRouteBoardId(), { silent: true });
}

async function toggleCardArchive(cardId) {
  const card = state.boardData.cards.find((item) => item.id === cardId);
  await restPatchSingle("cards", { id: `eq.${cardId}` }, {
    archived: !card.archived,
    updated_at: isoNow(),
  });
  await openBoard(getRouteBoardId(), { silent: true });
  showToast(card.archived ? "Card restored." : "Card archived.");
}

async function deleteCard(cardId) {
  await restDelete("card_labels", { card_id: `eq.${cardId}` });
  await restDelete("card_members", { card_id: `eq.${cardId}` });
  await restDelete("checklist_items", { card_id: `eq.${cardId}` });
  await restDelete("comments", { card_id: `eq.${cardId}` });
  await restDelete("card_links", { card_id: `eq.${cardId}` });
  await restDelete("cards", { id: `eq.${cardId}` });
  state.ui.cardId = null;
  await openBoard(getRouteBoardId(), { silent: true });
  showToast("Card deleted.");
}

async function archiveList(listId) {
  await restPatchSingle("lists", { id: `eq.${listId}` }, {
    archived: true,
    updated_at: isoNow(),
  });
  await openBoard(getRouteBoardId(), { silent: true });
  showToast("List archived.");
}

async function updateMemberRole(userId, role) {
  await functionRequest(`/boards/${getRouteBoardId()}/members/role`, {
    method: "POST",
    body: { user_id: userId, role },
  });
  await openBoard(getRouteBoardId(), { silent: true });
  showToast("Member role updated.");
}

async function removeMember(userId) {
  await functionRequest(`/boards/${getRouteBoardId()}/members/remove`, {
    method: "POST",
    body: { user_id: userId },
  });
  await openBoard(getRouteBoardId(), { silent: true });
  showToast("Member removed.");
}

async function moveCard(cardId, targetListId, beforeCardId) {
  if (!isBoardEditor(getRouteBoardId())) return;
  const card = state.boardData.cards.find((item) => item.id === cardId);
  const targetCards = state.boardData.cards
    .filter((item) => item.id !== cardId && item.list_id === targetListId && (!item.archived || state.filters.showArchived))
    .sort((left, right) => Number(left.position) - Number(right.position));
  const index = beforeCardId ? targetCards.findIndex((item) => item.id === beforeCardId) : targetCards.length;
  const previous = index > 0 ? targetCards[index - 1] : null;
  const next = index >= 0 && index < targetCards.length ? targetCards[index] : null;
  const position = positionBetween(previous?.position, next?.position);
  await restPatchSingle("cards", { id: `eq.${cardId}` }, {
    list_id: targetListId,
    position,
    updated_at: isoNow(),
  });
  await openBoard(getRouteBoardId(), { silent: true });
  if (card.list_id !== targetListId) {
    await logBoardActivity("card.moved", `Moved "${card.title}" to ${listTitle(targetListId)}.`, cardId);
  }
}

async function moveList(listId, beforeListId) {
  if (!isBoardEditor(getRouteBoardId())) return;
  const lists = state.boardData.lists
    .filter((item) => item.id !== listId && (!item.archived || state.filters.showArchived))
    .sort((left, right) => Number(left.position) - Number(right.position));
  const index = beforeListId ? lists.findIndex((item) => item.id === beforeListId) : lists.length;
  const previous = index > 0 ? lists[index - 1] : null;
  const next = index >= 0 && index < lists.length ? lists[index] : null;
  const position = positionBetween(previous?.position, next?.position);
  await restPatchSingle("lists", { id: `eq.${listId}` }, { position, updated_at: isoNow() });
  await openBoard(getRouteBoardId(), { silent: true });
}

async function duplicateBoard() {
  await withBusy("Duplicating board", async () => {
    const result = await functionRequest(`/boards/${getRouteBoardId()}/duplicate`, {
      method: "POST",
      body: {},
    });
    await loadBoards();
    setRouteBoard(result.board_id);
    await openBoard(result.board_id, { silent: true });
    showToast("Board duplicated.");
  });
}

async function exportBoard() {
  const result = await functionRequest(`/boards/${getRouteBoardId()}/export`, {
    method: "POST",
    body: {},
  });
  const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${slugify(state.boardData.board.title)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  showToast("Board exported.");
}

async function copyInvite(token) {
  const url = `${location.origin}?invite=${token}`;
  await navigator.clipboard.writeText(url);
  showToast("Invite copied.");
}

function toggleFilterLabel(labelId) {
  if (state.filters.labelIds.includes(labelId)) {
    state.filters.labelIds = state.filters.labelIds.filter((item) => item !== labelId);
  } else {
    state.filters.labelIds = [...state.filters.labelIds, labelId];
  }
  render();
}

async function acceptPendingInvite() {
  const token = getPendingInviteToken();
  if (!token) return;
  try {
    const result = await functionRequest("/invites/accept", {
      method: "POST",
      body: { token },
    });
    clearPendingInviteToken();
    clearInviteQueryParam();
    showToast(result.already_member ? "Invite already linked to your account." : "Invite accepted.");
    await loadBoards();
    setRouteBoard(result.board_id);
    await openBoard(result.board_id, { silent: true });
  } catch (error) {
    console.error(error);
    clearPendingInviteToken();
    clearInviteQueryParam();
    showToast(error.message || "Invite acceptance failed.");
  }
}

async function logBoardActivity(action, summary, cardId = null) {
  try {
    await restInsert("board_activity", {
      id: crypto.randomUUID(),
      board_id: getRouteBoardId(),
      card_id: cardId,
      user_id: state.user.id,
      action,
      summary,
      metadata: {},
      created_at: isoNow(),
    });
  } catch (error) {
    console.error("activity log failed", error);
  }
}

async function restSelect(table, query = {}) {
  const response = await apiRequest(`/rest/v1/${table}${queryString(query)}`);
  return Array.isArray(response) ? response : [];
}

async function restMaybeSelectOne(table, query = {}) {
  const rows = await restSelect(table, { ...query, limit: "1" });
  return rows[0] || null;
}

async function restInsert(table, payload) {
  return apiRequest(`/rest/v1/${table}`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: payload,
  });
}

async function restPatchSingle(table, query, payload) {
  const rows = await apiRequest(`/rest/v1/${table}${queryString(query)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: payload,
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

async function restDelete(table, query) {
  return apiRequest(`/rest/v1/${table}${queryString(query)}`, {
    method: "DELETE",
    headers: { Prefer: "return=representation" },
  });
}

async function functionRequest(path, { method = "POST", body } = {}) {
  return apiRequest(`/functions/v1/${CONFIG.functionName}${path}`, {
    method,
    body,
  });
}

async function authRequest(path, { method = "GET", body } = {}) {
  return rawRequest(path, {
    method,
    body,
    auth: false,
  });
}

async function apiRequest(path, options = {}) {
  return rawRequest(path, {
    ...options,
    auth: true,
  });
}

async function rawRequest(path, { method = "GET", body, headers = {}, auth = true } = {}) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("apikey", CONFIG.apikey);
  if (body && !requestHeaders.has("Content-Type")) {
    requestHeaders.set("Content-Type", "application/json");
  }
  if (auth && state.session?.access_token) {
    requestHeaders.set("Authorization", `Bearer ${state.session.access_token}`);
  }

  const response = await fetch(`${CONFIG.apiBase}${path}`, {
    method,
    headers: requestHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 401 && auth && state.session?.refresh_token) {
    const refreshed = await refreshSession();
    if (refreshed) {
      return rawRequest(path, { method, body, headers, auth });
    }
  }

  if (!response.ok) {
    const message = await parseError(response);
    throw new Error(message);
  }

  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return response.text();
  }
  return response.json();
}

async function parseError(response) {
  try {
    const body = await response.json();
    return body.error || body.message || `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

async function refreshSession() {
  try {
    const refreshed = await authRequest("/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      body: { refresh_token: state.session.refresh_token },
    });
    state.session = refreshed;
    writeSession(refreshed);
    return true;
  } catch {
    clearSession();
    render();
    return false;
  }
}

async function getCurrentUser() {
  return apiRequest("/auth/v1/user");
}

function readSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

function writeSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  state.session = null;
}

function captureInviteTokenFromUrl() {
  const token = new URL(location.href).searchParams.get("invite");
  if (token) {
    localStorage.setItem(INVITE_KEY, token);
  }
}

function getPendingInviteToken() {
  return localStorage.getItem(INVITE_KEY);
}

function clearPendingInviteToken() {
  localStorage.removeItem(INVITE_KEY);
}

function clearInviteQueryParam() {
  const url = new URL(location.href);
  url.searchParams.delete("invite");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function setRouteBoard(boardId) {
  location.hash = `#/board/${boardId}`;
}

function clearRouteBoard() {
  history.replaceState(null, "", `${location.pathname}${location.search}`);
}

function getRouteBoardId() {
  const match = location.hash.match(/^#\/board\/([0-9a-f-]+)$/i);
  return match ? match[1] : null;
}

function startPolling() {
  stopPolling();
  state.pollTimer = window.setInterval(() => {
    if (!document.hidden && state.session) {
      loadBoards();
      if (getRouteBoardId()) {
        openBoard(getRouteBoardId(), { silent: true });
      }
    }
  }, 30000);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function withBusy(label, work) {
  state.ui.busyLabel = label;
  render();
  try {
    await work();
  } finally {
    state.ui.busyLabel = "";
    render();
  }
}

function showToast(message) {
  state.ui.toast = message;
  if (state.ui.toastTimer) clearTimeout(state.ui.toastTimer);
  state.ui.toastTimer = setTimeout(() => {
    state.ui.toast = "";
    render();
  }, 3600);
  render();
}

function visibleLists() {
  return state.boardData.lists.filter((list) => state.filters.showArchived || !list.archived);
}

function cardsForList(listId) {
  return state.boardData.cards
    .filter((card) => card.list_id === listId)
    .filter((card) => state.filters.showArchived || !card.archived)
    .filter(matchesCardFilters)
    .sort((left, right) => Number(left.position) - Number(right.position));
}

function matchesCardFilters(card) {
  if (state.filters.assignedOnly) {
    const assigned = state.boardData.cardMembers.some((item) => item.card_id === card.id && item.user_id === state.user.id);
    if (!assigned) return false;
  }
  if (state.filters.overdueOnly && !isDueSoon(card)) {
    return false;
  }
  if (state.filters.labelIds.length > 0) {
    const labelIds = state.boardData.cardLabels.filter((item) => item.card_id === card.id).map((item) => item.label_id);
    if (!state.filters.labelIds.every((id) => labelIds.includes(id))) return false;
  }
  const query = state.filters.query.trim().toLowerCase();
  if (!query) return true;
  const haystack = [
    card.title,
    card.description,
    ...commentsFor(card.id).map((comment) => comment.body),
    ...linksFor(card.id).map((link) => link.title + " " + link.url),
  ].join(" ").toLowerCase();
  return haystack.includes(query);
}

function currentCard() {
  return state.boardData?.cards.find((card) => card.id === state.ui.cardId) || null;
}

function boardMembers() {
  return state.boardData.members.slice().sort((left, right) => {
    const rank = roleRank(right.role) - roleRank(left.role);
    if (rank !== 0) return rank;
    return profileFor(left.user_id).display_name.localeCompare(profileFor(right.user_id).display_name);
  });
}

function profileFor(userId) {
  return state.boardData?.profiles.find((profile) => profile.id === userId) || state.profile || { display_name: "User", avatar_tone: "ember" };
}

function cardLabelsFor(cardId) {
  const ids = state.boardData.cardLabels.filter((item) => item.card_id === cardId).map((item) => item.label_id);
  return state.boardData.labels.filter((label) => ids.includes(label.id));
}

function cardAssigneesFor(cardId) {
  const ids = state.boardData.cardMembers.filter((item) => item.card_id === cardId).map((item) => item.user_id);
  return state.boardData.profiles.filter((profile) => ids.includes(profile.id));
}

function checklistFor(cardId) {
  return state.boardData.checklist
    .filter((item) => item.card_id === cardId)
    .sort((left, right) => Number(left.position) - Number(right.position));
}

function commentsFor(cardId) {
  return state.boardData.comments.filter((item) => item.card_id === cardId);
}

function linksFor(cardId) {
  return state.boardData.links.filter((item) => item.card_id === cardId);
}

function visibleCardCount() {
  return visibleLists().reduce((total, list) => total + cardsForList(list.id).length, 0);
}

function dueSoonCards() {
  return state.boardData.cards
    .filter((card) => !card.archived)
    .filter((card) => card.due_at)
    .filter(isDueSoon)
    .sort((left, right) => new Date(left.due_at).getTime() - new Date(right.due_at).getTime())
    .slice(0, 6);
}

function isDueSoon(card) {
  if (!card.due_at) return false;
  const due = new Date(card.due_at).getTime();
  const now = Date.now();
  return due - now < 1000 * 60 * 60 * 72;
}

function listTitle(listId) {
  return state.boardData.lists.find((item) => item.id === listId)?.title || "that list";
}

function cardTitle(cardId) {
  return state.boardData.cards.find((item) => item.id === cardId)?.title || "card";
}

function doneChecklistCount(items) {
  return items.filter((item) => item.done).length;
}

function nextPosition(items) {
  if (!items.length) return 1024;
  const max = Math.max(...items.map((item) => Number(item.position || 0)));
  return max + 1024;
}

function positionBetween(previous, next) {
  if (previous == null && next == null) return 1024;
  if (previous == null) return Number(next) / 2;
  if (next == null) return Number(previous) + 1024;
  return Number(previous) + (Number(next) - Number(previous)) / 2;
}

function roleRank(role) {
  return { owner: 4, admin: 3, member: 2, viewer: 1 }[role] || 0;
}

function isBoardAdmin(boardId) {
  const membership = state.memberships.find((item) => item.board_id === boardId);
  return membership ? roleRank(membership.role) >= roleRank("admin") : false;
}

function isBoardOwner(boardId) {
  const membership = state.memberships.find((item) => item.board_id === boardId);
  return membership?.role === "owner";
}

function isBoardEditor(boardId) {
  const membership = state.memberships.find((item) => item.board_id === boardId);
  return membership ? roleRank(membership.role) >= roleRank("member") : false;
}

function getCurrentBoardRole() {
  return state.memberships.find((item) => item.board_id === getRouteBoardId())?.role || "viewer";
}

function memberCount(board) {
  return Array.isArray(board.member_ids) ? board.member_ids.length : 0;
}

function themeGradient(theme, accent) {
  const map = {
    sunrise: `linear-gradient(90deg, ${accentColor(accent || "ember")}, #f3c76a)`,
    cobalt: `linear-gradient(90deg, #3d63d2, ${accentColor(accent || "gold")})`,
    gallery: `linear-gradient(90deg, #cc527a, ${accentColor(accent || "rose")})`,
    aurora: `linear-gradient(90deg, #4b8b62, #91bda5)`,
    ember: `linear-gradient(90deg, #d95d39, ${accentColor(accent || "ember")})`,
    harbor: `linear-gradient(90deg, #7da0d8, #dce6ee)`,
  };
  return map[theme] || map.sunrise;
}

function accentColor(accent) {
  return {
    ember: "#d95d39",
    gold: "#ca9b35",
    rose: "#cc527a",
    moss: "#4b8b62",
    cobalt: "#3d63d2",
    sand: "#d8b58d",
    mist: "#9eb5c8",
  }[accent] || "#d95d39";
}

function accentTint(accent) {
  return {
    ember: "rgba(217, 93, 57, 0.14)",
    gold: "rgba(202, 155, 53, 0.16)",
    rose: "rgba(204, 82, 122, 0.14)",
    moss: "rgba(75, 139, 98, 0.14)",
    cobalt: "rgba(61, 99, 210, 0.12)",
    sand: "rgba(232, 199, 161, 0.28)",
    mist: "rgba(220, 230, 238, 0.38)",
  }[accent] || "rgba(31,36,48,0.08)";
}

function renderDuePill(card) {
  const stateName = dueState(card);
  return `<span class="due-pill" data-state="${stateName}">${formatDate(card.due_at)}</span>`;
}

function dueState(card) {
  if (!card.due_at) return "future";
  const due = new Date(card.due_at).getTime();
  if (due < Date.now()) return "overdue";
  if (due - Date.now() < 1000 * 60 * 60 * 72) return "soon";
  return "future";
}

function formatTheme(theme) {
  return theme[0].toUpperCase() + theme.slice(1);
}

function formatRelative(value) {
  const date = new Date(value);
  const diff = date.getTime() - Date.now();
  const abs = Math.abs(diff);
  const minute = 60000;
  const hour = minute * 60;
  const day = hour * 24;
  if (abs < hour) return `${Math.round(abs / minute) || 1}m ${diff < 0 ? "ago" : "from now"}`;
  if (abs < day) return `${Math.round(abs / hour)}h ${diff < 0 ? "ago" : "from now"}`;
  return `${Math.round(abs / day)}d ${diff < 0 ? "ago" : "from now"}`;
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function toLocalDateTimeInput(value) {
  const date = new Date(value);
  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function datetimeLocalToIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function initials(text) {
  return String(text)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "U";
}

function trimTo(text, limit) {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function slugify(value) {
  return String(value || "board")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "board";
}

function queryString(query) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, value);
    }
  });
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function buildInFilter(ids) {
  return `in.(${ids.join(",")})`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function isoNow() {
  return new Date().toISOString();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeHtmlAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function captureScroll() {
  const scroller = APP.querySelector("[data-board-scroll]");
  if (scroller) state.ui.scrollLeft = scroller.scrollLeft;
}

function restoreScroll() {
  requestAnimationFrame(() => {
    const scroller = APP.querySelector("[data-board-scroll]");
    if (scroller) scroller.scrollLeft = state.ui.scrollLeft || 0;
  });
}
