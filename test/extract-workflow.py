"""Print one reusable workflow's first job as JSON: inputs with defaults, job env, and each step's id, name, run, env and if.
Used by run-blocks.mjs, because Node has no YAML parser and this repo has no dependencies."""
import json
import sys

import yaml

wf = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
on = wf.get(True, wf.get("on"))  # PyYAML reads the bare key `on` as boolean True
inputs = {k: v.get("default") for k, v in (on["workflow_call"].get("inputs") or {}).items()}
job = next(iter(wf["jobs"].values()))
steps = [
    {"id": s.get("id"), "name": s.get("name"), "run": s.get("run"), "env": s.get("env") or {}, "if": s.get("if"), "shell": s.get("shell")}
    for s in job["steps"]
]
json.dump({"inputs": inputs, "env": job.get("env") or {}, "steps": steps}, sys.stdout)
