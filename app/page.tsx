"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Tab = "led" | "mic" | "speaker";
type LedMode = "solid" | "rainbow" | "breathe" | "chase" | "flicker";
type ConnectionState = "disconnected" | "connecting" | "connected";
type MicFrame = { t: number; left: number; right: number; peakL: number; peakR: number; samples: number[] };
type LogRow = { at: string; distance: number; angle: number; material: string; gain: number; sensitivity: number; left: number; right: number; balance: number };

interface SerialPortLike {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
}

interface SerialNavigator extends Navigator {
  serial?: { requestPort(): Promise<SerialPortLike> };
}

const LEDS = 7;
const MODES: { id: LedMode; label: string; icon: string }[] = [
  { id: "solid", label: "Solid", icon: "●" },
  { id: "rainbow", label: "Rainbow", icon: "◒" },
  { id: "breathe", label: "Breathe", icon: "◉" },
  { id: "chase", label: "Orbit", icon: "↗" },
  { id: "flicker", label: "Flicker", icon: "✦" },
];

function hexToRgb(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  return { r: value >> 16, g: (value >> 8) & 255, b: value & 255 };
}

function dbfs(value: number) {
  return 20 * Math.log10(Math.max(value, 0.00001));
}

function formatDb(value: number) {
  return `${dbfs(value).toFixed(1)} dB`;
}

