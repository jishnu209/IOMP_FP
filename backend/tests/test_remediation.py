"""Remediation — the adaptive catch-up path. On-track learners get nothing;
struggling learners get a plan with the hardest (failed test-out) first."""
from conftest import PREFIX


def test_on_track_learner_gets_empty_plan(client):
    r = client.get("/api/curriculum/remediation",
                   params={"member_name": PREFIX + "clean", "track": "rtcdp"}).json()
    assert r["on_track"] is True
    assert r["weak_count"] == 0
    assert r["plan"] == []


def test_weakness_detected_and_ranked(client, db):
    m = PREFIX + "struggler"
    cur = db.cursor()
    cur.execute("INSERT INTO module_test_outs (member_name,track,module_id,module_title,score,passed) "
                "VALUES (%s,'rtcdp',4,'Segmentation',45,FALSE)", (m,))
    cur.execute("INSERT INTO confidence_scores (user_name,module,score) "
                "VALUES (%s,'Some Weak Module',0.42)", (m,))
    r = client.get("/api/curriculum/remediation",
                   params={"member_name": m, "track": "rtcdp"}).json()
    assert r["on_track"] is False
    assert r["weak_count"] == 2
    # Failed test-out (severity 25) outranks low confidence (severity ~18).
    assert r["plan"][0]["kind"] == "failed_testout"
    assert "retest" in r["plan"][0]["actions"]


def test_only_failed_testouts_counted_not_passed(client, db):
    m = PREFIX + "passer"
    cur = db.cursor()
    # A PASSED test-out must not appear as a weakness.
    cur.execute("INSERT INTO module_test_outs (member_name,track,module_id,module_title,score,passed) "
                "VALUES (%s,'rtcdp',2,'Foundations',88,TRUE)", (m,))
    r = client.get("/api/curriculum/remediation",
                   params={"member_name": m, "track": "rtcdp"}).json()
    assert r["on_track"] is True
    assert r["weak_count"] == 0
