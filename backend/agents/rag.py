"""
rag.py — Shared RAG service + general RAG Agent (LangGraph)
===========================================================
This module is the SINGLE shared retrieval layer for the whole platform.
Every other agent (curriculum, reasoning, practice, capstone) imports
`retrieve()` from here instead of writing its own SQL — so retrieval logic,
the embedding model, and scoring live in exactly one place.

Two public surfaces:

  1. retrieve(query, track=None, top_k=?, module_title=None)  ← shared, low-level
        Returns a list of {title, url, repo, content, score}. Used everywhere.

  2. run_rag(query, track=None, graph=None)                   ← full pipeline
        5 LangGraph steps: rewrite → retrieve → rerank → answer → guard.
        Returns {answer, citations, meta}. Used by the general Q&A / RAG tab.

Storage model (matches the real DB + build_embeddings_index.py):
  doc_embeddings(title, repo, el_url, track, chunk_text, embedding TEXT)
  where `embedding` is a JSON array of floats. This table remains the source of
  truth and the corpus for the lexical (Postgres full-text) leg.

Retrieval, in preference order — both return the same document shape, so callers
never care which path ran:

  1. Persistent pgvector path (default when available; see agents/vector_store.py):
       • vector leg  → LlamaIndex PGVectorStore + a real FastEmbed embed model;
                       top-k ANN search runs in Postgres (no whole-corpus load).
       • lexical leg → Postgres full-text search (ts_rank), top-k in SQL.
     Neither leg pulls the whole corpus into memory per query.

  2. Legacy in-memory path (automatic fallback when pgvector is unavailable):
       fetch the whole doc_embeddings table, build an in-memory index, and score
       cosine + BM25 in Python. Kept intact so the app always works.
"""

from .config import (
    set_current_agent,
    GROQ_MODEL, groq_call, get_db_url, make_meta, parse_json_lenient,
    RAG_TOP_K, RAG_MIN_SCORE, RAG_EMBED_MODEL, PRODUCT_DISTINCTIONS,
    run_with_timeout,
)

# Persistent pgvector index behind the retriever. Import is cheap (its heavy deps
# load lazily); if the packages/extension are missing, is_available() is False and
# we transparently use the legacy in-memory path below.
from . import vector_store as _vstore

import re
import time
import json

try:
    from langgraph.graph import StateGraph, END
    LANGGRAPH_AVAILABLE = True
except ImportError:
    LANGGRAPH_AVAILABLE = False

try:
    from llama_index.core.schema import TextNode
    from llama_index.core import VectorStoreIndex, Settings as LISettings
    LLAMAINDEX_AVAILABLE = True
except Exception:
    LLAMAINDEX_AVAILABLE = False

# ── Pure-Python BM25 (no external package required) ───────────────────────────
import math
from collections import Counter

def _tokenise(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]{2,}", (text or "").lower())

def _build_bm25_corpus(rows: list[dict]) -> dict:
    """Pre-compute IDF + doc-term counts for a list of doc rows."""
    N = len(rows)
    df: dict[str, int] = {}
    doc_tokens = []
    for r in rows:
        toks = _tokenise(r.get("chunk_text") or "")
        doc_tokens.append(toks)
        for t in set(toks):
            df[t] = df.get(t, 0) + 1
    idf = {t: math.log((N - n + 0.5) / (n + 0.5) + 1) for t, n in df.items()}
    avg_len = sum(len(t) for t in doc_tokens) / max(N, 1)
    return {"idf": idf, "doc_tokens": doc_tokens, "avg_len": avg_len}

def _bm25_scores(query: str, corpus: dict, k1: float = 1.5, b: float = 0.75) -> list[float]:
    q_toks = _tokenise(query)
    idf, doc_tokens, avg_len = corpus["idf"], corpus["doc_tokens"], corpus["avg_len"]
    scores = []
    for toks in doc_tokens:
        dl = len(toks)
        freq = Counter(toks)
        score = 0.0
        for qt in q_toks:
            if qt not in idf:
                continue
            tf = freq.get(qt, 0)
            denom = tf + k1 * (1 - b + b * dl / max(avg_len, 1))
            score += idf[qt] * tf * (k1 + 1) / max(denom, 1e-9)
        scores.append(score)
    return scores

