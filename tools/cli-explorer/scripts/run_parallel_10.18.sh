#!/usr/bin/env bash
# Build four AOS-CX 10.18 banks in parallel.
set -u
cd "$(dirname "$0")/.."
PY=.venv/bin/python
mkdir -p source/build_logs
rm -f source/build_logs/*.exit source/build_logs/*.log

run_one() {
  local plat="$1" doc="$2"
  local pdf="source/aos-cx-10.18-${doc}.pdf"
  local bank="aos-cx-10.18-${plat}"
  local out="data/${bank}"
  local log="source/build_logs/${plat}.log"
  {
    echo "[$(date -Is)] START ${bank}"
    if "$PY" scripts/build_from_pdf.py \
      --pdf "$pdf" \
      --bank "$bank" \
      --out "$out" \
      --toc-mode nested
    then
      echo "[$(date -Is)] OK ${bank}"
      echo 0 > "source/build_logs/${plat}.exit"
      ls -lh "$out"
      du -sh "$out"
    else
      local rc=$?
      echo "[$(date -Is)] FAIL ${bank} rc=$rc"
      echo "$rc" > "source/build_logs/${plat}.exit"
    fi
  } >"$log" 2>&1
}

echo "==== PARALLEL START $(date -Is) ===="
run_one 6100 sd00007899en_us &
p1=$!
run_one 6200 sd00007900en_us &
p2=$!
run_one 6300 sd00007913en_us &
p3=$!
run_one 8360 sd00007891en_us &
p4=$!
echo "PIDs 6100=$p1 6200=$p2 6300=$p3 8360=$p4"
echo "$p1 $p2 $p3 $p4" > source/build_logs/pids.txt

fail=0
wait "$p1" || fail=1
wait "$p2" || fail=1
wait "$p3" || fail=1
wait "$p4" || fail=1

echo "==== PARALLEL DONE $(date -Is) fail=$fail ===="
for plat in 6100 6200 6300 8360; do
  echo "--- $plat exit=$(cat source/build_logs/${plat}.exit 2>/dev/null || echo ?) ---"
  tail -n 8 "source/build_logs/${plat}.log" 2>/dev/null || true
  du -sh "data/aos-cx-10.18-${plat}" 2>/dev/null || echo "missing bank"
done

"$PY" - <<'PY'
import json
from pathlib import Path
for plat in ["6100", "6200", "6300", "8360"]:
    d = Path(f"data/aos-cx-10.18-{plat}")
    if not (d / "meta.json").is_file():
        print(plat, "MISSING")
        continue
    meta = json.loads((d / "meta.json").read_text())
    t = json.loads((d / "tree.json").read_text())
    print(
        f"{plat}: pages={meta.get('pageCount')} toc={meta.get('tocCount')} "
        f"leaves={meta.get('leafCount')} entries_mb={(d/'entries.json').stat().st_size/1e6:.1f} "
        f"root={t['tree'][0]['title']!r}"
    )
print("catalog:", [b["id"] for b in json.loads(Path("data/catalog.json").read_text())["banks"]])
PY
exit "$fail"
