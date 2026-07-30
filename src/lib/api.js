// ── Backend + LLM transport ───────────────────────────────────────────────────
// All LLM calls route through the FastAPI backend.
// No API keys are stored or used in the browser.
// The backend reads GROQ_API_KEY and ANTHROPIC_API_KEY from its .env file.

// ── Backend config ────────────────────────────────────────────────────────────
// Empty string → all `${BACKEND}/api/...` calls are same-origin relative URLs
// proxied by Vite dev server to FastAPI backend (see vite.config.js).
export const BACKEND = "";

// ── Agent name → backend endpoint map ────────────────────────────────────────
// Only agents that BUILD THEIR OWN system prompts on the backend go here.
// Agents that use custom frontend-built system prompts use the generic /api/agent proxy.
const AGENT_ENDPOINT_MAP = {
  "Socratic":      "socratic",      // backend owns the Socratic system prompt
  "Reasoning":     "reasoning",     // backend classifies + builds prompt
  "DocSearch":     "rag",           // backend runs full RAG pipeline
  // /api/agents/advisor is dual-mode: an empty `messages` array (the initial
  // recommendation-card fetch, called directly via fetch(), not through here)
  // returns the structured recommendation object; a non-empty `messages` array
  // (routed through here) runs run_crossskill_chat — real tool-calling over the
  // SAME ranked-track/role-journey data, so the model looks up facts on demand
  // instead of a static context block. Requires `profile`/`track`/`extra` to
  // actually be passed in callAgent's opts (see sendExp in App.jsx) — without
  // those the backend has no learner context to ground the chat in at all.
  "CrossSkilling": "advisor",
};

/**
 * callAgent — route an LLM call through the backend.
 * API keys are never sent from or stored in the browser.
 *
 * @param {Array}  msgs       - conversation messages [{role, content}]
 * @param {string} sys        - system prompt
 * @param {string} _groqKey   - ignored (kept for backward compat, not used)
 * @param {object} opts       - {agentName, logFn, maxTokens, profile, track, module, extra}
 */
export async function callAgent(msgs, sys, _groqKey, opts = {}) {
  const { agentName = "Agent", logFn, maxTokens = 1000, profile = {},
          track = "rtcdp", module: mod = "", extra = {} } = opts;
  const t0 = Date.now();
  let text = "", iT = 0, oT = 0, model = "", ok = true, err = "";

  try {
    const lgEndpoint = AGENT_ENDPOINT_MAP[agentName];
    const endpoint   = lgEndpoint
      ? `${BACKEND}/api/agents/${lgEndpoint}`
      : `${BACKEND}/api/agent`;

    const body = lgEndpoint
      ? JSON.stringify({ messages: msgs, profile, track, module: mod, extra })
      : JSON.stringify({ messages: msgs, system: sys, max_tokens: maxTokens,
                         temperature: 0.7, agent_name: agentName, prefer_groq: true });

    const r = await fetch(endpoint, {
      method:      "POST",
      credentials: "include",
      headers:     { "Content-Type": "application/json" },
      body,
    });

    if (!r.ok) {
      const errData = await r.json().catch(() => ({}));
      throw new Error(errData.detail || `Backend error ${r.status}`);
    }

    const d = await r.json();
    text  = lgEndpoint ? (d.response || d.result?.response || "") : (d.text || "");
    iT    = d.input_tokens  || 0;
    oT    = d.output_tokens || 0;
    model = lgEndpoint ? `backend:${lgEndpoint}` : (d.model || "backend");

  } catch (e) {
    ok  = false;
    err = e.message;
    text = `Error: ${e.message}`;
  }

  const latency = Date.now() - t0;
  logFn?.({
    id: Date.now(), ts: new Date().toLocaleTimeString(),
    agent: agentName, model, inputTokens: iT, outputTokens: oT,
    totalTokens: iT + oT, latency, ok, err,
  });

  if (!ok) throw new Error(err);
  return text;
}

