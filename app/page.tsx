"use client";

import { FormEvent, useEffect, useState } from "react";
import { SignInButton, useAuth } from "@clerk/nextjs";
import posthog from "posthog-js";

type ModelOption = { id: string; name: string; shortName: string; contextLength: number; promptPrice: string; completionPrice: string };
type Metrics = { timeToFirstTokenMs?: number; elapsedMs?: number; promptTokens?: number; completionTokens?: number; totalTokens?: number };
type ModelState = { text: string; status: "idle" | "streaming" | "complete" | "error"; metrics?: Metrics; error?: string };
type StreamEvent = { modelId: string; roundId?: string; type: "start" | "token" | "complete" | "error"; text?: string; metrics?: Metrics; error?: string };

const FALLBACK_MODELS: ModelOption[] = [
  { id: "liquid/lfm-2.5-2.6b:free", name: "Liquid LFM 2.5", shortName: "LFM", contextLength: 0, promptPrice: "0", completionPrice: "0" },
  { id: "nvidia/nemotron-3.5-lightning:free", name: "NVIDIA Nemotron", shortName: "NEM", contextLength: 0, promptPrice: "0", completionPrice: "0" },
  { id: "cohere/north-mini-code:free", name: "Cohere North Mini", shortName: "NORTH", contextLength: 0, promptPrice: "0", completionPrice: "0" },
];

const initialStates = (ids: readonly string[]): Record<string, ModelState> => Object.fromEntries(ids.map((id) => [id, { text: "", status: "idle" }]));
const formatMetric = (value: number | undefined, suffix = "") => value === undefined ? "--" : `${value}${suffix}`;

