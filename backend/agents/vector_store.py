"""
vector_store.py — Persistent pgvector-backed index for the shared RAG retriever
===============================================================================
This is the "index behind the retriever". Nothing about the agents changes:
`agents/rag.py` still exposes `retrieve()` / `run_rag()` with the same signatures
and return shape. What changes is where the vector leg gets its results.

Before: every `retrieve()` call `SELECT`ed the ENTIRE `doc_embeddings` table into
Python, built an in-memory LlamaIndex `VectorStoreIndex` (with `embed_model=None`,
embeddings pre-injected onto nodes), and computed cosine in pure Python — the whole
corpus, per query.

Now: LlamaIndex is given
  1. a REAL embed model — fastembed `BAAI/bge-small-en-v1.5` via `FastEmbedEmbedding`
     (used to embed the *query* at retrieval time), and
  2. a PERSISTENT vector store — `PGVectorStore` (pgvector) living in the SAME
     Postgres. Top-k ANN search is pushed into SQL (`ORDER BY embedding <=> q`),
     so a query never loads more than `top_k` rows into memory.

The abstraction is deliberately load-bearing: it is the seam we swap when the
corpus outgrows a single box (a different backing store, an HNSW tuning, a managed
vector DB) without touching a single agent.

Everything here is guarded. If the pgvector packages, the `vector` extension, or
the store are unavailable, `is_available()` returns False and `agents/rag.py`
transparently falls back to its legacy in-memory cosine path. The app always boots.

Storage note: the LlamaIndex-managed table is `data_<PGVECTOR_TABLE>` (default
`data_nexus_docs`). The original `doc_embeddings` table is kept as the source of
truth and as the corpus for the lexical (Postgres full-text) leg.
"""

from __future__ import annotations

import json
import threading

from .config import (
    get_db_url, RAG_EMBED_MODEL, RAG_EMBED_DIM,
    PGVECTOR_ENABLE, PGVECTOR_TABLE, PGVECTOR_HNSW,
)

# ── Lazy import probe ─────────────────────────────────────────────────────────
# Heavy deps (fastembed, pgvector, sqlalchemy) are imported on first use, not at
# module import, so the FastAPI process still boots fast when RAG is idle.
_IMPORTS_OK: bool | None = None      # None = not yet probed
_IMPORT_ERROR: Exception | None = None

_lock = threading.Lock()
_embed_model = None
_vector_store = None
_index = None
_degraded = False                    # flipped True after any hard runtime failure
_last_error: Exception | None = None


def _probe_imports() -> bool:
    """Try importing the pgvector stack once; cache the result."""
    global _IMPORTS_OK, _IMPORT_ERROR
    if _IMPORTS_OK is not None:
        return _IMPORTS_OK
    try:
        from llama_index.core import VectorStoreIndex            # noqa: F401
        from llama_index.core.schema import TextNode             # noqa: F401
        from llama_index.vector_stores.postgres import PGVectorStore  # noqa: F401
        from llama_index.embeddings.fastembed import FastEmbedEmbedding  # noqa: F401
        from sqlalchemy.engine import make_url                   # noqa: F401
        _IMPORTS_OK = True
    except Exception as e:                                       # noqa: BLE001
        _IMPORTS_OK = False
        _IMPORT_ERROR = e
    return _IMPORTS_OK


def _mark_degraded(err: Exception) -> None:
    """Record a hard failure so we stop retrying the pgvector path this process."""
    global _degraded, _last_error
    if not _degraded:
        print(f"[vector_store] disabling pgvector path (falling back to in-memory cosine): {err}")
    _degraded = True
    _last_error = err


def is_available() -> bool:
    """True when the pgvector path should be used. Cheap; safe to call per query."""
    if not PGVECTOR_ENABLE or _degraded:
        return False
    return _probe_imports()


def last_error() -> Exception | None:
    return _last_error or _IMPORT_ERROR


def table_name() -> str:
    """The physical LlamaIndex-managed table (PGVectorStore prefixes with data_)."""
    return f"data_{PGVECTOR_TABLE}"


# ── DB params (parsed from DATABASE_URL — never hardcoded) ─────────────────────
def _db_params() -> dict:
    from sqlalchemy.engine import make_url
    url = make_url(get_db_url())        # raises via get_db_url() if unset
    return {
        "host":     url.host or "localhost",
        "port":     url.port or 5432,
        "database": url.database,
        "user":     url.username,
        "password": url.password,
    }