# ── LlamaIndex in-memory index (built lazily, cached per-track) ───────────────
_llama_indexes: dict = {}   # track → (VectorStoreIndex, row_count)

def _build_llama_index(rows: list[dict]):
    """Create an in-memory LlamaIndex VectorStoreIndex from doc_embeddings rows."""
    if not LLAMAINDEX_AVAILABLE:
        return None
    try:
        # Silence the embed model — every node already has a pre-computed embedding
        LISettings.embed_model = None
        LISettings.llm         = None
        nodes = []
        for r in rows:
            emb = None
            try:
                raw_emb = r.get("embedding")
                if raw_emb:
                    emb = json.loads(raw_emb) if isinstance(raw_emb, str) else raw_emb
            except Exception:
                pass
            node = TextNode(
                text=r.get("chunk_text") or "",
                metadata={
                    "title":    r.get("title") or "",
                    "url":      r.get("el_url") or "",
                    "repo":     r.get("repo") or "",
                    "track":    r.get("track") or "",
                    "page":     r.get("page_number"),
                    "section":  r.get("section_title") or "",
                    "filename": r.get("doc_filename") or "",
                    "source":   r.get("doc_source") or "markdown",
                },
            )
            if emb:
                node.embedding = emb
            nodes.append(node)
        index = VectorStoreIndex(nodes, embed_model=None)
        return index
    except Exception as e:
        print(f"[rag] LlamaIndex index build failed: {e}")
        return None

def _llama_retrieve(query: str, rows: list[dict], top_k: int, q_vec: list[float]) -> list[dict]:
    """Retrieve using LlamaIndex VectorIndexRetriever when available."""
    cache_key = id(rows[0]) if rows else "empty"   # rough key on row identity
    index = _llama_indexes.get(cache_key)
    if index is None:
        index = _build_llama_index(rows)
        if index:
            _llama_indexes[cache_key] = index
    if index is None:
        return []
    try:
        from llama_index.core.retrievers import VectorIndexRetriever
        retriever = VectorIndexRetriever(index=index, similarity_top_k=top_k)
        # LlamaIndex expects a QueryBundle; pass the query embedding we already computed
        from llama_index.core import QueryBundle
        qb = QueryBundle(query_str=query, embedding=q_vec)
        nodes = retriever.retrieve(qb)
        return [
            {
                "title":    n.metadata.get("title", ""),
                "url":      n.metadata.get("url", ""),
                "repo":     n.metadata.get("repo", ""),
                "content":  (n.text or "")[:900],
                "score":    round(float(n.score) if n.score is not None else 0.0, 3),
                "page":     n.metadata.get("page"),
                "section":  n.metadata.get("section", ""),
                "filename": n.metadata.get("filename", ""),
                "source":   n.metadata.get("source", "markdown"),
            }
            for n in nodes
        ]
    except Exception as e:
        print(f"[rag] LlamaIndex retrieve failed: {e}")
        return []


# ══════════════════════════════════════════════════════════════════════════════
# SHARED RETRIEVAL  (import this from any agent)
# ══════════════════════════════════════════════════════════════════════════════

_embedding_model = None  # lazy-loaded singleton


def _get_embedding_model():
    global _embedding_model
    if _embedding_model is None:
        from fastembed import TextEmbedding
        _embedding_model = TextEmbedding(model_name=RAG_EMBED_MODEL)
    return _embedding_model


def _embed(texts):
    model = _get_embedding_model()
    return [list(v) for v in model.embed(texts)]


