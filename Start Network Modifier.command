#!/bin/bash
# Double-click this file in Finder to start Network Modifier.
cd "$(dirname "$0")" || exit 1

# Appended, not prepended, so a version manager (nvm/asdf) on the user's PATH still wins.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
RUNTIME_DIR="$PWD/.runtime"
DATA_DIR="${NETMOD_HOME:-$HOME/.network-modifier}"
MIN_NODE_MAJOR=20
MIN_NODE_MINOR=19

fail() {
  echo
  echo "Setup could not finish: $1"
  read -r -p "Press return to close."
  exit 1
}

node_is_supported() {
  local version major minor
  version="$("$1" -v 2>/dev/null)" || return 1
  version="${version#v}"
  major="${version%%.*}"
  minor="${version#*.}"
  minor="${minor%%.*}"
  case "$major" in '' | *[!0-9]*) return 1 ;; esac
  case "$minor" in '' | *[!0-9]*) minor=0 ;; esac
  [ "$major" -gt "$MIN_NODE_MAJOR" ] && return 0
  [ "$major" -eq "$MIN_NODE_MAJOR" ] && [ "$minor" -ge "$MIN_NODE_MINOR" ]
}

install_local_node() {
  case "$(uname -m)" in
    arm64) node_arch="arm64" ;;
    x86_64) node_arch="x64" ;;
    *) fail "This Mac's processor is not supported." ;;
  esac

  echo "First run: downloading Node.js..."
  mkdir -p "$RUNTIME_DIR" || fail "Could not create the local runtime folder."
  checksums="$RUNTIME_DIR/SHASUMS256.txt"
  curl -fL "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt" -o "$checksums" || fail "Could not download Node.js. Check your internet connection."
  archive="$(awk -v arch="darwin-$node_arch.tar.gz" '$2 ~ arch "$" { print $2; exit }' "$checksums")"
  [ -n "$archive" ] || fail "Could not find a compatible Node.js download."
  curl -fL "https://nodejs.org/dist/latest-v22.x/$archive" -o "$RUNTIME_DIR/$archive" || fail "Could not download Node.js."
  (cd "$RUNTIME_DIR" && grep " $archive$" SHASUMS256.txt | shasum -a 256 -c -) || fail "The Node.js download failed its security check."
  rm -rf "$RUNTIME_DIR/node"
  tar -xzf "$RUNTIME_DIR/$archive" -C "$RUNTIME_DIR" || fail "Could not unpack Node.js."
  mv "$RUNTIME_DIR/${archive%.tar.gz}" "$RUNTIME_DIR/node" || fail "Could not finish installing Node.js."
  rm -f "$RUNTIME_DIR/$archive" "$checksums"
}

node_bin=""
for candidate in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node "$RUNTIME_DIR/node/bin/node"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ] && node_is_supported "$candidate"; then
    node_bin="$candidate"
    break
  fi
done

if [ -z "$node_bin" ]; then
  echo "Network Modifier needs Node.js $MIN_NODE_MAJOR.$MIN_NODE_MINOR or newer."
  install_local_node
  node_bin="$RUNTIME_DIR/node/bin/node"
  node_is_supported "$node_bin" || fail "The downloaded Node.js could not be used."
fi

# Put the chosen install first so `node` and `npm` in this script always agree.
export PATH="$(dirname "$node_bin"):$PATH"
echo "Using Node.js $(node -v) from $node_bin"

if [ ! -d node_modules ]; then
  echo "First run: installing dependencies..."
  npm install --no-audit --no-fund || fail "Dependencies could not be installed."
fi

mkdir -p "$DATA_DIR" || fail "Could not create the settings folder."
cert_path="$DATA_DIR/netmod-ca.crt"
stamp_path="$DATA_DIR/launcher-trust.sha256"
cert_hash=""
[ -f "$cert_path" ] && cert_hash="$(shasum -a 256 "$cert_path" | awk '{ print $1 }')"

if [ -z "$cert_hash" ] || [ ! -f "$stamp_path" ] || [ "$(cat "$stamp_path")" != "$cert_hash" ]; then
  echo "First run: macOS may ask for permission to trust Network Modifier's local certificate."
  node bin/netmod.js trust || fail "The local certificate was not trusted."
  shasum -a 256 "$cert_path" | awk '{ print $1 }' > "$stamp_path"
fi

echo "Starting Network Modifier..."
if ! node bin/netmod.js start --browser "$@"; then
  echo "Turning the system proxy back off so the internet keeps working..."
  node bin/netmod.js system-proxy off >/dev/null 2>&1
  fail "Network Modifier stopped unexpectedly."
fi
