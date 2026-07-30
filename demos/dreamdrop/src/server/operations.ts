import { HttpError } from "wasp/server";
import type { CreateDreamDrop, EmailDreamDrop, GetDreamDrops, RemixDreamDrop } from "wasp/server/operations";
import type {
  CreateDreamDropInput,
  DreamDrop,
  DreamDropFeed,
  EmailDreamDropInput,
  EmailDreamDropResult,
  RemixDreamDropInput,
} from "../shared";
import { DREAMDROP_VIBES } from "../shared";
import { createDemoDrop, listDemoDrops, remixDemoDrop } from "./demoStore";
import {
  createRun402Drop,
  emailRun402Drop,
  getRun402Feed,
  isRun402Configured,
  remixRun402Drop,
} from "./run402";

const demoFeed = (): DreamDropFeed => ({
  drops: listDemoDrops(),
  mode: "demo",
  statusLabel: "DEMO MODE · READY",
  agentEndpoint: "https://<your-subdomain>.run402.com/agent/remix",
  capabilities: ["Typed Actions", "React Query", "Run402-ready", "x402 contract"],
});

export const getDreamDrops: GetDreamDrops<void, DreamDropFeed> = async () => {
  if (!isRun402Configured) return demoFeed();
  try { return await getRun402Feed(); }
  catch (error) {
    console.error("Run402 feed failed", error);
    throw new HttpError(502, "Run402 is configured, but the DreamDrop feed is unavailable.");
  }
};

export const createDreamDrop: CreateDreamDrop<CreateDreamDropInput, DreamDrop> = async (input) => {
  const clean = validateCreateInput(input);
  try { return isRun402Configured ? await createRun402Drop(clean) : createDemoDrop(clean); }
  catch (error) {
    console.error("DreamDrop generation failed", error);
    throw new HttpError(502, "The artifact forge hit a snag. Please try that drop again.");
  }
};

export const remixDreamDrop: RemixDreamDrop<RemixDreamDropInput, DreamDrop> = async ({ id }) => {
  if (!id || typeof id !== "string") throw new HttpError(400, "Choose a DreamDrop to remix.");
  try {
    if (isRun402Configured) return await remixRun402Drop(id);
    const remix = remixDemoDrop(id);
    if (!remix) throw new HttpError(404, "DreamDrop not found.");
    return remix;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error("DreamDrop remix failed", error);
    throw new HttpError(502, "The remix signal got scrambled. Please try again.");
  }
};

export const emailDreamDrop: EmailDreamDrop<EmailDreamDropInput, EmailDreamDropResult> = async ({ id, email }) => {
  if (!id || typeof id !== "string") throw new HttpError(400, "Choose a DreamDrop first.");
  const cleanEmail = typeof email === "string" ? email.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw new HttpError(400, "Enter a valid email address.");
  if (!isRun402Configured) {
    return { status: "preview", message: `Preview ready for ${cleanEmail} · connect Run402 Email to send it.` };
  }
  try { return await emailRun402Drop(id, cleanEmail); }
  catch (error) {
    console.error("DreamDrop email failed", error);
    throw new HttpError(502, "Run402 Email could not send this drop yet.");
  }
};

function validateCreateInput(input: CreateDreamDropInput): CreateDreamDropInput {
  const idea = typeof input?.idea === "string" ? input.idea.trim().replace(/\s+/g, " ") : "";
  if (idea.length < 12) throw new HttpError(400, "Give the idea at least 12 characters of strange detail.");
  if (idea.length > 280) throw new HttpError(400, "Keep the idea under 280 characters.");
  if (!DREAMDROP_VIBES.includes(input.vibe)) throw new HttpError(400, "Choose a valid visual vibe.");
  return { idea, vibe: input.vibe };
}
