import React from 'react';
import {
  AbsoluteFill,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

export const TEST_VIDEO_FPS = 30;
export const TEST_VIDEO_WIDTH = 1280;
export const TEST_VIDEO_HEIGHT = 720;
export const TEST_VIDEO_DURATION = 12 * TEST_VIDEO_FPS; // 12 seconds

const COLORS = {
  bg: '#0A0A0F',
  green: '#00FF9F',
  blue: '#59D0FF',
  purple: '#B69CFF',
  amber: '#FFD47A',
  text: '#F7FBFF',
  muted: 'rgba(247, 251, 255, 0.6)',
};

const TypeWriter: React.FC<{
  text: string;
  startFrame: number;
  speed?: number;
  color?: string;
  fontSize?: number;
  fontWeight?: number;
  mono?: boolean;
}> = ({text, startFrame, speed = 2, color = COLORS.text, fontSize = 48, fontWeight = 700, mono = false}) => {
  const frame = useCurrentFrame();
  const elapsed = Math.max(0, frame - startFrame);
  const charsToShow = Math.min(Math.floor(elapsed / speed), text.length);

  return (
    <div
      style={{
        fontSize,
        fontWeight,
        fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'Inter, system-ui, sans-serif',
        letterSpacing: mono ? 0 : -1.5,
        lineHeight: 1.2,
      }}
    >
      <span style={{color}}>{text.substring(0, charsToShow)}</span>
      <span style={{color: 'transparent'}}>{text.substring(charsToShow)}</span>
    </div>
  );
};

const FloatingOrb: React.FC<{
  x: number;
  y: number;
  size: number;
  color: string;
  speed: number;
}> = ({x, y, size, color, speed}) => {
  const frame = useCurrentFrame();
  const offsetY = Math.sin(frame * speed * 0.02) * 20;
  const offsetX = Math.cos(frame * speed * 0.015) * 15;

  return (
    <div
      style={{
        position: 'absolute',
        left: `${x}%`,
        top: `${y}%`,
        width: size,
        height: size,
        borderRadius: '50%',
        background: `radial-gradient(circle, ${color}40, ${color}00)`,
        filter: 'blur(30px)',
        transform: `translate(${offsetX}px, ${offsetY}px)`,
      }}
    />
  );
};

const CodeLine: React.FC<{
  text: string;
  delay: number;
  color?: string;
}> = ({text, delay, color = '#C8C8D0'}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const s = spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: {damping: 20, stiffness: 120},
  });

  return (
    <div
      style={{
        fontSize: 22,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        lineHeight: 1.8,
        height: 40,
      }}
    >
      <span style={{opacity: s, color}}>{text}</span>
    </div>
  );
};

const IntroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const logoScale = spring({
    frame,
    fps,
    config: {damping: 14, stiffness: 80},
  });

  return (
    <AbsoluteFill>
      <div style={{
        position: 'absolute',
        top: 180,
        left: 0,
        right: 0,
        textAlign: 'center',
        opacity: logoScale,
      }}>
        <div
          style={{
            display: 'inline-block',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 14,
            color: COLORS.green,
            border: `1px solid ${COLORS.green}50`,
            borderRadius: 6,
            padding: '6px 14px',
          }}
        >
          run402.com
        </div>
      </div>

      <div style={{position: 'absolute', top: 260, left: 80, right: 80, textAlign: 'center'}}>
        <TypeWriter
          text="Your agent needs a backend."
          startFrame={15}
          fontSize={58}
          color={COLORS.text}
          speed={2}
        />
      </div>

      <div style={{position: 'absolute', top: 340, left: 80, right: 80, textAlign: 'center'}}>
        <TypeWriter
          text="We made it one HTTP call."
          startFrame={80}
          fontSize={58}
          color={COLORS.green}
          speed={2}
        />
      </div>
    </AbsoluteFill>
  );
};

const CodeScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const panelSpring = spring({
    frame,
    fps,
    config: {damping: 18, stiffness: 100},
  });

  return (
    <AbsoluteFill style={{padding: '60px 100px'}}>
      <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 60, alignItems: 'start', position: 'absolute', top: 140, left: 100, right: 100}}>
        <div>
          <TypeWriter
            text="POST /deploy/v1"
            startFrame={5}
            fontSize={42}
            color={COLORS.green}
            speed={2}
            mono
          />
          <div style={{marginTop: 24}}>
            <TypeWriter
              text="Database + API + Auth + Site"
              startFrame={40}
              fontSize={36}
              color={COLORS.text}
              speed={1.5}
            />
          </div>
          <div style={{marginTop: 12}}>
            <TypeWriter
              text="Deployed. Live. Done."
              startFrame={90}
              fontSize={36}
              color={COLORS.amber}
              speed={2}
            />
          </div>
        </div>

        <div
          style={{
            opacity: panelSpring,
            background: 'rgba(10, 17, 31, 0.8)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: 16,
            padding: '24px 28px',
            backdropFilter: 'blur(10px)',
          }}
        >
          <div style={{display: 'flex', gap: 6, marginBottom: 16}}>
            <div style={{width: 10, height: 10, borderRadius: 999, background: '#FF5F57'}} />
            <div style={{width: 10, height: 10, borderRadius: 999, background: '#FFBD2E'}} />
            <div style={{width: 10, height: 10, borderRadius: 999, background: '#28C840'}} />
          </div>
          <CodeLine text='curl -X POST api.run402.com/deploy/v1' delay={10} color={COLORS.green} />
          <CodeLine text='  -H "SIGN-IN-WITH-X: <CAIP-122>"' delay={20} color={COLORS.purple} />
          <CodeLine text={"  -d '{\"name\": \"my-app\","} delay={30} />
          <CodeLine text={'       "migrations": "CREATE TABLE...",'} delay={40} />
          <CodeLine text={'       "site": [{"file": "index.html"}],'} delay={50} />
          <CodeLine text={"       \"subdomain\": \"my-app\"}'"} delay={60} />
          <CodeLine text='' delay={70} />
          <CodeLine text={'\u2192 my-app.run402.com'} delay={80} color={COLORS.green} />
          <CodeLine text={'\u2192 project_id, anon_key, service_key'} delay={90} color={COLORS.blue} />
        </div>
      </div>
    </AbsoluteFill>
  );
};

const ClosingScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const s = spring({
    frame,
    fps,
    config: {damping: 16, stiffness: 90},
  });

  const chips = ['Postgres', 'REST API', 'Auth', 'Storage', 'Hosting', 'x402'];

  return (
    <AbsoluteFill style={{padding: 80}}>
      <div style={{
        position: 'absolute',
        top: 160,
        left: 0,
        right: 0,
        display: 'flex',
        justifyContent: 'center',
        gap: 10,
      }}>
        {chips.map((chip, i) => {
          const chipSpring = spring({
            frame: Math.max(0, frame - i * 4),
            fps,
            config: {damping: 18, stiffness: 140},
          });
          return (
            <span
              key={chip}
              style={{
                padding: '8px 16px',
                borderRadius: 999,
                background: 'rgba(0, 255, 159, 0.1)',
                border: '1px solid rgba(0, 255, 159, 0.3)',
                color: COLORS.green,
                fontSize: 16,
                fontWeight: 700,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                opacity: chipSpring,
              }}
            >
              {chip}
            </span>
          );
        })}
      </div>

      <div style={{
        position: 'absolute',
        top: 230,
        left: 0,
        right: 0,
        textAlign: 'center',
        opacity: s,
      }}>
        <div style={{fontSize: 72, fontWeight: 900, letterSpacing: -3, lineHeight: 1}}>
          <span style={{color: COLORS.green}}>run402</span>
          <span style={{color: COLORS.text}}>.com</span>
        </div>
        <div style={{marginTop: 20, fontSize: 28, color: COLORS.muted}}>
          Full-stack infrastructure for AI agents
        </div>
      </div>

      <div style={{
        position: 'absolute',
        top: 380,
        left: 0,
        right: 0,
        textAlign: 'center',
      }}>
        <TypeWriter
          text="No signups. No console. Just x402."
          startFrame={30}
          fontSize={24}
          color={COLORS.amber}
          speed={2}
          mono
        />
      </div>
    </AbsoluteFill>
  );
};

export const TestVideo: React.FC = () => {
  const SCENE_1 = 5 * TEST_VIDEO_FPS;
  const SCENE_2 = 4 * TEST_VIDEO_FPS;
  const SCENE_3 = 3 * TEST_VIDEO_FPS;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        color: COLORS.text,
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      {/* Floating orbs */}
      <FloatingOrb x={15} y={20} size={300} color={COLORS.blue} speed={1} />
      <FloatingOrb x={75} y={60} size={250} color={COLORS.purple} speed={1.3} />
      <FloatingOrb x={50} y={80} size={200} color={COLORS.green} speed={0.8} />

      {/* Grid */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0.15,
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px)',
          backgroundSize: '60px 60px',
        }}
      />

      <Sequence from={0} durationInFrames={SCENE_1}>
        <IntroScene />
      </Sequence>

      <Sequence from={SCENE_1} durationInFrames={SCENE_2}>
        <CodeScene />
      </Sequence>

      <Sequence from={SCENE_1 + SCENE_2} durationInFrames={SCENE_3}>
        <ClosingScene />
      </Sequence>
    </AbsoluteFill>
  );
};
