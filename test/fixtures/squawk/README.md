Each case holds `base/` (optional, the base branch tree), `head/` (the PR's tree), `expect` (the exit code) and
`expect-log` (lines the run must print, so a red case proves which check made it red). The approval cases add
`event.json` (the pull request) and `reviews.json` (what `gh api graphql` returns; the fake `gh` in `run-blocks.mjs` prints it).

- `ordinary`, `no-migration`: pass. `dangerous`: the lint fails (`require-concurrent-index-creation`).
- `destructive-ignore`, `bare-ignore`: a `squawk-ignore` does not get a DROP COLUMN past the guard.
- `cue-*`: the destructive changes that need a human. Every DROP INDEX fails on `guard-drop-index`: a dropped
  index (`cue-drop-index`), a dropped unique index (`cue-drop-unique-index`), a drop and a re-create on other
  columns under a new name (`cue-drop-index-renamed`) or the same name (`cue-drop-index-rebuilt`), and the seven
  drop-and-re-create shapes that lose a unique index on Postgres 17 (`cue-drop-index-bypass-*`: IF NOT EXISTS
  onto a plain index, an earlier no-op IF NOT EXISTS, ON ONLY a partitioned table, an unqualified name in another
  schema, an INSERT between, an index history built in a DO block, CONCURRENTLY). A removed enum value (the type
  recreated: DROP TYPE, a type change and a rename), a dropped default and a collation change each fail on their
  own rule. A COLLATE in a comment or a new table passes.
- `cue-prisma-index-rename`: `prisma migrate diff` output, byte for byte (Prisma 6.19.3 and 7.10.1 print the
  same SQL), for a `@unique(map:)` and a `@@unique` rename: `ALTER INDEX "User_email_key" RENAME TO "User_mail_key"`.
  `base/` proves each name is an index, so the guard passes it, and the config switches off squawk's
  `renaming-object` (the guard covers renames), so the whole job passes. `cue-alter-index-on-a-table` (the name is
  a table in `base/`) and `cue-alter-index-table-dropped-since` fail on `guard-rename`, and so does
  `cue-table-rename` (`ALTER TABLE users RENAME TO people`).
- `log-injection-filename`: a migration whose name holds newlines and `::notice` / `::add-mask::` lines
  (`head-rename.json` gives it that name at run time). `reject-commands` proves the runner would act on none of
  them.
- `cue-approved*`: an approval of the head commit by a writer who is not the author clears the guard, and the
  lint still needs its scoped ignore (`cue-approved-no-ignore`). A stale commit, the author, a reader without
  push access, and an approval since dismissed do not clear it; each says why.
