import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import {
  ArrowDown, ArrowUpRight, Check, ChevronRight, CircleDollarSign, Cloud, Code2, Copy,
  Database, Hexagon, Mail, RefreshCw, Sparkles, WandSparkles, X, Zap,
} from "lucide-react";
import {
  createDreamDrop, emailDreamDrop, getDreamDrops, remixDreamDrop, useQuery,
} from "wasp/client/operations";
import type { DreamDrop, DreamDropVibe } from "./shared";
import { DREAMDROP_VIBES } from "./shared";
import {
  createHostedDrop,
  emailHostedDrop,
  getHostedFeed,
  IS_RUN402_HOSTED,
  remixHostedDrop,
} from "./hostedApi";
import "./Main.css";

const SAMPLE_IDEAS = [
  "A pocket weather system that changes with the mood of your group chat.",
  "A lamp that only turns on when you finally say the thing you have been avoiding.",
  "A tiny museum that curates one object from your week, every Sunday.",
  "A bike bell that leaves a five-second trail of color in the air.",
];

const PIPELINE = [
  { label: "Idea", icon: Sparkles }, { label: "Wasp Action", icon: Zap },
  { label: "Run402 fn", icon: Code2 }, { label: "AI image", icon: WandSparkles },
  { label: "CDN", icon: Cloud }, { label: "Postgres", icon: Database },
];

