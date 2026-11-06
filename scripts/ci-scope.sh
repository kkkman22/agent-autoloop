#!/bin/sh
# Says how much CI a change needs, as scope=docs, normal or full. The slow simulations only cover kernel/, protocol/
# and sim/, so other code skips them on a PR, and text no test reads skips everything. A file this doesn't name, or
# a diff it can't get, means full; so does anything but pure text once it reaches main, in case a PR skipped too much.
set -u

case "${GITHUB_EVENT_NAME:-}" in
  pull_request) from=HEAD^1 ;;
  push) from=${BEFORE:-} ;;
  *) from="" ;;
esac

# Without --no-renames, moving a file out of kernel/ would show only where it landed.
if [ -z "$from" ] || ! files=$(git diff --no-renames --name-only "$from" HEAD 2>/dev/null) || [ -z "$files" ]; then
  echo "scope=full"
  exit 0
fi

scope=docs
while IFS= read -r file; do
  case "$file" in
    # These paths can weaken the checks themselves, so a change to any of them runs everything.
    .github/workflows/* | scripts/* | tests/* | package.json | package-lock.json | ops/delivery.json) kind=full ;;
    # Tests read these pages: tests/example-plugins.test.ts runs this tutorial's commands, and tests/docs-json.test.ts
    # parses the examples in them, so a change to one gets the unit tests.
    docs/protocol.md | docs/plugins.md | README.md | README.en.md) kind=normal ;;
    INSTALL.md | SECURITY.md | CONTRIBUTING.md | AGENTS.md | LICENSE | CHANGELOG.md) kind=docs ;;
    docs/* | .github/ISSUE_TEMPLATE/* | .github/pull_request_template.md) kind=docs ;;
    plugins/* | examples/* | skills/* | worker/* | host/* | cli/* | bin/* | install.sh) kind=normal ;;
    *) kind=full ;;
  esac
  case "$kind" in
    full) scope=full ;;
    normal) [ "$scope" = full ] || scope=normal ;;
  esac
done <<END
$files
END

if [ "$scope" = normal ] && [ "$GITHUB_EVENT_NAME" = push ]; then scope=full; fi
echo "scope=$scope"
