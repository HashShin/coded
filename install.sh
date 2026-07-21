#!/bin/sh
set -e

REPO="HashShin/coded"
BINARY="coded"

# Detect OS and arch
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64)  ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  armv7l)  ARCH="armv7" ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

case "$OS" in
  linux|darwin) ;;
  *)
    echo "Unsupported OS: $OS"
    echo "For Windows, use: irm https://raw.githubusercontent.com/${REPO}/main/install.ps1 | iex"
    exit 1
    ;;
esac

# Get latest release tag
TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed 's/.*"tag_name": *"\(.*\)".*/\1/')"

if [ -z "$TAG" ]; then
  echo "Failed to fetch latest release tag"
  exit 1
fi

FILENAME="${BINARY}_${OS}_${ARCH}"
URL="https://github.com/${REPO}/releases/download/${TAG}/${FILENAME}"

echo "Installing coded ${TAG} for ${OS}/${ARCH}..."
echo "Downloading from: $URL"

# Download to temp file
TMP="$(mktemp)"
curl -fsSL "$URL" -o "$TMP"
chmod +x "$TMP"

# Install to /usr/local/bin or ~/bin as fallback
if [ -w /usr/local/bin ]; then
  mv "$TMP" /usr/local/bin/coded
  echo "Installed to /usr/local/bin/coded"
elif [ -d "$HOME/.local/bin" ]; then
  mv "$TMP" "$HOME/.local/bin/coded"
  echo "Installed to $HOME/.local/bin/coded"
else
  mkdir -p "$HOME/bin"
  mv "$TMP" "$HOME/bin/coded"
  echo "Installed to $HOME/bin/coded"
  echo "Make sure $HOME/bin is in your PATH"
fi

echo "Done! Run: coded"
