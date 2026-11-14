"""Rebuild all data with one command:  python pipeline/run.py [first_stage]

Stages run in order; each one only reads raw/ and the outputs of earlier stages.
"""
import runpy, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
STAGES = sorted(p for p in HERE.glob("[0-9][0-9]_*.py") if not p.name.startswith("07_"))  # 07 = Engine

start = sys.argv[1] if len(sys.argv) > 1 else "00"
for stage in STAGES:
    if stage.name[:2] < start:
        continue
    print(f"\n===== {stage.name} =====")
    runpy.run_path(str(stage), run_name="__main__")