function downloadCsv(rows: LogRow[]) {
  const fields = ["timestamp", "distance_cm", "angle_deg", "material", "gain_db", "sensitivity", "left_dbfs", "right_dbfs", "balance"];
  const lines = rows.map((r) => [r.at, r.distance, r.angle, JSON.stringify(r.material), r.gain, r.sensitivity, dbfs(r.left).toFixed(2), dbfs(r.right).toFixed(2), r.balance.toFixed(3)].join(","));
  const blob = new Blob([[fields.join(","), ...lines].join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `audio-lab-${new Date().toISOString().replaceAll(":", "-")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function Range({ label, value, min, max, step = 1, unit = "", onChange }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void }) {
  const progress = ((value - min) / (max - min)) * 100;
  return (
    <label className="range-field">
      <span className="field-label"><span>{label}</span><output>{value}{unit}</output></span>
      <input aria-label={label} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ "--range": `${progress}%` } as React.CSSProperties} />
      <span className="range-ends"><span>{min}{unit}</span><span>{max}{unit}</span></span>
    </label>
  );
}

function Ring({ mode, color, brightness, speed, active, now, onSelect }: { mode: LedMode; color: string; brightness: number; speed: number; active: number | null; now: number; onSelect: (index: number) => void }) {
  const rgb = hexToRgb(color);
  return (
    <div className="ring-stage">
      <div className="board-disc">
        <div className="board-copy"><span>WAVESHARE</span><strong>S3</strong><small>AUDIO</small></div>
        {Array.from({ length: LEDS }, (_, i) => {
          const angle = (i / LEDS) * Math.PI * 2 - Math.PI / 2;
          const x = 50 + Math.cos(angle) * 39;
          const y = 50 + Math.sin(angle) * 39;
          const phase = (now * speed + i / LEDS) % 1;
          let hue = color;
          let alpha = brightness / 100;
          if (mode === "rainbow") hue = `hsl(${Math.round(phase * 360)} 90% 60%)`;
          if (mode === "chase") alpha *= Math.max(0.08, 1 - phase * 1.35);
          if (mode === "breathe") alpha *= 0.2 + Math.abs(Math.sin(now * speed * Math.PI)) * 0.8;
          if (mode === "flicker") alpha *= 0.35 + ((i * 17 + Math.floor(now * speed * 8)) % 7) / 10;
          return <button aria-label={`LED ${i + 1}`} title={`LED ${i + 1}`} key={i} onClick={() => onSelect(i)} className={`pixel ${active === i ? "selected" : ""}`} style={{ left: `${x}%`, top: `${y}%`, "--pixel": hue, "--alpha": alpha, "--glow-r": rgb.r, "--glow-g": rgb.g, "--glow-b": rgb.b } as React.CSSProperties}><span /></button>;
        })}
        <span className="mic-hole mic-a" /><span className="mic-hole mic-b" />
      </div>
      <div className="ring-caption"><span><i className="dot online" /> LIVE PREVIEW</span><span>7 × RGB</span></div>
    </div>
  );
}

function Waveform({ frame, sensitivity }: { frame: MicFrame; sensitivity: number }) {
  const points = frame.samples.map((sample, i) => `${(i / Math.max(1, frame.samples.length - 1)) * 100},${50 - sample * sensitivity * 0.34}`).join(" ");
  return (
    <div className="wave-wrap">
      <div className="wave-grid" />
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Live microphone waveform"><polyline points={points} vectorEffect="non-scaling-stroke" /></svg>
      <span className="scope-tag">20 ms/div</span><span className="scope-status"><i className="dot online" /> streaming</span>
    </div>
  );
}

function LevelMeter({ label, value, peak }: { label: string; value: number; peak: number }) {
  const pct = Math.max(0, Math.min(100, (dbfs(value) + 72) / 72 * 100));
  const peakPct = Math.max(0, Math.min(100, (dbfs(peak) + 72) / 72 * 100));
  return (
    <div className="meter-row">
      <span>{label}</span>
      <div className="meter-track"><i style={{ width: `${pct}%` }} /><b style={{ left: `${peakPct}%` }} /></div>
      <output>{formatDb(value)}</output>
    </div>
  );
}

export default function Home() {
  const [tab, setTab] = useState<Tab>("led");
  const [connection, setConnection] = useState<ConnectionState>("disconnected");
  const [demo, setDemo] = useState(true);
  const [toast, setToast] = useState("");
  const [mode, setMode] = useState<LedMode>("rainbow");
  const [color, setColor] = useState("#7c5cff");
  const [brightness, setBrightness] = useState(72);
  const [speed, setSpeed] = useState(1.2);
  const [ease, setEase] = useState("sine");
  const [selectedLed, setSelectedLed] = useState<number | null>(null);
  const [gain, setGain] = useState(24);
  const [sensitivity, setSensitivity] = useState(1.4);
  const [noiseGate, setNoiseGate] = useState(-58);
  const [monitoring, setMonitoring] = useState(true);
  const [distance, setDistance] = useState(50);
  const [angle, setAngle] = useState(0);
  const [material, setMaterial] = useState("Open air");
  const [rows, setRows] = useState<LogRow[]>([]);
  const [frame, setFrame] = useState<MicFrame>({ t: 0, left: 0.12, right: 0.1, peakL: 0.18, peakR: 0.15, samples: Array(96).fill(0) });
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioInfo, setAudioInfo] = useState("Choose a 16 kHz · 16-bit · mono PCM file");
  const [volume, setVolume] = useState(55);
  const [playing, setPlaying] = useState(false);
  const portRef = useRef<SerialPortLike | null>(null);
  const writerRef = useRef<WritableStreamDefaultWriter<Uint8Array> | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const bufferRef = useRef("");

  const supported = typeof navigator !== "undefined" && Boolean((navigator as SerialNavigator).serial);
  const balance = (frame.right - frame.left) / Math.max(frame.left + frame.right, 0.001);
  const inferredAngle = Math.round(Math.max(-90, Math.min(90, balance * 120)));

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2400);
  }, []);

  const send = useCallback(async (message: object) => {
    if (!writerRef.current) return;
    await writerRef.current.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
  }, []);

  useEffect(() => {
    if (connection === "connected") send({ type: "led.set", mode, color, brightness, speed, easing: ease, led: selectedLed });
  }, [mode, color, brightness, speed, ease, selectedLed, connection, send]);

  useEffect(() => {
    if (connection === "connected") send({ type: "mic.config", gainDb: gain, sensitivity, noiseGateDb: noiseGate, stream: monitoring });
  }, [gain, sensitivity, noiseGate, monitoring, connection, send]);

  useEffect(() => {
    if (!demo || connection === "connected" || !monitoring) return;
    const interval = window.setInterval(() => {
      const t = performance.now() / 1000;
      const envelope = 0.14 + (Math.sin(t * 0.8) + 1) * 0.06 + Math.max(0, Math.sin(t * 2.7)) * 0.1;
      const directional = Math.sin(t * 0.31) * 0.13;
      const samples = Array.from({ length: 96 }, (_, i) => {
        const x = t + i / 1600;
        return (Math.sin(x * 220) * 0.54 + Math.sin(x * 503) * 0.17 + (Math.random() - 0.5) * 0.18) * envelope * 100;
      });
      const left = Math.max(0.008, envelope * (1 - directional));
      const right = Math.max(0.008, envelope * (1 + directional));
      setFrame((old) => ({ t, left, right, peakL: Math.max(left, old.peakL * 0.94), peakR: Math.max(right, old.peakR * 0.94), samples }));
    }, 42);
    return () => window.clearInterval(interval);
  }, [demo, connection, monitoring]);

  const handleLine = useCallback((line: string) => {
    try {
      const msg = JSON.parse(line) as { type?: string; left?: number; right?: number; peakL?: number; peakR?: number; samples?: number[]; message?: string };
      if (msg.type === "mic.frame" && typeof msg.left === "number" && typeof msg.right === "number") {
        setFrame((old) => ({ t: performance.now() / 1000, left: msg.left!, right: msg.right!, peakL: msg.peakL ?? msg.left!, peakR: msg.peakR ?? msg.right!, samples: msg.samples?.slice(0, 128) ?? old.samples }));
      }
      if (msg.type === "error") notify(msg.message ?? "Device reported an error");
    } catch { /* Ignore boot logs and incomplete diagnostic lines. */ }
  }, [notify]);

  const readLoop = useCallback(async (port: SerialPortLike) => {
    if (!port.readable) return;
    const reader = port.readable.getReader();
    readerRef.current = reader;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bufferRef.current += new TextDecoder().decode(value, { stream: true });
        const lines = bufferRef.current.split("\n");
        bufferRef.current = lines.pop() ?? "";
        lines.forEach(handleLine);
      }
    } catch { /* Reader is expected to throw when disconnecting. */ }
    finally { reader.releaseLock(); readerRef.current = null; }
  }, [handleLine]);

  const connect = async () => {
    if (connection === "connected") {
      await readerRef.current?.cancel().catch(() => undefined);
      await writerRef.current?.close().catch(() => undefined);
      writerRef.current = null;
      await portRef.current?.close().catch(() => undefined);
      portRef.current = null;
      setConnection("disconnected");
      setDemo(true);
      notify("Board disconnected · demo signal restored");
      return;
    }
    if (!supported) { notify("Web Serial needs Chrome, Edge, or the Codex desktop browser"); return; }
    setConnection("connecting");
    try {
      const port = await (navigator as SerialNavigator).serial!.requestPort();
      await port.open({ baudRate: 921600, bufferSize: 65536 });
      if (!port.writable) throw new Error("Serial output unavailable");
      portRef.current = port;
      writerRef.current = port.writable.getWriter();
      setConnection("connected");
      setDemo(false);
      void readLoop(port);
      await send({ type: "hello", protocol: 1 });
      notify("ESP32-S3 Audio Board connected");
    } catch (error) {
      setConnection("disconnected");
      notify(error instanceof Error ? error.message : "Could not connect to board");
    }
  };

  const capture = () => {
    setRows((old) => [{ at: new Date().toISOString(), distance, angle, material, gain, sensitivity, left: frame.left, right: frame.right, balance }, ...old].slice(0, 40));
    notify("Measurement captured");
  };

  const inspectAudio = async (file: File | null) => {
    setAudioFile(null);
    if (!file) return;
    const bytes = new Uint8Array(await file.slice(0, 44).arrayBuffer());
    const view = new DataView(bytes.buffer);
    const wav = bytes.length >= 44 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WAVE";
    if (wav) {
      const channels = view.getUint16(22, true), rate = view.getUint32(24, true), bits = view.getUint16(34, true), format = view.getUint16(20, true);
      if (format !== 1 || channels !== 1 || rate !== 16000 || bits !== 16) {
        setAudioInfo(`Rejected · ${rate / 1000} kHz · ${bits}-bit · ${channels === 1 ? "mono" : `${channels} ch`}`);
        notify("Audio must be PCM, 16 kHz, 16-bit, mono"); return;
      }
      setAudioInfo(`Ready · WAV PCM · 16 kHz · 16-bit mono · ${(file.size / 32000).toFixed(1)} s`);
    } else if (!file.name.toLowerCase().endsWith(".pcm") && !file.name.toLowerCase().endsWith(".raw")) {
      setAudioInfo("Rejected · use a validated WAV, .pcm, or .raw file"); notify("Unsupported audio container"); return;
    } else setAudioInfo(`Ready · raw signed PCM assumed · ${(file.size / 32000).toFixed(1)} s`);
    setAudioFile(file);
  };

  const playAudio = async () => {
    if (!audioFile) { notify("Choose a valid audio file first"); return; }
    if (connection !== "connected" || !writerRef.current) { notify("Connect the board before speaker playback"); return; }
    setPlaying(true);
    try {
      const all = new Uint8Array(await audioFile.arrayBuffer());
      const wav = String.fromCharCode(...all.slice(0, 4)) === "RIFF";
      const payload = wav ? all.slice(44) : all;
      await send({ type: "speaker.begin", format: "pcm_s16le", sampleRate: 16000, channels: 1, bytes: payload.length, volume });
      for (let offset = 0; offset < payload.length; offset += 1024) await writerRef.current.write(payload.slice(offset, offset + 1024));
      await send({ type: "speaker.end" });
      notify("Playback transferred to board");
    } catch { notify("Playback transfer interrupted"); }
    finally { setPlaying(false); }
  };

  const ledPreview = useMemo(() => ({ mode, color, brightness, speed, ease }), [mode, color, brightness, speed, ease]);

  return (
    <main>
      <header className="topbar">
        <div className="brand"><span className="brand-mark">A</span><div><strong>Audio Lab</strong><small>ESP32-S3 test console</small></div></div>
        <div className="header-actions">
          <span className={`status-pill ${connection}`}><i className="dot" /> {connection === "connected" ? "Board online" : connection === "connecting" ? "Connecting…" : demo ? "Demo signal" : "Offline"}</span>
          <button className={`connect-button ${connection === "connected" ? "danger" : ""}`} onClick={connect}>{connection === "connected" ? "Disconnect" : "Connect board"}<span>{connection === "connected" ? "×" : "↗"}</span></button>
        </div>
      </header>

      <section className="hero">
        <div><p className="eyebrow">BENCH / AUDIO BOARD 01</p><h1>Hardware, <em>made visible.</em></h1><p>Shape light, inspect sound, and capture repeatable measurements from one real-time console.</p></div>
        <div className="hero-readout"><span>TRANSPORT</span><strong>USB Serial</strong><small>921,600 baud · protocol v1</small></div>
      </section>

      <nav className="tabs" aria-label="Test modules">
        <button className={tab === "led" ? "active" : ""} onClick={() => setTab("led")}><span>◉</span><div>LIGHT<small>LED ring control</small></div></button>
        <button className={tab === "mic" ? "active" : ""} onClick={() => setTab("mic")}><span>⌁</span><div>LISTEN<small>Microphone lab</small></div></button>
        <button className={tab === "speaker" ? "active" : ""} onClick={() => setTab("speaker")}><span>◖</span><div>PLAY<small>Speaker verifier</small></div></button>
        <button className="future" disabled><span>＋</span><div>EXPAND<small>MPR121 · FSR · more</small></div></button>
      </nav>

      {tab === "led" && <section className="workspace led-workspace">
        <article className="panel visual-panel">
          <div className="panel-heading"><div><p className="kicker">LIVE OUTPUT</p><h2>Seven-pixel ring</h2></div><button className="icon-button" onClick={() => setSelectedLed(null)} title="Select all LEDs">ALL</button></div>
          <Ring {...ledPreview} now={frame.t} active={selectedLed} onSelect={(i) => setSelectedLed(selectedLed === i ? null : i)} />
          <div className="selection-note"><strong>{selectedLed === null ? "All pixels linked" : `Pixel ${selectedLed + 1} isolated`}</strong><span>{selectedLed === null ? "Changes are broadcast to the full ring" : "Click again to return to the full ring"}</span></div>
        </article>
        <article className="panel control-panel">
          <div className="panel-heading"><div><p className="kicker">BEHAVIOUR</p><h2>Light composer</h2></div><button className="reset-link" onClick={() => { setMode("rainbow"); setBrightness(72); setSpeed(1.2); setEase("sine"); }}>Reset</button></div>
          <div className="mode-grid">{MODES.map((item) => <button key={item.id} className={mode === item.id ? "active" : ""} onClick={() => setMode(item.id)}><span>{item.icon}</span>{item.label}</button>)}</div>
          <div className="color-row"><label><span className="field-label"><span>Colour</span><output>{color.toUpperCase()}</output></span><span className="color-control"><input aria-label="LED color" type="color" value={color} onChange={(e) => setColor(e.target.value)} /><i style={{ background: color }} /><input value={color.toUpperCase()} onChange={(e) => /^#[0-9a-f]{6}$/i.test(e.target.value) && setColor(e.target.value)} aria-label="LED color hex" /></span></label><div className="swatches">{["#7c5cff", "#00d4a6", "#ffb547", "#ff5370", "#42a5ff"].map((swatch) => <button key={swatch} aria-label={`Use ${swatch}`} style={{ background: swatch }} onClick={() => setColor(swatch)} />)}</div></div>
          <Range label="Brightness" value={brightness} min={0} max={100} unit="%" onChange={setBrightness} />
          <Range label={mode === "flicker" ? "Flicker rate" : "Animation speed"} value={speed} min={0.1} max={4} step={0.1} unit="×" onChange={setSpeed} />
          <div className="select-field"><label className="field-label" htmlFor="easing"><span>Easing curve</span><output>transition</output></label><select id="easing" value={ease} onChange={(e) => setEase(e.target.value)}><option value="sine">Sine · soft</option><option value="linear">Linear · mechanical</option><option value="quadIn">Ease in · accelerating</option><option value="quadOut">Ease out · settling</option><option value="smoothstep">Smoothstep · organic</option></select></div>
          <div className="command-preview"><span>DEVICE COMMAND</span><code>{JSON.stringify({ mode, brightness, speed, easing: ease })}</code></div>
        </article>
      </section>}

      {tab === "mic" && <section className="mic-layout">
        <article className="panel scope-panel">
          <div className="panel-heading"><div><p className="kicker">DUAL MICROPHONE ARRAY</p><h2>Live acoustic field</h2></div><label className="toggle"><input type="checkbox" checked={monitoring} onChange={(e) => setMonitoring(e.target.checked)} /><i /><span>{monitoring ? "Monitoring" : "Paused"}</span></label></div>
          <Waveform frame={frame} sensitivity={sensitivity} />
          <div className="meters"><div className="db-scale"><span>0</span><span>−18</span><span>−36</span><span>−54</span><span>−72</span></div><LevelMeter label="MIC L" value={frame.left} peak={frame.peakL} /><LevelMeter label="MIC R" value={frame.right} peak={frame.peakR} /></div>
          <div className="direction-card"><div className="direction-dial"><i style={{ transform: `rotate(${inferredAngle}deg)` }} /><span>L</span><span>R</span></div><div><p>LEVEL-DERIVED DIRECTION CUE</p><strong>{Math.abs(inferredAngle)}° {inferredAngle < -4 ? "left" : inferredAngle > 4 ? "right" : "centre"}</strong><small>Relative level estimate—not calibrated beamforming</small></div></div>
        </article>
        <aside className="mic-side">
          <article className="panel compact-panel"><div className="panel-heading"><div><p className="kicker">INPUT STAGE</p><h2>Mic controls</h2></div></div><Range label="Codec gain" value={gain} min={0} max={37} unit=" dB" onChange={setGain} /><Range label="Visual sensitivity" value={sensitivity} min={0.5} max={4} step={0.1} unit="×" onChange={setSensitivity} /><Range label="Noise gate" value={noiseGate} min={-72} max={-18} unit=" dB" onChange={setNoiseGate} /></article>
          <article className="panel compact-panel test-context"><div className="panel-heading"><div><p className="kicker">TEST CONDITIONS</p><h2>Tag this reading</h2></div></div><div className="two-cols"><label><span>Distance</span><div><input type="number" min="0" max="1000" value={distance} onChange={(e) => setDistance(Number(e.target.value))} /><i>cm</i></div></label><label><span>Source angle</span><div><input type="number" min="-180" max="180" value={angle} onChange={(e) => setAngle(Number(e.target.value))} /><i>°</i></div></label></div><label><span>Mic covering / environment</span><select value={material} onChange={(e) => setMaterial(e.target.value)}><option>Open air</option><option>Acoustic mesh</option><option>Thin fabric</option><option>Foam</option><option>Plastic enclosure</option><option>Custom material</option></select></label><button className="primary wide" onClick={capture}>Capture measurement <span>＋</span></button></article>
        </aside>
        <article className="panel log-panel"><div className="panel-heading"><div><p className="kicker">MEASUREMENT LOG</p><h2>{rows.length ? `${rows.length} captured reading${rows.length === 1 ? "" : "s"}` : "Ready for first capture"}</h2></div><button className="reset-link" disabled={!rows.length} onClick={() => downloadCsv(rows)}>Export CSV ↗</button></div>{rows.length ? <div className="table-wrap"><table><thead><tr><th>Time</th><th>Conditions</th><th>Left</th><th>Right</th><th>Balance</th></tr></thead><tbody>{rows.map((row) => <tr key={row.at}><td>{new Date(row.at).toLocaleTimeString()}</td><td>{row.distance} cm · {row.angle}° · {row.material}</td><td>{formatDb(row.left)}</td><td>{formatDb(row.right)}</td><td>{row.balance > 0.04 ? "R" : row.balance < -0.04 ? "L" : "Centre"} {Math.abs(row.balance * 100).toFixed(0)}%</td></tr>)}</tbody></table></div> : <div className="empty-log"><span>＋</span><p>Set the physical conditions, then capture a reading to make comparisons repeatable.</p></div>}</article>
      </section>}

      {tab === "speaker" && <section className="workspace speaker-workspace">
        <article className="panel speaker-main"><div className="panel-heading"><div><p className="kicker">SPEAKER OUTPUT</p><h2>PCM playback verifier</h2></div><span className="format-chip">S16LE · 16 kHz · MONO</span></div><label className={`drop-zone ${audioFile ? "ready" : ""}`}><input type="file" accept=".wav,.pcm,.raw,audio/wav" onChange={(e) => void inspectAudio(e.target.files?.[0] ?? null)} /><span className="upload-icon">⇧</span><strong>{audioFile?.name ?? "Drop a test tone or spoken sample"}</strong><small>{audioInfo}</small><em>{audioFile ? "Replace file" : "Browse files"}</em></label><div className="speaker-controls"><Range label="Output volume" value={volume} min={0} max={100} unit="%" onChange={setVolume} /><button className="primary play-button" disabled={!audioFile || playing} onClick={() => void playAudio()}>{playing ? "Transferring…" : "Send & play"}<span>▶</span></button></div><div className="safety-note"><span>!</span><p><strong>Start low.</strong> The amplifier can be loud at close range. Playback is disabled until the board is connected and the audio format passes validation.</p></div></article>
        <aside className="panel checklist"><div className="panel-heading"><div><p className="kicker">REPEATABLE TEST</p><h2>Listening checklist</h2></div></div>{["Begin at 25% output volume", "Listen for clipping on peaks", "Check buzz at 100–250 Hz", "Compare near / far microphone bleed", "Record enclosure and surface"].map((item, i) => <label key={item}><input type="checkbox" defaultChecked={i === 0} /><i>{i + 1}</i><span>{item}</span></label>)}<div className="spec-block"><span>EXPECTED FILE</span><dl><div><dt>Encoding</dt><dd>Signed linear PCM</dd></div><div><dt>Sample rate</dt><dd>16,000 Hz</dd></div><div><dt>Word / channels</dt><dd>16-bit / mono</dd></div></dl></div></aside>
      </section>}

      <footer><p><i className="dot online" /> Console running locally in your browser</p><p>ESP32-S3 Audio Board · test protocol v1</p></footer>
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
