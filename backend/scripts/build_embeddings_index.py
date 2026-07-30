import os
import re
import json
import time
import requests
import psycopg2
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://postgres:nexus123@localhost:5432/nexus")
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")

CHUNK_WORDS = 350
CHUNK_OVERLAP = 50


def el_url_to_github_path(el_url):
    url = el_url.replace("https://experienceleague.adobe.com", "").split("?")[0].split("#")[0].rstrip("/")
    m = re.search(r'/docs/platform-learn/tutorials/(.+?)(?:\.html)?$', url)
    if m:
        return "AdobeDocs/platform-learn.en", f"help/platform/{m.group(1)}.md"
    m = re.search(r'/(?:en/)?docs/analytics-platform/(.+?)(?:\.html)?$', url)
    if m:
        return "AdobeDocs/analytics-platform.en", f"help/{m.group(1)}.md"
    m = re.search(r'/(?:en/)?docs/analytics/(.+?)(?:\.html)?$', url)
    if m:
        return "AdobeDocs/analytics.en", f"help/{m.group(1)}.md"
    m = re.search(r'/docs/analytics-learn/(.+?)(?:\.html)?$', url)
    if m:
        return "AdobeDocs/analytics-learn.en", f"help/{m.group(1)}.md"
    m = re.search(r'/(?:en/)?docs/experience-platform/(.+?)(?:\.html)?$', url)
    if m:
        return "AdobeDocs/experience-platform.en", f"help/{m.group(1)}.md"
    m = re.search(r'/(?:en/)?docs/federated-audience-composition/(.+?)(?:\.html)?$', url)
    if m:
        return "AdobeDocs/federated-audience-composition.en", f"help/{m.group(1)}.md"
    return "AdobeDocs/experience-platform.en", None


def fetch_markdown(repo, path):
    headers = {}
    if GITHUB_TOKEN:
        headers["Authorization"] = f"token {GITHUB_TOKEN}"
    for branch in ("main", "master"):
        url = f"https://raw.githubusercontent.com/{repo}/{branch}/{path}"
        try:
            r = requests.get(url, headers=headers, timeout=15)
            if r.status_code == 200 and len(r.text) > 100:
                return r.text
        except Exception:
            continue
    return None


def clean_markdown(raw):
    text = re.sub(r'^---[\s\S]*?---\n?', '', raw)
    text = re.sub(r'<!--[\s\S]*?-->', '', text)
    text = re.sub(r'!\[([^\]]*)\]\([^)]+\)', '', text)
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)
    text = re.sub(r'[#*`>]', '', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def chunk_text(text, chunk_words=CHUNK_WORDS, overlap=CHUNK_OVERLAP):
    words = text.split()
    if len(words) <= chunk_words:
        return [text] if text.strip() else []
    chunks = []
    i = 0
    while i < len(words):
        chunk = " ".join(words[i:i + chunk_words])
        if len(chunk.strip()) > 80:
            chunks.append(chunk)
        i += chunk_words - overlap
    return chunks


def main():
    print("Loading embedding model...")
    from fastembed import TextEmbedding
    model = TextEmbedding(model_name="BAAI/bge-small-en-v1.5")
    print("Model ready.\n")

    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = True
    cur = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS doc_embeddings (
            id SERIAL PRIMARY KEY,
            repo VARCHAR(120),
            file_path VARCHAR(500),
            el_url VARCHAR(500),
            title VARCHAR(255),
            track VARCHAR(50),
            chunk_index INTEGER,
            chunk_text TEXT,
            embedding TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        )
    """)
    # GIN index powers the Postgres full-text (lexical) leg of the shared
    # retriever — without it, ts_rank falls back to a sequential scan.
    cur.execute(
        "CREATE INDEX IF NOT EXISTS doc_embeddings_fts_idx "
        "ON doc_embeddings USING GIN (to_tsvector('english', chunk_text))"
    )
    cur.execute("DELETE FROM doc_embeddings")

    cur.execute("SELECT module_id, topic_order, title, track, el_url FROM curriculum_topics WHERE el_url IS NOT NULL")
    topics = cur.fetchall()
    print(f"Found {len(topics)} curriculum topics with an EL URL.\n")

    indexed, skipped, total_chunks = 0, 0, 0

    for module_id, topic_order, title, track, el_url in topics:
        repo, path = el_url_to_github_path(el_url)
        if not path:
            skipped += 1
            continue

        raw = fetch_markdown(repo, path)
        if not raw:
            print(f"[skip] {title[:40]}")
            skipped += 1
            continue

        cleaned = clean_markdown(raw)
        chunks = chunk_text(cleaned)

        if not chunks:
            skipped += 1
            continue

        # ✅ FIXED HERE (convert to pure Python floats)
        embeddings = [[float(x) for x in v] for v in model.embed(chunks)]

        for idx, (chunk, emb) in enumerate(zip(chunks, embeddings)):
            cur.execute(
                """INSERT INTO doc_embeddings 
                (repo, file_path, el_url, title, track, chunk_index, chunk_text, embedding)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
                (repo, path, el_url, title, track, idx, chunk, json.dumps(emb))
            )

        total_chunks += len(chunks)
        indexed += 1
        print(f"[ok] {title[:40]} — {len(chunks)} chunks")

        time.sleep(0.05)

    cur.close()
    conn.close()

    print("\nDONE")
    print(f"{indexed} indexed | {skipped} skipped | {total_chunks} chunks")

    # Sync the freshly-built corpus into the persistent pgvector store so the
    # shared retriever's vector leg is served from Postgres (no whole-corpus load
    # per query). No-op / graceful skip if pgvector isn't configured.
    try:
        from agents import vector_store as vstore
        if vstore.is_available():
            print("\nSyncing into pgvector store (no re-embedding)...")
            res = vstore.sync_from_doc_embeddings(reset=True, verbose=True)
            if res.get("ok"):
                print(f"pgvector: {res['added']} vectors → {res['table']}")
            else:
                print(f"pgvector sync skipped: {res.get('reason')}")
        else:
            print("\npgvector not available — retriever will use the in-memory path.")
    except Exception as e:
        print(f"\npgvector sync skipped: {e}")


if __name__ == "__main__":
    main()
