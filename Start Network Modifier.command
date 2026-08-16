#!/bin/bash
# Double-click this file in Finder to start Network Modifier.
cd "$(dirname "$0")" || exit 1

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
RUNTIME_DIR="$PWD/.runtime"
DATA_DIR="${NETMOD_HOME:-$HOME/.network-modifier}"

fail() {
  echo
  echo "Setup could not finish: $1"
  read -r -p "Press return to close."
  exit 1
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
  tar -xzf "$RUNTIME_DIR/$archive" -C "$RUNTIME_DIR" || fail "Could not unpack Node.js."
  mv "$RUNTIME_DIR/${archive%.tar.gz}" "$RUNTIME_DIR/node" || fail "Could not finish installing Node.js."
  rm -f "$RUNTIME_DIR/$archive" "$checksums"
}

if ! command -v node >/dev/null 2>&1; then
  [ -x "$RUNTIME_DIR/node/bin/node" ] || install_local_node
  export PATH="$RUNTIME_DIR/node/bin:$PATH"
fi

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
node bin/netmod.js start --browser "$@" || fail "Network Modifier stopped unexpectedly."