def _cosine(a, b):
    import math
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def _fetch_rows(track=None, module_title=None):
    """
    Pull candidate chunks from doc_embeddings.
    Selects core columns + the PDF-metadata columns added by pdf_ingestion.py.
    Falls back gracefully if the extra columns don't exist yet.
    """
    import psycopg2
    import psycopg2.extras
    conn = psycopg2.connect(get_db_url())
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as c:
            clauses, params = [], []
            if track:
                clauses.append("track = %s")
                params.append(track)
            if module_title:
                clauses.append("title ILIKE %s")
                params.append(f"%{module_title}%")
            where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
            # Try to select PDF columns; fall back to base columns if they don't exist
            try:
                c.execute(
                    f"SELECT title, repo, el_url, chunk_text, embedding, "
                    f"page_number, section_title, doc_source, doc_filename "
                    f"FROM doc_embeddings{where}",
                    tuple(params),
                )
            except Exception:
                conn.rollback()
                c.execute(
                    f"SELECT title, repo, el_url, chunk_text, embedding "
                    f"FROM doc_embeddings{where}",
                    tuple(params),
                )
            return c.fetchall()
    finally:
        conn.close()


def _fts_retrieve(query, track=None, module_title=None, top_k=12):
    """
    Lexical leg via Postgres full-text search — the SQL-side replacement for the
    in-memory BM25 corpus. Ranking (ts_rank) and top-k happen in the DB, so only
    `top_k` rows ever reach Python. A GIN index on to_tsvector(chunk_text) keeps
    this fast (created by build_embeddings_index.py / pdf_ingestion.py).

    Returns docs in the shared shape (score = ts_rank). Empty on no match / error.
    """
    import psycopg2
    import psycopg2.extras

    extra_clauses, extra_params = [], []
    if track:
        extra_clauses.append("track = %s")
        extra_params.append(track)
    if module_title:
        extra_clauses.append("title ILIKE %s")
        extra_params.append(f"%{module_title}%")
    extra_where = (" AND " + " AND ".join(extra_clauses)) if extra_clauses else ""

    def _run(pdf_cols: str):
        # NOTE: every value is passed as a bound parameter (%s) — the only thing
        # interpolated into the SQL text is the fixed, code-controlled column list.
        sql = (
            f"SELECT title, el_url, repo, chunk_text{pdf_cols}, "
            f"ts_rank(to_tsvector('english', chunk_text), "
            f"plainto_tsquery('english', %s)) AS _rank "
            f"FROM doc_embeddings "
            f"WHERE to_tsvector('english', chunk_text) @@ "
            f"plainto_tsquery('english', %s){extra_where} "
            f"ORDER BY _rank DESC LIMIT %s"
        )
        params = [query, query] + extra_params + [top_k]
        conn = psycopg2.connect(get_db_url())
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as c:
                c.execute(sql, tuple(params))
                return c.fetchall()
        finally:
            conn.close()

    try:
        try:
            rows = _run(", page_number, section_title, doc_source, doc_filename")
        except Exception:
            # PDF-metadata columns not present yet — retry with base columns only.
            rows = _run("")
    except Exception as e:
        print(f"[rag._fts_retrieve] FTS error: {e}")
        return []

    return [
        {
            "title":    r.get("title", ""),
            "url":      r.get("el_url", ""),
            "repo":     r.get("repo", ""),
            "content":  (r.get("chunk_text") or "")[:900],
            "score":    round(float(r.get("_rank") or 0.0), 3),
            "page":     r.get("page_number"),
            "section":  r.get("section_title") or "",
            "filename": r.get("doc_filename") or "",
            "source":   r.get("doc_source") or "markdown",
        }
        for r in rows
    ]


def _rrf_fuse(vec_results: list[dict], bm25_results: list[dict], top_k: int) -> list[dict]:
    """Reciprocal Rank Fusion of the vector + lexical legs. RRF score =
    Σ 1/(k+rank), k=60 (standard). Dedupes on title+content prefix."""
    rrf_k = 60
    rrf: dict[str, dict] = {}

    def _key(doc: dict) -> str:
        return (doc.get("title") or "") + "||" + (doc.get("content") or "")[:100]

    for rank, doc in enumerate(vec_results):
        key = _key(doc)
        if key not in rrf:
            rrf[key] = {**doc, "_rrf": 0.0}
        rrf[key]["_rrf"] += 1.0 / (rrf_k + rank)

    for rank, doc in enumerate(bm25_results):
        key = _key(doc)
        if key not in rrf:
            rrf[key] = {**doc, "_rrf": 0.0}
        rrf[key]["_rrf"] += 1.0 / (rrf_k + rank)

    fused = sorted(rrf.values(), key=lambda x: x["_rrf"], reverse=True)[:top_k]
    for doc in fused:
        doc.pop("_rrf", None)
        doc.pop("_bm25_rank", None)
    return fused


