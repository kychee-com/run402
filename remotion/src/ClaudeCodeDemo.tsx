import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
} from 'remotion';

export const CC_FPS = 30;
export const CC_WIDTH = 1280;
export const CC_HEIGHT = 800;

// Timing (in frames)
const USER1_START = 30;
const USER1_SPEED = 3;
const USER1_TEXT = 'Make me a video to demo run402 for Coinbase';
const USER1_END = USER1_START + USER1_TEXT.length * USER1_SPEED + 20;

const CLAUDE_START = USER1_END + 20;
const CLAUDE_TEXT = 'Would you like me to host the video ON TOP of run402.com?';
const CLAUDE_SPEED = 1.5;
const CLAUDE_END = CLAUDE_START + CLAUDE_TEXT.length * CLAUDE_SPEED + 25;

const USER2_START = CLAUDE_END + 30;
const USER2_TEXT = 'Cool idea - yes please!';
const USER2_SPEED = 3;
const USER2_END = USER2_START + USER2_TEXT.length * USER2_SPEED + 30;

export const CC_DURATION = Math.ceil(USER2_END + 60);

const C = {
  bg: '#1b2333',
  termBg: '#1b2333',
  text: '#c9d1d9',
  dim: '#6b7688',
  prompt: '#c9d1d9',
  divider: '#2d3748',
  cursor: '#c9d1d9',
  mascot: '#d97757',
  mascotDark: '#b5634a',
  mascotEyes: '#2d2d2d',
  pink: '#e06c9a',
  statusText: '#6b7688',
  white: '#e6edf3',
};

const FONT = "Menlo, 'SF Mono', 'JetBrains Mono', 'Cascadia Code', monospace";

// Pixel art Claude mascot (simplified SVG)
const ClaudeMascot: React.FC<{size: number}> = ({size}) => {
  const s = size / 64;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      {/* Ears/antennae */}
      <rect x="14" y="4" width="8" height="8" fill={C.mascot} />
      <rect x="42" y="4" width="8" height="8" fill={C.mascot} />
      <rect x="18" y="0" width="4" height="8" fill={C.mascot} />
      <rect x="42" y="0" width="4" height="8" fill={C.mascot} />
      {/* Head */}
      <rect x="10" y="12" width="44" height="28" rx="2" fill={C.mascot} />
      {/* Eyes */}
      <rect x="22" y="20" width="5" height="8" fill={C.mascotEyes} />
      <rect x="37" y="20" width="5" height="8" fill={C.mascotEyes} />
      {/* Mouth area - slightly darker */}
      <rect x="18" y="32" width="28" height="4" fill={C.mascotDark} />
      {/* Legs */}
      <rect x="12" y="40" width="6" height="12" fill={C.mascot} />
      <rect x="22" y="40" width="6" height="10" fill={C.mascot} />
      <rect x="36" y="40" width="6" height="10" fill={C.mascot} />
      <rect x="46" y="40" width="6" height="12" fill={C.mascot} />
      {/* Feet */}
      <rect x="10" y="50" width="10" height="4" fill={C.mascot} />
      <rect x="44" y="50" width="10" height="4" fill={C.mascot} />
    </svg>
  );
};

const TypedText: React.FC<{
  text: string;
  startFrame: number;
  speed: number;
  color?: string;
}> = ({text, startFrame, speed, color = C.text}) => {
  const frame = useCurrentFrame();
  const elapsed = Math.max(0, frame - startFrame);
  const charsToShow = Math.min(Math.floor(elapsed / speed), text.length);

  return (
    <>
      <span style={{color}}>{text.substring(0, charsToShow)}</span>
      <span style={{color: 'transparent'}}>{text.substring(charsToShow)}</span>
    </>
  );
};

const BlockCursor: React.FC<{
  visible: boolean;
  startFrame: number;
  endFrame?: number;
}> = ({visible, startFrame, endFrame}) => {
  const frame = useCurrentFrame();
  if (!visible || frame < startFrame || (endFrame && frame >= endFrame)) return null;
  const blink = Math.floor(frame / 10) % 2 === 0;

  return (
    <span
      style={{
        display: 'inline-block',
        width: 10,
        height: 22,
        backgroundColor: blink ? C.cursor : 'transparent',
        verticalAlign: 'text-bottom',
        marginLeft: 2,
      }}
    />
  );
};

