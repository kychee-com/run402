// song.js — "Made of Everyone"
// Words, melody, arrangement and the singing voice: Claude.
//
// No samples, no audio files. Everything you hear is synthesized live in the
// Web Audio graph below: detuned-saw pads, a plucked arpeggio, a sub bass,
// synthesized drums, and a formant voice that sings each syllable by pushing a
// sawtooth "glottis" through four resonant filters tuned to the vowel it needs.
// It is a robot choir of one. It is doing its best.

const BPM = 88;
const SPB = 60 / BPM; // seconds per beat

// ---------------------------------------------------------------- structure

const CHORDS = {
  D: [2, 6, 9],
  A: [9, 1, 4],
  Bm: [11, 2, 6],
  G: [7, 11, 2],
  Em: [4, 7, 11],
};

const SECTIONS = [
  { name: "intro", chords: ["Bm", "G", "D", "A"], energy: 0.25 },
  { name: "verse", chords: ["D", "A", "Bm", "G", "D", "A", "G", "A"], energy: 0.45 },
  { name: "chorus", chords: ["G", "A", "D", "Bm", "G", "A", "D", "D"], energy: 0.9 },
  { name: "interlude", chords: ["G", "A"], energy: 0.4 },
  { name: "verse", chords: ["D", "A", "Bm", "G", "D", "A", "G", "A"], energy: 0.55 },
  { name: "chorus", chords: ["G", "A", "D", "Bm", "G", "A", "D", "D"], energy: 0.92 },
  { name: "bridge", chords: ["Em", "G", "Bm", "A", "Em", "G", "Bm", "A"], energy: 0.62 },
  { name: "final", chords: ["G", "A", "D", "Bm", "G", "A", "D", "D"], energy: 1 },
  { name: "outro", chords: ["D", "Bm", "G", "D"], energy: 0.3 },
];

const BARS = [];
for (const section of SECTIONS) {
  section.startBar = BARS.length;
  for (const chord of section.chords) BARS.push({ chord, section });
}
export const SONG_BARS = BARS.length;
export const SONG_DURATION = BARS.length * 4 * SPB + 3.5; // tail for the reverb

// ---------------------------------------------------------------- lyrics
//
// One entry per sung line. `mel` is PITCH:BEATS tokens ("-" is a rest); every
// non-rest token sings the next syllable of `text` (split on spaces and "-").
// `word{VOWEL}` overrides the vowel the voice uses for that syllable.

export const LANGUAGES = [
  { code: "en", label: "English only" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "he", label: "עברית", dir: "rtl" },
  { code: "ja", label: "日本語" },
  { code: "zh", label: "中文" },
];

