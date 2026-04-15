import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { formatMessage } from "./format.mjs";

const SECRET_ID = process.env.TELEGRAM_SECRET_ID || "agentdb/telegram-bot";
const REGION = process.env.AWS_REGION || "us-east-1";

const sm = new SecretsManagerClient({ region: REGION });

let cachedSecret = null;
async function loadSecret() {
  if (cachedSecret) return cachedSecret;
  const out = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
  cachedSecret = JSON.parse(out.SecretString);
  return cachedSecret;
}

async function sendTelegram(botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram API ${res.status}: ${body.slice(0, 200)}`);
  }
}

export async function handler(event) {
  const { bot_token, chat_id } = await loadSecret();
  const records = event?.Records ?? [];
  for (const rec of records) {
    let alarm;
    try {
      alarm = JSON.parse(rec.Sns.Message);
    } catch (err) {
      console.error("Could not parse SNS Message as JSON:", err.message);
      continue;
    }
    const text = formatMessage(alarm, REGION);
    await sendTelegram(bot_token, chat_id, text);
  }
  return { ok: true, delivered: records.length };
}
