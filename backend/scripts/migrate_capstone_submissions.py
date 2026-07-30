"""
Capstone Submissions — persists a New Joiner's generated capstone scenario,
their submitted response, and the AI (advisory) evaluation for manager review.
Run: python migrate_capstone_submissions.py
"""
import os, psycopg2
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")
DB = os.getenv("DATABASE_URL", "postgresql://postgres:nexus123@localhost:5432/nexus")

conn = psycopg2.connect(DB)
conn.autocommit = True
cur = conn.cursor()

cur.execute("""
CREATE TABLE IF NOT EXISTS capstone_submissions (
    id SERIAL PRIMARY KEY,
    member_id INTEGER NOT NULL REFERENCES onboarding_requests(id) ON DELETE CASCADE,
    scenario JSONB,
    response_text TEXT,
    ai_evaluation JSONB,
    status VARCHAR(30) DEFAULT 'generated',
    generated_at TIMESTAMP DEFAULT NOW(),
    submitted_at TIMESTAMP,
    evaluated_at TIMESTAMP,
    reviewed_at TIMESTAMP,
    manager_notes TEXT
)
""")

cur.execute("SELECT COUNT(*) FROM capstone_submissions")
count = cur.fetchone()[0]

cur.close()
conn.close()

print("Table ready: capstone_submissions")
print(f"Existing submissions: {count}")