// ── Guardrail — Socratic response judge ───────────────────────────────────────
export async function judgeResponse(response) {
  try {
    const r = await fetch(`${BACKEND}/api/judge`, {
      method:      "POST",
      credentials: "include",
      headers:     { "Content-Type": "application/json" },
      body:        JSON.stringify({ response }),
    });
    if (r.ok) return await r.json();
  } catch {}

  // Lightweight local fallback (no LLM needed)
  const wc   = response.trim().split(/\s+/).length;
  const hasQ = (response.match(/\?/g) || []).length === 1;
  const short = wc <= 55;
  return {
    wordCount: wc, hasOneQuestion: hasQ, avoidsDirectAnswer: true,
    isSocratic: hasQ, score: hasQ && short ? 7 : 4,
    issue: !hasQ ? "Missing question" : !short ? `${wc} words (limit 55)` : null,
  };
}

// ── Generic agent guardrail ───────────────────────────────────────────────────
const AEP_TERMS = [
  "segment","profile","dataset","schema","identity","destination","dataflow",
  "ingestion","activation","XDM","RTCDP","AJO","CJA","sandbox","merge policy",
  "streaming","batch","edge","audience","namespace",
];

export async function judgeGenericResponse(text, agentName) {
  try {
    const words       = text.trim().split(/\s+/).length;
    const tooShort    = words < 8;
    const tooLong     = words > 700;
    const refuses     = /\b(i cannot|i can't|i'm unable|i am unable)\b/i.test(text);
    const isDomainAgent = ["Capstone","CapstoneHint","CrossSkilling","Practice"].includes(agentName);
    const lower       = text.toLowerCase();
    const aepHit      = isDomainAgent ? AEP_TERMS.some(t => lower.includes(t.toLowerCase())) : true;
    const score       = tooShort ? 30 : refuses ? 40 : !aepHit ? 55 : tooLong ? 65 : 90;
    const issue       = tooShort ? "Response too short" : refuses ? "Agent refused task"
                      : !aepHit ? "No AEP domain terms" : tooLong ? "Response too long" : "";

    await fetch(`${BACKEND}/api/guardrail/generic`, {
      method:      "POST",
      credentials: "include",
      headers:     { "Content-Type": "application/json" },
      body:        JSON.stringify({ agent_name: agentName, score, issue,
                                    response_preview: text.slice(0, 120) }),
    });
  } catch {}
}

/**
 * callFlashcardAgent — generate flashcards via the backend Study Aid agent.
 * Returns {cards, usedFallback}. usedFallback=true means the backend couldn't
 * generate real cards and returned its single hardcoded placeholder card — the
 * caller must NOT persist that result to the generation cache (getCachedOrGenerate),
 * otherwise the failure gets served back on every subsequent load of that module
 * until someone happens to click Regenerate. A request-level exception (network
 * failure, non-2xx) is treated the same way (usedFallback=true, cards=[]).
 */
export async function callFlashcardAgent(module, track = "rtcdp", moduleId = null, logFn = null, confidence = null) {
  const t0 = Date.now();
  let cards = [], usedFallback = true, ok = true, err = "", model = "backend:flashcard";
  try {
    const r = await fetch(`${BACKEND}/api/agents/flashcard`, {
      method:      "POST",
      credentials: "include",
      headers:     { "Content-Type": "application/json" },
      body:        JSON.stringify({ module, track, extra: { module_id: moduleId, topic: module, confidence } }),
    });
    if (!r.ok) {
      const errData = await r.json().catch(() => ({}));
      throw new Error(errData.detail || `Backend error ${r.status}`);
    }
    const d = await r.json();
    cards = Array.isArray(d.cards) ? d.cards : [];
    usedFallback = !!d.used_fallback;
    model = d.meta?.model || model;
  } catch (e) {
    ok = false; err = e.message;
  }

  logFn?.({
    id: Date.now(), ts: new Date().toLocaleTimeString(),
    agent: "Study Aid", model, inputTokens: 0, outputTokens: 0,
    totalTokens: 0, latency: Date.now() - t0, ok, err,
  });

  return { cards, usedFallback };
}