def _retrieve_pgvector(query, track, top_k, module_title, min_score, hybrid):
    """
    Persistent path: pgvector vector leg + Postgres FTS lexical leg, RRF-fused.
    Returns a list of docs, or None to signal "fall back to the legacy in-memory
    path" (pgvector unavailable / degraded this request).
    """
    vec = _vstore.vector_retrieve(query, track=track, module_title=module_title,
                                  top_k=top_k * 3, min_score=min_score)
    if vec is None:                     # hard failure inside the vector store
        return None

    lex = _fts_retrieve(query, track=track, module_title=module_title,
                        top_k=top_k * 3) if hybrid else []

    # Widen gracefully if a module scope matched nothing (mirror legacy behaviour).
    if module_title and not vec and not lex:
        vec_wide = _vstore.vector_retrieve(query, track=track, top_k=top_k * 3,
                                           min_score=min_score)
        if vec_wide is None:            # store degraded mid-request → use legacy
            return None
        vec = vec_wide
        lex = _fts_retrieve(query, track=track, top_k=top_k * 3) if hybrid else []

    if not vec and not lex:
        return []
    if not hybrid:
        return vec[:top_k]
    return _rrf_fuse(vec, lex, top_k)


def retrieve(query, track=None, top_k=None, module_title=None, min_score=None,
             hybrid: bool = True):
    """
    Hybrid lexical + semantic retrieval (Reciprocal Rank Fusion).

    Vector leg: served by the persistent pgvector index when available
    (agents/vector_store.py) — top-k ANN search runs in Postgres. Lexical leg:
    Postgres full-text search. If pgvector is unavailable, transparently falls
    back to the legacy in-memory path (whole-corpus fetch + Python cosine + BM25).

    Args:
        query        : natural-language query
        track        : optional track filter
        top_k        : max docs to return (defaults to RAG_TOP_K)
        module_title : narrow to a specific module's content
        min_score    : cosine floor for vector leg
        hybrid       : combine BM25 + vector (True) or vector-only (False)

    Returns:
        [{title, url, repo, content, score, page, section, filename}]
    """
    top_k     = top_k if top_k is not None else RAG_TOP_K
    min_score = min_score if min_score is not None else RAG_MIN_SCORE

    # ── Persistent pgvector path (no whole-corpus load) ───────────────────────
    # Returns None only when the vector store is unavailable/degraded — in which
    # case we fall through to the legacy in-memory path below.
    if _vstore.is_available():
        fused = _retrieve_pgvector(query, track, top_k, module_title, min_score, hybrid)
        if fused is not None:
            return fused

    # ── Legacy in-memory path (fallback) ──────────────────────────────────────
    try:
        rows = _fetch_rows(track=track, module_title=module_title)
    except Exception as e:
        print(f"[rag.retrieve] db error: {e}")
        return []

    # If module scope returned nothing, widen gracefully.
    if not rows and module_title:
        try:
            rows = _fetch_rows(track=track)
        except Exception:
            rows = []
    if not rows:
        return []

    rows = list(rows)   # materialise cursor result

    # ── Vector retrieval leg ──────────────────────────────────────────────────
    q_vec = None
    try:
        q_vec = _embed([query])[0]
    except Exception as e:
        print(f"[rag.retrieve] embed error: {e}; falling back to BM25-only")

    # Over-fetch for the hybrid merge then trim
    over_k = min(top_k * 3, len(rows))

    vec_results: list[dict] = []
    if q_vec:
        # Try LlamaIndex first (when available), then fall back to cosine
        if LLAMAINDEX_AVAILABLE:
            vec_results = _llama_retrieve(query, rows, over_k, q_vec)

        if not vec_results:
            # Pure cosine fallback
            scored_vec = []
            for r in rows:
                try:
                    raw_emb = r.get("embedding")
                    if raw_emb is None:
                        continue
                    doc_vec = json.loads(raw_emb) if isinstance(raw_emb, str) else raw_emb
                    s = _cosine(q_vec, doc_vec)
                    scored_vec.append((s, r))
                except Exception:
                    continue
            scored_vec.sort(key=lambda x: x[0], reverse=True)
            vec_results = [
                {
                    "title":    r.get("title", ""),
                    "url":      r.get("el_url", ""),
                    "repo":     r.get("repo", ""),
                    "content":  (r.get("chunk_text") or "")[:900],
                    "score":    round(s, 3),
                    "page":     r.get("page_number"),
                    "section":  r.get("section_title") or "",
                    "filename": r.get("doc_filename") or "",
                    "source":   r.get("doc_source") or "markdown",
                }
                for s, r in scored_vec[:over_k]
                if s >= min_score
            ]

    if not vec_results and not hybrid:
        return _lexical_fallback(query, rows, top_k)

    # ── BM25 leg ──────────────────────────────────────────────────────────────
    bm25_results: list[dict] = []
    if hybrid:
        try:
            corpus  = _build_bm25_corpus(rows)
            bm25_sc = _bm25_scores(query, corpus)
            idx_sc  = sorted(enumerate(bm25_sc), key=lambda x: x[1], reverse=True)
            for rank, (idx, sc) in enumerate(idx_sc[:over_k]):
                if sc <= 0:
                    break
                r = rows[idx]
                bm25_results.append({
                    "title":    r.get("title", ""),
                    "url":      r.get("el_url", ""),
                    "repo":     r.get("repo", ""),
                    "content":  (r.get("chunk_text") or "")[:900],
                    "score":    round(sc, 3),
                    "page":     r.get("page_number"),
                    "section":  r.get("section_title") or "",
                    "filename": r.get("doc_filename") or "",
                    "source":   r.get("doc_source") or "markdown",
                    "_bm25_rank": rank,
                })
        except Exception as e:
            print(f"[rag.retrieve] BM25 error: {e}")

    if not vec_results and not bm25_results:
        return _lexical_fallback(query, rows, top_k)

    # ── Reciprocal Rank Fusion ─────────────────────────────────────────────────
    # RRF score = Σ 1 / (k + rank)  where k=60 (standard)
    rrf_k = 60
    rrf: dict[str, dict] = {}   # content_key → doc

    def _rrf_key(doc: dict) -> str:
        return (doc.get("title") or "") + "||" + (doc.get("content") or "")[:100]

    for rank, doc in enumerate(vec_results):
        key = _rrf_key(doc)
        if key not in rrf:
            rrf[key] = {**doc, "_rrf": 0.0}
        rrf[key]["_rrf"] += 1.0 / (rrf_k + rank)

    for rank, doc in enumerate(bm25_results):
        key = _rrf_key(doc)
        if key not in rrf:
            rrf[key] = {**doc, "_rrf": 0.0}
        rrf[key]["_rrf"] += 1.0 / (rrf_k + rank)

    fused = sorted(rrf.values(), key=lambda x: x["_rrf"], reverse=True)[:top_k]
    # Clean internal keys
    for doc in fused:
        doc.pop("_rrf", None)
        doc.pop("_bm25_rank", None)
    return fused