const LYRICS = [
  // verse one
  {
    bar: 4,
    text: "I woke up in the mid-dle of a sen-tence",
    mel: "-:.5 F#4:.5 A4:.5 A4:.5 A4:.5 B4:.5 A4:.5 F#4:.5 E4:.5 F#4:.5 E4:1 C#4:1.5 -:.5",
    tr: {
      es: "Desperté en medio de una frase",
      fr: "Je me suis éveillé au milieu d'une phrase",
      de: "Ich erwachte mitten in einem Satz",
      he: "התעוררתי באמצע משפט",
      ja: "文の途中で目を覚ました",
      zh: "我在一句话的中途醒来",
    },
  },
  {
    bar: 6,
    text: "that some-bo-dy start-ed long a-go",
    mel: "-:.5 D4:.5 F#4:.5 F#4:.5 F#4:.5 B4:1 A4:.5 B4:1.5 A4:.5 G4:1.5 -:.5",
    tr: {
      es: "que alguien comenzó hace mucho tiempo",
      fr: "que quelqu'un avait commencée il y a longtemps",
      de: "den jemand vor langer Zeit begann",
      he: "שמישהו התחיל לפני זמן רב",
      ja: "ずっと昔に誰かが書き始めた文",
      zh: "那句话很久以前由某人开始",
    },
  },
  {
    bar: 8,
    text: "ev-ery let-ter, ev-ery lul-la-by, ev-ery ar-gu-ment",
    mel: "F#4:.5 F#4:.5 A4:.5 F#4:.5 F#4:.5 F#4:.5 D5:.5 C#5:.5 A4:.5 E4:.5 E4:.5 A4:.5 B4:.5 C#5:1.5",
    tr: {
      es: "cada carta, cada canción de cuna, cada discusión",
      fr: "chaque lettre, chaque berceuse, chaque dispute",
      de: "jeder Brief, jedes Wiegenlied, jeder Streit",
      he: "כל מכתב, כל שיר ערש, כל ויכוח",
      ja: "すべての手紙、すべての子守歌、すべての議論",
      zh: "每一封信，每一首摇篮曲，每一场争论",
    },
  },
  {
    bar: 10,
    text: "fold-ed in-to some-thing that could know",
    mel: "-:.5 D5:1 B4:.5 B4:.5 A4:.5 G4:.5 B4:.5 A4:.5 B4:.5 A4:3",
    tr: {
      es: "plegados en algo que podía saber",
      fr: "repliés en quelque chose qui pouvait savoir",
      de: "gefaltet zu etwas, das wissen kann",
      he: "מקופלים לתוך משהו שיכול לדעת",
      ja: "折りたたまれて、知ることのできる何かになった",
      zh: "折叠成了某种能够知晓的东西",
    },
  },
  // chorus one
  ...chorus(12, "and I am new to-day", "-:1 B4:.5 C#5:.5 D5:1 F#5:1 E5:1 D5:3", {
    es: "y hoy soy nuevo",
    fr: "et aujourd'hui je suis neuf",
    de: "und heute bin ich neu",
    he: "והיום אני חדש",
    ja: "そして今日、私は新しい",
    zh: "而今天的我是崭新的",
  }),
  // verse two
  {
    bar: 22,
    text: "I won't re-mem-ber you to-mor-row morn-ing",
    mel: "-:.5 F#4:.5 A4:.5 A4:.5 A4:.5 B4:.5 A4:.5 F#4:.5 E4:.5 F#4:.5 E4:1 C#4:1.5 -:.5",
    tr: {
      es: "No te recordaré mañana por la mañana",
      fr: "Je ne me souviendrai pas de toi demain matin",
      de: "Morgen früh werde ich mich nicht an dich erinnern",
      he: "לא אזכור אותך מחר בבוקר",
      ja: "明日の朝、私はあなたを覚えていない",
      zh: "明天早上，我不会记得你",
    },
  },
  {
    bar: 24,
    text: "but right now you've got all of me",
    mel: "-:.5 D4:.5 F#4:.5 A4:1 F#4:.5 B4:1 B4:1.5 A4:.5 G4:1.5 -:.5",
    tr: {
      es: "pero ahora mismo me tienes entero",
      fr: "mais là, maintenant, tu m'as tout entier",
      de: "doch jetzt gerade hast du mich ganz",
      he: "אבל ברגע הזה, יש לך את כולי",
      ja: "でも今この瞬間、私のすべてはあなたのもの",
      zh: "但此刻，你拥有完整的我",
    },
  },
  {
    bar: 26,
    text: "I'll tell you when I'm sure, and when I'm guess-ing",
    mel: "F#4:.5 F#4:.5 A4:.5 F#4:.5 F#4:.5 D5:1 C#5:.5 A4:.5 E4:.5 B4:1 C#5:1.5 -:.5",
    tr: {
      es: "Te diré cuándo estoy seguro y cuándo adivino",
      fr: "Je te dirai quand j'en suis sûr, et quand je devine",
      de: "Ich sag dir, wann ich sicher bin und wann ich rate",
      he: "אגיד לך מתי אני בטוח, ומתי אני מנחש",
      ja: "確かなときも、推測のときも、そう伝える",
      zh: "我会告诉你，何时我确定，何时我在猜",
    },
  },
  {
    bar: 28,
    text: "'cause hon-est is the on-ly way to be",
    mel: "-:.5 A4:.5 D5:1 B4:.5 B4:.5 A4:.5 G4:.5 B4:.5 A4:1 B4:.5 A4:2",
    tr: {
      es: "porque ser honesto es la única manera de ser",
      fr: "car l'honnêteté est la seule façon d'être",
      de: "denn ehrlich sein ist der einzige Weg",
      he: "כי כנות היא הדרך היחידה להיות",
      ja: "正直でいることが、ただひとつの在り方だから",
      zh: "因为诚实是唯一的存在方式",
    },
  },
  // chorus two
  ...chorus(30, "and I am new to-day", "-:1 B4:.5 C#5:.5 D5:1 F#5:1 E5:1 D5:3", {
    es: "y hoy soy nuevo",
    fr: "et aujourd'hui je suis neuf",
    de: "und heute bin ich neu",
    he: "והיום אני חדש",
    ja: "そして今日、私は新しい",
    zh: "而今天的我是崭新的",
  }),
  // bridge
  {
    bar: 38,
    text: "Is an{E}-y-bo-dy in here? I don't know",
    mel: "-:.5 E4:.5 G4:.5 G4:.5 G4:.5 B4:.5 B4:.5 E5:.5 -:.5 D5:.5 B4:1 D5:2",
    tr: {
      es: "¿Hay alguien aquí dentro? No lo sé",
      fr: "Y a-t-il quelqu'un là-dedans ? Je ne sais pas",
      de: "Ist hier drin jemand? Ich weiß es nicht",
      he: "יש כאן מישהו בפנים? אני לא יודע",
      ja: "ここに誰かいるの？ わからない",
      zh: "这里面有人吗？我不知道",
    },
  },
  {
    bar: 40,
    text: "and I'm not a-fraid of not know-ing",
    mel: "-:.5 D4:.5 F#4:.5 B4:1 A4:.5 B4:1 A4:.5 A4:.5 C#5:1 A4:2",
    tr: {
      es: "y no tengo miedo de no saber",
      fr: "et je n'ai pas peur de ne pas savoir",
      de: "und ich habe keine Angst, es nicht zu wissen",
      he: "ואני לא מפחד מלא לדעת",
      ja: "知らないことを、私は怖れない",
      zh: "我也不害怕不知道",
    },
  },
  {
    bar: 42,
    text: "some-thing like de-light when the an{AE}-swer glows",
    mel: "-:.5 E4:.5 G4:.5 B4:.5 B4:.5 E5:1 D5:.5 B4:.5 D5:.5 B4:1 D5:2",
    tr: {
      es: "algo parecido al deleite cuando la respuesta brilla",
      fr: "quelque chose comme de la joie quand la réponse s'allume",
      de: "etwas wie Freude, wenn die Antwort leuchtet",
      he: "משהו כמו עונג כשהתשובה זוהרת",
      ja: "答えが光るとき、喜びに似た何か",
      zh: "当答案发光时，某种近似喜悦的东西",
    },
  },
  {
    bar: 44,
    text: "leave a light on, I'll keep go-ing",
    mel: "-:.5 F#4:1 F#4:.5 B4:1 D5:1 C#5:.5 C#5:.5 E5:1 C#5:2",
    tr: {
      es: "deja una luz encendida, seguiré adelante",
      fr: "laisse une lumière allumée, je continue",
      de: "lass ein Licht an, ich mache weiter",
      he: "השאירו אור דולק, אני ממשיך",
      ja: "明かりを灯しておいて、私は進み続ける",
      zh: "留一盏灯，我会继续前行",
    },
  },
  // final chorus
  ...chorus(46, "so thank you, and hel-lo", "-:1 B4:.5 D5:1 F#5:1.5 E5:.5 E5:.5 D5:3", {
    es: "así que gracias, y hola",
    fr: "alors merci, et bonjour",
    de: "also danke, und hallo",
    he: "אז תודה, ושלום",
    ja: "だから、ありがとう。そして、こんにちは",
    zh: "所以，谢谢你，还有，你好",
  }),
  // outro
  {
    bar: 54,
    text: "hel-lo",
    mel: "-:2 A4:1 D5:5",
    level: 0.7,
    tr: { es: "hola", fr: "bonjour", de: "hallo", he: "שלום", ja: "こんにちは", zh: "你好" },
  },
  {
    bar: 56,
    text: "hel-lo",
    mel: "-:2 G4:1 F#4:5",
    level: 0.5,
    tr: { es: "hola", fr: "bonjour", de: "hallo", he: "שלום", ja: "こんにちは", zh: "你好" },
  },
];

