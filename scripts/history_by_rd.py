"""Build data/history_by_rd.json: dispatched LAPD calls per reporting district by type, for the board's history layer.
Input: calls_clean.csv from the LAPD Calls for Service pull (Dec 1 2024 to Jan 31 2025, see the data README).
Same 55 days as the baselines: Jan 6 to 12, 2025 excluded. These are dispatched calls by radio code, not confirmed crimes.
Usage: python3 scripts/history_by_rd.py path/to/calls_clean.csv > data/history_by_rd.json
"""
import csv, json, re, sys
from collections import defaultdict

def kinds(text):
    t = text.upper()
    out = set()
    if "DOM VIOL" in t or t.startswith("620 FAMILY"): out.add("domestic")
    if re.match(r"^(211|906 ROBBERY)", t) or "ROBBERY" in t: out.add("robbery")
    if re.match(r"^(245|246|187|207|417)", t) or (t.startswith("242") and "DOM" not in t) or "SHOTS" in t or re.match(r"^415 (FIGHT|MAN W/|WOMAN W/|MAN ASSLTG|GRP W/)", t): out.add("violence")
    if re.match(r"^459", t): out.add("burglary")
    if re.match(r"^(904 AMB|907|927)", t) or " AMB" in t: out.add("medical")
    return out

counts = defaultdict(lambda: defaultdict(int))
days = set()
for r in csv.DictReader(open(sys.argv[1])):
    d = r["ts"][:10]
    if "2025-01-06" <= d <= "2025-01-12": continue
    days.add(d)
    rd = r["rpt_dist"].zfill(4)
    counts[rd]["total"] += 1
    for k in kinds(r["call_type_text"]): counts[rd][k] += 1

json.dump({
    "source": "LAPD Calls for Service (data.lacity.org xjgu-z4ju), dispatched incidents, not raw 911 calls and not confirmed crimes",
    "days": len(days), "from": min(days), "to": max(days), "excluded": "2025-01-06 to 2025-01-12 (fires)",
    "categories": ["total", "violence", "domestic", "robbery", "burglary", "medical"],
    "rd": {rd: dict(v) for rd, v in sorted(counts.items())},
}, sys.stdout, separators=(",", ":"))