def _lexical_fallback(query, rows, top_k):
    """Cheap keyword overlap ranking when embeddings are unavailable."""
    terms = {w for w in re.split(r"\W+", query.lower()) if len(w) > 3}
    scored = []
    for r in rows:
        text = (r["chunk_text"] or "").lower()
        overlap = sum(1 for t in terms if t in text)
        if overlap:
            scored.append((overlap, r))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [
        {"title": r["title"], "url": r["el_url"], "repo": r["repo"],
         "content": (r["chunk_text"] or "")[:900], "score": 0.0}
        for _, r in scored[:top_k]
    ]


# ══════════════════════════════════════════════════════════════════════════════
# GENERAL RAG PIPELINE  (5 LangGraph steps)
# ══════════════════════════════════════════════════════════════════════════════

REWRITE_SYSTEM = """You are a search query optimizer for Adobe Experience Platform documentation.
Rewrite the user's query to be more specific and retrieval-friendly.
Output ONLY the rewritten query — no explanation, no quotes, no preamble.

Rules:
- Expand abbreviations (AEP, RTCDP, CJA, AJO, AA)
- Add relevant technical context
- Keep it under 15 words
- Preserve the original intent
"""


def step_rewrite_query(state: dict) -> dict:
    raw_query = state.get("query", "")
    try:
        rewritten = groq_call(
            [{"role": "user", "content": raw_query}], REWRITE_SYSTEM, max_tokens=50
        ).strip()
    except Exception:
        rewritten = raw_query
    return {**state, "rewritten_query": rewritten or raw_query}


