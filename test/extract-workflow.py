"""Print one reusable workflow as JSON: inputs with defaults, and every job's env, if, needs, outputs,
default run shell and steps (id, name, run, env, if, shell). The first job's env and steps are also
printed at the top level. Used by run-blocks.mjs, because Node has no YAML parser and this repo has no
dependencies."""
import json
import sys

import yaml

wf = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
on = wf.get(True, wf.get("on"))  # PyYAML reads the bare key `on` as boolean True
inputs = {k: v.get("default") for k, v in (on["workflow_call"].get("inputs") or {}).items()}


def steps_of(job):
    return [
        {"id": s.get("id"), "name": s.get("name"), "run": s.get("run"), "env": s.get("env") or {}, "if": s.get("if"), "shell": s.get("shell")}
        for s in job["steps"]
    ]


jobs = {}
for name, job in wf["jobs"].items():
    needs = job.get("needs") or []
    jobs[name] = {
        "env": job.get("env") or {},
        "if": job.get("if"),
        "needs": [needs] if isinstance(needs, str) else needs,
        "outputs": job.get("outputs") or {},
        "shell": ((job.get("defaults") or {}).get("run") or {}).get("shell"),
        "steps": steps_of(job),
    }
first = next(iter(jobs.values()))
json.dump({"inputs": inputs, "env": first["env"], "steps": first["steps"], "jobs": jobs}, sys.stdout)
