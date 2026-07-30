"""
rag/pdf_ingestion.py — PDF ingestion for the advanced RAG pipeline
==================================================================
Parses PDFs (local files or uploaded bytes) using pypdf, extracts clean text
with page numbers and section headings, chunks with overlap, generates embeddings,
and stores everything in doc_embeddings. Uses the SAME schema as
build_embeddings_index.py so both Markdown and PDF content live in one table.

Extra columns written (via ALTER TABLE IF NOT EXISTS in main.py startup or here):
  page_number    INT
  section_title  VARCHAR(255)
  doc_source     VARCHAR(50)   -- "pdf" | "markdown"
  doc_filename   VARCHAR(255)

Public API
----------
  ingest_pdf(path_or_bytes, *, track, filename, module_title, overwrite=False)
      → {ok, chunks_written, skipped, filename, track}

  list_pdf_docs(track=None) → [{filename, track, chunk_count, last_updated}]
"""

from __future__ import annotations

import io
import json
import re
import time
import hashlib
from pathlib import Path
from typing import Union

# ── Config from agents/config (reuse existing settings) ───────────────────────
import sys
import os
sys.path.insert(0, str(Path(__file__).parent.parent))

from agents.config import get_db_url, RAG_EMBED_MODEL

CHUNK_WORDS   = 350
CHUNK_OVERLAP = 60

# ── Embedding (reuse same lazy model as agents/rag.py) ────────────────────────
_embedding_model = None

def _get_embed_model():
    global _embedding_model
    if _embedding_model is None:
        try:
            from fastembed import TextEmbedding
            _embedding_model = TextEmbedding(model_name=RAG_EMBED_MODEL)
        except Exception as e:
            print(f"[pdf_ingestion] fastembed unavailable: {e}")
    return _embedding_model


def _embed_texts(texts: list[str]) -> list[list[float]]:
    model = _get_embed_model()
    if model is None:
        return [[] for _ in texts]
    try:
        return [list(v) for v in model.embed(texts)]
    except Exception as e:
        print(f"[pdf_ingestion] embed error: {e}")
        return [[] for _ in texts]


# ── Ensure extra columns exist ────────────────────────────────────────────────

def _ensure_columns():
    """Add page_number / section_title / doc_source / doc_filename if absent."""
    import psycopg2
    conn = psycopg2.connect(get_db_url())
    conn.autocommit = True
    with conn.cursor() as c:
        for stmt in [
            "ALTER TABLE doc_embeddings ADD COLUMN IF NOT EXISTS page_number INT",
            "ALTER TABLE doc_embeddings ADD COLUMN IF NOT EXISTS section_title VARCHAR(255)",
            "ALTER TABLE doc_embeddings ADD COLUMN IF NOT EXISTS doc_source VARCHAR(50) DEFAULT 'markdown'",
            "ALTER TABLE doc_embeddings ADD COLUMN IF NOT EXISTS doc_filename VARCHAR(255)",
            # GIN index for the shared retriever's Postgres full-text (lexical) leg.
            "CREATE INDEX IF NOT EXISTS doc_embeddings_fts_idx "
            "ON doc_embeddings USING GIN (to_tsvector('english', chunk_text))",
        ]:
            c.execute(stmt)
    conn.close()


# ── PDF text extraction ────────────────────────────────────────────────────────

