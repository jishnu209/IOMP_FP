"""Shared pytest fixtures.

Tests run in-process against the FastAPI app (TestClient) using the real local
Postgres. Every test author/member name is prefixed with `pytest_` so the
teardown can delete only test-created rows and never touch real data.
"""
import os
import sys

import pytest

# Make `import main` / `import agents...` resolve from the backend/ root.
BACKEND = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, BACKEND)

from dotenv import load_dotenv
load_dotenv(os.path.join(BACKEND, ".env"))

import psycopg2
from fastapi.testclient import TestClient
import main

PREFIX = "pytest_"
MGR = PREFIX + "mgr@test"


@pytest.fixture(scope="session")
def client():
    with TestClient(main.app) as c:
        yield c


@pytest.fixture()
def db():
    conn = psycopg2.connect(os.getenv("DATABASE_URL"))
    conn.autocommit = True
    yield conn
    conn.close()


def _cleanup():
    conn = psycopg2.connect(os.getenv("DATABASE_URL"))
    conn.autocommit = True
    cur = conn.cursor()
    like = PREFIX + "%"
    # community_reactions cascade when their thread is deleted.
    cur.execute("DELETE FROM community_threads WHERE author_name LIKE %s OR manager_email LIKE %s", (like, like))
    cur.execute("DELETE FROM notifications WHERE member_name LIKE %s OR actor LIKE %s", (like, like))
    cur.execute("DELETE FROM module_test_outs WHERE member_name LIKE %s", (like,))
    cur.execute("DELETE FROM confidence_scores WHERE user_name LIKE %s", (like,))
    conn.close()


@pytest.fixture(autouse=True)
def _clean_around():
    """Clean pytest_ rows before AND after each test so tests never interfere."""
    _cleanup()
    yield
    _cleanup()
