#!/usr/bin/env python3
"""One-day bonus evidence, using the assigned MIA guards and cumulative query budget."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time


def statements(day):
    start = dt.date.fromisoformat(day)
    end = start + dt.timedelta(days=1)
    window = lambda field: f"{field} >= toDateTime('{start} 00:00:00','UTC') AND {field} < toDateTime('{end} 00:00:00','UTC')"
    return {
        "by_program": f"""SELECT b.Id bonus_id, b.Name bonus_name, b.BonusType bonus_type,
count() assignments, uniqExact(cb.Id) unique_assignments, uniqExact(cb.ClientId) recipients,
countIf(cb.Status=8) currently_expired
FROM chr_NextCode2.ClientBonuses cb
INNER JOIN chr_NextCode2.Bonuses b ON cb.BonusId=b.Id AND b.PartnerId=100
INNER JOIN chr_NextCode2.Clients_Local c ON cb.ClientId=c.Id AND c.PartnerId=100
WHERE cb.PartnerId=100 AND c.IsTest=0 AND {window('cb.AwardingTime')}
GROUP BY b.Id,b.Name,b.BonusType ORDER BY assignments DESC,b.Id LIMIT 1000""",
        "independent_total": f"""SELECT count() assignments, uniqExact(Id) unique_assignments,
uniqExact(ClientId) recipients, uniqExact(BonusId) programs,
countIf(Status=7) status_not_awarded, countIf(Status=8) currently_expired
FROM chr_NextCode2.ClientBonuses WHERE PartnerId=100 AND {window('AwardingTime')}
AND ClientId IN (SELECT Id FROM chr_NextCode2.Clients_Local WHERE PartnerId=100 AND IsTest=0)""",
        "ledger": f"""SELECT OperationTypeId, count() documents, uniqExact(Id) unique_documents,
sum(AmountEur) amount_eur, max(CreationTime) latest
FROM chr_NextCode2.Documents_Local WHERE PartnerId=100 AND {window('CreationTime')}
AND OperationTypeId IN (8,27,37)
AND ClientId IN (SELECT Id FROM chr_NextCode2.Clients_Local WHERE PartnerId=100 AND IsTest=0)
GROUP BY OperationTypeId ORDER BY OperationTypeId""",
        "coverage": f"""SELECT countIf({window('cb.AwardingTime')}) all_assignments,
countIf({window('cb.AwardingTime')} AND c.IsTest=1) test_assignments,
countIf({window('cb.AwardingTime')} AND c.Id IS NULL) missing_clients,
countIf({window('cb.AwardingTime')} AND b.Id IS NULL) missing_programs,
countIf(cb.AwardingTime IS NULL AND {window('cb.CreationTime')} AND c.IsTest=0) created_not_awarded,
toString(now('UTC')) checked_at,
(SELECT toString(max(CreationTime)) FROM chr_NextCode2.Documents_Local
 WHERE PartnerId=100 AND CreationTime >= toDateTime('{start} 00:00:00','UTC')) latest_ledger
