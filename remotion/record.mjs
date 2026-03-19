import puppeteer from 'puppeteer';
import { mkdirSync, existsSync, readdirSync, unlinkSync, copyFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;
const DURATION_S = 50;
const FRAMES_DIR = join(__dirname, 'out', 'recording');
const OUTPUT = join(__dirname, 'out', 'run402-demo.mp4');

// Clean frames dir
if (existsSync(FRAMES_DIR)) {
  for (const f of readdirSync(FRAMES_DIR)) unlinkSync(join(FRAMES_DIR, f));
} else {
  mkdirSync(FRAMES_DIR, { recursive: true });
}

const totalFrames = FPS * DURATION_S;
const msPerFrame = 1000 / FPS;
console.log(`Recording ${totalFrames} frames at ${FPS}fps (${DURATION_S}s)...`);

const browser = await puppeteer.launch({
  headless: true,
  args: [`--window-size=${WIDTH},${HEIGHT}`],
});

const page = await browser.newPage();
await page.setViewport({ width: WIDTH, height: HEIGHT });

// Inject virtual clock BEFORE page loads
await page.evaluateOnNewDocument(() => {
  // Virtual time starts at 0
  let virtualTime = 0;
  let timerId = 1;
  const timers = new Map(); // id -> { fn, delay, repeat, scheduled }
  const rafs = [];

  // Override Date.now and performance.now
  Date.now = () => virtualTime;
  const origPerfNow = performance.now.bind(performance);
  performance.now = () => virtualTime;

  // Override setTimeout
  window._origSetTimeout = window.setTimeout;
  window.setTimeout = (fn, delay = 0, ...args) => {
    const id = timerId++;
    timers.set(id, { fn, delay: delay || 0, repeat: false, scheduled: virtualTime, args });
    return id;
  };

  // Override setInterval
  window._origSetInterval = window.setInterval;
  window.setInterval = (fn, delay = 0, ...args) => {
    const id = timerId++;
    timers.set(id, { fn, delay: delay || 0, repeat: true, scheduled: virtualTime, args });
    return id;
  };

  window.clearTimeout = (id) => timers.delete(id);
  window.clearInterval = (id) => timers.delete(id);

  // Override requestAnimationFrame
  window.requestAnimationFrame = (fn) => {
    rafs.push(fn);
    return rafs.length;
  };
  window.cancelAnimationFrame = () => {};

  // Advance virtual clock - called from Puppeteer per frame
  window.__advanceTime = (ms) => {
    virtualTime += ms;

    // Fire expired timers
    const toFire = [];
    for (const [id, t] of timers) {
      while (t.scheduled + t.delay <= virtualTime) {
        toFire.push({ id, fn: t.fn, args: t.args, repeat: t.repeat });
        if (t.repeat) {
          t.scheduled += t.delay;
        } else {
          timers.delete(id);
          break;
        }
      }
    }
    for (const { fn, args } of toFire) {
      try { fn(...(args || [])); } catch (e) { console.error(e); }
    }

    // Fire rafs
    const pending = rafs.splice(0);
    for (const fn of pending) {
      try { fn(virtualTime); } catch (e) { console.error(e); }
    }
  };

  window.__getVirtualTime = () => virtualTime;

  // Sync CSS animations to virtual clock
  const origRAF = window.requestAnimationFrame;
  window.__syncCSSAnimations = () => {
    document.getAnimations().forEach(anim => {
      anim.currentTime = virtualTime;
    });
  };
});

await page.goto(`http://localhost:8402/claude-code-preview.html?autoplay`, {
  waitUntil: 'networkidle0',
  timeout: 10000,
});

// Small real delay for fonts
await new Promise(r => setTimeout(r, 2000));

// Inject scene timing logger
await page.evaluate(() => {
  window.__sceneTimings = {};
  const origBuilders = ['buildScene1','buildScene2','buildScene3','buildScene4','buildScene5'];
  origBuilders.forEach(name => {
    const orig = window[name];
    window[name] = function() {
      window.__sceneTimings[name] = window.__getVirtualTime();
      return orig.apply(this, arguments);
    };
  });
});

console.log('Starting frame capture...');

for (let i = 0; i < totalFrames; i++) {
  // Advance virtual clock and sync CSS animations
  await page.evaluate((ms) => {
    window.__advanceTime(ms);
    window.__syncCSSAnimations();
  }, msPerFrame);

  // Small real delay for rendering
  await new Promise(r => setTimeout(r, 10));

  const padded = String(i).padStart(5, '0');
  await page.screenshot({
    path: join(FRAMES_DIR, `frame_${padded}.png`),
    type: 'png',
  });

  if (i % (FPS * 5) === 0) {
    const sec = (i / FPS).toFixed(0);
    console.log(`  ${sec}s / ${DURATION_S}s (frame ${i}/${totalFrames})`);
  }
}

// Get actual scene timings
const timings = await page.evaluate(() => window.__sceneTimings);
console.log('\nActual scene timings (ms):');
for (const [name, ms] of Object.entries(timings)) {
  console.log(`  ${name}: ${ms}ms (${(ms/1000).toFixed(2)}s)`);
}

await browser.close();
console.log(`\nFrames captured. Encoding to MP4...`);

// Generate typing click audio using the same Web Audio synthesis as the HTML
console.log('Generating typing sounds via Web Audio...');
{
  const clickTimesMs = [];
  const t1Start = 1900;
  const t1Text = 'Make me a video to demo run402 for Coinbase';
  for (let c = 0; c < t1Text.length; c++) {
    if (t1Text[c] !== ' ') clickTimesMs.push(t1Start + c * 80);
  }
  const t3Start = 7620;
  const t3Text = 'Cool idea - yes please!';
  for (let c = 0; c < t3Text.length; c++) {
    if (t3Text[c] !== ' ') clickTimesMs.push(t3Start + c * 80);
  }

  const clickBrowser = await puppeteer.launch({ headless: true });
  const clickPage = await clickBrowser.newPage();
  await clickPage.setContent('<html><body></body></html>');

  const wavBase64 = await clickPage.evaluate((clicks, durS) => {
    const sampleRate = 44100;
    const totalSamples = sampleRate * durS;
    const ctx = new OfflineAudioContext(1, totalSamples, sampleRate);

    clicks.forEach(tMs => {
      const startTime = tMs / 1000;
      const bufSize = Math.floor(sampleRate * 0.025);
      const buf = ctx.createBuffer(1, bufSize, sampleRate);
      const data = buf.getChannelData(0);
      for (let j = 0; j < bufSize; j++) {
        const env = Math.exp(-j / (bufSize * 0.15));
        data[j] = (Math.random() * 2 - 1) * env * 0.3;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const filt = ctx.createBiquadFilter();
      filt.type = 'bandpass';
      filt.frequency.value = 800 + Math.random() * 600;
      filt.Q.value = 1.5;
      const gain = ctx.createGain();
      gain.gain.value = 0.15 + Math.random() * 0.1;
      src.connect(filt);
      filt.connect(gain);
      gain.connect(ctx.destination);
      src.start(startTime);
    });

    return ctx.startRendering().then(rendered => {
      const samples = rendered.getChannelData(0);
      // Encode as 16-bit PCM WAV
      const numSamples = samples.length;
      const buffer = new ArrayBuffer(44 + numSamples * 2);
      const view = new DataView(buffer);
      const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
      writeStr(0, 'RIFF');
      view.setUint32(4, 36 + numSamples * 2, true);
      writeStr(8, 'WAVE');
      writeStr(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeStr(36, 'data');
      view.setUint32(40, numSamples * 2, true);
      for (let i = 0; i < numSamples; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(44 + i * 2, s * 32767, true);
      }
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    });
  }, clickTimesMs, DURATION_S);

  await clickBrowser.close();

  const wavBuf = Buffer.from(wavBase64, 'base64');
  const { writeFileSync: wf } = await import('fs');
  wf(join(__dirname, 'out', 'audio', 'typing-clicks.wav'), wavBuf);
  console.log(`Typing sounds generated: ${(wavBuf.length / 1024).toFixed(0)}KB`);
}

// Encode video
execSync(
  `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/frame_%05d.png" -c:v libx264 -pix_fmt yuv420p -crf 18 -preset fast "${OUTPUT}.tmp.mp4"`,
  { stdio: 'inherit' }
);

// Now add audio tracks
// Scene timing (approximate, based on animation):
// 0.0s  - 1.5s:  Splash
// 1.5s  - 17s:   Claude Code terminal
// 17s   - 22s:   Allowance (slide2 audio)
// 22s   - 27s:   Infrastructure (slide3 audio)
// 27s   - 32s:   SIWX (slide4 audio)
// 32s   - 38s:   Testimonials (slide5 audio)
// 38s   - 46s:   Closing (slide6 audio)

const audioTracks = [
  { file: join(__dirname, 'out', 'audio', 'typing-clicks.wav'), start: 0 },
  { file: join(__dirname, 'out', 'audio', 'slide2-voice-short.mp3'), start: 14.4 },
  { file: join(__dirname, 'out', 'audio', 'slide3-voice.mp3'), start: 19.9 },
  { file: join(__dirname, 'out', 'audio', 'slide4-voice.mp3'), start: 25.3 },
  { file: join(__dirname, 'out', 'audio', 'slide5-voice.mp3'), start: 30.8 },
  { file: join(__dirname, 'out', 'audio', 'slide6-voice.mp3'), start: 37.2 },
];

// Check which audio files exist
const validAudio = audioTracks.filter(a => existsSync(a.file));

if (validAudio.length > 0) {
  // Build ffmpeg filter for mixing audio
  let inputs = `-i "${OUTPUT}.tmp.mp4"`;
  let filterParts = [];

  validAudio.forEach((a, i) => {
    inputs += ` -i "${a.file}"`;
    filterParts.push(`[${i + 1}:a]adelay=${a.start * 1000}|${a.start * 1000}[a${i}]`);
  });

  const mixInputs = validAudio.map((_, i) => `[a${i}]`).join('');
  const filter = filterParts.join(';') + `;${mixInputs}amix=inputs=${validAudio.length}:normalize=0[aout]`;

  execSync(
    `ffmpeg -y ${inputs} -filter_complex "${filter}" -map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 128k "${OUTPUT}"`,
    { stdio: 'inherit' }
  );
  unlinkSync(`${OUTPUT}.tmp.mp4`);
  console.log(`\nDone (with audio): ${OUTPUT}`);
} else {
  execSync(`mv "${OUTPUT}.tmp.mp4" "${OUTPUT}"`);
  console.log(`\nDone (no audio): ${OUTPUT}`);
}
