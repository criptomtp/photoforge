#!/usr/bin/env bash
# Run this after: export SUPABASE_ACCESS_TOKEN=your_token

set -e

PROJECT_NAME="photoforge"
ORG_ID=""  # Fill in your org ID from: supabase orgs list
REGION="eu-central-1"
DB_PASS=$(openssl rand -base64 24 | tr -d '=/+' | cut -c1-20)

echo "Creating Supabase project '$PROJECT_NAME'..."
PROJECT=$(supabase projects create "$PROJECT_NAME" \
  --org-id "$ORG_ID" \
  --region "$REGION" \
  --db-password "$DB_PASS" \
  --output json 2>/dev/null || echo "{}")

REF=$(echo "$PROJECT" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$REF" ]; then
  echo "Project may already exist. Listing projects..."
  supabase projects list
  echo "Set REF manually below and re-run from step 2"
  exit 1
fi

echo "Project ref: $REF"
echo "Waiting for project to be ready..."
sleep 15

echo "Linking project..."
supabase link --project-ref "$REF"

echo "Running migrations..."
supabase db push

echo "Getting API keys..."
supabase projects api-keys --project-ref "$REF"

echo ""
echo "Done! Copy the keys above into .env.local and Vercel env vars."
