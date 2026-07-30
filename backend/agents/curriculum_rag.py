"""
curriculum_rag.py — Restricted RAG (module-scoped) for quiz grounding
======================================================================
The shared retriever in rag.py answers open questions across the whole corpus.
Quiz generation needs the OPPOSITE: a tightly-scoped, high-precision view of a
SINGLE module's material, so that generated questions test what the learner was
actually taught — never general trivia and never content from other modules.

This is the "more restricted RAG" the spec asks for. It is deliberately thin:
it reuses the shared embedding model + cosine scoring from rag.py, but forces a
title/track scope and returns a compact grounding pack rather than an answer.

Because it reads live from doc_embeddings on every call, any documents newly
added by build_embeddings_index.py are picked up automatically — no restart,
no cache to invalidate (dynamic updates requirement).
"""

import os
from concurrent.futures import ThreadPoolExecutor, TimeoutError as _FTimeout

from .config import RAG_MIN_SCORE
from . import rag as shared_rag

try:
    import llama_index  # noqa: F401
    LLAMAINDEX_AVAILABLE = True
except Exception:
    LLAMAINDEX_AVAILABLE = False


# Restricted retrieval is stricter than the shared default: we raise the cosine
# floor a little so quiz questions are only grounded in strong matches.
RESTRICTED_MIN_SCORE = max(RAG_MIN_SCORE, 0.30)

# Quiz generation must never HANG waiting on retrieval. Grounding is a best-effort
# quality boost, not a hard dependency — if the embeddings index is empty, the
# embedding model is cold, or a vector query stalls, we time out and generate an
# ungrounded quiz (the caller already handles grounded=False). Without this, a
# slow/degraded retrieval blocked /api/curriculum/quiz/start indefinitely, which
# surfaced to the learner as "Backend unavailable".
GROUNDING_TIMEOUT_SEC = float(os.getenv("QUIZ_GROUNDING_TIMEOUT_SEC", "8"))
_GROUNDING_POOL = ThreadPoolExecutor(max_workers=2)


def retrieve_module_context(module_title: str, track: str = None,
                            topic: str = None, top_k: int = 6):
    """
    Retrieve chunks scoped to ONE module.

    Precedence of the retrieval query:
        topic (if given) > module_title
    Scope filters applied to the corpus:
        track (if given) AND title ILIKE module_title
    """
    query = (topic or module_title or "").strip()
    if not query:
        return []

    def _do_retrieve():
        docs = shared_rag.retrieve(
            query,
            track=track,
            top_k=top_k,
            module_title=module_title or None,
            min_score=RESTRICTED_MIN_SCORE,
        )
        # If the strict title scope was too tight (nothing indexed under that
        # exact title), widen to track-only so quiz gen still has *some*
        # grounding.
        if not docs:
            docs = shared_rag.retrieve(
                query, track=track, top_k=top_k, min_score=RESTRICTED_MIN_SCORE
            )
        return docs

    # Hard time-bound: retrieval must never hang quiz generation (see note above).
    try:
        return _GROUNDING_POOL.submit(_do_retrieve).result(timeout=GROUNDING_TIMEOUT_SEC)
    except _FTimeout:
        print(f"[curriculum_rag] grounding retrieval timed out after {GROUNDING_TIMEOUT_SEC}s — generating ungrounded")
        return []
    except Exception as e:
        print(f"[curriculum_rag] grounding retrieval error ({e}) — generating ungrounded")
        return []


def build_grounding_pack(module_title: str, track: str = None,
                         topic: str = None, max_chars: int = 3500) -> dict:
    """
    Build the context block fed to the quiz generator.

    Returns:
        {
          "context":  concatenated, trimmed source text (or "" if none),
          "sources":  [{title, url, score}],
          "grounded": bool  — True if real module docs were found
        }

    When `grounded` is False the caller still generates a quiz, but flags it as
    ungrounded so the UI/telemetry can show that the module index was empty.
    """
    docs = retrieve_module_context(module_title, track=track, topic=topic)
    if not docs:
        return {"context": "", "sources": [], "grounded": False}

    blocks, sources, used = [], [], 0
    for i, d in enumerate(docs):
        chunk = (d.get("content") or "").strip()
        if not chunk:
            continue
        piece = f"[Source {i+1}: {d.get('title','')}]\n{chunk}"
        if used + len(piece) > max_chars:
            piece = piece[: max(0, max_chars - used)]
        blocks.append(piece)
        sources.append({
            "title": d.get("title", ""),
            "url":   d.get("url", ""),
            "score": d.get("score", 0.0),
        })
        used += len(piece)
        if used >= max_chars:
            break

    return {
        "context":  "\n\n".join(blocks),
        "sources":  sources,
        "grounded": True,
    }
