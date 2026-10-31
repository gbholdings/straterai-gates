Each case holds `base/` (optional, the base branch tree), `head/` (the PR's tree), `expect` (the exit code) and
`expect-log` (lines the run must print, so a red case proves which check made it red). The approval cases add
`event.json` (the pull request) and `reviews.json` (what `gh api graphql` returns; `test/bin/gh` prints it).

- `ordinary`, `no-migration`: pass. `dangerous`: the lint fails (`require-concurrent-index-creation`).
- `destructive-ignore`, `bare-ignore`: a `squawk-ignore` does not get a DROP COLUMN past the guard.
- `cue-*`: the destructive changes that need a human. A dropped index (`cue-drop-index`), a dropped unique
  index (`cue-drop-unique-index`), a drop and a re-create on other columns under a new name
  (`cue-drop-index-renamed`) or the same name (`cue-drop-index-rebuilt`), a removed enum value (the type
  recreated: DROP TYPE, a type change and a rename), a dropped default and a collation change each fail on their
  own rule. A Prisma `@unique` rename, the same unique index built again under a new name, passes
  (`cue-drop-index-prisma-rename`): the guard reads what the dropped index was from `base/`. So does a COLLATE in
  a comment or a new table.
- `cue-approved*`: an approval of the head commit by a writer who is not the author clears the guard, and the
  lint still needs its scoped ignore (`cue-approved-no-ignore`). A stale commit, the author, a reader without
  push access, and an approval since dismissed do not clear it; each says why.