def _extract_pdf_pages(source: Union[str, bytes, Path]) -> list[dict]:
    """
    Returns [{page_num (1-based), text, section_title}] for every page.
    section_title is detected from lines that look like headings.
    """
    try:
        import pypdf
    except ImportError as e:
        raise RuntimeError("pypdf is required for PDF ingestion. Run: pip install pypdf") from e

    if isinstance(source, (str, Path)):
        reader = pypdf.PdfReader(str(source))
    else:
        reader = pypdf.PdfReader(io.BytesIO(source))

    pages = []
    current_section = ""

    for page_num, page in enumerate(reader.pages, start=1):
        raw = page.extract_text() or ""
        # Detect section headings: lines that are short (< 80 chars), ALL-CAPS or
        # Title Case, with no sentence-ending punctuation.
        lines = raw.split("\n")
        clean_lines = []
        for line in lines:
            stripped = line.strip()
            if not stripped:
                continue
            # Heading heuristic
            if (
                len(stripped) < 80
                and stripped == stripped.title()
                and not stripped.endswith((".", ",", ";", ":"))
                and len(stripped.split()) >= 2
            ):
                current_section = stripped
            # Remove hyphenation artifacts at line ends
            if stripped.endswith("-") and len(stripped) > 2:
                clean_lines.append(stripped[:-1])
            else:
                clean_lines.append(stripped + " ")

        text = " ".join(clean_lines)
        text = re.sub(r"\s{2,}", " ", text).strip()
        # Skip pages with less than 50 chars of real content
        if len(text) < 50:
            continue
        pages.append({
            "page_num":      page_num,
            "text":          text,
            "section_title": current_section,
        })

    return pages


# ── Chunking ──────────────────────────────────────────────────────────────────

def _chunk_page(
    text: str,
    page_num: int,
    section_title: str,
    chunk_words: int = CHUNK_WORDS,
    overlap: int = CHUNK_OVERLAP,
) -> list[dict]:
    words = text.split()
    if len(words) <= chunk_words:
        return [{"text": text, "page_num": page_num, "section_title": section_title}]

    chunks = []
    i = 0
    while i < len(words):
        chunk_text = " ".join(words[i : i + chunk_words])
        if len(chunk_text.strip()) > 80:
            chunks.append({
                "text":          chunk_text,
                "page_num":      page_num,
                "section_title": section_title,
            })
        i += chunk_words - overlap
    return chunks


def _build_chunks(pages: list[dict]) -> list[dict]:
    chunks = []
    for pg in pages:
        chunks.extend(_chunk_page(pg["text"], pg["page_num"], pg["section_title"]))
    return chunks


# ── Deduplication ─────────────────────────────────────────────────────────────

def _content_hash(text: str) -> str:
    return hashlib.md5(text.encode()).hexdigest()


def _existing_hashes(filename: str) -> set[str]:
    """Load MD5 hashes of chunks already stored for this filename."""
    import psycopg2
    import psycopg2.extras
    try:
        conn = psycopg2.connect(get_db_url())
        with conn.cursor() as c:
            c.execute(
                "SELECT chunk_text FROM doc_embeddings WHERE doc_filename=%s",
                (filename,),
            )
            return {_content_hash(r[0]) for r in c.fetchall() if r[0]}
    except Exception:
        return set()
    finally:
        conn.close()


# ── Database write ────────────────────────────────────────────────────────────

