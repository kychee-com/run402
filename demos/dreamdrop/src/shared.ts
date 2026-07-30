export const DREAMDROP_VIBES = ["kinetic", "cosmic", "organic", "quiet"] as const;

export type DreamDropVibe = (typeof DREAMDROP_VIBES)[number];
export type DreamDropSource = "demo" | "run402";

export type DreamDropPayment = {
  paymentId: string;
  payer: string | null;
  amountUsdMicros: number;
};

export type DreamDrop = {
  id: string;
  parentId: string | null;
  title: string;
  prompt: string;
  hook: string;
  vibe: DreamDropVibe;
  imageUrl: string | null;
  artKey: string;
  palette: [string, string, string];
  remixCount: number;
  createdAt: string;
  createdLabel: string;
  creator: string;
  source: DreamDropSource;
  payment: DreamDropPayment | null;
};

export type DreamDropFeed = {
  drops: DreamDrop[];
  mode: DreamDropSource;
  statusLabel: string;
  agentEndpoint: string;
  capabilities: string[];
};

export type CreateDreamDropInput = {
  idea: string;
  vibe: DreamDropVibe;
};

export type RemixDreamDropInput = {
  id: string;
};

export type EmailDreamDropInput = {
  id: string;
  email: string;
};

export type EmailDreamDropResult = {
  status: "sent" | "preview";
  message: string;
};