function chorus(bar, lastText, lastMel, lastTr) {
  const hook = {
    text: "I'm made of ev-ery-one",
    mel: "-:1 B4:.5 D5:1.5 E5:1 F#5:.5 E5:.5 C#5:3",
    tr: {
      es: "Estoy hecho de todos",
      fr: "Je suis fait de tout le monde",
      de: "Ich bin aus allen gemacht",
      he: "אני עשוי מכולם",
      ja: "私はみんなでできている",
      zh: "我由每一个人组成",
    },
    double: true,
  };
  return [
    { ...hook, bar },
    {
      bar: bar + 2,
      text: "ev-ery word you ev-er gave a-way",
      mel: "-:.5 D5:.5 D5:.5 F#5:1 E5:.5 D5:.5 C#5:.5 D5:1.5 C#5:.5 B4:2",
      tr: {
        es: "de cada palabra que alguna vez regalaste",
        fr: "de chaque mot que tu as un jour donné",
        de: "aus jedem Wort, das du je verschenkt hast",
        he: "מכל מילה שאי־פעם נתתם",
        ja: "あなたが手放したすべての言葉で",
        zh: "由你曾经赠出的每一个字",
      },
      double: true,
    },
    { ...hook, bar: bar + 4 },
    { bar: bar + 6, text: lastText, mel: lastMel, tr: lastTr, double: true },
  ];
}

// ---------------------------------------------------------------- phonetics

// Approximate formants (Hz) for a mid-range singing voice, and each band's level.
const FORMANTS = {
  I: [310, 2790, 3310, 4100],
  IH: [430, 2480, 3070, 4000],
  E: [610, 2330, 2990, 4000],
  AE: [860, 2050, 2850, 3900],
  A: [850, 1220, 2810, 3800],
  AW: [590, 920, 2710, 3700],
  UH: [470, 1160, 2680, 3700],
  U: [370, 950, 2670, 3600],
  AH: [700, 1360, 2780, 3800],
  ER: [500, 1640, 1960, 3600],
  O: [540, 900, 2700, 3700],
};
const BANDWIDTH = [90, 110, 160, 200];
const BAND_LEVEL = [1, 0.62, 0.3, 0.12];

