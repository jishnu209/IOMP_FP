"""
Weekly Tracker — Project Allocations & Weekly Updates
Creates project_allocations + allocation_updates tables.
No roster is seeded — team members are derived dynamically from whoever
logs a project allocation through the platform.
Run: python migrate_tracker.py
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
CREATE TABLE IF NOT EXISTS project_allocations (
    id SERIAL PRIMARY KEY,
    member_name VARCHAR(120) NOT NULL,
    manager VARCHAR(120),
    project_id VARCHAR(50),
    project_name VARCHAR(255),
    project_type VARCHAR(100),
    industry VARCHAR(100),
    phase VARCHAR(50),
    stage VARCHAR(50),
    start_date DATE,
    end_date DATE,
    hrs_per_week NUMERIC DEFAULT 0,
    use_cases TEXT,
    solutions_used VARCHAR(255),
    product_features VARCHAR(255),
    data_sources VARCHAR(255),
    destinations VARCHAR(255),
    num_audiences INTEGER DEFAULT 0,
    region VARCHAR(50),
    ticket_ids VARCHAR(255),
    health_status VARCHAR(50) DEFAULT 'On track',
    renewal VARCHAR(20) DEFAULT 'TBD',
    comments TEXT,
    project_notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
)
""")

cur.execute("""
CREATE TABLE IF NOT EXISTS allocation_updates (
    id SERIAL PRIMARY KEY,
    allocation_id INTEGER REFERENCES project_allocations(id) ON DELETE CASCADE,
    member_name VARCHAR(120) NOT NULL,
    comment TEXT NOT NULL,
    health_status VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW()
)
""")

# Drop the old hardcoded team_roster table if it exists from a prior run —
# the roster is now fully dynamic, derived from project_allocations.
cur.execute("DROP TABLE IF EXISTS team_roster")

cur.execute("SELECT COUNT(*) FROM project_allocations")
alloc_count = cur.fetchone()[0]
cur.execute("SELECT COUNT(*) FROM allocation_updates")
update_count = cur.fetchone()[0]

cur.close()
conn.close()

print("Tables ready: project_allocations, allocation_updates")
print(f"Existing allocations: {alloc_count}")
print(f"Existing weekly updates: {update_count}")
print("No roster seeded — team members appear automatically once they log their first project.")