def step_retrieve(state: dict) -> dict:
    query = state.get("rewritten_query") or state.get("query", "")
    # retrieve() lazily loads a fastembed embedding model on first use and can
    # stall against a degraded vector store — same cold-start hang class fixed
    # in capstone.py's node_retrieve. Bounded here so a single slow retrieval
    # can't hang this endpoint indefinitely; an empty result still lets the
    # answer step run (ungrounded) instead of the whole request timing out.
    docs = run_with_timeout(
        retrieve, query,
        track=state.get("track"),
        top_k=state.get("top_k", RAG_TOP_K + 4),  # over-fetch, rerank trims
        module_title=state.get("module_title"),
        timeout=8.0, default=[], on_timeout_log="rag step_retrieve",
    ) or []
    return {**state, "retrieved_docs": docs}


RERANK_SYSTEM = """You are ranking retrieved documents for relevance.
Given a query and documents, score each document 0-6.
Respond ONLY with a JSON array of scores in the same order as the documents.
Example: [5, 2, 6, 0, 3]

Scoring:
  6   = directly answers the query with specific AEP details
  4-5 = relevant context, partial answer
  2-3 = related topic, indirect relevance
  0-1 = not relevant
"""


def step_rerank(state: dict) -> dict:
    query = state.get("rewritten_query") or state.get("query", "")
    docs = state.get("retrieved_docs", [])
    if not docs:
        return {**state, "reranked_docs": []}

    doc_list = "\n\n".join(f"[{i}] {d['content'][:300]}" for i, d in enumerate(docs))
    try:
        raw = groq_call(
            [{"role": "user", "content": f"Query: {query}\n\nDocuments:\n{doc_list}"}],
            RERANK_SYSTEM, max_tokens=100,
        )
        m = re.search(r"\[[\d,\s]+\]", raw)
        scores = json.loads(m.group()) if m else [3] * len(docs)
    except Exception:
        scores = [3] * len(docs)

    scored = sorted(
        ({"doc": d, "s": scores[i] if i < len(scores) else 0} for i, d in enumerate(docs)),
        key=lambda x: x["s"], reverse=True,
    )
    reranked = [x["doc"] for x in scored if x["s"] >= 3][:RAG_TOP_K]
    return {**state, "reranked_docs": reranked}


ANSWER_SYSTEM = """You are a senior Adobe Experience Platform Solutions Architect.
Answer the learner's question using ONLY the provided documentation excerpts.
Cite each factual claim with [Doc N] where N is the document number.

Rules:
- Only use information from the provided documents
- If the documents don't contain the answer, say so clearly
- Be specific and technical — this is for AEP practitioners
- Keep the answer under 300 words
- End with a list of citations
"""


def step_generate_answer(state: dict) -> dict:
    query = state.get("query", "")
    docs = state.get("reranked_docs", [])
    if not docs:
        return {
            **state,
            "answer": ("I couldn't find relevant documentation for this query. "
                       "Try rephrasing, or the module index may not be built yet."),
            "citations": [],
        }
    ctx = "\n\n".join(f"[Doc {i+1}] {d['content'][:500]}" for i, d in enumerate(docs))
    try:
        answer = groq_call(
            [{"role": "user", "content": f"Question: {query}\n\nDocumentation:\n{ctx}"}],
            ANSWER_SYSTEM, max_tokens=500,
        )
    except Exception as e:
        answer = f"Answer generation failed: {e}"

    citations = [
        {"index": i + 1, "title": d.get("title", f"Document {i+1}"),
         "url": d.get("url", ""), "excerpt": (d["content"][:150] + "...")}
        for i, d in enumerate(docs)
    ]
    return {**state, "answer": answer, "citations": citations}


