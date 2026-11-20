#!/bin/sh
# Rules written for the shell version still point here; it hands over to the Node one, which also runs on Windows.
# New rules use ["node", ".../examples/recipes/github-issues/watch.ts", "owner/repo", ...] directly.
exec node "$(dirname "$0")/recipes/github-issues/watch.ts" "$@"