def _write_chunks(
    chunks: list[dict],
    *,
    filename: str,
    track: str,
    module_title: str,
    overwrite: bool,
) -> dict:
    import psycopg2
    import psycopg2.extras

    if overwrite:
        # Delete existing rows for this filename before re-inserting
        conn = psycopg2.connect(get_db_url())
        conn.autocommit = True
        with conn.cursor() as c:
            c.execute("DELETE FROM doc_embeddings WHERE doc_filename=%s", (filename,))
        conn.close()
        existing_hashes: set[str] = set()
    else:
        existing_hashes = _existing_hashes(filename)

    new_chunks = [c for c in chunks if _content_hash(c["text"]) not in existing_hashes]

    if not new_chunks:
        return {"chunks_written": 0, "skipped": len(chunks)}

    # Generate embeddings in one batch
    texts     = [c["text"] for c in new_chunks]
    embeddings = _embed_texts(texts)

    conn = psycopg2.connect(get_db_url())
    conn.autocommit = True
    written = 0
    with conn.cursor() as cur:
        for chunk, emb in zip(new_chunks, embeddings):
            try:
                cur.execute(
                    """INSERT INTO doc_embeddings
                       (repo, file_path, el_url, title, track,
                        chunk_index, chunk_text, embedding,
                        page_number, section_title, doc_source, doc_filename)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                       ON CONFLICT DO NOTHING""",
                    (
                        "pdf_upload",
                        filename,
                        "",
                        module_title or filename,
                        track,
                        written,
                        chunk["text"],
                        json.dumps(emb) if emb else None,
                        chunk["page_num"],
                        chunk["section_title"] or "",
                        "pdf",
                        filename,
                    ),
                )
                written += 1
            except Exception as e:
                print(f"[pdf_ingestion] write error (chunk {written}): {e}")
    conn.close()

    # Mirror the newly-written chunks into the persistent pgvector store so the
    # shared retriever's vector leg sees them without a whole-corpus reload.
    # Guarded: silently skipped if pgvector isn't configured. Reuses the stored
    # embeddings (no re-embedding). On overwrite, the pgvector table may retain
    # stale rows for this filename until the next `python migrate_to_pgvector.py`.
    try:
        from agents import vector_store as vstore
        if vstore.is_available():
            rows_for_vec = [
                {
                    "title":         module_title or filename,
                    "el_url":        "",
                    "repo":          "pdf_upload",
                    "track":         track,
                    "chunk_text":    chunk["text"],
                    "embedding":     emb,
                    "page_number":   chunk["page_num"],
                    "section_title": chunk["section_title"] or "",
                    "doc_source":    "pdf",
                    "doc_filename":  filename,
                }
                for chunk, emb in zip(new_chunks, embeddings) if emb
            ]
            if rows_for_vec:
                vstore.add_rows(rows_for_vec)
    except Exception as e:
        print(f"[pdf_ingestion] pgvector sync skipped: {e}")

    return {"chunks_written": written, "skipped": len(chunks) - len(new_chunks)}


# ── Public API ────────────────────────────────────────────────────────────────

def ingest_pdf(
    source: Union[str, bytes, Path],
    *,
    track: str = "rtcdp",
    filename: str = "document.pdf",
    module_title: str = "",
    overwrite: bool = False,
) -> dict:
    """
    Full pipeline: parse → chunk → embed → store.
    Returns {ok, chunks_written, skipped, filename, track, pages_processed}.
    """
    start = time.time()
    try:
        _ensure_columns()
        pages  = _extract_pdf_pages(source)
        chunks = _build_chunks(pages)
        result = _write_chunks(
            chunks,
            filename=filename,
            track=track,
            module_title=module_title or filename,
            overwrite=overwrite,
        )
        return {
            "ok":               True,
            "filename":         filename,
            "track":            track,
            "pages_processed":  len(pages),
            "chunks_total":     len(chunks),
            "chunks_written":   result["chunks_written"],
            "skipped":          result["skipped"],
            "latency_ms":       round((time.time() - start) * 1000),
        }
    except Exception as e:
        return {"ok": False, "error": str(e), "filename": filename}


def list_pdf_docs(track: str | None = None) -> list[dict]:
    """List PDFs currently indexed in doc_embeddings."""
    import psycopg2
    import psycopg2.extras
    try:
        conn = psycopg2.connect(get_db_url())
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as c:
            if track:
                c.execute(
                    """SELECT doc_filename, track, COUNT(*) AS chunk_count,
                              MAX(created_at) AS last_updated
                       FROM doc_embeddings WHERE doc_source='pdf' AND track=%s
                       GROUP BY doc_filename, track ORDER BY last_updated DESC""",
                    (track,),
                )
            else:
                c.execute(
                    """SELECT doc_filename, track, COUNT(*) AS chunk_count,
                              MAX(created_at) AS last_updated
                       FROM doc_embeddings WHERE doc_source='pdf'
                       GROUP BY doc_filename, track ORDER BY last_updated DESC"""
                )
            return [dict(r) for r in c.fetchall()]
    except Exception as e:
        print(f"[pdf_ingestion] list_pdf_docs error: {e}")
        return []
    finally:
        try:
            conn.close()
        except Exception:
            pass