export function MainPage() {
  const waspFeed = useQuery(getDreamDrops, undefined, { enabled: !IS_RUN402_HOSTED });
  const [hostedFeed, setHostedFeed] = useState<Awaited<ReturnType<typeof getHostedFeed>> | null>(null);
  const [hostedFeedError, setHostedFeedError] = useState<string | null>(null);
  const [idea, setIdea] = useState(SAMPLE_IDEAS[0]);
  const [vibe, setVibe] = useState<DreamDropVibe>("kinetic");
  const [isDropping, setIsDropping] = useState(false);
  const [pipelineStage, setPipelineStage] = useState(-1);
  const [selected, setSelected] = useState<DreamDrop | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);

  const feed = IS_RUN402_HOSTED ? hostedFeed : waspFeed.data;
  const drops = feed?.drops ?? [];
  const heroDrop = drops[0];

  async function refreshFeed() {
    if (!IS_RUN402_HOSTED) {
      await waspFeed.refetch();
      return;
    }
    try {
      setHostedFeedError(null);
      setHostedFeed(await getHostedFeed());
    } catch (error) {
      setHostedFeedError(error instanceof Error ? error.message : "Run402 is still waking up.");
    }
  }

  useEffect(() => {
    if (IS_RUN402_HOSTED) void refreshFeed();
  }, []);

  useEffect(() => {
    if (!selected) return;
    const fresh = drops.find((drop) => drop.id === selected.id);
    if (fresh) setSelected(fresh);
  }, [drops, selected?.id]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (isDropping) return;
    setNotice(null); setIsDropping(true); setPipelineStage(0);
    const timer = window.setInterval(() => setPipelineStage((stage) => Math.min(stage + 1, PIPELINE.length - 1)), 520);
    try {
      const drop = IS_RUN402_HOSTED
        ? await createHostedDrop({ idea, vibe })
        : await createDreamDrop({ idea, vibe });
      setPipelineStage(PIPELINE.length - 1);
      await refreshFeed();
      setSelected(drop);
      setNotice(`${drop.title} is live.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The drop got lost in transit.");
    } finally {
      window.clearInterval(timer);
      window.setTimeout(() => setPipelineStage(-1), 900);
      setIsDropping(false);
    }
  }

  function surpriseMe() {
    const currentIndex = SAMPLE_IDEAS.indexOf(idea);
    setIdea(SAMPLE_IDEAS[(currentIndex + 1 + SAMPLE_IDEAS.length) % SAMPLE_IDEAS.length]);
  }

  async function copyEndpoint() {
    await navigator.clipboard.writeText(feed?.agentEndpoint ?? "https://<your-subdomain>.run402.com/agent/remix");
    setCopied(true); window.setTimeout(() => setCopied(false), 1_600);
  }

  return (
    <div className="app-shell">
      <div className="ambient ambient-one" /><div className="ambient ambient-two" />
      <header className="topbar">
        <a className="brand" href="#top" aria-label="DreamDrop home">
          <span className="brand-mark"><Sparkles size={18} strokeWidth={2.2} /></span><span>DreamDrop</span>
        </a>
        <div className="stack-lockup" aria-label="Built with Wasp and Run402"><span className="wasp-dot" /> Wasp <span className="stack-x">×</span> Run402</div>
        <button className="header-cta" onClick={() => formRef.current?.scrollIntoView({ behavior: "smooth" })}>Drop an idea <ArrowDown size={16} /></button>
      </header>

      <main id="top">
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow"><span /> EXPERIMENT 04 · FULL STACK</p>
            <h1>Make the<br /><em>weird thing.</em></h1>
            <p className="hero-deck">Drop a strange product idea. Wasp and Run402 turn it into a launch-ready artifact—live, stored, and agent-remixable.</p>
            <div className="hero-proof">
              <div><strong>01</strong><span>Type-safe<br />full stack</span></div>
              <div><strong>02</strong><span>Agent-native<br />infra</span></div>
              <div><strong>03</strong><span>Pay-per-remix<br />with x402</span></div>
            </div>
          </div>
          <div className="hero-artifact" aria-label="Featured DreamDrop artifact">
            {heroDrop ? <PosterArt drop={heroDrop} feature /> : <div className="artifact-skeleton" />}
            <div className="artifact-sticker">LIVE<br />DROP</div>
            <div className="artifact-caption"><span>{heroDrop?.vibe ?? "kinetic"} / 001</span><span>GENERATED ON RUN402</span></div>
          </div>
        </section>

        <section className="forge-wrap" ref={formRef}>
          <div className="forge-heading">
            <div><p className="eyebrow"><span /> THE ARTIFACT FORGE</p><h2>What should exist<br />that doesn’t yet?</h2></div>
            <p>One idea in. A campaign-ready visual, durable record, CDN asset, and paid agent endpoint out.</p>
          </div>
          <form className="forge" onSubmit={handleSubmit}>
            <div className="forge-input">
              <label htmlFor="idea">YOUR UNREASONABLE IDEA</label>
              <textarea id="idea" value={idea} maxLength={280} onChange={(event) => setIdea(event.target.value)} placeholder="A toaster that predicts tomorrow’s weather…" />
              <div className="input-tools">
                <button type="button" onClick={surpriseMe}><RefreshCw size={15} /> Surprise me</button>
                <span className="character-count">{idea.length}/280</span>
              </div>
            </div>
            <div className="vibe-picker">
              <span>VISUAL TEMPERATURE</span>
              <div role="radiogroup" aria-label="Visual temperature">
                {DREAMDROP_VIBES.map((option) => (
                  <button type="button" role="radio" aria-checked={vibe === option} className={vibe === option ? "active" : ""} onClick={() => setVibe(option)} key={option}>
                    <span className={`vibe-swatch ${option}`} /> {option}
                  </button>
                ))}
              </div>
            </div>
            <button className="drop-button" type="submit" disabled={isDropping || idea.trim().length < 12}>
              <span>{isDropping ? "Forging your drop" : "Drop it into reality"}</span>
              {isDropping ? <span className="spinner" /> : <ArrowUpRight size={22} />}
            </button>
          </form>
          <div className={`pipeline ${pipelineStage >= 0 ? "running" : ""}`} aria-live="polite">
            {PIPELINE.map(({ label, icon: Icon }, index) => (
              <div className={`pipeline-step ${pipelineStage >= index ? "complete" : ""}`} key={label}>
                <span className="pipeline-icon">{pipelineStage > index ? <Check size={15} /> : <Icon size={15} />}</span>
                <span>{label}</span>{index < PIPELINE.length - 1 && <ChevronRight className="pipeline-arrow" size={14} />}
              </div>
            ))}
          </div>
          {notice && <p className="notice" role="status">{notice}</p>}
        </section>

        <section className="gallery-section">
          <div className="section-heading">
            <div><p className="eyebrow"><span /> TRANSMISSIONS FROM THE EDGE</p><h2>Recent drops</h2></div>
            <div className="live-status"><span /> {feed?.statusLabel ?? "WAKING THE STACK"}</div>
          </div>
          {(IS_RUN402_HOSTED ? !hostedFeed && !hostedFeedError : waspFeed.isLoading) ? <div className="gallery-loading"><div /><div /><div /></div> : (
            <div className="drop-grid">{drops.map((drop, index) => <DropCard drop={drop} index={index} key={drop.id} onOpen={() => setSelected(drop)} />)}</div>
          )}
          {hostedFeedError && <p className="notice" role="alert">{hostedFeedError}</p>}
        </section>

        <section className="agent-section">
          <div className="agent-orbit" aria-hidden="true"><span /><span /><Hexagon size={38} /></div>
          <div className="agent-copy">
            <p className="eyebrow light"><span /> BUILT FOR HUMANS. OPEN TO AGENTS.</p>
            <h2>Your idea just became<br />a tiny economy.</h2>
            <p>Every public drop can be remixed by another agent through a priced Run402 route. No account, API key exchange, or invoice—just an x402 payment and a new artifact.</p>
          </div>
          <div className="endpoint-card">
            <div className="endpoint-top"><span>POST</span><code>/agent/remix</code><strong>$0.05</strong></div>
            <pre>{`{\n  "idea": "a map for forgotten sounds",\n  "vibe": "cosmic"\n}`}</pre>
            <button onClick={copyEndpoint}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? "Copied endpoint" : "Copy agent endpoint"}</button>
          </div>
        </section>

        <section className="stack-section">
          <p className="eyebrow"><span /> TWO STACKS, ONE VERY SMALL APP</p>
          <div className="stack-cards">
            <article>
              <div className="stack-card-top"><span className="wasp-logo">W</span><span>Wasp</span><small>THE APP</small></div>
              <h3>Product logic without the plumbing.</h3>
              <ul><li>Type-safe Actions & Queries</li><li>React Query data flow</li><li>Node server + deployable client</li></ul>
              <a href="https://wasp.sh" target="_blank" rel="noreferrer">Explore Wasp <ArrowUpRight size={16} /></a>
            </article>
            <div className="stack-join"><span>×</span></div>
            <article className="run-card">
              <div className="stack-card-top"><span className="run-logo"><Hexagon size={22} /></span><span>Run402</span><small>THE INFRA</small></div>
              <h3>Infrastructure agents can actually operate.</h3>
              <ul><li>Postgres + serverless functions</li><li>AI images + content-addressed CDN</li><li>x402 payments + email</li></ul>
              <a href="https://run402.com" target="_blank" rel="noreferrer">Explore Run402 <ArrowUpRight size={16} /></a>
            </article>
          </div>
        </section>
      </main>

      <footer>
        <a className="brand footer-brand" href="#top"><span className="brand-mark"><Sparkles size={16} /></span>DreamDrop</a>
        <p>An unreasonable demo by two unusually capable stacks.</p>
        <div><span>WASP 0.25</span><span>RUN402</span><span>2026</span></div>
      </footer>

      {selected && <DropDialog
        drop={selected}
        onClose={() => setSelected(null)}
        onRemix={async (id) => IS_RUN402_HOSTED ? remixHostedDrop(id) : remixDreamDrop({ id })}
        onEmail={async (id, email) => IS_RUN402_HOSTED ? emailHostedDrop(id, email) : emailDreamDrop({ id, email })}
        onRemixed={async (drop) => { setSelected(drop); await refreshFeed(); }}
      />}
    </div>
  );
}

function DropCard({ drop, index, onOpen }: { drop: DreamDrop; index: number; onOpen: () => void }) {
  return (
    <article className={`drop-card card-${index % 4}`}>
      <button className="card-open" onClick={onOpen} aria-label={`Open ${drop.title}`}>
        <PosterArt drop={drop} />
        <div className="card-content">
          <div className="card-meta"><span>{drop.createdLabel}</span><span>{drop.vibe}</span></div>
          <h3>{drop.title}</h3><p>{drop.hook}</p>
          <div className="card-footer"><span>BY {drop.creator.toUpperCase()}</span><span><RefreshCw size={13} /> {drop.remixCount}</span></div>
        </div>
      </button>
    </article>
  );
}

function PosterArt({ drop, feature = false }: { drop: DreamDrop; feature?: boolean }) {
  const style = { "--p1": drop.palette[0], "--p2": drop.palette[1], "--p3": drop.palette[2] } as CSSProperties;
  return (
    <div className={`poster-art ${feature ? "feature" : ""}`} data-art={drop.artKey} style={style}>
      {drop.imageUrl ? <img src={drop.imageUrl} alt={`Generated launch art for ${drop.title}`} /> : <div className="generated-shape" />}
      <div className="poster-noise" /><div className="poster-label"><span>DREAMDROP</span><strong>{drop.title}</strong></div>
    </div>
  );
}

function DropDialog({
  drop,
  onClose,
  onRemix,
  onEmail,
  onRemixed,
}: {
  drop: DreamDrop;
  onClose: () => void;
  onRemix: (id: string) => Promise<DreamDrop>;
  onEmail: (id: string, email: string) => Promise<{ message: string }>;
  onRemixed: (drop: DreamDrop) => Promise<void>;
}) {
  const [isRemixing, setIsRemixing] = useState(false);
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) { if (event.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKeyDown); document.body.classList.add("dialog-open");
    return () => { document.removeEventListener("keydown", onKeyDown); document.body.classList.remove("dialog-open"); };
  }, [onClose]);

  async function handleRemix() {
    setIsRemixing(true); setMessage(null);
    try { const remix = await onRemix(drop.id); await onRemixed(remix); setMessage("A fresh branch of this idea just landed."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not remix this drop."); }
    finally { setIsRemixing(false); }
  }

  async function handleEmail(event: FormEvent) {
    event.preventDefault(); setMessage(null);
    try { const result = await onEmail(drop.id, email); setMessage(result.message); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not prepare that email."); }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="drop-dialog" role="dialog" aria-modal="true" aria-labelledby="drop-title">
        <button className="dialog-close" onClick={onClose} aria-label="Close DreamDrop"><X size={20} /></button>
        <div className="dialog-art"><PosterArt drop={drop} feature /></div>
        <div className="dialog-content">
          <p className="eyebrow"><span /> {drop.source === "run402" ? "LIVE RUN402 ARTIFACT" : "INTERACTIVE DEMO ARTIFACT"}</p>
          <h2 id="drop-title">{drop.title}</h2><p className="dialog-hook">{drop.hook}</p><p className="dialog-prompt">“{drop.prompt}”</p>
          <div className="provenance-grid">
            <div><Database size={16} /><span>RECORD</span><strong>{drop.id.slice(0, 12)}</strong></div>
            <div><Cloud size={16} /><span>ASSET</span><strong>{drop.imageUrl ? "CDN LIVE" : "DEMO RENDER"}</strong></div>
            <div><CircleDollarSign size={16} /><span>REMIXES</span><strong>{drop.remixCount}</strong></div>
          </div>
          <button className="remix-button" onClick={handleRemix} disabled={isRemixing}>
            {isRemixing ? <span className="spinner dark" /> : <RefreshCw size={18} />}{isRemixing ? "Branching the idea…" : "Remix this drop"}
          </button>
          <form className="email-form" onSubmit={handleEmail}>
            <Mail size={17} /><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Send this artifact to…" aria-label="Email address" /><button type="submit">Send</button>
          </form>
          {message && <p className="dialog-message" role="status">{message}</p>}
        </div>
      </div>
    </div>
  );
}