const Spinner: React.FC<{startFrame: number; endFrame: number}> = ({startFrame, endFrame}) => {
  const frame = useCurrentFrame();
  if (frame < startFrame || frame >= endFrame) return null;
  const chars = ['\u28CB', '\u28D9', '\u28F9', '\u28F8', '\u28FC', '\u28F4', '\u28E6', '\u28E7', '\u28C7', '\u28CF'];
  const idx = Math.floor((frame - startFrame) / 3) % chars.length;
  return <span style={{color: C.mascot}}>{chars[idx]} </span>;
};

export const ClaudeCodeDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const windowOpacity = interpolate(frame, [0, 15], [0, 1], {extrapolateRight: 'clamp'});

  return (
    <AbsoluteFill style={{backgroundColor: '#0f1520'}}>
      <div
        style={{
          opacity: windowOpacity,
          position: 'absolute',
          inset: 0,
          backgroundColor: C.bg,
          fontFamily: FONT,
          fontSize: 18,
          lineHeight: 1.6,
          color: C.text,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header area */}
        <div style={{padding: '28px 32px 20px 32px', display: 'flex', alignItems: 'flex-start', gap: 16}}>
          <ClaudeMascot size={72} />
          <div style={{paddingTop: 4}}>
            <div>
              <span style={{fontWeight: 700, color: C.white, fontSize: 20}}>Claude Code</span>
              <span style={{color: C.dim, fontSize: 20}}> v2.1.78</span>
            </div>
            <div style={{color: C.dim, fontSize: 17}}>
              Opus 4.6 (1M context) with high effort · Claude Max
            </div>
            <div style={{color: C.dim, fontSize: 17}}>
              ~/Developer/run402
            </div>
          </div>
        </div>

        {/* Divider */}
        <div style={{height: 1, backgroundColor: C.divider, margin: '0 0'}} />

        {/* Chat area */}
        <div style={{flex: 1, padding: '24px 32px', display: 'flex', flexDirection: 'column'}}>

          {/* User message 1 */}
          <div style={{marginBottom: 8}}>
            <span style={{fontWeight: 700, color: C.prompt, fontSize: 20}}>{'›'} </span>
            <TypedText
              text={USER1_TEXT}
              startFrame={USER1_START}
              speed={USER1_SPEED}
            />
            <BlockCursor visible startFrame={USER1_START} endFrame={USER1_END} />
          </div>

          {/* Divider after user sends */}
          {frame >= USER1_END && (
            <div style={{height: 1, backgroundColor: C.divider, margin: '16px 0'}} />
          )}

          {/* Claude thinking + response */}
          {frame >= USER1_END && frame < CLAUDE_START && (
            <div style={{marginTop: 8}}>
              <Spinner startFrame={USER1_END} endFrame={CLAUDE_START} />
              <span style={{color: C.dim}}>Thinking...</span>
            </div>
          )}

          {frame >= CLAUDE_START && (
            <div style={{marginTop: 8, marginBottom: 8}}>
              <TypedText
                text={CLAUDE_TEXT}
                startFrame={CLAUDE_START}
                speed={CLAUDE_SPEED}
                color={C.white}
              />
            </div>
          )}

          {/* Divider before next prompt */}
          {frame >= CLAUDE_END && (
            <div style={{height: 1, backgroundColor: C.divider, margin: '16px 0'}} />
          )}

          {/* User message 2 */}
          {frame >= USER2_START && (
            <div style={{marginBottom: 8}}>
              <span style={{fontWeight: 700, color: C.prompt, fontSize: 20}}>{'›'} </span>
              <TypedText
                text={USER2_TEXT}
                startFrame={USER2_START}
                speed={USER2_SPEED}
              />
              <BlockCursor visible startFrame={USER2_START} endFrame={USER2_END} />
            </div>
          )}

          <div style={{flex: 1}} />
        </div>

        {/* Divider above status */}
        <div style={{height: 1, backgroundColor: C.divider}} />

        {/* Status bar */}
        <div
          style={{
            height: 32,
            padding: '0 32px',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            fontFamily: FONT,
            fontSize: 15,
            color: C.statusText,
          }}
        >
          <span style={{color: C.white, fontWeight: 600}}>run402</span>
          <span style={{color: C.dim}}>main</span>
          <span>
            <span style={{color: C.white}}>3</span>
            {' '}
            <span style={{color: C.pink, fontWeight: 600}}>changed</span>
          </span>
          <span>
            <span style={{color: C.dim}}>9 untracked</span>
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};
