#!/usr/bin/env bash
set -euo pipefail

# Compute changed files between base and head SHAs
base="${AIRLOCK_BASE_SHA:-HEAD~1}"
head="${AIRLOCK_HEAD_SHA:-HEAD}"

# Get committed changes between SHAs
changed_files=$(git diff --name-only --diff-filter=ACMR "$base" "$head" 2>/dev/null || true)

# Also include uncommitted changes (staged + unstaged) if any
uncommitted=$(git diff --name-only --diff-filter=ACMR HEAD 2>/dev/null || true)
staged=$(git diff --name-only --diff-filter=ACMR --cached 2>/dev/null || true)

# Merge and deduplicate all changed files
changed_files=$(printf '%s\n%s\n%s' "$changed_files" "$uncommitted" "$staged" | sort -u | sed '/^$/d')

if [ -z "$changed_files" ]; then
  echo "No changed files detected."
  exit 0
fi

# Filter to TypeScript files
ts_files=()
while IFS= read -r file; do
  if [[ "$file" == *.ts || "$file" == *.tsx ]]; then
    # Only include files that still exist (not deleted)
    if [ -f "$file" ]; then
      ts_files+=("$file")
    fi
  fi
done <<< "$changed_files"

if [ ${#ts_files[@]} -eq 0 ]; then
  echo "No TypeScript files changed — nothing to lint."
  exit 0
fi

echo "Linting ${#ts_files[@]} changed TypeScript file(s):"
printf '  %s\n' "${ts_files[@]}"
echo ""

errors=0

# Step 0: Ensure dependencies are installed
if [ ! -d "node_modules" ]; then
  echo "==> npm install (dependencies missing)"
  npm install --ignore-scripts 2>&1
  echo "    Dependencies installed."
  echo ""
fi

# Step 1: Auto-fix formatting with Prettier
echo "==> Prettier --write (auto-fix)"
if npx prettier --write "${ts_files[@]}" 2>&1; then
  echo "    Prettier auto-fix done."
else
  echo "    Prettier auto-fix encountered issues."
fi
echo ""

# Step 2: Verify formatting is clean
echo "==> Prettier --check (verify)"
if npx prettier --check "${ts_files[@]}" 2>&1; then
  echo "    Prettier check passed."
else
  echo "    Prettier check FAILED — formatting issues remain."
  errors=1
fi
echo ""

# Step 3: TypeScript type-check (whole project, since types are interconnected)
echo "==> tsc --noEmit (type-check)"
if npx tsc --noEmit 2>&1; then
  echo "    TypeScript check passed."
else
  echo "    TypeScript check FAILED."
  errors=1
fi
echo ""

if [ "$errors" -ne 0 ]; then
  echo "FAIL: Some checks did not pass."
  exit 1
fi

echo "All checks passed."
exit 0
