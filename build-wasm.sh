#!/usr/bin/env bash
# Builds the Rust engine into wasm/text_engine.js and wasm/text_engine_bg.wasm.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "wasm-pack is not installed. Install it with: cargo install wasm-pack" >&2
  exit 1
fi

wasm-pack build rust-engine --target web --release --out-dir ../wasm --out-name text_engine

for f in wasm/text_engine.js wasm/text_engine_bg.wasm; do
  if [ ! -f "$f" ]; then
    echo "Build finished but $f is missing." >&2
    exit 1
  fi
done
echo "WASM build complete: wasm/text_engine.js and wasm/text_engine_bg.wasm"
