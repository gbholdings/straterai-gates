"""Write a GX Core file data context with one checkpoint, as GX itself stores it.

    python -I make_context.py <dir> [routed|no-route|success-only|no-owner|placeholder-owner|email-no-smtp]

email-no-smtp is the routed context with its checkpoint's action then edited by hand, as a person would, into
an email action with no SMTP server: GX will not write that, and GX refuses to load it.

The self-test runs this with great_expectations from requirements/great-expectations.txt and then runs
`governance-check monitors --gx <dir>/gx` on the result, so the check reads what GX writes, not a copy.
"""
import json
import os
import sys

os.environ["GX_ANALYTICS_ENABLED"] = "false"

import great_expectations as gx  # noqa: E402
from great_expectations.checkpoint import SlackNotificationAction  # noqa: E402

VARIANTS = ("routed", "no-route", "success-only", "no-owner", "placeholder-owner", "email-no-smtp")


def main(argv):
    if len(argv) not in (1, 2) or (len(argv) == 2 and argv[1] not in VARIANTS):
        print(f"usage: make_context.py <dir> [{'|'.join(VARIANTS)}]", file=sys.stderr)
        return 2
    root, variant = argv[0], (argv[1] if len(argv) == 2 else "routed")
    os.makedirs(root, exist_ok=True)
    ctx = gx.get_context(mode="file", project_root_dir=root)
    batch = ctx.data_sources.add_pandas("orders_source").add_dataframe_asset("orders").add_batch_definition_whole_dataframe("all")
    meta = {} if variant == "no-owner" else {"owner": "TODO" if variant == "placeholder-owner" else "data-platform"}
    suite = ctx.suites.add(gx.ExpectationSuite(name="orders_arrived", meta=meta))
    suite.add_expectation(gx.expectations.ExpectTableRowCountToBeBetween(min_value=1))
    vd = ctx.validation_definitions.add(gx.ValidationDefinition(name="orders_arrived", data=batch, suite=suite))
    actions = []
    if variant != "no-route":
        notify_on = "success" if variant == "success-only" else "failure"
        actions.append(SlackNotificationAction(name="page_data_platform", slack_webhook="${SLACK_WEBHOOK}", notify_on=notify_on))
    ctx.checkpoints.add(gx.Checkpoint(name="orders_arrived", validation_definitions=[vd], actions=actions))
    if variant == "email-no-smtp":
        cp_file = os.path.join(root, "gx", "checkpoints", "orders_arrived.json")
        with open(cp_file, encoding="utf-8") as f:
            cp = json.load(f)
        cp["actions"] = [{"name": "email_data_platform", "type": "email", "notify_on": "failure", "receiver_emails": "oncall@data-team.test", "smtp_address": None, "smtp_port": None}]
        with open(cp_file, "w", encoding="utf-8") as f:
            json.dump(cp, f, indent=2)
    print(f"wrote {variant} context at {root}/gx")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
