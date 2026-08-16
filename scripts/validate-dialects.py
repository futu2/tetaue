#!/usr/bin/env python3
"""Render every runnable example for every dialect and syntax-check it with sqlglot.

This is intentionally parse-only. PostgreSQL and MySQL are executed with real
service containers in the CI workflow; Trino/Hive are validated here until
service-container execution is added for them.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import sqlglot

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = [
    "examples/adults.tetaue",
    "examples/case.tetaue",
    "examples/joins.tetaue",
    "examples/lpbirthday.tetaue",
    "examples/orders.tetaue",
    "examples/report.tetaue",
    "examples/selective.tetaue",
    "examples/strings.tetaue",
    "examples/lib-project/main.tetaue",
]
DIALECTS = {
    "sqlite": "sqlite",
    "postgresql": "postgres",
    "mysql": "mysql",
    "trino": "trino",
    "hive": "hive",
}

failures: list[str] = []
for rel in EXAMPLES:
    path = ROOT / rel
    for tetaue_dialect, sqlglot_dialect in DIALECTS.items():
        proc = subprocess.run(
            ["bun", "run", "src/cli.ts", "render", str(path), "--dialect", tetaue_dialect, "--format", "compact"],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if proc.returncode != 0:
            failures.append(f"{rel} ({tetaue_dialect}): render failed:\n{proc.stderr.strip()}")
            continue
        sql = proc.stdout.strip()
        try:
            sqlglot.parse_one(sql, read=sqlglot_dialect)
        except Exception as exc:  # sqlglot raises a variety of parser errors
            failures.append(f"{rel} ({tetaue_dialect}): sqlglot parse failed:\n{sql}\n{exc}")

if failures:
    print("\n\n".join(failures))
    sys.exit(1)
print(f"Validated {len(EXAMPLES)} examples across {len(DIALECTS)} SQL dialects.")
