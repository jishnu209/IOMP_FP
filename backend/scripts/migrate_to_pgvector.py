#!/usr/bin/env python
"""
migrate_to_pgvector.py — one-shot copy of doc_embeddings → persistent pgvector
==============================================================================
Populates the LlamaIndex-managed pgvector table (data_<PGVECTOR_TABLE>, default
data_nexus_docs) from the existing `doc_embeddings` rows. Existing embeddings are
REUSED as-is — nothing is re-embedded — so this is a straight, fast copy.

After this runs, agents/rag.py's shared retriever serves its vector leg from
pgvector (top-k ANN in SQL) instead of loading the whole corpus into memory per
query. The agents themselves are unchanged.

Prerequisites
-------------
1. Install deps:      pip install -r requirements.txt
2. Enable pgvector in the SAME Postgres (one time, needs a privileged role):
       CREATE EXTENSION IF NOT EXISTS vector;
   (PGVectorStore also tries this itself on first write; doing it up front avoids
   a permissions surprise.)
3. DATABASE_URL set in .env, and doc_embeddings already populated
   (run build_embeddings_index.py first if it is empty).

Usage
-----
    python migrate_to_pgvector.py            # rebuild the vector table from scratch
    python migrate_to_pgvector.py --append   # add without truncating first

Idempotent by default: --reset (the default) truncates the vector table first, so
re-running gives a clean, exact mirror of doc_embeddings.
"""

import sys
from pathlib import Path

# Load .env exactly like the other backend scripts.
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent.parent / ".env")
except Exception:
    pass

sys.path.insert(0, str(Path(__file__).parent.parent))

from agents import vector_store as vstore  # noqa: E402


def main() -> int:
    reset = "--append" not in sys.argv

    if not vstore.is_available():
        err = vstore.last_error()
        print("pgvector path is NOT available — nothing migrated.")
        print(f"  reason: {err}")
        print("  checklist: pip install -r requirements.txt · PGVECTOR_ENABLE=1 · "
              "CREATE EXTENSION vector · DATABASE_URL set")
        return 1

    print(f"Target table : {vstore.table_name()}")
    print(f"Mode         : {'reset (truncate first)' if reset else 'append'}")
    print("Migrating doc_embeddings → pgvector (reusing stored vectors)...\n")

    res = vstore.sync_from_doc_embeddings(reset=reset, verbose=True)

    if not res.get("ok"):
        print(f"\nMigration FAILED: {res.get('reason')}")
        return 1

    count = vstore.store_count()
    print("\nDONE")
    print(f"  scanned : {res['scanned']} rows")
    print(f"  added   : {res['added']} vectors")
    print(f"  table   : {res['table']} now holds {count} rows")
    if res["added"] < res["scanned"]:
        print(f"  note    : {res['scanned'] - res['added']} rows had no usable "
              "embedding and were skipped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
