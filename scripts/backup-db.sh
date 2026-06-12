#!/usr/bin/env bash
# ============================================================================
# A2: off-site backup of the Supabase Postgres (the financial ledger lives here
# and the free tier has NO automatic backups + deletes projects on inactivity —
# it already happened once). Run on a schedule (cron / a cheap box / GitHub
# Action) until the project is on Supabase Pro (which gives PITR).
#
# Setup:
#   1. Supabase Dashboard → Project Settings → Database → Connection string
#      (use the "Session"/direct connection, NOT the pooler, for pg_dump).
#   2. export SUPABASE_DB_URL="postgresql://postgres:<pwd>@db.<ref>.supabase.co:5432/postgres"
#   3. ./scripts/backup-db.sh   →   writes backups/photoforge-YYYYMMDD-HHMM.sql.gz
#
# Keep the dumps somewhere OFF Supabase (S3 / Backblaze / Google Drive / git-crypt).
# ============================================================================
set -euo pipefail

: "${SUPABASE_DB_URL:?Set SUPABASE_DB_URL to your Supabase direct connection string}"

mkdir -p backups
STAMP="$(date +%Y%m%d-%H%M)"
OUT="backups/photoforge-${STAMP}.sql.gz"

echo "Dumping → ${OUT}"
pg_dump "${SUPABASE_DB_URL}" \
  --no-owner --no-privileges \
  --schema=public \
  | gzip > "${OUT}"

# Retain the last 30 dumps locally.
ls -1t backups/photoforge-*.sql.gz | tail -n +31 | xargs -r rm -f

echo "Done: $(du -h "${OUT}" | cut -f1) ${OUT}"
