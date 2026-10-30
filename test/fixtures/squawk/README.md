Each case holds `base/` (optional, the base branch tree), `head/` (the PR's tree) and `expect` (the exit code).

`destructive-ignore` passes in this release because it ships only the lint step, and squawk honours a scoped
`-- squawk-ignore <rule>` comment. The destructive-change approval guard arrives as a minor release and flips it
to 1. `bare-ignore` (a `-- squawk-ignore` with no rule name) is not honoured by squawk 2.70.0: the lint fails on
its own, observed 2026-10-30.
