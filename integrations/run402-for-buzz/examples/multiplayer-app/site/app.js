const board = document.querySelector("#board");
const template = document.querySelector("#card-template");
const status = document.querySelector("#form-status");

async function api(body) {
  const response = await fetch("/api/feedback", body ? {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  } : { headers: { accept: "application/json" } });
  if (response.status === 401) {
    location.assign(`/auth/sign-in?returnTo=${encodeURIComponent(location.pathname)}`);
    return null;
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || data.error || `Request failed (${response.status})`);
  return data;
}

async function load() {
  board.textContent = "Loading…";
  try {
    const { items } = await api();
    board.replaceChildren(...items.map(card));
  } catch (error) {
    board.textContent = error.message;
  }
}

function card(item) {
  const node = template.content.firstElementChild.cloneNode(true);
  node.querySelector("h3").textContent = item.title;
  node.querySelector(".body").textContent = item.body;
  node.querySelector(".status").textContent = item.status;
  node.querySelector("time").textContent = new Date(item.created_at).toLocaleDateString();
  node.querySelector(".vote span").textContent = String(item.votes);
  const attachment = node.querySelector(".attachment");
  if (item.attachment_url) attachment.href = item.attachment_url;
  else attachment.remove();
  const comments = node.querySelector(".comments");
  for (const comment of item.comments) {
    const p = document.createElement("p");
    p.textContent = comment.body;
    comments.append(p);
  }
  node.querySelector(".vote").addEventListener("click", async () => {
    await api({ action: "vote", feedback_id: item.id });
    await load();
  });
  node.querySelector(".comment-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await api({ action: "comment", feedback_id: item.id, body: new FormData(event.currentTarget).get("body") });
    await load();
  });
  return node;
}

document.querySelector("#feedback-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  status.textContent = "Publishing…";
  const values = Object.fromEntries(new FormData(event.currentTarget));
  try {
    await api({ action: "create", ...values, attachment_url: values.attachment_url || null });
    event.currentTarget.reset();
    status.textContent = "Published.";
    await load();
  } catch (error) {
    status.textContent = error.message;
  }
});
document.querySelector("#refresh").addEventListener("click", load);
load();