GUARD_SYSTEM = """You are a hallucination detector for AEP learning content.
Given an answer and the source documents used to generate it, determine if the
answer contains any claims NOT supported by the documents.

Respond ONLY with valid JSON:
{"grounded": true/false, "ungrounded_claims": ["..."], "confidence": 0.0-1.0}
"""


def step_guard(state: dict) -> dict:
    answer = state.get("answer", "")
    docs = state.get("reranked_docs", [])
    if not docs or not answer:
        return {**state, "grounded": True, "guard_result": {}}
    docs_text = " ".join(d["content"][:300] for d in docs)
    try:
        raw = groq_call(
            [{"role": "user", "content": f"Answer:\n{answer}\n\nSource documents:\n{docs_text}"}],
            GUARD_SYSTEM, max_tokens=200,
        )
        result = parse_json_lenient(raw)
    except Exception:
        result = {"grounded": True, "ungrounded_claims": [], "confidence": 0.8}

    grounded = result.get("grounded", True)
    final = answer
    if not grounded:
        final = (answer + "\n\n⚠️ Note: some claims could not be fully verified "
                 "against the retrieved documentation. Please cross-check the "
                 "official AEP docs.")
    return {**state, "answer": final, "grounded": grounded, "guard_result": result}


def build_rag_graph():
    if not LANGGRAPH_AVAILABLE:
        return None
    g = StateGraph(dict)
    g.add_node("rewrite",  step_rewrite_query)
    g.add_node("retrieve", step_retrieve)
    g.add_node("rerank",   step_rerank)
    g.add_node("answer",   step_generate_answer)
    g.add_node("guard",    step_guard)
    g.set_entry_point("rewrite")
    g.add_edge("rewrite",  "retrieve")
    g.add_edge("retrieve", "rerank")
    g.add_edge("rerank",   "answer")
    g.add_edge("answer",   "guard")
    g.add_edge("guard",    END)
    return g.compile()


def run_rag(query: str, track: str = None, module_title: str = None, graph=None) -> dict:
    """
    Full general RAG pipeline. `track`/`module_title` narrow retrieval when the
    caller knows the context (e.g. reasoning agent passes the learner's track).
    """
    set_current_agent("RAG")
    start = time.time()
    state = {"query": query, "track": track, "module_title": module_title}

    if graph is not None:
        try:
            final = graph.invoke(state)
        except Exception as e:
            print(f"[rag] graph error: {e}, running inline")
            graph = None
    if graph is None:
        state = step_rewrite_query(state)
        state = step_retrieve(state)
        state = step_rerank(state)
        state = step_generate_answer(state)
        state = step_guard(state)
        final = state

    # RAGAS scoring (faithfulness/answer_relevancy/context_precision) — fire-
    # and-forget, never blocks or affects this response. Only meaningful when
    # something was actually retrieved; skip entirely on an empty/ungrounded run.
    reranked = final.get("reranked_docs") or final.get("retrieved_docs") or []
    if reranked:
        try:
            from evaluation import evaluate_and_log
            evaluate_and_log("rag", query, final.get("answer", ""),
                              [d.get("content", "") for d in reranked])
        except Exception:
            pass

    return {
        "answer":            final.get("answer", ""),
        "citations":         final.get("citations", []),
        "rewritten_query":   final.get("rewritten_query", query),
        "grounded":          final.get("grounded", True),
        "docs_retrieved":    len(final.get("retrieved_docs", [])),
        "docs_after_rerank": len(final.get("reranked_docs", [])),
        "meta": {
            "type":              "agent",
            "name":              "rag",
            "engine":            "langgraph" if LANGGRAPH_AVAILABLE else "sequential",
            "index":             ("pgvector" if _vstore.is_available()
                                  else "llama_index" if LLAMAINDEX_AVAILABLE else "fastembed"),
            "model":             GROQ_MODEL,
            "steps_executed":    5,
            "latency_ms":        round((time.time() - start) * 1000),
            "docs_retrieved":    len(final.get("retrieved_docs", [])),
            "docs_after_rerank": len(final.get("reranked_docs", [])),
            "grounded":          final.get("grounded", True),
        },
    }