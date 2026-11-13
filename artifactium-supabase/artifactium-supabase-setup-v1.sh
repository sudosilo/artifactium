#!/usr/bin/env bash
# Artifactium Supabase setup v1
# Creates the artifactium Supabase project, switches sign in emails to a typed code,
# and writes the public URL and key to artifactium-supabase-v1.env next to this script.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SUDO=""
if [ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1; then SUDO=sudo; fi
need(){ command -v "$1" >/dev/null 2>&1; }

if ! need jq || ! need curl || ! need od; then
  $SUDO apt-get update -y >/dev/null
  $SUDO apt-get install -y jq curl ca-certificates coreutils >/dev/null
fi

if ! need supabase; then
  case "$(uname -m)" in
    aarch64|arm64) A=arm64 ;;
    x86_64|amd64) A=amd64 ;;
    *) echo "This CPU is not supported by the Supabase CLI: $(uname -m)"; exit 1 ;;
  esac
  echo "Installing the Supabase CLI."
  curl -fsSL "https://github.com/supabase/cli/releases/latest/download/supabase_linux_${A}.tar.gz" | tar -xz -C /tmp supabase
  $SUDO install -m 755 /tmp/supabase /usr/local/bin/supabase
fi

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ] && [ ! -s "$HOME/.supabase/access-token" ]; then
  echo "Open the link below, approve it, then type the verification code here."
  supabase login --no-browser
fi
TOKEN="${SUPABASE_ACCESS_TOKEN:-$(cat "$HOME/.supabase/access-token" 2>/dev/null || true)}"

ORG=$(supabase orgs list -o json | jq -r '.[0].id // .[0].slug')
REF=$(supabase projects list -o json | jq -r '.[] | select(.name=="artifactium") | (.ref // .id)' | head -n1)
PW=""
if [ -z "$REF" ]; then
  echo "Creating the artifactium Supabase project."
  PW=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
  REF=$(supabase projects create artifactium --org-id "$ORG" --db-password "$PW" --region us-west-1 -o json | jq -r '.ref // .id')
fi

echo "Waiting for the project to come up."
for i in $(seq 1 90); do
  ST=$(supabase projects list -o json | jq -r --arg r "$REF" '.[] | select((.ref // .id)==$r) | .status')
  [ "$ST" = "ACTIVE_HEALTHY" ] && break
  sleep 10
done

KEY=""
for i in $(seq 1 30); do
  KEY=$(supabase projects api-keys --project-ref "$REF" -o json | jq -r '([.[] | select(.type=="publishable")][0].api_key) // ([.[] | select(.name=="anon")][0].api_key) // empty')
  [ -n "$KEY" ] && break
  sleep 10
done

TPL='<div style="font-family:Arial,sans-serif;max-width:420px"><h2 style="color:#1d5fc4;letter-spacing:3px">ARTIFACTIUM</h2><p>Your sign in code:</p><p style="font-size:30px;font-weight:bold;letter-spacing:8px;color:#1d2430">{{ .Token }}</p><p>Type it into Artifactium to finish signing in.</p></div>'
BODY=$(jq -n --arg t "$TPL" '{mailer_subjects_magic_link:"Your Artifactium sign in code",mailer_templates_magic_link_content:$t,mailer_subjects_confirmation:"Your Artifactium sign in code",mailer_templates_confirmation_content:$t}')
if [ -n "$TOKEN" ] && curl -fsS -X PATCH "https://api.supabase.com/v1/projects/$REF/config/auth" \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$BODY" >/dev/null; then
  echo "Sign in emails now send a typed code."
else
  echo "Sign in email template was not updated."
fi

URL="https://$REF.supabase.co"
printf 'SUPABASE_URL=%s\nSUPABASE_ANON_KEY=%s\n' "$URL" "$KEY" > "$HERE/artifactium-supabase-v1.env"
echo
echo "SAVE THIS  Supabase URL: $URL"
echo "SAVE THIS  Supabase publishable key: $KEY"
if [ -n "$PW" ]; then echo "SAVE THIS  Supabase database password: $PW"; fi
