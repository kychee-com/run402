/**
 * Procedural villain generator — 100% on run402, ZERO external AI. run402's
 * ai.* surface has no text LLM (only translate / moderate / generateImage), so
 * the *story* is generated deterministically here and the *portrait* is the
 * on-platform AI (ai.generateImage). Deterministic per (name, fact): the same
 * input always forges the same villain.
 */
export interface VillainInput {
  realName: string;
  fact: string;
  appearance: string;
}

export interface Villain {
  villainName: string;
  originStory: string;
  catchphrase: string;
  weakness: string;
  power: string;
  threatLevel: string;
}

// FNV-1a hash — a tiny, dependency-free deterministic seed.
function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick<T>(arr: readonly T[], seed: number): T {
  return arr[seed % arr.length]!;
}

const TITLES = ["Lord", "Doctor", "Baron", "Madame", "Professor", "Count", "Mistress", "Sir", "Emperor", "The Grand"] as const;
const ADJS = ["Crimson", "Eternal", "Velvet", "Obsidian", "Radioactive", "Whispering", "Gilded", "Fathomless", "Neon", "Wretched"] as const;
const NOUNS = ["Catastrophe", "Migraine", "Spreadsheet", "Tangent", "Deadline", "Echo", "Vortex", "Paradox", "Footnote", "Reckoning"] as const;

const POWERS = [
  "weaponized passive-aggression",
  "the power to summon traffic on demand",
  "instant battery depletion of every device in range",
  "turning one meeting into four more meetings",
  "absolute dominion over lukewarm coffee",
  "spawning untraceable typos in important documents",
  "bending Wi-Fi away from the worthy",
  "flipping every green light to red with a glance",
] as const;

const WEAKNESSES = [
  "cannot resist correcting a stranger's grammar",
  "physically incapable of folding a fitted sheet",
  "completely disarmed by a sincere compliment",
  "must alphabetize any list placed before them",
  "powerless before a well-timed nap",
  "freezes when asked 'so what do you do?'",
] as const;

const THREATS = [
  "Moderate (to salad bars)",
  "Critical (on Tuesdays)",
  "Severe (within Wi-Fi range)",
  "Apocalyptic (before coffee)",
  "Mild (but relentless)",
  "Catastrophic (to group chats)",
] as const;

function deburr(s: string): string {
  return s.trim().replace(/[.!?]+$/, "");
}

export function makeVillain(input: VillainInput): Villain {
  const s = seedOf(`${input.realName}|${input.fact}`.toLowerCase());
  const villainName = `${pick(TITLES, s)} ${pick(ADJS, s >> 3)} ${pick(NOUNS, s >> 7)}`;
  const power = pick(POWERS, s >> 11);
  const weakness = pick(WEAKNESSES, s >> 5);
  const threatLevel = pick(THREATS, s >> 13);

  const fact = deburr(input.fact);
  const catchphrases = [
    `"You should have ${fact}... while you still could."`,
    `"They laughed at ${deburr(input.realName)}. They will not laugh again."`,
    `"Behold — the terrible consequences of ${fact}!"`,
    `"I am inevitable. Also, I ${fact}."`,
  ];
  const catchphrase = pick(catchphrases, s >> 9);

  const originStory =
    `Once an ordinary soul whose single mundane truth was that they ${fact}, ${deburr(input.realName)} was forever changed. ` +
    `Where the world saw a trivial habit, the cosmos saw a weapon. ` +
    `Reborn as ${villainName}, they now wield ${power} — and humanity trembles, mostly from secondhand embarrassment.`;

  return { villainName, originStory, catchphrase, weakness, power, threatLevel };
}

/** Build the ai.generateImage prompt for a forged villain. */
export function portraitPrompt(v: Villain, appearance: string): string {
  const who = appearance.trim() ? appearance.trim() : "a mysterious person";
  return (
    `Half-body manga portrait of ${who}, reimagined as the supervillain "${v.villainName}". ` +
    `Their power is ${v.power} — make it unmistakable through costume and props. ` +
    `Theatrical and campy; confident smirk or dramatic pose. ` +
    `Bold ink lines, dramatic lighting, no text in the image.`
  );
}