export default function Home() {
  const { isLoaded, isSignedIn } = useAuth();
  const [catalog, setCatalog] = useState(FALLBACK_MODELS);
  const [selectedIds, setSelectedIds] = useState(FALLBACK_MODELS.map((model) => model.id));
  const [states, setStates] = useState<Record<string, ModelState>>(() => initialStates(selectedIds));
  const [prompt, setPrompt] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [winner, setWinner] = useState<string | null>(null);
  const [roundId, setRoundId] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);

  useEffect(() => {
    const loadCatalog = async () => {
      try {
        const response = await fetch("/api/models");
        if (!response.ok) throw new Error("Catalog unavailable");
        const result = (await response.json()) as { models?: ModelOption[] };
        if (result.models?.length) {
          const defaults = result.models.slice(0, 3).map((model) => model.id);
          setCatalog(result.models);
          setSelectedIds(defaults);
          setStates(initialStates(defaults));
        }
      } catch {
        // Keep the fallback catalog available when the network is unavailable.
      } finally {
        setCatalogLoading(false);
      }
    };
    void loadCatalog();
  }, []);

  const selectedModels = catalog.filter((model) => selectedIds.includes(model.id));
  const completedCount = selectedModels.filter((model) => states[model.id]?.status === "complete").length;

  const updateModel = (modelId: string, update: Partial<ModelState>) => {
    setStates((current) => ({ ...current, [modelId]: { ...current[modelId], ...update } }));
  };

  const appendToken = (modelId: string, text: string) => {
    setStates((current) => ({ ...current, [modelId]: { ...current[modelId], text: `${current[modelId]?.text ?? ""}${text}`, status: "streaming" } }));
  };

  const toggleModel = (modelId: string) => {
    setSelectedIds((current) => {
      if (current.includes(modelId)) return current.length === 1 ? current : current.filter((id) => id !== modelId);
      if (current.length >= 3) return current;
      setStates((existing) => ({ ...existing, [modelId]: { text: "", status: "idle" } }));
      return [...current, modelId];
    });
  };

  const submitPrompt = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStates(initialStates(selectedIds));
    setWinner(null);
    setError("");
    setIsLoading(true);

    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, models: selectedIds }) });
      if (!response.ok) { const result = (await response.json()) as { error?: string }; throw new Error(result.error ?? "Unable to get a response."); }
      if (!response.body) throw new Error("The model stream could not start.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        events.forEach((rawEvent) => {
          const line = rawEvent.split("\n").find((item) => item.startsWith("data: "));
          if (!line) return;
          const streamEvent = JSON.parse(line.slice(6)) as StreamEvent;
          if (streamEvent.roundId) setRoundId(streamEvent.roundId);
          if (streamEvent.type === "start") updateModel(streamEvent.modelId, { status: "streaming" });
          if (streamEvent.type === "token") appendToken(streamEvent.modelId, streamEvent.text ?? "");
          if (streamEvent.type === "complete") updateModel(streamEvent.modelId, { status: "complete", metrics: streamEvent.metrics });
          if (streamEvent.type === "error") updateModel(streamEvent.modelId, { status: "error", error: streamEvent.error });
        });
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Something went wrong.");
    } finally {
      setIsLoading(false);
    }
  };

  const chooseWinner = (modelId: string) => {
    setWinner(modelId);
    posthog.capture("vote_cast", { model: modelId });
    if (roundId) {
      void fetch("/api/vote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roundId, modelId }) });
    }
  };

  return <main className="app-frame">
    <aside className="sidebar" aria-label="Primary navigation">
      <div className="sidebar-brand"><span className="brand-symbol">◒</span><span>LLM Arena</span></div>
      <nav className="primary-nav"><a className="nav-item is-active" href="#arena"><span>⌁</span> Arena</a><a className="nav-item" href="/leaderboard"><span>◫</span> Leaderboard</a></nav>
      <div className="sidebar-bottom"><span className="avatar">A</span><span className="sidebar-user">Arena user</span><button className="icon-button" type="button" aria-label="Toggle appearance">◐</button></div>
    </aside>
    <div className="workspace" id="arena">
      <header className="workspace-bar"><div className="breadcrumb"><span className="mobile-brand">LLM Arena</span><span className="crumb-muted">Arena</span><span>/</span><strong>New comparison</strong></div><div className="round-status"><span className="status-dot" /> {completedCount}/{selectedModels.length} complete</div></header>
      <section className="workspace-content">
        <div className="hero-row"><div><p className="eyebrow">A private model comparison</p><h1>One prompt.<br /><em>Three perspectives.</em></h1></div><p className="hero-copy">Ask once. See every answer arrive in real time, then decide which model earned your vote.</p></div>
        <section className="selection-panel" aria-label="Model selection"><div className="selection-heading"><div><span className="panel-kicker">Models in this round</span><strong>{selectedModels.length} of 3 selected</strong></div><span className="catalog-state">{catalogLoading ? "Updating catalog" : "Free tier models"}</span></div><div className="model-options">{catalog.map((model) => <button className={`model-option ${selectedIds.includes(model.id) ? "is-selected" : ""}`} type="button" key={model.id} onClick={() => toggleModel(model.id)} aria-pressed={selectedIds.includes(model.id)}><span className="checkmark">{selectedIds.includes(model.id) ? "✓" : "+"}</span>{model.name}</button>)}</div></section>
        <div className="model-grid">{selectedModels.map((model, index) => { const state = states[model.id] ?? { text: "", status: "idle" as const }; return <article className={`model-card ${winner === model.id ? "is-winner" : ""}`} key={model.id}>
          <div className="model-card-header"><div className="model-title"><span className="model-avatar">{index + 1}</span><div><h2>{model.name}</h2><span>{model.shortName} · Free tier</span></div></div>{state.status === "streaming" && <span className="live-state"><i /> Live</span>}{winner === model.id && <span className="winner-state">Winner</span>}</div>
          <div className="answer-area">{state.error ? <p className="error-message">{state.error}</p> : state.text ? <p>{state.text}</p> : <span className="empty-answer">{state.status === "streaming" ? "Thinking..." : "Waiting for your prompt"}</span>}</div>
          <div className="metrics"><div><span>Time to first token</span><strong>{formatMetric(state.metrics?.timeToFirstTokenMs, " ms")}</strong></div><div><span>Total time</span><strong>{formatMetric(state.metrics?.elapsedMs, " ms")}</strong></div><div><span>Total tokens</span><strong>{formatMetric(state.metrics?.totalTokens)}</strong></div><div><span>Generation speed</span><strong>{state.metrics?.completionTokens && state.metrics.elapsedMs ? `${Math.round(state.metrics.completionTokens / (state.metrics.elapsedMs / 1000))} tok/s` : "--"}</strong></div></div>
          <button className="vote-button" type="button" disabled={completedCount < 2 || isLoading || Boolean(winner)} onClick={() => chooseWinner(model.id)}>{winner === model.id ? "Winner selected" : completedCount < 2 ? "Waiting for two answers" : "Choose this answer"}<span>↗</span></button>
        </article>; })}</div>
        {isLoaded && isSignedIn && <form className="prompt-composer" onSubmit={submitPrompt}><div className="composer-label"><label htmlFor="prompt">Your prompt</label><span>⌘ ↵ to send</span></div><textarea id="prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="What would you like to explore?" rows={3} disabled={isLoading} /><div className="composer-footer"><span>{selectedModels.length} models will answer independently</span><button type="submit" disabled={isLoading || prompt.trim().length === 0}>{isLoading ? "Responses incoming" : "Send prompt"}<span>↗</span></button></div></form>}
        {isLoaded && !isSignedIn && <div className="sign-in-prompt"><span>Sign in to compare models and save your rounds.</span><SignInButton mode="modal"><button type="button">Sign in <span>↗</span></button></SignInButton></div>}
        {error && <p className="error-message request-error">{error}</p>}
      </section>
      <footer className="workspace-footer"><span>LLM Arena · Comparison workspace</span><span>Built for thoughtful answers</span></footer>
    </div>
  </main>;
}
