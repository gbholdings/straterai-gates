#!/usr/bin/env bash
# classification prisma --emit-comments on a real Postgres (pgvector, for the fixture's embeddings table).
# self-test.yml's emit-comments job runs it against its service container; run it locally against your own:
#
#   PG=<container id or name> bash test/emit-comments-pg.sh
#
# The emitted migration applies after the schema's own and every tagged column then carries its tier as its
# comment; a second run writes nothing; then a migration drops a tagged column and adds it back, which
# loses its comment in Postgres, and the next run writes it again.
set -euo pipefail
F=test/fixtures/governance/privacy
: "${PG:?PG names the Postgres container}"
db="emit_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
docker exec -i "$PG" psql -U postgres -v ON_ERROR_STOP=1 -X -q -c "create database $db" </dev/null
trap 'docker exec -i "$PG" psql -U postgres -X -q -c "drop database if exists $db" </dev/null >/dev/null 2>&1 || true' EXIT
psql() { docker exec -i "$PG" psql -U postgres -d "$db" -v ON_ERROR_STOP=1 -X -q "$@"; }
psql -tAc "select version()" </dev/null
comment() { psql -tAc "select coalesce(col_description('$1'::regclass, attnum), 'NULL') from pg_attribute where attrelid = '$1'::regclass and attname = '$2'" </dev/null; }
emit() { node scripts/governance-check.mjs classification prisma --schema "$F/schema.prisma" --tiers "$F/tiers.json" --emit-comments "$W/migrations" --date "$1"; }
apply() { psql < "$W/migrations/$1/migration.sql"; }
W=$(mktemp -d)
cp -R "$F/migrations" "$W/migrations"
emit 2026-10-30T12:00:00Z
sql=$(ls "$W"/migrations/*_classification_comments/migration.sql 2>/dev/null | head -1)
[ -n "$sql" ] && [ -f "$sql" ] || { echo "::error::--emit-comments wrote no migration"; exit 1; }
for m in $(ls "$W/migrations" | sort); do apply "$m"; done
got=$(comment people tax_id)
[ "$got" = "classification:restricted" ] || { echo "::error::people.tax_id has comment '$got'"; exit 1; }
n=$(psql -tAc "select count(*) from pg_attribute a join pg_class c on c.oid = a.attrelid where c.relname in ('people','notes','note_embeddings','sessions') and a.attnum > 0 and col_description(c.oid, a.attnum) like 'classification:%'" </dev/null)
[ "$n" = 13 ] || { echo "::error::$n columns carry a classification comment, want 13"; exit 1; }
before=$(ls "$W/migrations" | wc -l)
emit 2026-10-31T12:00:00Z
[ "$(ls "$W/migrations" | wc -l)" = "$before" ] || { echo "::error::a second run wrote a migration with no tag changed"; exit 1; }
echo "13 columns carry their tier as a Postgres comment; the second run wrote nothing"
# Drop tax_id and add it back, as Prisma writes a type change: Postgres drops the comment with the column.
mkdir "$W/migrations/20261101000000_drop_tax_id" "$W/migrations/20261102000000_add_tax_id"
printf -- '-- AlterTable\nALTER TABLE "people" DROP COLUMN "tax_id";\n' > "$W/migrations/20261101000000_drop_tax_id/migration.sql"
printf -- '-- AlterTable\nALTER TABLE "people" ADD COLUMN "tax_id" TEXT;\n' > "$W/migrations/20261102000000_add_tax_id/migration.sql"
apply 20261101000000_drop_tax_id
apply 20261102000000_add_tax_id
got=$(comment people tax_id)
[ "$got" = "NULL" ] || { echo "::error::after the drop and add, people.tax_id has comment '$got'; want none"; exit 1; }
emit 2026-11-03T12:00:00Z
again="$W/migrations/20261103120000_classification_comments"
[ -f "$again/migration.sql" ] || { echo "::error::after a drop and re-add, --emit-comments wrote no migration, so people.tax_id stays without its comment"; exit 1; }
cat "$again/migration.sql"
apply 20261103120000_classification_comments
got=$(comment people tax_id)
[ "$got" = "classification:restricted" ] || { echo "::error::after the re-emit, people.tax_id has comment '$got'"; exit 1; }
echo "a column dropped and added back gets its comment again"
