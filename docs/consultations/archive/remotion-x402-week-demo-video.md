# Consultation Result

**Model**: gpt-5.4-pro
**Submitted**: 2026-03-17T13:29:39.017775
**Completed**: 2026-03-17T13:51:12.050775
**Status**: completed

---

Here’s a 52-second Remotion concept that stays tightly on the autonomous backend story: **no human in the loop, just an allowance**. It avoids app-forking and does not mention Stripe.

## Voiceover / caption script

**0–6s**  
“Agents can already write code. The missing step is buying infrastructure.”

**6–13s**  
“Run402 solves that with one idea: no human in the loop, just an allowance.”

**13–21s**  
“The agent pays for a tier over x402 and instantly unlocks Postgres, REST APIs, auth, storage, and hosting.”

**21–29s**
“After purchase, the agent signs in with Sign-In-With-X — the new CAIP-122 standard. One header, no custom auth, EVM and Solana wallets.”

**29–39s**  
“Then through plain HTTP or our MCP server, the agent provisions a project, runs SQL, uploads files, deploys a site, and claims a subdomain.”

**39–52s**  
“So the agent doesn’t stop at code. It buys, deploys, and operates the backend autonomously under a hard cap. Run402 is the autonomous backend for the agent economy.”

---

## `remotion/Root.tsx`

```tsx
import React from 'react';
import {Composition} from 'remotion';
import {
  Run402BuilderSpotlight,
  RUN402_DURATION_IN_FRAMES,
  RUN402_FPS,
  RUN402_HEIGHT,
  RUN402_WIDTH,
} from './Run402BuilderSpotlight';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Run402BuilderSpotlight"
      component={Run402BuilderSpotlight}
      durationInFrames={RUN402_DURATION_IN_FRAMES}
      fps={RUN402_FPS}
      width={RUN402_WIDTH}
      height={RUN402_HEIGHT}
    />
  );
};
```

---

## `remotion/Run402BuilderSpotlight.tsx`

