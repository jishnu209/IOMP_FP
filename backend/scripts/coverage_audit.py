"""
AdobeDocs Coverage Audit — finds out for real, instead of guessing.

Runs every curriculum topic (both tracks) through the actual /api/content
endpoint and reports HIT (real content found), FALLBACK (no content, curriculum
card only), or ERROR. This is ground truth from your own database and backend,
not an estimate.

Run from the backend folder, with uvicorn already running on port 8000:
    python coverage_audit.py

Output: coverage_report.csv + a printed summary by module and track.
"""
import requests
import csv
import time

BACKEND = "http://localhost:8000"

def get_curriculum(track):
    r = requests.get(f"{BACKEND}/api/curriculum", params={"track": track}, timeout=10)
    r.raise_for_status()
    return r.json().get("modules", {})

def check_topic(module_id, topic_order, track):
    try:
        r = requests.get(
            f"{BACKEND}/api/content/{module_id}/{topic_order}",
            params={"track": track}, timeout=20
        )
        data = r.json()
        if data.get("source") == "not_found" or not data.get("content"):
            return "FALLBACK", 0, data.get("debug", [])
        return "HIT", len(data.get("content", "")), data.get("source", "?")
    except Exception as e:
        return "ERROR", 0, str(e)

def main():
    rows = []
    summary = {}

    for track in ["rtcdp", "analytics"]:
        modules = get_curriculum(track)
        for module_id_str, topics in modules.items():
            module_id = int(module_id_str)
            for t in topics:
                order = t["topic_order"]
                title = t["title"]
                status, length, detail = check_topic(module_id, order, track)
                rows.append({
                    "track": track, "module_id": module_id, "topic_order": order,
                    "title": title, "status": status, "content_length": length, "detail": detail
                })
                key = (track, module_id)
                summary.setdefault(key, {"HIT": 0, "FALLBACK": 0, "ERROR": 0, "total": 0})
                summary[key][status] += 1
                summary[key]["total"] += 1
                print(f"  [{track:9s}] M{module_id} T{order:2d}  {status:9s}  {title[:50]}")
                time.sleep(0.1)  # be gentle on GitHub API rate limits

    with open("coverage_report.csv", "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["track", "module_id", "topic_order", "title", "status", "content_length", "detail"])
        writer.writeheader()
        writer.writerows(rows)

    print("\n" + "=" * 70)
    print("COVERAGE SUMMARY (real, from your database + backend)")
    print("=" * 70)
    grand_hit, grand_total = 0, 0
    for (track, module_id), counts in sorted(summary.items()):
        pct = round(counts["HIT"] / counts["total"] * 100) if counts["total"] else 0
        print(f"  {track:10s} Module {module_id}: {counts['HIT']:2d}/{counts['total']:2d} hit  ({pct}%)   fallback={counts['FALLBACK']}  error={counts['ERROR']}")
        grand_hit += counts["HIT"]
        grand_total += counts["total"]
    overall_pct = round(grand_hit / grand_total * 100) if grand_total else 0
    print("-" * 70)
    print(f"  OVERALL: {grand_hit}/{grand_total} topics have real AdobeDocs content ({overall_pct}%)")
    print("=" * 70)
    print(f"\nFull per-topic detail written to coverage_report.csv")

if __name__ == "__main__":
    main()
