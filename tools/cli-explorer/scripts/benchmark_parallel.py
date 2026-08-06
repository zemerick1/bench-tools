#!/usr/bin/env python3
"""
Parallel CLI PDF build benchmark on native Linux FS.

Runs N bank builds concurrently, samples host CPU/RAM/disk, and writes:
  logs/benchmark_report.json
  logs/benchmark_report.md
  logs/<platform>.log
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

try:
    import psutil
except ImportError:
    print("psutil required", file=sys.stderr)
    sys.exit(1)

SCRIPTS_DIR = Path(__file__).resolve().parent
APP_ROOT = SCRIPTS_DIR.parent
ROOT = APP_ROOT  # run with cwd or paths under app root
PY = APP_ROOT / ".venv" / "bin" / "python"
BUILDER = SCRIPTS_DIR / "build_from_pdf.py"
SOURCE = APP_ROOT / "source"
DATA = APP_ROOT / "data"
LOGS = APP_ROOT / "logs"

# platform -> pdf basename on native FS
JOBS = [
    ("6100", "aos-cx-10.17-6100.pdf", "aos-cx-10.17-6100"),
    ("6200", "aos-cx-10.17-6200.pdf", "aos-cx-10.17-6200"),
    ("6300", "aos-cx-10.17-6300.pdf", "aos-cx-10.17-6300"),
    ("8360", "aos-cx-10.17-8360.pdf", "aos-cx-10.17-8360"),
]

SAMPLE_INTERVAL = 1.0  # seconds


@dataclass
class JobResult:
    platform: str
    bank: str
    pdf: str
    pdf_bytes: int
    wall_sec: float = 0.0
    exit_code: int = -1
    peak_rss_mb: float = 0.0
    avg_cpu_pct: float = 0.0  # of this process, 100 = one core
    out_entries_mb: float = 0.0
    out_tree_mb: float = 0.0
    leaf_count: int | None = None
    page_count: int | None = None
    toc_count: int | None = None
    log_path: str = ""


@dataclass
class HostSample:
    t: float
    cpu_pct: float
    mem_used_mb: float
    mem_avail_mb: float
    mem_pct: float
    disk_read_mb: float
    disk_write_mb: float
    load1: float


@dataclass
class Report:
    started_at: str
    finished_at: str
    host: dict
    jobs: list[dict] = field(default_factory=list)
    host_samples: list[dict] = field(default_factory=list)
    summary: dict = field(default_factory=dict)


def host_snapshot(t0: float, disk0) -> HostSample:
    vm = psutil.virtual_memory()
    disk = psutil.disk_io_counters()
    load1 = os.getloadavg()[0] if hasattr(os, "getloadavg") else 0.0
    # disk counters are cumulative; store absolute for later delta
    return HostSample(
        t=time.monotonic() - t0,
        cpu_pct=psutil.cpu_percent(interval=None),
        mem_used_mb=(vm.total - vm.available) / (1024 * 1024),
        mem_avail_mb=vm.available / (1024 * 1024),
        mem_pct=vm.percent,
        disk_read_mb=(disk.read_bytes if disk else 0) / (1024 * 1024),
        disk_write_mb=(disk.write_bytes if disk else 0) / (1024 * 1024),
        load1=load1,
    )


def run_job(platform: str, pdf_name: str, bank: str, results: dict, stop_event: threading.Event) -> None:
    pdf = SOURCE / pdf_name
    out = DATA / bank
    log_path = LOGS / f"{platform}.log"
    out.mkdir(parents=True, exist_ok=True)

    cmd = [
        str(PY),
        str(BUILDER),
        "--pdf",
        str(pdf),
        "--bank",
        bank,
        "--out",
        str(out),
        "--toc-mode",
        "nested",
    ]

    jr = JobResult(
        platform=platform,
        bank=bank,
        pdf=pdf_name,
        pdf_bytes=pdf.stat().st_size,
        log_path=str(log_path),
    )

    t0 = time.monotonic()
    with log_path.open("w", encoding="utf-8") as logf:
        logf.write(f"$ {' '.join(cmd)}\n\n")
        logf.flush()
        proc = subprocess.Popen(
            cmd,
            cwd=str(ROOT),
            stdout=logf,
            stderr=subprocess.STDOUT,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
        )
        p = psutil.Process(proc.pid)
        cpu_samples: list[float] = []
        peak_rss = 0
        # Prime cpu_percent
        try:
            p.cpu_percent(interval=None)
        except psutil.Error:
            pass

        while proc.poll() is None:
            try:
                # include children (unlikely, but safe)
                rss = p.memory_info().rss
                for c in p.children(recursive=True):
                    try:
                        rss += c.memory_info().rss
                    except psutil.Error:
                        pass
                peak_rss = max(peak_rss, rss)
                cpu_samples.append(p.cpu_percent(interval=None))
            except psutil.Error:
                pass
            time.sleep(SAMPLE_INTERVAL)

        jr.exit_code = proc.returncode if proc.returncode is not None else -1
        jr.wall_sec = time.monotonic() - t0
        jr.peak_rss_mb = peak_rss / (1024 * 1024)
        jr.avg_cpu_pct = sum(cpu_samples) / len(cpu_samples) if cpu_samples else 0.0

    entries = out / "entries.json"
    tree = out / "tree.json"
    meta = out / "meta.json"
    if entries.is_file():
        jr.out_entries_mb = entries.stat().st_size / (1024 * 1024)
    if tree.is_file():
        jr.out_tree_mb = tree.stat().st_size / (1024 * 1024)
    if meta.is_file():
        try:
            m = json.loads(meta.read_text(encoding="utf-8"))
            jr.leaf_count = m.get("leafCount")
            jr.page_count = m.get("pageCount")
            jr.toc_count = m.get("tocCount")
        except json.JSONDecodeError:
            pass

    results[platform] = jr


def main() -> int:
    LOGS.mkdir(parents=True, exist_ok=True)
    DATA.mkdir(parents=True, exist_ok=True)

    if not PY.is_file():
        print(f"Missing venv python: {PY}", file=sys.stderr)
        return 1

    for _plat, pdf_name, _bank in JOBS:
        if not (SOURCE / pdf_name).is_file():
            print(f"Missing PDF: {SOURCE / pdf_name}", file=sys.stderr)
            return 1

    # Warm cpu_percent
    psutil.cpu_percent(interval=0.1)
    disk0 = psutil.disk_io_counters()
    vm = psutil.virtual_memory()

    host_info = {
        "hostname": os.uname().nodename if hasattr(os, "uname") else "",
        "platform": sys.platform,
        "python": sys.version.split()[0],
        "cpu_count_logical": psutil.cpu_count(logical=True),
        "cpu_count_physical": psutil.cpu_count(logical=False),
        "ram_total_mb": round(vm.total / (1024 * 1024), 1),
        "root_fs": str(ROOT),
        "sample_interval_sec": SAMPLE_INTERVAL,
        "jobs": len(JOBS),
        "note": "Builds run fully parallel on native Linux FS under /tmp",
    }

    print("=== CLI parallel build benchmark ===")
    print(json.dumps(host_info, indent=2))
    print(f"Jobs: {[j[0] for j in JOBS]}")
    print()

    t0 = time.monotonic()
    started = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    results: dict[str, JobResult] = {}
    stop = threading.Event()
    samples: list[HostSample] = []

    def sampler():
        # baseline absolute disk counters for delta reporting later
        while not stop.is_set():
            samples.append(host_snapshot(t0, disk0))
            stop.wait(SAMPLE_INTERVAL)

    sample_thread = threading.Thread(target=sampler, daemon=True)
    sample_thread.start()

    threads: list[threading.Thread] = []
    for platform, pdf_name, bank in JOBS:
        th = threading.Thread(
            target=run_job,
            args=(platform, pdf_name, bank, results, stop),
            name=f"build-{platform}",
        )
        th.start()
        threads.append(th)

    for th in threads:
        th.join()

    stop.set()
    sample_thread.join(timeout=2)

    finished = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    wall = time.monotonic() - t0

    job_list = [asdict(results[p]) for p, _, _ in JOBS if p in results]

    # Host sample deltas for disk
    sample_dicts = []
    if samples:
        r0 = samples[0].disk_read_mb
        w0 = samples[0].disk_write_mb
        for s in samples:
            d = asdict(s)
            d["disk_read_delta_mb"] = round(s.disk_read_mb - r0, 2)
            d["disk_write_delta_mb"] = round(s.disk_write_mb - w0, 2)
            sample_dicts.append(d)

    peak_mem = max((s.mem_used_mb for s in samples), default=0)
    peak_cpu = max((s.cpu_pct for s in samples), default=0)
    avg_cpu = sum((s.cpu_pct for s in samples), 0) / len(samples) if samples else 0
    min_avail = min((s.mem_avail_mb for s in samples), default=0)
    disk_read = (samples[-1].disk_read_mb - samples[0].disk_read_mb) if len(samples) > 1 else 0
    disk_write = (samples[-1].disk_write_mb - samples[0].disk_write_mb) if len(samples) > 1 else 0

    ok = all(j.get("exit_code") == 0 for j in job_list)
    summary = {
        "wall_sec": round(wall, 2),
        "wall_min": round(wall / 60, 2),
        "all_ok": ok,
        "sum_job_wall_sec": round(sum(j["wall_sec"] for j in job_list), 2),
        "parallel_efficiency": round(
            sum(j["wall_sec"] for j in job_list) / wall / max(len(job_list), 1), 3
        )
        if wall > 0
        else 0,
        "host_peak_cpu_pct": round(peak_cpu, 1),
        "host_avg_cpu_pct": round(avg_cpu, 1),
        "host_peak_mem_used_mb": round(peak_mem, 1),
        "host_min_mem_avail_mb": round(min_avail, 1),
        "host_disk_read_mb": round(disk_read, 1),
        "host_disk_write_mb": round(disk_write, 1),
        "bottleneck_hint": "",
    }

    # crude bottleneck classification
    ncpu = host_info["cpu_count_logical"] or 1
    if peak_cpu >= 85 and summary["parallel_efficiency"] > 0.7:
        summary["bottleneck_hint"] = "CPU-bound (high utilization during parallel extract)"
    elif min_avail < 400 or peak_mem > host_info["ram_total_mb"] * 0.9:
        summary["bottleneck_hint"] = "Memory pressure (low available RAM)"
    elif disk_read + disk_write > 500 and peak_cpu < 50:
        summary["bottleneck_hint"] = "Disk-heavy (high IO, modest CPU)"
    else:
        summary["bottleneck_hint"] = "Mixed / check per-job CPU and peak RSS"

    report = Report(
        started_at=started,
        finished_at=finished,
        host=host_info,
        jobs=job_list,
        host_samples=sample_dicts[:: max(1, len(sample_dicts) // 200)],  # downsample for file size
        summary=summary,
    )

    json_path = LOGS / "benchmark_report.json"
    # full samples in separate file
    (LOGS / "benchmark_samples.json").write_text(
        json.dumps([asdict(s) for s in samples], indent=2) + "\n", encoding="utf-8"
    )
    json_path.write_text(json.dumps(asdict(report), indent=2) + "\n", encoding="utf-8")

    # Markdown summary
    lines = [
        "# CLI parallel build benchmark",
        "",
        f"- Started: `{started}`",
        f"- Finished: `{finished}`",
        f"- Wall: **{summary['wall_min']} min** ({summary['wall_sec']} s)",
        f"- Host: {host_info['cpu_count_logical']} logical CPUs, {host_info['ram_total_mb']} MB RAM",
        f"- FS: `{ROOT}`",
        f"- Hint: **{summary['bottleneck_hint']}**",
        "",
        "## Host during run",
        "",
        f"| Metric | Value |",
        f"|--------|-------|",
        f"| Peak CPU % | {summary['host_peak_cpu_pct']} |",
        f"| Avg CPU % | {summary['host_avg_cpu_pct']} |",
        f"| Peak mem used MB | {summary['host_peak_mem_used_mb']} |",
        f"| Min mem available MB | {summary['host_min_mem_avail_mb']} |",
        f"| Disk read MB (delta) | {summary['host_disk_read_mb']} |",
        f"| Disk write MB (delta) | {summary['host_disk_write_mb']} |",
        f"| Parallel efficiency | {summary['parallel_efficiency']} (sum_job_wall / wall / N) |",
        "",
        "## Per job",
        "",
        "| Plat | Pages | Leaves | Wall min | Peak RSS MB | Avg CPU% | Entries MB | Exit |",
        "|------|------:|-------:|---------:|------------:|---------:|-----------:|-----:|",
    ]
    for j in job_list:
        lines.append(
            f"| {j['platform']} | {j.get('page_count') or '?'} | {j.get('leaf_count') or '?'} | "
            f"{j['wall_sec']/60:.2f} | {j['peak_rss_mb']:.0f} | {j['avg_cpu_pct']:.0f} | "
            f"{j['out_entries_mb']:.1f} | {j['exit_code']} |"
        )
    lines.append("")
    lines.append("## Compare to prior /mnt/c run")
    lines.append("")
    lines.append("Prior 10.18 parallel on Windows path ≈ 39 min wall (6300 longest).")
    lines.append("This run uses **10.17** PDFs on **native /tmp** — compare wall_min above.")
    lines.append("")

    md_path = LOGS / "benchmark_report.md"
    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print("\n".join(lines))
    print(f"\nWrote {json_path}")
    print(f"Wrote {md_path}")
    print(f"Wrote {LOGS / 'benchmark_samples.json'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
