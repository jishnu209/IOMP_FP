"""Community — the rules that actually matter: visibility scoping, author-only
edit/delete, mention notifications, and quality-based kudos scoring."""
from conftest import PREFIX, MGR


def _post(client, author, vis="team", mgr=MGR, mentions=None):
    return client.post("/api/community/threads", json={
        "space": "exp", "author_name": author, "author_email": author + "@test",
        "manager_email": mgr, "title": PREFIX + "title", "body": "body",
        "tag": "Projects", "visibility": vis, "mentions": mentions or [],
    })


def _feed(client, as_name, my_manager):
    return client.get("/api/community/threads",
                      params={"as_name": as_name, "my_manager": my_manager}).json()["threads"]


def _has(threads, author):
    return any(t["author_name"] == author for t in threads)


def test_team_post_visible_to_same_manager_only(client):
    a = PREFIX + "alice"
    assert _post(client, a, "team").status_code == 200
    # Teammate (same manager) sees it.
    assert _has(_feed(client, PREFIX + "bob", MGR), a)
    # Someone under a DIFFERENT manager does not.
    assert not _has(_feed(client, PREFIX + "carol", PREFIX + "othermgr@test"), a)


def test_public_post_visible_across_teams(client):
    a = PREFIX + "pub"
    _post(client, a, "public")
    assert _has(_feed(client, PREFIX + "stranger", PREFIX + "any@test"), a)


def test_private_post_visible_to_author_only(client):
    a = PREFIX + "priv"
    _post(client, a, "private")
    assert _has(_feed(client, a, MGR), a)                       # author sees own
    assert not _has(_feed(client, PREFIX + "bob", MGR), a)      # teammate does not


def test_edit_and_delete_are_author_only(client):
    a = PREFIX + "owner"
    tid = _post(client, a).json()["thread"]["id"]
    # Non-author cannot edit or delete.
    assert client.put(f"/api/community/threads/{tid}",
                      json={"editor_name": PREFIX + "intruder", "title": "x"}).status_code == 403
    assert client.request("DELETE", f"/api/community/threads/{tid}",
                          params={"editor_name": PREFIX + "intruder"}).status_code == 403
    # Author can.
    assert client.put(f"/api/community/threads/{tid}",
                      json={"editor_name": a, "title": PREFIX + "edited"}).status_code == 200
    assert client.request("DELETE", f"/api/community/threads/{tid}",
                          params={"editor_name": a}).status_code == 200


def test_mention_creates_notification(client):
    a, m = PREFIX + "mentioner", PREFIX + "mentioned"
    _post(client, a, mentions=[{"name": m, "email": m + "@test"}])
    n = client.get("/api/notifications", params={"member_name": m}).json()
    assert n["unread"] >= 1
    assert any(x["type"] == "mention" for x in n["notifications"])


def test_kudos_drives_quality_score(client):
    a = PREFIX + "helpful"
    tid = _post(client, a).json()["thread"]["id"]
    r = client.post(f"/api/community/threads/{tid}/react", json={"member_name": PREFIX + "fan"})
    assert r.json()["reactions"] == 1
    stats = client.get("/api/community/stats", params={"space": "exp", "author_name": a}).json()
    # 1 post (+2) + 1 kudos received (+5) == 7
    assert stats["kudos"] >= 1
    assert stats["points"] >= 7


def test_kudos_toggle_off(client):
    a = PREFIX + "author2"
    tid = _post(client, a).json()["thread"]["id"]
    fan = PREFIX + "fan2"
    assert client.post(f"/api/community/threads/{tid}/react", json={"member_name": fan}).json()["reactions"] == 1
    assert client.post(f"/api/community/threads/{tid}/react", json={"member_name": fan}).json()["reactions"] == 0