FROM chr_NextCode2.ClientBonuses cb
LEFT JOIN chr_NextCode2.Clients_Local c ON cb.ClientId=c.Id AND c.PartnerId=100
LEFT JOIN chr_NextCode2.Bonuses b ON cb.BonusId=b.Id AND b.PartnerId=100
WHERE cb.PartnerId=100 AND ({window('cb.AwardingTime')} OR {window('cb.CreationTime')})
SETTINGS join_use_nulls=1""",
    }


def parse_rows(output):
    matches = list(re.finditer(r"rows returned: (\d+)", output))
    if not matches:
        raise RuntimeError("Toolkit did not return a row count")
    count = int(matches[-1].group(1))
    if count >= 1000 or "result is TRUNCATED" in output:
        raise RuntimeError("Row cap reached; no complete report")
    tail = output[matches[-1].end():]
    rows = json.loads(tail[tail.index('['):])
    if not isinstance(rows, list) or len(rows) != count:
        raise RuntimeError("Toolkit result shape changed")
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", required=True, help="One UTC date, YYYY-MM-DD")
    parser.add_argument("--dry-run", action="store_true", help="Print statements; do not query")
    args = parser.parse_args()
    queries = statements(args.date)
    if args.dry_run:
        print(json.dumps(queries, ensure_ascii=False, indent=2))
        return
    if (os.environ.get("BRAND_SLUG"), os.environ.get("BRAND_DB"), os.environ.get("BRAND_PARTNER_ID")) != ("motor", "chr_NextCode2", "100"):
        raise RuntimeError("This report requires the Motor profile")
    cid = os.environ["PAPERCLIP_COMPANY_ID"]
    mia = Path(os.environ["MIA"]).resolve(strict=True)
    skills = Path(os.environ["PAPERCLIP_SKILLS_ROOT"]).resolve(strict=True)
    if not mia.is_relative_to(skills) or cid not in mia.parts or cid not in skills.parts:
        raise RuntimeError("Toolkit company identity mismatch")
    out = Path(os.environ["PAPERCLIP_RUN_SCRATCH_DIR"]).resolve(strict=True) / "bonus-daily"
    out.mkdir(exist_ok=True)
    run_id = os.environ["PAPERCLIP_RUN_ID"]
    started = time.monotonic()

    def invoke(name, argv, sql=None):
        result = subprocess.run([sys.executable, str(mia), *argv], input=sql, text=True,
                                capture_output=True, timeout=65)
        (out / f"{name}.log").write_text(result.stdout + result.stderr)
        if result.returncode:
            raise RuntimeError(f"Toolkit rejected {name}; inspect {out / (name + '.log')}")
        return result.stdout

    # Validate the live schema before relying on a template. Fail on drift.
    columns = {
        "ClientBonuses": ["Id", "PartnerId", "BonusId", "ClientId", "Status", "AwardingTime", "CreationTime"],
        "Bonuses": ["Id", "PartnerId", "Name", "BonusType"],
        "Clients_Local": ["Id", "PartnerId", "IsTest"],
        "Documents_Local": ["Id", "PartnerId", "ClientId", "OperationTypeId", "AmountEur", "CreationTime"],
    }
    for table, expected in columns.items():
        schema = invoke(f"schema-{table}", ["columns", "--table", f"chr_NextCode2.{table}"])
        if any(not re.search(r"\b" + re.escape(col) + r"\b", schema) for col in expected):
            raise RuntimeError(f"Schema drift in {table}")
    results = {}
    for name, sql in queries.items():
        (out / f"{name}.sql").write_text(sql)
        results[name] = parse_rows(invoke(name, ["sql", "--run-id", run_id, "--limit", "1000", "--timeout", "45"], sql))
    totals = results["independent_total"][0]
    coverage = results["coverage"][0]
    by_type = {}
    for row in results["by_program"]:
        bucket = by_type.setdefault(str(row["bonus_type"]), {"assignments": 0, "programs": 0})
        bucket["assignments"] += int(row["assignments"])
        bucket["programs"] += 1
    checks = {
        "unique_assignments": int(totals["assignments"]) == int(totals["unique_assignments"]),
        "breakdown_matches_total": sum(v["assignments"] for v in by_type.values()) == int(totals["unique_assignments"]),
        "programs_match": len(results["by_program"]) == int(totals["programs"]),
        "no_missing_join_rows": int(coverage["missing_clients"]) == int(coverage["missing_programs"]) == 0,
        "no_not_awarded_status": int(totals["status_not_awarded"]) == 0,
    }
    ledger_awards = next((int(r["documents"]) for r in results["ledger"] if int(r["OperationTypeId"]) == 8), 0)
    checks["ledger_award_count_matches"] = ledger_awards == int(totals["unique_assignments"])
    report = {"date": args.date, "timezone": "UTC", "definition": "actual AwardingTime, non-test Motor players; not spin count or released winnings",
              "totals": totals, "by_type": by_type, "top_programs": results["by_program"][:10],
              "ledger": results["ledger"], "coverage": coverage, "checks": checks,
              "all_checks_pass": all(checks.values()), "evidence_directory": str(out),
              "elapsed_seconds": round(time.monotonic() - started, 2),
              "limitations": "Live production snapshot may change; no settled Motor daily report. Ledger operations and bonus assignments are different measures; count equality alone is not row-level matching. Spin package value cannot be inferred from ledger amounts."}
    (out / "full-results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"REPORT_FAILED: {error}", file=sys.stderr)
        sys.exit(1)
