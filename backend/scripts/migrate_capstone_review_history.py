"""
Capstone Manager Review History — adds an append-only audit trail of every
manager decision (approve/reject) on a capstone_submissions row, separate from
manager_notes (which stays the current/active note and is cleared on resubmit).
Run: python migrate_capstone_review_history.py
"""
import os, psycopg2
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")
DB = os.getenv("DATABASE_URL", "postgresql://postgres:nexus123@localhost:5432/nexus")

conn = psycopg2.connect(DB)
conn.autocommit = True
cur = conn.cursor()

cur.execute("ALTER TABLE capstone_submissions ADD COLUMN IF NOT EXISTS manager_review_history JSONB DEFAULT '[]'")

cur.execute("SELECT COUNT(*) FROM capstone_submissions WHERE manager_review_history IS NOT NULL AND manager_review_history != '[]'")
count = cur.fetchone()[0]

cur.close()
conn.close()

print("Column ready: capstone_submissions.manager_review_history")
print(f"Submissions with existing history: {count}")
print("No backfill performed — history starts accumulating from the next manager decision onward.")
