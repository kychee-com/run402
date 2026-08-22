#!/usr/bin/env bash
# D182 acceptance rule 3 — "never assembled":
#  1. the HPKE module imports only the `hpke` crate (no x25519_dalek / hkdf / chacha20poly1305);
#  2. no other module touches HPKE at all;
#  3. `hpke` is an unpatched crates.io release at the pinned version + checksum.
set -euo pipefail
cd "$(dirname "$0")/.."

HPKE_MOD=src/hpke_envelope.rs
PIN_VERSION="0.14.0"
PIN_CHECKSUM="dd5130e119706b4d8c2180da6126f7e60b6c38c2d340d539219f57051f0a7af7"

fail() { echo "never-assembled-gate: $*" >&2; exit 1; }

# 1. forbidden primitive imports inside the HPKE module
if grep -nE '^\s*use\s+(x25519_dalek|hkdf|chacha20poly1305|sha2|hmac|curve25519_dalek)\b' "$HPKE_MOD"; then
  fail "$HPKE_MOD imports a primitive crate — HPKE must come from the hpke crate only"
fi
if grep -nE '\b(x25519_dalek|chacha20poly1305|hkdf)::' "$HPKE_MOD"; then
  fail "$HPKE_MOD references a primitive crate path"
fi

# 2. HPKE is confined to the one module
if grep -rlE '\bhpke::' src --include='*.rs' | grep -v "^$HPKE_MOD$"; then
  fail "hpke:: referenced outside $HPKE_MOD"
fi

# 3. the pin: exact version, registry source, checksum
if ! grep -qE '^hpke = \{ version = "=0\.14\.0"' Cargo.toml; then
  fail "Cargo.toml must pin hpke = \"=$PIN_VERSION\""
fi
if ! grep -qE 'default-features = false' <(grep -E '^hpke = ' Cargo.toml); then
  fail "hpke must have default-features = false"
fi
block="$(awk '/^name = "hpke"$/{f=1} f&&/^$/{exit} f' Cargo.lock)"
echo "$block" | grep -q "version = \"$PIN_VERSION\"" || fail "Cargo.lock does not pin hpke $PIN_VERSION"
echo "$block" | grep -q 'source = "registry+https://github.com/rust-lang/crates.io-index"' || fail "hpke is not a crates.io registry release"
echo "$block" | grep -q "checksum = \"$PIN_CHECKSUM\"" || fail "hpke checksum differs from the pinned $PIN_CHECKSUM"
if grep -qE '^\[patch' Cargo.toml; then
  fail "Cargo.toml carries a [patch] section"
fi
cargo tree -e normal -i hpke --locked >/dev/null || fail "cargo tree -i hpke failed (lockfile drift?)"

echo "never-assembled-gate: OK (hpke $PIN_VERSION, registry, checksum pinned; HPKE confined to $HPKE_MOD)"
