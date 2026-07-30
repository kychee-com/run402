import type { CreateDreamDropInput, DreamDrop, DreamDropVibe } from "../shared";

const ART_KEYS = ["reef", "orb", "moss", "luna", "signal", "drift"];
const PALETTES: Record<DreamDropVibe, [string, string, string]> = {
  kinetic: ["#ff6b57", "#d8ff5e", "#b9a7ff"],
  cosmic: ["#b9a7ff", "#5de4ff", "#ff8ab7"],
  organic: ["#d8ff5e", "#68c38c", "#ff9b6a"],
  quiet: ["#f4efdf", "#b9a7ff", "#7e8b82"],
};

const seedDrops: DreamDrop[] = [
  {
    id: "seed-moonmilk", parentId: null, title: "Moonmilk Radio",
    prompt: "A bedside radio that translates your dreams into an ambient station for the morning.",
    hook: "Wake up to the part of your mind that stayed awake.", vibe: "cosmic",
    imageUrl: null, artKey: "luna", palette: PALETTES.cosmic, remixCount: 18,
    createdAt: "2026-07-30T10:41:00.000Z", createdLabel: "12 MIN AGO", creator: "Mira", source: "demo", payment: null,
  },
  {
    id: "seed-moss", parentId: null, title: "Moss Office",
    prompt: "A tiny living desktop landscape that shows team health through weather and plant growth.",
    hook: "Your standup, but photosynthesis.", vibe: "organic",
    imageUrl: null, artKey: "moss", palette: PALETTES.organic, remixCount: 31,
    createdAt: "2026-07-30T09:58:00.000Z", createdLabel: "55 MIN AGO", creator: "Jo", source: "demo", payment: null,
  },
  {
    id: "seed-reef", parentId: null, title: "Pocket Reef",
    prompt: "A focus timer that grows a strange coral ecosystem while you resist touching your phone.",
    hook: "Attention is a habitat. Grow yours.", vibe: "kinetic",
    imageUrl: null, artKey: "reef", palette: PALETTES.kinetic, remixCount: 42,
    createdAt: "2026-07-30T08:12:00.000Z", createdLabel: "2 HRS AGO", creator: "Ari", source: "demo", payment: null,
  },
  {
    id: "seed-signal", parentId: null, title: "Signal Supper",
    prompt: "A dinner party tool that pairs guests by the questions they are secretly hoping someone asks.",
    hook: "Skip the small talk. Keep the candles.", vibe: "quiet",
    imageUrl: null, artKey: "signal", palette: PALETTES.quiet, remixCount: 9,
    createdAt: "2026-07-29T20:30:00.000Z", createdLabel: "YESTERDAY", creator: "Noor", source: "demo", payment: null,
  },
];

let drops = [...seedDrops];

export function listDemoDrops(): DreamDrop[] {
  return drops.map((drop) => ({ ...drop, palette: [...drop.palette] as DreamDrop["palette"] }));
}

export function createDemoDrop(input: CreateDreamDropInput, parentId: string | null = null): DreamDrop {
  const id = `demo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const drop: DreamDrop = {
    id, parentId, title: titleFromIdea(input.idea), prompt: input.idea, hook: hookFor(input.vibe),
    vibe: input.vibe, imageUrl: null, artKey: ART_KEYS[drops.length % ART_KEYS.length],
    palette: PALETTES[input.vibe], remixCount: 0, createdAt: new Date().toISOString(),
    createdLabel: "JUST NOW", creator: "You", source: "demo", payment: null,
  };
  drops = [drop, ...drops];
  return drop;
}

export function remixDemoDrop(id: string): DreamDrop | null {
  const parent = drops.find((drop) => drop.id === id);
  if (!parent) return null;
  parent.remixCount += 1;
  return createDemoDrop({
    idea: `${parent.prompt} Reimagine it for a world where screens disappeared overnight.`,
    vibe: parent.vibe === "quiet" ? "kinetic" : "quiet",
  }, parent.id);
}

function titleFromIdea(idea: string): string {
  const words = idea.replace(/[^a-zA-Z0-9\s-]/g, " ").trim().split(/\s+/)
    .filter((word) => !["a", "an", "the", "that", "for", "with"].includes(word.toLowerCase())).slice(0, 3);
  return (words.length ? words : ["Untitled", "Future"])
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

function hookFor(vibe: DreamDropVibe): string {
  return {
    kinetic: "Too strange to ignore. Too useful to forget.",
    cosmic: "A small portal for a much bigger possibility.",
    organic: "Technology that behaves more like a living thing.",
    quiet: "Less interface. More feeling.",
  }[vibe];
}