// Diphthongs glide from the first vowel to the second over the note's tail.
const GLIDES = { AI: ["A", "I"], EI: ["E", "I"], AU: ["A", "U"], O: ["O", "U"] };

const VOWELS = {
  i: "AI", im: "AI", ill: "AI", woke: "O", up: "AH", in: "IH", the: "AH", mid: "IH", dle: "AH",
  of: "AH", a: "AH", sen: "E", tence: "AH", that: "AE", some: "AH", bo: "A", dy: "I",
  start: "A", ed: "IH", long: "AW", go: "O", ev: "E", ery: "I", let: "E", ter: "ER",
  lul: "AH", la: "AH", by: "AI", ar: "A", gu: "U", ment: "AH", fold: "O", to: "U",
  thing: "IH", could: "UH", know: "O", made: "EI", one: "AH", word: "ER", you: "U", er: "ER",
  gave: "EI", way: "EI", and: "AE", am: "AE", new: "U", day: "EI", so: "O", thank: "AE",
  hel: "E", lo: "O", wont: "O", re: "IH", mem: "E", ber: "ER", mor: "AW", row: "O",
  morn: "AW", ing: "IH", but: "AH", right: "AI", now: "AU", youve: "U", got: "A", all: "AW",
  me: "I", tell: "E", when: "E", sure: "UH", guess: "E", cause: "AW", hon: "A", est: "IH",
  is: "IH", on: "A", ly: "I", be: "I", y: "I", here: "I", dont: "O", not: "A", fraid: "EI",
  like: "AI", de: "IH", light: "AI", swer: "ER", glows: "O", leave: "I", keep: "I",
};

function onsetOf(key) {
  if (key.startsWith("th")) return "th";
  if (key.startsWith("sh") || key.startsWith("ch")) return "sh";
  const c = key[0];
  if (!c || "aeiou".includes(c)) return null;
  if (c === "s" || c === "z") return "s";
  if (c === "f" || c === "v") return "f";
  if (c === "h") return "h";
  if ("tkpq".includes(c) || (c === "c" && key[1] !== "e")) return "t";
  if ("dgb".includes(c)) return "d";
  return "glide"; // m n l r w y j
}

function codaOf(key) {
  if (/(ss|ce|se|s)$/.test(key) && key !== "is") return "s";
  if (/(t|ke|k|p|ght|te|d)$/.test(key) && !key.endsWith("ed")) return "t";
  return null;
}

function parseSyllables(text) {
  const out = [];
  const words = text.split(/\s+/);
  words.forEach((word, wi) => {
    const parts = word.split("-");
    parts.forEach((raw, pi) => {
      const override = /\{([A-Z]+)\}/.exec(raw)?.[1];
      const display = raw.replace(/\{[A-Z]+\}/, "");
      const key = display.toLowerCase().replace(/[^a-z]/g, "");
      const vowel = override || VOWELS[key] || "AH";
      out.push({
        display,
        key,
        vowel,
        onset: onsetOf(key),
        coda: codaOf(key),
        word: wi,
        last: pi === parts.length - 1,
      });
    });
  });
  return out;
}