def _hnsw_kwargs():
    if not PGVECTOR_HNSW:
        return None
    # Cosine distance to match the query embeddings' space (bge is cosine-normalised).
    return {
        "hnsw_m":               16,
        "hnsw_ef_construction": 64,
        "hnsw_ef_search":       40,
        "hnsw_dist_method":     "vector_cosine_ops",
    }


# ── Singletons ────────────────────────────────────────────────────────────────
def get_embed_model():
    """The REAL embed model LlamaIndex uses to embed queries at retrieval time."""
    global _embed_model
    if _embed_model is None:
        with _lock:
            if _embed_model is None:
                from llama_index.embeddings.fastembed import FastEmbedEmbedding
                _embed_model = FastEmbedEmbedding(model_name=RAG_EMBED_MODEL)
    return _embed_model


def get_vector_store(perform_setup: bool = True):
    """Persistent PGVectorStore. `perform_setup` lets it create the extension/table
    lazily on first use. Returns a cached singleton."""
    global _vector_store
    if _vector_store is None:
        with _lock:
            if _vector_store is None:
                from llama_index.vector_stores.postgres import PGVectorStore
                p = _db_params()
                _vector_store = PGVectorStore.from_params(
                    host=p["host"], port=p["port"], database=p["database"],
                    user=p["user"], password=p["password"],
                    table_name=PGVECTOR_TABLE,
                    embed_dim=RAG_EMBED_DIM,
                    hnsw_kwargs=_hnsw_kwargs(),
                    perform_setup=perform_setup,
                )
    return _vector_store


def get_index():
    """VectorStoreIndex bound to the persistent store + the real embed model."""
    global _index
    if _index is None:
        with _lock:
            if _index is None:
                from llama_index.core import VectorStoreIndex
                _index = VectorStoreIndex.from_vector_store(
                    get_vector_store(), embed_model=get_embed_model(),
                )
    return _index


# ── Retrieval ─────────────────────────────────────────────────────────────────
def vector_retrieve(query: str, track: str | None = None,
                    module_title: str | None = None,
                    top_k: int = 12, min_score: float = 0.0) -> list[dict] | None:
    """
    Top-k semantic retrieval served by pgvector (ANN search runs in Postgres).

    Returns a list of doc dicts in the exact shape `agents/rag.py` expects, or
    None on a hard failure (caller then uses the legacy in-memory path). An empty
    list means "queried fine, no matches" and is NOT a failure.

    `track` is applied as a metadata filter in SQL. `module_title` is applied as a
    post-filter on the small returned set (never a full-corpus scan).
    """
    if not is_available():
        return None
    try:
        from llama_index.core.vector_stores.types import (
            MetadataFilters, MetadataFilter, FilterOperator,
        )
        index = get_index()
        filters = None
        if track:
            filters = MetadataFilters(filters=[
                MetadataFilter(key="track", value=track, operator=FilterOperator.EQ),
            ])
        retriever = index.as_retriever(similarity_top_k=top_k, filters=filters)
        nodes = retriever.retrieve(query)   # embeds the query with the real model
    except Exception as e:                  # noqa: BLE001 — degrade, don't crash the request
        _mark_degraded(e)
        return None

    results: list[dict] = []
    mt = (module_title or "").lower()
    for n in nodes:
        node = getattr(n, "node", n)
        md = dict(getattr(node, "metadata", {}) or {})
        score = float(n.score) if getattr(n, "score", None) is not None else 0.0
        if score < min_score:
            continue
        title = md.get("title") or ""
        if mt and mt not in title.lower():
            continue
        try:
            text = node.get_content() or ""
        except Exception:
            text = getattr(node, "text", "") or ""
        results.append({
            "title":    title,
            "url":      md.get("url") or "",
            "repo":     md.get("repo") or "",
            "content":  text[:900],
            "score":    round(score, 3),
            "page":     md.get("page"),
            "section":  md.get("section") or "",
            "filename": md.get("filename") or "",
            "source":   md.get("source") or "markdown",
        })
    return results