```tsx
import React, {type CSSProperties, type ReactNode} from 'react';
import {
  AbsoluteFill,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

// 52-second builder spotlight video for Run402.
// Focus: autonomous backend, allowance-governed infrastructure, x402, wallet-signed repeat access, MCP.

export const RUN402_FPS = 30;
export const RUN402_WIDTH = 1920;
export const RUN402_HEIGHT = 1080;

const SCENE_1 = 6 * RUN402_FPS;
const SCENE_2 = 7 * RUN402_FPS;
const SCENE_3 = 8 * RUN402_FPS;
const SCENE_4 = 8 * RUN402_FPS;
const SCENE_5 = 10 * RUN402_FPS;
const SCENE_6 = 13 * RUN402_FPS;

export const RUN402_DURATION_IN_FRAMES =
  SCENE_1 + SCENE_2 + SCENE_3 + SCENE_4 + SCENE_5 + SCENE_6;

const COLORS = {
  bg: '#050816',
  panel: 'rgba(10, 17, 31, 0.72)',
  border: 'rgba(255, 255, 255, 0.10)',
  text: '#F7FBFF',
  muted: 'rgba(247, 251, 255, 0.72)',
  blue: '#59D0FF',
  green: '#8DFFAA',
  purple: '#B69CFF',
  amber: '#FFD47A',
};

const CHIP_TONES = {
  blue: {
    bg: 'rgba(89, 208, 255, 0.12)',
    border: 'rgba(89, 208, 255, 0.35)',
    color: COLORS.blue,
  },
  green: {
    bg: 'rgba(141, 255, 170, 0.12)',
    border: 'rgba(141, 255, 170, 0.35)',
    color: COLORS.green,
  },
  purple: {
    bg: 'rgba(182, 156, 255, 0.12)',
    border: 'rgba(182, 156, 255, 0.35)',
    color: COLORS.purple,
  },
  amber: {
    bg: 'rgba(255, 212, 122, 0.12)',
    border: 'rgba(255, 212, 122, 0.35)',
    color: COLORS.amber,
  },
} as const;

type Tone = keyof typeof CHIP_TONES;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const enterStyle = (frame: number, fps: number, delay = 0): CSSProperties => {
  const s = spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: {
      damping: 20,
      stiffness: 110,
      mass: 0.9,
    },
  });

  return {
    opacity: s,
    transform: `translateY(${interpolate(s, [0, 1], [28, 0])}px) scale(${interpolate(
      s,
      [0, 1],
      [0.985, 1]
    )})`,
  };
};

const sceneOpacity = (frame: number, duration: number) =>
  interpolate(
    frame,
    [0, 12, duration - 12, duration],
    [0, 1, 1, 0],
    {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }
  );

const SceneFrame: React.FC<{
  duration: number;
  children: ReactNode;
  style?: CSSProperties;
}> = ({duration, children, style}) => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill
      style={{
        padding: '88px 110px',
        justifyContent: 'center',
        opacity: sceneOpacity(frame, duration),
        ...style,
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

const Background: React.FC = () => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();

  const gridX = interpolate(frame, [0, durationInFrames], [0, -80]);
  const gridY = interpolate(frame, [0, durationInFrames], [0, -40]);
  const orbShift = interpolate(frame, [0, durationInFrames], [0, -120]);

  return (
    <AbsoluteFill style={{overflow: 'hidden', backgroundColor: COLORS.bg}}>
      <div
        style={{
          position: 'absolute',
          inset: -200,
          transform: `translateY(${orbShift}px)`,
          background:
            'radial-gradient(circle at 18% 22%, rgba(89,208,255,0.20), transparent 24%), ' +
            'radial-gradient(circle at 82% 20%, rgba(182,156,255,0.18), transparent 22%), ' +
            'radial-gradient(circle at 50% 82%, rgba(141,255,170,0.14), transparent 24%)',
          filter: 'blur(24px)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0.22,
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px)',
          backgroundSize: '72px 72px',
          backgroundPosition: `${gridX}px ${gridY}px`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'linear-gradient(180deg, rgba(5,8,22,0.05) 0%, rgba(5,8,22,0.35) 60%, rgba(5,8,22,0.72) 100%)',
        }}
      />
    </AbsoluteFill>
  );
};

const GlassPanel: React.FC<{children: ReactNode; style?: CSSProperties}> = ({
  children,
  style,
}) => (
  <div
    style={{
      background: COLORS.panel,
      border: `1px solid ${COLORS.border}`,
      borderRadius: 28,
      padding: 30,
      boxShadow: '0 26px 80px rgba(0,0,0,0.28)',
      backdropFilter: 'blur(14px)',
      ...style,
    }}
  >
    {children}
  </div>
);

const Chip: React.FC<{
  children: ReactNode;
  tone?: Tone;
  style?: CSSProperties;
}> = ({children, tone = 'blue', style}) => {
  const palette = CHIP_TONES[tone];

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        borderRadius: 999,
        padding: '10px 16px',
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        color: palette.color,
        fontSize: 18,
        fontWeight: 700,
        letterSpacing: 0.2,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

const CodeWindow: React.FC<{
  title: string;
  lines: string[];
}> = ({title, lines}) => {
  const frame = useCurrentFrame();

  return (
    <GlassPanel style={{padding: 0, overflow: 'hidden'}}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 22px',
          borderBottom: `1px solid ${COLORS.border}`,
          background: 'rgba(255,255,255,0.03)',
        }}
      >
        <div style={{display: 'flex', gap: 8}}>
          <div style={{width: 12, height: 12, borderRadius: 999, background: '#FF5F57'}} />
          <div style={{width: 12, height: 12, borderRadius: 999, background: '#FFBD2E'}} />
          <div style={{width: 12, height: 12, borderRadius: 999, background: '#28C840'}} />
        </div>
        <div style={{fontSize: 15, color: COLORS.muted, letterSpacing: 0.4}}>{title}</div>
      </div>

      <div
        style={{
          padding: '26px 28px 30px 28px',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 25,
          lineHeight: 1.6,
          color: '#E8F3FF',
        }}
      >
        {lines.map((line, i) => {
          const lineOpacity = interpolate(frame, [i * 4, i * 4 + 8], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });

          const lineY = interpolate(frame, [i * 4, i * 4 + 8], [10, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });

          return (
            <div
              key={`${title}-${i}`}
              style={{
                minHeight: 38,
                opacity: lineOpacity,
                transform: `translateY(${lineY}px)`,
                color: line.startsWith('→')
                  ? COLORS.green
                  : line.includes('x402')
                    ? COLORS.blue
                    : line.includes('EIP-4361')
                      ? COLORS.purple
                      : '#E8F3FF',
              }}
            >
              {line || ' '}
            </div>
          );
        })}
      </div>
    </GlassPanel>
  );
};

const ResourceCard: React.FC<{
  title: string;
  subtitle: string;
  index: number;
}> = ({title, subtitle, index}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  return (
    <div style={enterStyle(frame, fps, index * 3)}>
      <GlassPanel style={{padding: 22, minHeight: 132}}>
        <div style={{fontSize: 26, fontWeight: 800, marginBottom: 8}}>{title}</div>
        <div style={{fontSize: 18, color: COLORS.muted, lineHeight: 1.4}}>{subtitle}</div>
      </GlassPanel>
    </div>
  );
};

const MetricBox: React.FC<{
  label: string;
  index: number;
}> = ({label, index}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  return (
    <div style={enterStyle(frame, fps, index * 3)}>
      <div
        style={{
          padding: '14px 16px',
          borderRadius: 18,
          border: `1px solid ${COLORS.border}`,
          background: 'rgba(255,255,255,0.04)',
          fontSize: 18,
          color: COLORS.text,
        }}
      >
        {label}
      </div>
    </div>
  );
};

const AllowancePanel: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const p = spring({
    frame,
    fps,
    config: {damping: 20, stiffness: 100},
  });

  const fillWidth = interpolate(clamp(p, 0, 1), [0, 1], [0, 34]);

  return (
    <GlassPanel>
      <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
        <div
          style={{
            fontSize: 16,
            color: COLORS.muted,
            textTransform: 'uppercase',
            letterSpacing: 1.6,
          }}
        >
          allowance
        </div>
        <Chip tone="green">hard cap</Chip>
      </div>

      <div style={{marginTop: 18, fontSize: 58, fontWeight: 900, letterSpacing: -1.5}}>
        $20.00
        <span style={{fontSize: 24, color: COLORS.muted, fontWeight: 600}}> / month</span>
      </div>

      <div
        style={{
          marginTop: 24,
          height: 16,
          borderRadius: 999,
          overflow: 'hidden',
          background: 'rgba(255,255,255,0.08)',
        }}
      >
        <div
          style={{
            width: `${fillWidth}%`,
            height: '100%',
            borderRadius: 999,
            background: `linear-gradient(90deg, ${COLORS.blue}, ${COLORS.green})`,
          }}
        />
      </div>

      <div
        style={{
          marginTop: 14,
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 19,
          color: COLORS.muted,
        }}
      >
        <span>spent: $5.10</span>
        <span>remaining: $14.90</span>
      </div>

      <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 24}}>
        {['prepaid', 'revocable', 'every purchase logged', 'worst case = allowance'].map(
          (item, i) => (
            <MetricBox key={item} label={item} index={i} />
          )
        )}
      </div>
    </GlassPanel>
  );
};

const FlowBox: React.FC<{
  title: string;
  subtitle: string;
  index: number;
}> = ({title, subtitle, index}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  return (
    <div style={{...enterStyle(frame, fps, index * 3), flex: 1}}>
      <GlassPanel style={{padding: 20, minHeight: 110}}>
        <div style={{fontSize: 24, fontWeight: 800}}>{title}</div>
        <div style={{marginTop: 8, fontSize: 17, color: COLORS.muted, lineHeight: 1.4}}>
          {subtitle}
        </div>
      </GlassPanel>
    </div>
  );
};

const CheckRow: React.FC<{
  label: string;
  index: number;
}> = ({label, index}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  return (
    <div style={enterStyle(frame, fps, 8 + index * 3)}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '14px 16px',
          borderRadius: 18,
          border: `1px solid ${COLORS.border}`,
          background: 'rgba(255,255,255,0.04)',
          fontSize: 20,
        }}
      >
        <span style={{color: COLORS.green, fontWeight: 900}}>✓</span>
        <span>{label}</span>
      </div>
    </div>
  );
};

const Arrow: React.FC = () => (
  <div
    style={{
      fontSize: 42,
      fontWeight: 900,
      color: COLORS.blue,
      alignSelf: 'center',
      margin: '0 4px',
    }}
  >
    →
  </div>
);

const HookScene: React.FC<{duration: number}> = ({duration}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  return (
    <SceneFrame duration={duration}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.12fr 0.88fr',
          gap: 56,
          alignItems: 'center',
          height: '100%',
        }}
      >
        <div style={enterStyle(frame, fps, 0)}>
          <div style={{display: 'flex', gap: 12, marginBottom: 28}}>
            <Chip tone="blue">x402 week</Chip>
            <Chip tone="purple">builder spotlight</Chip>
          </div>

          <div
            style={{
              fontSize: 80,
              fontWeight: 900,
              lineHeight: 0.96,
              letterSpacing: -3.4,
            }}
          >
            Agents can write code.
            <br />
            Run402 lets them buy the backend.
          </div>

          <div
            style={{
              marginTop: 24,
              maxWidth: 820,
              fontSize: 30,
              lineHeight: 1.35,
              color: COLORS.muted,
            }}
          >
            The missing step for agents isn’t coding. It’s procurement. Run402 turns backend
            infrastructure into an autonomous x402 flow.
          </div>
        </div>

        <div style={enterStyle(frame, fps, 8)}>
          <CodeWindow
            title="agent requests infrastructure"
            lines={[
              'POST /tiers/v1/hobby',
              '→ 402 Payment Required',
              '',
              'x-402-payment: <signed USDC>',
              '→ 201 tier_active: true',
              '',
              'POST /projects/v1',
              'SIGN-IN-WITH-X: <CAIP-122>',
              '→ 201 project_id, keys',
            ]}
          />
        </div>
      </div>
    </SceneFrame>
  );
};

const AllowanceScene: React.FC<{duration: number}> = ({duration}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  return (
    <SceneFrame duration={duration}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 0.92fr',
          gap: 56,
          alignItems: 'center',
          height: '100%',
        }}
      >
        <div style={enterStyle(frame, fps, 0)}>
          <div
            style={{
              fontSize: 74,
              fontWeight: 900,
              lineHeight: 0.98,
              letterSpacing: -3,
            }}
          >
            No humans needed.
            <br />
            Just an allowance.
          </div>

          <div
            style={{
              marginTop: 22,
              fontSize: 30,
              lineHeight: 1.35,
              color: COLORS.muted,
              maxWidth: 760,
            }}
          >
            Prepaid, hard-capped, revocable. Set the budget once and the agent spends inside
            clear policy with clean receipts.
          </div>

          <div style={{marginTop: 28}}>
            <Chip tone="blue" style={{fontSize: 22, padding: '12px 18px'}}>
              Wallet is infrastructure language. Allowance is trust language.
            </Chip>
          </div>
        </div>

        <div style={enterStyle(frame, fps, 6)}>
          <AllowancePanel />
        </div>
      </div>
    </SceneFrame>
  );
};

const UnlockScene: React.FC<{duration: number}> = ({duration}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const resources = [
    ['Postgres', 'instant project database'],
    ['REST API', 'CRUD over your tables'],
    ['Auth', 'wallet-signed access'],
    ['Storage', 'upload and serve files'],
    ['Hosting', 'deploy a static site'],
    ['Subdomain', 'claim and go live'],
  ] as const;

  return (
    <SceneFrame duration={duration}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '0.85fr 1.15fr',
          gap: 52,
          alignItems: 'center',
          height: '100%',
        }}
      >
        <div style={enterStyle(frame, fps, 0)}>
          <div
            style={{
              fontSize: 68,
              fontWeight: 900,
              lineHeight: 0.98,
              letterSpacing: -2.8,
            }}
          >
            One x402 purchase unlocks the full backend.
          </div>

          <div
            style={{
              marginTop: 20,
              fontSize: 28,
              lineHeight: 1.35,
              color: COLORS.muted,
              maxWidth: 650,
            }}
          >
            Buy a tier once, and the agent gets the infrastructure bundle it actually needs to
            ship: database, API, auth, storage, hosting, and lifecycle.
          </div>

          <div style={{display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 24}}>
            <Chip tone="blue">x402-native</Chip>
            <Chip tone="green">hard-capped</Chip>
            <Chip tone="purple">live in seconds</Chip>
          </div>
        </div>

        <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16}}>
          {resources.map(([title, subtitle], i) => (
            <ResourceCard key={title} title={title} subtitle={subtitle} index={i} />
          ))}
        </div>
      </div>
    </SceneFrame>
  );
};

const SignedAccessScene: React.FC<{duration: number}> = ({duration}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const actions = [
    'provision project',
    'run SQL',
    'query REST',
    'upload file',
    'deploy site',
    'claim subdomain',
  ];

  return (
    <SceneFrame duration={duration}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '0.92fr 1.08fr',
          gap: 52,
          alignItems: 'center',
          height: '100%',
        }}
      >
        <div style={enterStyle(frame, fps, 0)}>
          <div
            style={{
              fontSize: 68,
              fontWeight: 900,
              lineHeight: 0.98,
              letterSpacing: -2.8,
            }}
          >
            Pay once.
            <br />
            Sign in with your wallet.
          </div>

          <div style={{marginTop: 22, display: 'flex', gap: 12, flexWrap: 'wrap'}}>
            <Chip tone="purple">SIGN-IN-WITH-X</Chip>
            <Chip tone="blue">CAIP-122 standard</Chip>
          </div>

          <div
            style={{
              marginTop: 22,
              fontSize: 28,
              lineHeight: 1.35,
              color: COLORS.muted,
              maxWidth: 700,
            }}
          >
            After x402 payment, every action uses the new SIGN-IN-WITH-X header — one standard,
            EVM and Solana wallets, no custom auth. The wallet IS the identity.
          </div>
        </div>

        <GlassPanel style={enterStyle(frame, fps, 6)}>
          <div style={{display: 'flex', alignItems: 'stretch', gap: 12}}>
            <FlowBox title="x402 payment" subtitle="pay for tier once" index={0} />
            <Arrow />
            <FlowBox title="SIGN-IN-WITH-X" subtitle="CAIP-122 header" index={1} />
            <Arrow />
            <FlowBox title="Repeat access" subtitle="all actions free" index={2} />
          </div>

          <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 24}}>
            {actions.map((action, i) => (
              <CheckRow key={action} label={action} index={i} />
            ))}
          </div>
        </GlassPanel>
      </div>
    </SceneFrame>
  );
};

const MCPScene: React.FC<{duration: number}> = ({duration}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  return (
    <SceneFrame duration={duration}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '0.9fr 1.1fr',
          gap: 52,
          alignItems: 'center',
          height: '100%',
        }}
      >
        <div style={enterStyle(frame, fps, 0)}>
          <div
            style={{
              fontSize: 66,
              fontWeight: 900,
              lineHeight: 0.98,
              letterSpacing: -2.6,
            }}
          >
            HTTP or MCP,
            <br />
            whichever the agent speaks.
          </div>

          <div
            style={{
              marginTop: 20,
              fontSize: 28,
              lineHeight: 1.35,
              color: COLORS.muted,
              maxWidth: 680,
            }}
          >
            Run402 is machine-native on purpose. Agents can call the API directly or use the MCP
            server to provision and operate the backend with tool calls.
          </div>

          <div style={{marginTop: 24}}>
            <Chip tone="green">MCP-native tooling</Chip>
          </div>

          <div style={{marginTop: 24}}>
            <CodeWindow
              title="run402-mcp"
              lines={[
                '$ npx run402-mcp',
                '',
                'tool: provision_postgres_project',
                'tool: run_sql',
                'tool: rest_query',
                'tool: upload_file',
                'tool: deploy_site',
                'tool: claim_subdomain',
              ]}
            />
          </div>
        </div>

        <div style={enterStyle(frame, fps, 8)}>
          <GlassPanel>
            <div style={{display: 'flex', alignItems: 'stretch', gap: 12}}>
              <FlowBox title="Agent" subtitle="goal + budget" index={0} />
              <Arrow />
              <FlowBox title="MCP / HTTP" subtitle="tool calls or requests" index={1} />
              <Arrow />
              <FlowBox title="Run402" subtitle="x402 + signed access" index={2} />
            </div>

            <div
              style={{
                marginTop: 24,
                display: 'grid',
                gridTemplateColumns: '1fr 1fr 1fr',
                gap: 12,
              }}
            >
              {[
                'Postgres',
                'REST API',
                'Auth',
                'Storage',
                'Hosting',
                'Subdomain',
              ].map((item, i) => (
                <MetricBox key={item} label={item} index={i} />
              ))}
            </div>
          </GlassPanel>
        </div>
      </div>
    </SceneFrame>
  );
};

const ClosingScene: React.FC<{duration: number}> = ({duration}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  return (
    <SceneFrame duration={duration} style={{textAlign: 'center', alignItems: 'center'}}>
      <div style={{maxWidth: 1280, margin: 'auto'}}>
        <div style={{display: 'flex', justifyContent: 'center', gap: 12, flexWrap: 'wrap'}}>
          <Chip tone="blue">x402 payment</Chip>
          <Chip tone="purple">SIGN-IN-WITH-X</Chip>
          <Chip tone="green">MCP-native</Chip>
        </div>

        <div
          style={{
            ...enterStyle(frame, fps, 4),
            marginTop: 28,
            fontSize: 88,
            fontWeight: 900,
            lineHeight: 0.95,
            letterSpacing: -3.8,
          }}
        >
          No cloud console.
          <br />
          No operator in the loop.
        </div>

        <div
          style={{
            ...enterStyle(frame, fps, 10),
            marginTop: 22,
            fontSize: 34,
            lineHeight: 1.3,
            color: COLORS.muted,
          }}
        >
          Set the allowance once. The rest is autonomous.
        </div>

        <div
          style={{
            ...enterStyle(frame, fps, 15),
            marginTop: 34,
            fontSize: 54,
            fontWeight: 900,
            color: COLORS.blue,
            letterSpacing: -1.4,
          }}
        >
          Run402
        </div>

        <div
          style={{
            ...enterStyle(frame, fps, 19),
            marginTop: 8,
            fontSize: 30,
            color: COLORS.text,
          }}
        >
          Autonomous backend for the agent economy
        </div>

        <div
          style={{
            ...enterStyle(frame, fps, 24),
            marginTop: 22,
            fontSize: 22,
            lineHeight: 1.4,
            color: COLORS.muted,
          }}
        >
          Built on x402’s newest standards: SIGN-IN-WITH-X (CAIP-122), broader ERC-20 token
          rails, and MCP-native tooling.
        </div>

        <div
          style={{
            ...enterStyle(frame, fps, 28),
            marginTop: 26,
            fontSize: 24,
            color: COLORS.text,
          }}
        >
          run402.com • api.run402.com
        </div>
      </div>
    </SceneFrame>
  );
};

export const Run402BuilderSpotlight: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        color: COLORS.text,
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      <Background />

      <Sequence from={0} durationInFrames={SCENE_1}>
        <HookScene duration={SCENE_1} />
      </Sequence>

      <Sequence from={SCENE_1} durationInFrames={SCENE_2}>
        <AllowanceScene duration={SCENE_2} />
      </Sequence>

      <Sequence from={SCENE_1 + SCENE_2} durationInFrames={SCENE_3}>
        <UnlockScene duration={SCENE_3} />
      </Sequence>

      <Sequence from={SCENE_1 + SCENE_2 + SCENE_3} durationInFrames={SCENE_4}>
        <SignedAccessScene duration={SCENE_4} />
      </Sequence>

      <Sequence from={SCENE_1 + SCENE_2 + SCENE_3 + SCENE_4} durationInFrames={SCENE_5}>
        <MCPScene duration={SCENE_5} />
      </Sequence>

      <Sequence
        from={SCENE_1 + SCENE_2 + SCENE_3 + SCENE_4 + SCENE_5}
        durationInFrames={SCENE_6}
      >
        <ClosingScene duration={SCENE_6} />
      </Sequence>
    </AbsoluteFill>
  );
};
```

---

## Suggested quote-tweet copy

> Agents can already write code. Run402 lets them buy and operate the backend via x402: pay for a tier once, then use SIGN-IN-WITH-X (CAIP-122) for all subsequent actions — EVM + Solana wallets, one standard header. Postgres, auth, storage, hosting, MCP tools, all under a hard allowance. No cloud console. Just a budget. run402.com

---

## Small edit notes

- For a stronger demo feel, replace the code panels in scenes 1 and 5 with real captures from:
  - `POST /tiers/v1/:tier`
  - `npx run402-mcp`
- If you want this optimized for the X feed, I’d convert it to **1080x1350** and stack the two-column scenes vertically.

If you want, I can also turn this into a **4:5 social version** or rewrite it as a **more technical / more cinematic** cut.

---
**Wall time**: 21m 33s
**Tokens**: 3,166 input, 30,088 output (22,736 reasoning), 33,254 total
**Estimated cost**: $5.5108