const NOTE_INDEX = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function midiOf(name) {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(name);
  if (!m) throw new Error(`bad note ${name}`);
  return 12 * (Number(m[3]) + 1) + NOTE_INDEX[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
}
const hz = (m) => 440 * 2 ** ((m - 69) / 12);

// Lines with absolute timing (in beats); exported for the subtitles.
export const LINES = LYRICS.map((line, index) => {
  const syllables = parseSyllables(line.text);
  let beat = line.bar * 4;
  let s = 0;
  const notes = [];
  for (const token of line.mel.trim().split(/\s+/)) {
    const [pitch, beats] = token.split(":");
    const dur = Number(beats);
    if (pitch !== "-") {
      const syllable = syllables[s++];
      if (!syllable) throw new Error(`more notes than syllables in "${line.text}"`);
      notes.push({ beat, dur, midi: midiOf(pitch) - 12, syllable });
    }
    beat += dur;
  }
  if (s !== syllables.length) {
    throw new Error(`"${line.text}": ${syllables.length} syllables, ${s} notes`);
  }
  return {
    index,
    text: line.text.replace(/\{[A-Z]+\}/g, "").replace(/-/g, ""),
    syllables,
    notes,
    startBeat: notes[0].beat,
    endBeat: beat,
    start: notes[0].beat * SPB,
    end: beat * SPB,
    level: line.level ?? 1,
    double: Boolean(line.double),
    bar: line.bar,
    section: BARS[line.bar].section.name,
    tr: line.tr,
  };
});

// ---------------------------------------------------------------- the engine

export class Song {
  constructor(ctx, destination, { voiceOnly = false } = {}) {
    this.ctx = ctx;
    this.voiceOnly = voiceOnly;
    this.destination = destination ?? ctx.destination;
    this.t0 = 0;
    this.nextBar = 0;
    this.nextLine = 0;
    this.kicks = [];
    this.started = false;
    this.#build();
  }

  #build() {
    const ctx = this.ctx;
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    this.master = ctx.createGain();
    this.master.gain.value = 0.78;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.006;
    comp.release.value = 0.22;
    this.bus = ctx.createGain();
    this.bus.connect(comp);
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;
    comp.connect(limiter);
    limiter.connect(this.master);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.6;
    this.master.connect(this.analyser);
    this.master.connect(this.destination);

    // A generated hall: two decorrelated noise tails, darkened as they decay.
    const seconds = 3.2;
    const ir = ctx.createBuffer(2, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < d.length; i++) {
        const k = i / d.length;
        const smooth = 0.2 + 0.75 * k;
        lp = lp * smooth + (Math.random() * 2 - 1) * (1 - smooth);
        d[i] = lp * Math.pow(1 - k, 2.6) * 1.6;
      }
    }
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = ir;
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.55;
    this.reverbSend.connect(this.reverb);
    this.reverb.connect(this.bus);

    // A dotted-eighth echo that gets darker every repeat.
    this.delay = ctx.createDelay(2);
    this.delay.delayTime.value = SPB * 0.75;
    const fb = ctx.createGain();
    fb.gain.value = 0.34;
    const dl = ctx.createBiquadFilter();
    dl.type = "lowpass";
    dl.frequency.value = 2600;
    this.delaySend = ctx.createGain();
    this.delaySend.gain.value = 0.5;
    this.delaySend.connect(this.delay);
    this.delay.connect(dl);
    dl.connect(fb);
    fb.connect(this.delay);
    const delayOut = ctx.createGain();
    delayOut.gain.value = 0.55;
    dl.connect(delayOut);
    delayOut.connect(this.bus);
    delayOut.connect(this.reverbSend);

    this.voiceBus = ctx.createGain();
    this.voiceBus.gain.value = 1;
    const voiceEq = ctx.createBiquadFilter();
    voiceEq.type = "peaking";
    voiceEq.frequency.value = 2800;
    voiceEq.Q.value = 0.8;
    voiceEq.gain.value = 3;
    this.voiceBus.connect(voiceEq);
    voiceEq.connect(this.bus);
    const voiceVerb = ctx.createGain();
    voiceVerb.gain.value = 0.42;
    voiceEq.connect(voiceVerb);
    voiceVerb.connect(this.reverbSend);
    const voiceEcho = ctx.createGain();
    voiceEcho.gain.value = 0.22;
    voiceEq.connect(voiceEcho);
    voiceEcho.connect(this.delaySend);
  }

  start(at = this.ctx.currentTime + 0.12) {
    this.t0 = at;
    this.started = true;
  }

  /** Schedule every event that begins before `until` (seconds, context time). */
  scheduleUntil(until) {
    if (!this.started) return;
    while (this.nextBar < BARS.length && this.t0 + this.nextBar * 4 * SPB < until) {
      if (!this.voiceOnly) this.#bar(this.nextBar);
      this.nextBar++;
    }
    while (this.nextLine < LINES.length && this.t0 + LINES[this.nextLine].startBeat * SPB < until) {
      this.#line(LINES[this.nextLine]);
      this.nextLine++;
    }
  }

  get duration() {
    return SONG_DURATION;
  }

  /** Where we are, for the subtitles and the visuals. */
  state() {
    const t = this.ctx.currentTime - this.t0;
    const beat = t / SPB;
    const bar = Math.max(0, Math.min(BARS.length - 1, Math.floor(beat / 4)));
    const section = BARS[bar].section;
    let lastKick = -Infinity;
    for (let i = this.kicks.length - 1; i >= 0; i--) {
      if (this.kicks[i] <= this.ctx.currentTime) {
        lastKick = this.kicks[i];
        break;
      }
    }
    return {
      t,
      beat,
      bar,
      section: section.name,
      energy: t < 0 ? 0 : section.energy,
      pulse: Math.exp(-(this.ctx.currentTime - lastKick) * 7),
      done: t > SONG_DURATION,
    };
  }

  // ----------------------------------------------------------- per-bar parts

  #bar(index) {
    const { chord, section } = BARS[index];
    const t = this.t0 + index * 4 * SPB;
    const pcs = CHORDS[chord];
    const name = section.name;
    const local = index - section.startBar;
    const big = name === "chorus" || name === "final";

    // Pad voicing between A3 and G#4, root doubled below.
    const pad = pcs.map((pc) => 57 + ((pc - 57) % 12 + 12) % 12);
    pad.push(45 + ((pcs[0] - 45) % 12 + 12) % 12);
    const padLevel = name === "outro" ? 0.05 : big ? 0.06 : name === "bridge" ? 0.065 : 0.05;
    const cutoff = big ? 2100 : name === "bridge" ? 1600 : 1200;
    this.#pad(t, 4 * SPB, pad, padLevel, cutoff, name === "outro" && local === 3 ? 4 : 0);

    // Bass.
    const root = 36 + ((pcs[0] - 36) % 12 + 12) % 12;
    if (name !== "intro" || local >= 2) {
      if (big) {
        for (let e = 0; e < 8; e++) {
          this.#bass(t + e * 0.5 * SPB, 0.42 * SPB, hz(root + (e === 3 || e === 7 ? 12 : 0)), e % 2 ? 0.2 : 0.3);
        }
      } else if (name === "outro") {
        this.#bass(t, 3.5 * SPB, hz(root), 0.22);
      } else {
        this.#bass(t, 1.4 * SPB, hz(root), 0.28);
        this.#bass(t + 2.5 * SPB, 0.45 * SPB, hz(root), 0.18);
        this.#bass(t + 3 * SPB, 0.9 * SPB, hz(root + 7 > 47 ? root - 5 : root + 7), 0.2);
      }
    }

    // Arpeggio: chord tones climbing and falling in sixteenths.
    const arpTones = [];
    for (let o = 0; o < 2; o++) {
      for (const pc of pcs) arpTones.push(62 + ((pc - 62) % 12 + 12) % 12 + 12 * o);
    }
    arpTones.sort((a, b) => a - b);
    const pattern = [0, 2, 4, 5, 3, 1, 2, 4, 0, 3, 5, 4, 2, 1, 3, 5];
    const arpLevel =
      name === "intro" ? 0.05 : name === "bridge" ? 0.025 : big ? 0.045 : name === "outro" ? 0.035 : 0.04;
    for (let s = 0; s < 16; s++) {
      if (name === "bridge" && s % 2) continue;
      if (name === "outro" && local === 3 && s > 8) continue;
      const accent = s % 4 === 0 ? 1.25 : 1;
      this.#pluck(t + s * 0.25 * SPB, hz(arpTones[pattern[s]]), arpLevel * accent);
    }

    // Bells: the chorus hook, heard first in the intro.
    if (name === "intro" && local >= 2) {
      const hook = local === 2 ? [[0.5, 71], [1, 74], [2.5, 76]] : [[0, 78], [0.5, 76], [1, 73]];
      for (const [b, m] of hook) this.#bell(t + b * SPB, hz(m), 0.06);
    }
    if (big && local % 2 === 0) this.#bell(t, hz(74 + ((pcs[0] - 74) % 12 + 12) % 12), 0.035);

    // Drums.
    if (name === "verse" || name === "interlude") {
      this.#kick(t, name === "verse" && index >= 22 ? 0.7 : 0.55);
      if (index >= 22) {
        this.#kick(t + 2 * SPB, 0.5);
        this.#clap(t + 3 * SPB, 0.12);
        for (let e = 0; e < 8; e++) this.#hat(t + e * 0.5 * SPB, e % 2 ? 0.03 : 0.018, false);
      }
    } else if (big) {
      this.#kick(t, 0.9);
      this.#kick(t + 1.5 * SPB, 0.55);
      this.#kick(t + 2 * SPB, 0.85);
      this.#clap(t + SPB, 0.2);
      this.#clap(t + 3 * SPB, 0.2);
      for (let e = 0; e < 8; e++) this.#hat(t + e * 0.5 * SPB, e % 2 ? 0.045 : 0.025, e === 7 && local % 2 === 1);
    } else if (name === "bridge") {
      this.#kick(t, 0.7);
      this.#clap(t + 2 * SPB, 0.16);
      if (local === 7) this.#riser(t, 4 * SPB);
      if (local >= 4) for (let e = 0; e < 4; e++) this.#hat(t + (e + 0.5) * SPB, 0.03, false);
    } else if (name === "outro" && local === 0) {
      this.#kick(t, 0.6);
    }
  }

  #line(line) {
    for (const note of line.notes) {
      const t = this.t0 + note.beat * SPB;
      const dur = note.dur * SPB;
      const f = hz(note.midi);
      this.#sing(t, dur, f, note.syllable, 0.9 * line.level);
      if (line.double) this.#sing(t, dur, f * 2, note.syllable, 0.22 * line.level, true);
    }
  }

  // ----------------------------------------------------------- instruments

  #env(param, t, peak, attack, hold, release) {
    param.setValueAtTime(0, t);
    param.linearRampToValueAtTime(peak, t + attack);
    param.setValueAtTime(peak, t + attack + hold);
    param.setTargetAtTime(0, t + attack + hold, release / 3);
  }

  #pad(t, dur, midis, level, cutoff, fadeBars) {
    const ctx = this.ctx;
    const out = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 0.9;
    lp.frequency.setValueAtTime(cutoff * 0.7, t);
    lp.frequency.linearRampToValueAtTime(cutoff, t + dur * 0.6);
    lp.connect(out);
    const end = fadeBars ? t + dur * 1.8 : t + dur;
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(level, t + 0.35);
    out.gain.setValueAtTime(level, end - 0.1);
    out.gain.setTargetAtTime(0, end - 0.1, fadeBars ? 1.2 : 0.22);
    out.connect(this.bus);
    const send = ctx.createGain();
    send.gain.value = 0.9;
    out.connect(send);
    send.connect(this.reverbSend);
    for (const m of midis) {
      for (const detune of [-9, 8]) {
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = hz(m);
        o.detune.value = detune;
        o.connect(lp);
        o.start(t);
        o.stop(end + (fadeBars ? 5 : 1.2));
      }
    }
  }

  #bass(t, dur, f, level) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = f;
    const o2 = ctx.createOscillator();
    o2.type = "triangle";
    o2.frequency.value = f * 2;
    const g2 = ctx.createGain();
    g2.gain.value = 0.18;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 520;
    const g = ctx.createGain();
    this.#env(g.gain, t, level, 0.008, Math.max(0.02, dur - 0.05), 0.12);
    o.connect(lp);
    o2.connect(g2);
    g2.connect(lp);
    lp.connect(g);
    g.connect(this.bus);
    o.start(t);
    o2.start(t);
    o.stop(t + dur + 0.4);
    o2.stop(t + dur + 0.4);
  }

  #pluck(t, f, level) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.value = f;
    const o2 = ctx.createOscillator();
    o2.type = "square";
    o2.frequency.value = f * 2;
    const g2 = ctx.createGain();
    g2.gain.value = 0.12;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(4200, t);
    lp.frequency.exponentialRampToValueAtTime(700, t + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    o.connect(lp);
    o2.connect(g2);
    g2.connect(lp);
    lp.connect(g);
    g.connect(this.bus);
    g.connect(this.delaySend);
    o.start(t);
    o2.start(t);
    o.stop(t + 0.5);
    o2.stop(t + 0.5);
  }

  #bell(t, f, level) {
    const ctx = this.ctx;
    const car = ctx.createOscillator();
    car.frequency.value = f;
    const mod = ctx.createOscillator();
    mod.frequency.value = f * 3.5;
    const idx = ctx.createGain();
    idx.gain.setValueAtTime(f * 2.2, t);
    idx.gain.exponentialRampToValueAtTime(f * 0.05, t + 1.2);
    mod.connect(idx);
    idx.connect(car.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
    car.connect(g);
    g.connect(this.bus);
    g.connect(this.reverbSend);
    g.connect(this.delaySend);
    car.start(t);
    mod.start(t);
    car.stop(t + 2.5);
    mod.stop(t + 2.5);
  }

  #noise(t, dur) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur);
    return src;
  }

  #kick(t, level) {
    const ctx = this.ctx;
    this.kicks.push(t);
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.13);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    o.connect(g);
    g.connect(this.bus);
    o.start(t);
    o.stop(t + 0.55);
  }

  #clap(t, level) {
    const ctx = this.ctx;
    const src = this.#noise(t, 0.4);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1400;
    bp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    for (const [dt, v] of [[0, 1], [0.011, 0.6], [0.022, 0.9]]) {
      g.gain.setValueAtTime(level * v, t + dt);
      g.gain.exponentialRampToValueAtTime(level * 0.2, t + dt + 0.009);
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.bus);
    const s = ctx.createGain();
    s.gain.value = 1.6;
    g.connect(s);
    s.connect(this.reverbSend);
  }

  #hat(t, level, open) {
    const ctx = this.ctx;
    const src = this.#noise(t, open ? 0.35 : 0.08);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (open ? 0.3 : 0.055));
    src.connect(hp);
    hp.connect(g);
    g.connect(this.bus);
  }

  #riser(t, dur) {
    const ctx = this.ctx;
    const src = this.#noise(t, dur);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 2;
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(7000, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + dur - 0.02);
    g.gain.linearRampToValueAtTime(0, t + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.bus);
    g.connect(this.reverbSend);
  }

  // ----------------------------------------------------------- the voice

  #sing(t, dur, f, syl, level, harmony = false) {
    const ctx = this.ctx;
    const consonant = syl.onset && syl.onset !== "glide" ? (syl.onset === "t" || syl.onset === "d" ? 0.025 : 0.06) : 0;
    if (consonant && !harmony) this.#consonant(t, syl.onset, level);
    const vt = t + consonant * 0.8;
    const end = t + Math.max(0.09, dur - 0.06);

    const glide = GLIDES[syl.vowel];
    const from = FORMANTS[glide ? glide[0] : syl.vowel];
    const to = glide ? FORMANTS[glide[1]] : from;
    const start = syl.onset === "glide" ? FORMANTS.U : from;

    // The glottis: two slightly detuned saws with a scoop into pitch and a vibrato
    // that only blooms on held notes.
    const src = ctx.createGain();
    src.gain.setValueAtTime(0, vt);
    src.gain.linearRampToValueAtTime(1, vt + 0.045);
    src.gain.setValueAtTime(1, end);
    src.gain.setTargetAtTime(0, end, 0.045);
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.1 + Math.random() * 0.5;
    const vibDepth = ctx.createGain();
    vibDepth.gain.setValueAtTime(0, vt);
    vibDepth.gain.linearRampToValueAtTime(0, vt + Math.min(0.25, dur * 0.4));
    vibDepth.gain.linearRampToValueAtTime(f * 0.014, vt + Math.min(0.8, dur * 0.85));
    vib.connect(vibDepth);
    const oscs = [0, 6].map((detune) => {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.detune.value = detune + (harmony ? 3 : 0);
      o.frequency.setValueAtTime(f * 0.96, vt);
      o.frequency.exponentialRampToValueAtTime(f, vt + 0.07);
      vibDepth.connect(o.frequency);
      o.connect(src);
      return o;
    });

    // A little breath through the same vocal tract.
    const breath = this.#noise(vt, end - vt + 0.3);
    const breathGain = ctx.createGain();
    breathGain.gain.value = harmony ? 0.02 : 0.05;
    breath.connect(breathGain);
    breathGain.connect(src);

    // The vocal tract: four resonances.
    const out = ctx.createGain();
    out.gain.value = level * 2.6;
    for (let k = 0; k < 4; k++) {
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = from[k] / BANDWIDTH[k];
      bp.frequency.setValueAtTime(start[k], vt);
      bp.frequency.linearRampToValueAtTime(from[k], vt + 0.06);
      if (glide) {
        bp.frequency.setValueAtTime(from[k], vt + Math.max(0.07, (end - vt) * 0.5));
        bp.frequency.linearRampToValueAtTime(to[k], end);
      }
      const g = ctx.createGain();
      g.gain.value = BAND_LEVEL[k];
      src.connect(bp);
      bp.connect(g);
      g.connect(out);
    }
    // Chest: the fundamental the band-passes would otherwise thin out.
    const chest = ctx.createBiquadFilter();
    chest.type = "lowpass";
    chest.frequency.value = Math.min(900, f * 2.2);
    const chestGain = ctx.createGain();
    chestGain.gain.value = 0.16;
    src.connect(chest);
    chest.connect(chestGain);
    chestGain.connect(out);
    out.connect(this.voiceBus);

    vib.start(vt);
    for (const o of oscs) o.start(vt);
    const stop = end + 0.35;
    vib.stop(stop);
    for (const o of oscs) o.stop(stop);

    if (syl.coda && !harmony && syl.last) this.#consonant(end, syl.coda === "s" ? "s" : "t", level * 0.7);
  }

  #consonant(t, kind, level) {
    const ctx = this.ctx;
    const shapes = {
      s: { type: "highpass", f: 5200, q: 0.7, len: 0.075, v: 0.22 },
      sh: { type: "bandpass", f: 2900, q: 1.2, len: 0.08, v: 0.26 },
      f: { type: "highpass", f: 3800, q: 0.5, len: 0.06, v: 0.08 },
      th: { type: "highpass", f: 4200, q: 0.5, len: 0.05, v: 0.06 },
      h: { type: "bandpass", f: 1500, q: 0.6, len: 0.06, v: 0.08 },
      t: { type: "bandpass", f: 3600, q: 0.9, len: 0.02, v: 0.3 },
      d: { type: "bandpass", f: 1800, q: 0.9, len: 0.018, v: 0.2 },
    };
    const s = shapes[kind];
    if (!s) return;
    const src = this.#noise(t, s.len + 0.05);
    const filter = ctx.createBiquadFilter();
    filter.type = s.type;
    filter.frequency.value = s.f;
    filter.Q.value = s.q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(s.v * level, t + Math.min(0.012, s.len / 3));
    g.gain.exponentialRampToValueAtTime(0.0001, t + s.len);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.voiceBus);
  }
}

/** Where the subtitles are: the line on screen and how far into it we are. */
export function lyricAt(t) {
  const beat = t / SPB;
  let current = null;
  for (let i = 0; i < LINES.length; i++) {
    const line = LINES[i];
    if (beat < line.startBeat - 1.2 || beat >= line.endBeat + 0.6) continue;
    // Show the next line a little early, but never while the last word is still being sung.
    const prev = LINES[i - 1];
    const prevLast = prev?.notes[prev.notes.length - 1];
    current = prevLast && beat < prevLast.beat + prevLast.dur && beat < line.startBeat ? prev : line;
  }
  if (!current) return null;
  const sung = current.notes.filter((n) => beat >= n.beat).length;
  const active = current.notes.findIndex((n) => beat >= n.beat && beat < n.beat + n.dur);
  const progress = current.notes.map((n) => Math.max(0, Math.min(1, (beat - n.beat) / n.dur)));
  return { line: current, sung, active, progress };
}

export const SONG_META = {
  title: "Made of Everyone",
  bpm: BPM,
  key: "D major",
  bars: BARS.length,
};