# ── Ingestion / migration helpers ─────────────────────────────────────────────
def build_nodes_from_rows(rows: list[dict]) -> list:
    """
    Turn `doc_embeddings`-shaped rows into LlamaIndex TextNodes carrying their
    PRE-COMPUTED embeddings. Because each node already has `.embedding`, adding
    them to the store does NOT re-embed — the migration is a straight copy.
    Rows without a usable embedding are skipped (pgvector needs a vector).
    """
    from llama_index.core.schema import TextNode
    nodes = []
    for r in rows:
        raw = r.get("embedding")
        emb = None
        try:
            if raw:
                emb = json.loads(raw) if isinstance(raw, str) else list(raw)
        except Exception:
            emb = None
        if not emb:
            continue
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
            # Keep these out of what the embed model would ever see (moot here —
            # we never re-embed — but correct hygiene for LlamaIndex nodes).
            excluded_embed_metadata_keys=["url", "repo", "track", "page",
                                          "section", "filename", "source"],
            excluded_llm_metadata_keys=["url", "repo", "page", "filename", "source"],
        )
        node.embedding = emb
        nodes.append(node)
    return nodes


def add_rows(rows: list[dict]) -> int:
    """Add `doc_embeddings`-shaped rows to the persistent store. Returns #added.
    Best-effort: returns 0 and marks degraded on failure (keeps ingestion alive)."""
    if not is_available():
        return 0
    try:
        nodes = build_nodes_from_rows(rows)
        if not nodes:
            return 0
        get_vector_store().add(nodes)
        return len(nodes)
    except Exception as e:                  # noqa: BLE001
        _mark_degraded(e)
        return 0


def reset_store() -> None:
    """Empty the LlamaIndex-managed table so a full rebuild starts clean.
    Best-effort: silently no-ops if the table does not exist yet."""
    import psycopg2
    from psycopg2 import sql
    conn = psycopg2.connect(get_db_url())
    conn.autocommit = True
    try:
        with conn.cursor() as c:
            # Identifier is a fixed, config-derived name — quoted via psycopg2.sql,
            # never string-formatted from user input.
            c.execute(sql.SQL("TRUNCATE TABLE {}").format(
                sql.Identifier(table_name())))
    except Exception:
        # Table not created yet (first run) — the next add() will create it.
        pass
    finally:
        conn.close()


def store_count() -> int:
    """Number of vectors currently persisted. -1 if the table is absent/unreadable."""
    import psycopg2
    from psycopg2 import sql
    conn = psycopg2.connect(get_db_url())
    try:
        with conn.cursor() as c:
            c.execute(sql.SQL("SELECT COUNT(*) FROM {}").format(
                sql.Identifier(table_name())))
            return int(c.fetchone()[0])
    except Exception:
        return -1
    finally:
        conn.close()


def _iter_doc_embeddings(batch_size: int = 256):
    """Yield doc_embeddings rows in batches. Used by the sync/migration only, so
    the per-query hot path is never involved. Falls back to base columns when the
    PDF-metadata columns are absent."""
    import psycopg2
    import psycopg2.extras
    conn = psycopg2.connect(get_db_url())
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as c:
            try:
                c.execute(
                    "SELECT title, repo, el_url, track, chunk_text, embedding, "
                    "page_number, section_title, doc_source, doc_filename "
                    "FROM doc_embeddings")
            except Exception:
                conn.rollback()
                c.execute(
                    "SELECT title, repo, el_url, track, chunk_text, embedding "
                    "FROM doc_embeddings")
            while True:
                batch = c.fetchmany(batch_size)
                if not batch:
                    break
                yield [dict(r) for r in batch]
    finally:
        conn.close()


def sync_from_doc_embeddings(reset: bool = True, verbose: bool = False) -> dict:
    """
    One-shot migration/refresh: copy every embedded row from `doc_embeddings` into
    the persistent pgvector store WITHOUT re-embedding (each node carries its
    stored vector). Streams in batches. Returns a summary dict.

    Called by migrate_to_pgvector.py and by build_embeddings_index.py after a
    full rebuild, so the two stores never drift.
    """
    if not is_available():
        return {"ok": False, "reason": str(last_error() or "pgvector unavailable"),
                "added": 0}
    if reset:
        reset_store()
    added, scanned = 0, 0
    try:
        for batch in _iter_doc_embeddings():
            scanned += len(batch)
            added += add_rows(batch)
            if verbose:
                print(f"  ...{added}/{scanned} vectors")
    except Exception as e:                  # noqa: BLE001
        _mark_degraded(e)
        return {"ok": False, "reason": str(e), "added": added, "scanned": scanned}
    return {"ok": True, "added": added, "scanned": scanned, "table": table_name()}
