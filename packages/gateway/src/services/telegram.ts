import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } from "../config.js";

export function notifyMessage(message: string): void {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const text = `💬 New message via /message/v1\n\n${message}`;

  fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
    }),
  }).catch((err) => {
    console.error("Telegram notification failed:", err.message);
  });
}

export function notifyNewProject(name: string, tier: string, projectId: string, walletAddress?: string): void {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  let text = `🆕 New project created\n\nName: ${name}\nTier: ${tier}\nID: ${projectId}`;
  if (walletAddress) {
    text += `\nWallet: ${walletAddress}`;
    text += `\n\nhttps://run402.com/admin/wallet/${walletAddress}`;
  }

  fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
    }),
  }).catch((err) => {
    console.error("Telegram notification failed:", err.message);
  });
}
