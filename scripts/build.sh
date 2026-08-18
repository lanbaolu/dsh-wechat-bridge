#!/bin/bash
# dsh-wechat-bridge build script.
# Compiles host src/ → lib/ with TypeScript. Dependency resolution:
#   1. local node_modules (npm-installed dev deps)
#   2. DSH_CHECKOUT (source checkout)
#   3. current DSH profile node_modules (~/.dsh/profiles/node_modules)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ---- Locate tsc -----------------------------------------------------------
TSC=""
if [ -x "$ROOT/node_modules/.bin/tsc" ] || [ -f "$ROOT/node_modules/.bin/tsc.cmd" ]; then
  TSC="$ROOT/node_modules/.bin/tsc"
fi

if [ -z "$TSC" ]; then
  CHECKOUT="${DSH_CHECKOUT:-}"
  if [ -z "$CHECKOUT" ]; then
    for candidate in "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness"; do
      if [ -d "$candidate/packages" ]; then CHECKOUT="$candidate"; break; fi
    done
  fi
  if [ -n "$CHECKOUT" ] && [ -d "$CHECKOUT/packages" ]; then
    if [ -x "$CHECKOUT/node_modules/.bin/tsc" ] || [ -f "$CHECKOUT/node_modules/.bin/tsc.cmd" ]; then
      TSC="$CHECKOUT/node_modules/.bin/tsc"
    fi
  fi
fi

if [ -z "$TSC" ]; then
  echo "build: cannot locate tsc (run npm install, set DSH_CHECKOUT, or use a DSH profile with typescript)" >&2
  exit 1
fi

# ---- Locate DSH runtime packages ------------------------------------------
PKG_SRC=""
if [ -d "$ROOT/node_modules/@deepseek-ai/cordis" ]; then
  PKG_SRC="$ROOT/node_modules"
elif [ -n "${DSH_CHECKOUT:-}" ] && [ -d "$DSH_CHECKOUT/vendor/cordis" ]; then
  PKG_SRC="$DSH_CHECKOUT"
elif [ -d "$HOME/.dsh/profiles/node_modules/@deepseek-ai/cordis" ]; then
  PKG_SRC="$HOME/.dsh/profiles/node_modules"
fi

if [ -z "$PKG_SRC" ]; then
  echo "build: cannot locate DSH runtime packages (@deepseek-ai/cordis not found)" >&2
  exit 1
fi

# Local node_modules already contains the DSH runtime packages (installed by
# npm/pnpm) — no linking needed. This also avoids accidental self-symlinks.
if [ "$PKG_SRC" = "$ROOT/node_modules" ]; then
  echo "=== Using local node_modules (no linking needed) ==="
  "$TSC" -p tsconfig.json
  echo "=== Build complete ==="
  exit 0
fi

echo "=== Linking build dependencies (pkg src: $PKG_SRC) ==="
mkdir -p node_modules/@deepseek-ai

# If the source is a full node_modules tree (profile), link the whole scoped
# namespace; otherwise link the individual vendor/source paths used by the
# scaffold. Keeping a namespace link avoids transitive type-resolution gaps.
if [ -d "$PKG_SRC/@deepseek-ai/cordis" ]; then
  node -e "
    const fs = require('fs');
    const path = require('path');
    const link = path.resolve('node_modules/@deepseek-ai');
    const target = path.resolve(process.argv[1]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "$PKG_SRC/@deepseek-ai"
  if [ -d "$PKG_SRC/@types/node" ]; then
    node -e "
      const fs = require('fs');
      const path = require('path');
      const link = path.resolve('node_modules/@types');
      const target = path.resolve(process.argv[1]);
      fs.rmSync(link, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    " "$PKG_SRC/@types"
  fi
else
  # Checkout source layout: vendor packages live outside @deepseek-ai.
  link_pkg() {
    local target="$PKG_SRC/$2"
    if [ ! -e "$target" ]; then
      echo "build: dependency target missing: $target" >&2
      exit 1
    fi
    node -e "
      const fs = require('fs');
      const path = require('path');
      const link = path.resolve(process.argv[1]);
      const target = path.resolve(process.argv[2]);
      fs.rmSync(link, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    " "node_modules/$1" "$target"
  }
  link_pkg @deepseek-ai/cordis vendor/cordis
  link_pkg @deepseek-ai/schemastery vendor/schemastery
  link_pkg @deepseek-ai/dsh-tools packages/core/tools
  link_pkg @deepseek-ai/dsh-llm packages/llm/llm
  link_pkg @deepseek-ai/dsh-agent packages/core/agent
  link_pkg @deepseek-ai/dsh-session packages/core/session
  link_pkg @deepseek-ai/dsh-client-ui-slots packages/client/ui-slots
  link_pkg @deepseek-ai/dsh-client-runtime packages/client/runtime
fi

# @standard-schema: profile node_modules may already expose it; checkout needs a symlink.
if [ ! -e "node_modules/@standard-schema" ] && [ -d "$PKG_SRC/@standard-schema" ]; then
  node -e "
    const fs = require('fs');
    const path = require('path');
    fs.mkdirSync('node_modules/@standard-schema', { recursive: true });
    fs.symlinkSync(path.resolve(process.argv[1]), path.resolve('node_modules/@standard-schema/spec'), process.platform === 'win32' ? 'junction' : 'dir');
  " "$PKG_SRC/@standard-schema/spec"
fi

echo "=== Compiling src → lib ==="
"$TSC" -p tsconfig.json
echo "=== Build complete ==="
