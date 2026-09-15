#!/usr/bin/env bash
# Verify one deployed dsh-interconnect instance from this checkout.
#
# Encodes the checks the release runbook prescribes, so a version roll-out is
# verified the same way every time instead of by hand: version read-back,
# profile layer list, `/` and `/interconnect/link` responses, the five-frame
# protocol probe, and the artifact hash chain against this repository's build.
#
# Linux hosts only. Windows needs the `powershell -EncodedCommand` path (see
# RELEASING.md) because it has no POSIX shell over ssh.
#
# Usage:
#   scripts/verify-deployment.sh <ssh-host> <port> <ws-module-path> [<cross-leg-port>]
#
#   <ssh-host>          an ssh alias, e.g. CI-Server
#   <port>              the instance's local web port, e.g. 3080
#   <ws-module-path>    path to the `ws` package on that host
#   <cross-leg-port>    optional second port reached through this host's tunnel;
#                       the probe then also proves that leg carries the protocol
#
# Exit status: 0 when every check passes, 1 otherwise. Never prints the token.

set -uo pipefail

HOST=${1:?usage: verify-deployment.sh <ssh-host> <port> <ws-module-path> [<cross-leg-port>]}
PORT=${2:?missing port}
WS=${3:?missing ws module path}
CROSS=${4:-}
ROOT=$(cd "$(dirname "$0")/.." && pwd)

SSH=(ssh -o ConnectTimeout=20 "$HOST")
fails=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; fails=$((fails + 1)); }

# The credential lives under `refs:` with two leading spaces; never echo it.
TOKEN=$("${SSH[@]}" "sed -n 's/^  DSH_INTERCONNECT_TOKEN: *//p' \$HOME/.dsh/.credentials.yaml | head -1 | tr -d '\"'" 2>/dev/null)
if [ -z "$TOKEN" ]; then fail 'token read from the host credential store'; else pass 'token read from the host credential store'; fi

VERSION=$("${SSH[@]}" "node -p \"require(process.env.HOME+'/.dsh/profiles/web/node_modules/dsh-interconnect/dsh.plugin.json').version\"" 2>/dev/null)
LOCAL_VERSION=$(node -p "require('$ROOT/package.json').version" 2>/dev/null)
if [ -n "$VERSION" ] && [ "$VERSION" = "$LOCAL_VERSION" ]; then
  pass "installed plugin version matches this checkout ($VERSION)"
else
  fail "installed plugin version '$VERSION' != checkout '$LOCAL_VERSION'"
fi

LAYERS=$("${SSH[@]}" "node -p \"JSON.stringify(require(process.env.HOME+'/.dsh/profiles/web/package.json').dsh.profile.bundles)\"" 2>/dev/null)
case "$LAYERS" in
  *dsh-interconnect*|*interconnect-profile*) pass "profile layers: $LAYERS" ;;
  *) fail "profile layers look wrong: $LAYERS" ;;
esac

# `/` returns 404 while the tree composes, so poll for the settled 401.
ROOT_CODE=$("${SSH[@]}" "for i in \$(seq 1 10); do c=\$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:$PORT/); [ \"\$c\" = 401 ] && break; sleep 3; done; echo \$c" 2>/dev/null | tail -1)
if [ "$ROOT_CODE" = 401 ]; then pass "GET / -> 401 (unauthenticated)"; else fail "GET / -> $ROOT_CODE (want 401)"; fi

LINK_CODE=$("${SSH[@]}" "curl -s -o /dev/null -w '%{http_code}' --max-time 8 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' http://127.0.0.1:$PORT/interconnect/link" 2>/dev/null | tail -1)
if [ "$LINK_CODE" = 401 ]; then pass 'WS /interconnect/link without a token -> 401'; else fail "WS /interconnect/link -> $LINK_CODE (want 401)"; fi

probe() {
  local port=$1
  "${SSH[@]}" "IC_TOKEN='$TOKEN' IC_PORT=$port IC_WS='$WS' node -" < "$ROOT/scripts/probe-deployed-link.cjs" 2>&1 | tail -5
}

SELF=$(probe "$PORT")
if printf '%s' "$SELF" | grep -q '^hello from: '; then
  pass "five-frame probe on $PORT: $(printf '%s' "$SELF" | head -1)"
else
  fail "five-frame probe on $PORT: $(printf '%s' "$SELF" | tr '\n' ' ')"
fi

if [ -n "$CROSS" ]; then
  LEG=$(probe "$CROSS")
  if printf '%s' "$LEG" | grep -q '^hello from: '; then
    pass "five-frame probe through the tunnel on $CROSS: $(printf '%s' "$LEG" | head -1)"
  else
    fail "five-frame probe through the tunnel on $CROSS: $(printf '%s' "$LEG" | tr '\n' ' ')"
  fi
fi

# The artifact chain: comments are stripped from lib/, so these must match
# byte-for-byte for the same version unless this checkout moved on after the
# release (see RELEASING.md).
CHAIN='lib/index.js lib/interconnect/index.js lib/tool-interconnect/index.js lib/skill-interconnect/index.js assets/dsh-interconnect.md cordis.patch.yml dsh.plugin.json'
if command -v sha256sum >/dev/null 2>&1; then HASH='sha256sum'; else HASH='shasum -a 256'; fi
local_hashes=$(cd "$ROOT" && $HASH $CHAIN 2>/dev/null | awk '{print substr($1,1,16), $2}' | sort)
remote_hashes=$("${SSH[@]}" "cd \$HOME/.dsh/profiles/web/node_modules/dsh-interconnect && sha256sum $CHAIN 2>/dev/null | awk '{print substr(\$1,1,16), \$2}' | sort" 2>/dev/null)
if [ -n "$local_hashes" ] && [ "$local_hashes" = "$remote_hashes" ]; then
  pass 'artifact hash chain matches this checkpoint'
else
  fail 'artifact hash chain differs:'
  diff <(printf '%s\n' "$local_hashes") <(printf '%s\n' "$remote_hashes") | sed 's/^/      /'
fi

printf '%s: %s\n' "$HOST" "$([ "$fails" -eq 0 ] && echo 'all checks passed' || echo "$fails check(s) failed")"
[ "$fails" -eq 0 ]
