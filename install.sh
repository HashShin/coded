#!/bin/sh
set -e

REPO="HashShin/coded"
BINARY="coded"

# ── Color / formatting ────────────────────────────────────────────────────────
if [ -t 1 ] && [ "${TERM:-}" != "dumb" ]; then
  ESC=$(printf '\033')
  BOLD="${ESC}[1m"; DIM="${ESC}[2m"; RESET="${ESC}[0m"
  GREEN="${ESC}[32m"; CYAN="${ESC}[36m"; RED="${ESC}[31m"; YELLOW="${ESC}[33m"
else
  BOLD=; DIM=; RESET=; GREEN=; CYAN=; RED=; YELLOW=
fi

# ── Spinner frames ────────────────────────────────────────────────────────────
case "${LC_ALL:-${LANG:-}}" in
  *UTF-8*|*utf8*)
    SPIN_FRAMES='⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏'
    DONE_MARK='✓'
    BAR_FILL='█'
    BAR_EMPTY='░'
    ;;
  *)
    SPIN_FRAMES='- \ | /'
    DONE_MARK='*'
    BAR_FILL='#'
    BAR_EMPTY='-'
    ;;
esac
SPIN_COUNT=0
for f in $SPIN_FRAMES; do SPIN_COUNT=$((SPIN_COUNT + 1)); done

# Return the Nth (1-indexed) frame from SPIN_FRAMES.
spin_frame() {
  idx=$(( ($1 % SPIN_COUNT) + 1 ))
  i=0
  for f in $SPIN_FRAMES; do
    i=$((i + 1))
    [ "$i" = "$idx" ] && printf '%s' "$f" && return
  done
}

info()    { printf '%s\n' "${CYAN}${BOLD}=>${RESET} $*"; }
success() { printf '%s\n' "${GREEN}${BOLD}${DONE_MARK}${RESET}  $*"; }
warn()    { printf '%s\n' "${YELLOW}${BOLD}!${RESET}  $*"; }
die()     { printf '%s\n' "${RED}${BOLD}✗${RESET}  $*" >&2; exit 1; }

# ── Detect OS and arch ────────────────────────────────────────────────────────
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64)        ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  armv7l)        ARCH="armv7" ;;
  *) die "Unsupported architecture: $ARCH" ;;
esac

case "$OS" in
  linux|darwin) ;;
  *)
    die "Unsupported OS: $OS. For Windows, use: irm https://raw.githubusercontent.com/${REPO}/main/install.ps1 | iex"
    ;;
esac

# Termux reports OS=linux but needs the Android build (Bionic/restricted kernel).
if [ -n "$TERMUX_VERSION" ] || [ "$PREFIX" = "/data/data/com.termux/files/usr" ]; then
  OS="android"
fi

# ── Fetch latest release tag ──────────────────────────────────────────────────
info "Fetching latest release info…"
TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep '"tag_name"' \
  | sed 's/.*"tag_name": *"\(.*\)".*/\1/')"

[ -z "$TAG" ] && die "Failed to fetch latest release tag."

VERSION="${TAG#v}"

# ── coded update fast-path: silent skip when already on latest ────────────────
if [ -n "$CODED_CURRENT_VERSION" ] && [ "$CODED_CURRENT_VERSION" = "$VERSION" ]; then
  success "coded is already up to date (${VERSION})"
  exit 0
fi

# ── Already-installed detection (direct runs only) ────────────────────────────
EXISTING="$(command -v coded 2>/dev/null || true)"
INSTALLED_VER=""
if [ -n "$EXISTING" ]; then
  INSTALLED_VER="$("$EXISTING" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
fi

if [ -z "$CODED_CURRENT_VERSION" ] && [ -n "$INSTALLED_VER" ] && [ "$INSTALLED_VER" = "$VERSION" ]; then
  warn "coded ${INSTALLED_VER} is already the latest version."
  # Read prompt from /dev/tty (stdin may be a curl pipe, not a terminal).
  if [ -e /dev/tty ]; then
    printf '%s' "${BOLD}Reinstall anyway? [y/N]${RESET} " >/dev/tty
    read -r ANS </dev/tty || ANS=n
  else
    ANS=n
  fi
  case "$ANS" in
    [Yy]*) info "Reinstalling…" ;;
    *) success "Nothing to do."; exit 0 ;;
  esac
elif [ -n "$INSTALLED_VER" ] && [ "$INSTALLED_VER" != "$VERSION" ]; then
  info "Upgrading ${YELLOW}${INSTALLED_VER}${RESET} → ${GREEN}${VERSION}${RESET} for ${OS}/${ARCH}…"
else
  info "Installing coded ${BOLD}${TAG}${RESET} for ${os:-$OS}/${ARCH}…"
fi

FILENAME="${BINARY}_${VERSION}_${OS}_${ARCH}"
URL="https://github.com/${REPO}/releases/download/${TAG}/${FILENAME}"

# ── Download with spinner + real progress bar ─────────────────────────────────
TMP="$(mktemp)"

download() {
  if [ -t 1 ]; then
    # Get Content-Length for real-percentage bar.
    TOTAL="$(curl -fsSLI "$URL" 2>/dev/null \
      | awk 'BEGIN{IGNORECASE=1} /^content-length:/{print $2}' \
      | tr -d '\r' | tail -1 || true)"

    # Background download.
    curl -fsSL "$URL" -o "$TMP" &
    DL_PID=$!

    FRAME=0
    while kill -0 "$DL_PID" 2>/dev/null; do
      SPIN=$(spin_frame $FRAME)
      FRAME=$((FRAME + 1))

      if [ -n "$TOTAL" ] && [ "$TOTAL" -gt 0 ] 2>/dev/null; then
        CUR="$(wc -c < "$TMP" 2>/dev/null | tr -d ' ' || echo 0)"
        PCT=$((CUR * 100 / TOTAL))
        [ "$PCT" -gt 100 ] && PCT=100

        # Build a 20-char bar.
        FILLED=$((PCT * 20 / 100))
        EMPTY=$((20 - FILLED))
        BAR=""
        i=0
        while [ "$i" -lt "$FILLED" ]; do BAR="${BAR}${BAR_FILL}"; i=$((i + 1)); done
        while [ "$i" -lt 20 ]; do BAR="${BAR}${BAR_EMPTY}"; i=$((i + 1)); done

        printf '\r  %s %sDownloading%s  [%s]  %3d%%' \
          "${CYAN}${SPIN}${RESET}" "$BOLD" "$RESET" "${CYAN}${BAR}${RESET}" "$PCT"
      else
        printf '\r  %s %sDownloading%s…' "${CYAN}${SPIN}${RESET}" "$BOLD" "$RESET"
      fi

      sleep 0.1
    done

    wait "$DL_PID" || die "Download failed."
    printf '\r\033[K'  # clear spinner line
  else
    # Non-TTY / piped: silent download, no ANSI.
    curl -fsSL "$URL" -o "$TMP" || die "Download failed."
  fi
}

download
chmod +x "$TMP"
success "Downloaded coded ${TAG}"

# ── Install to a directory in PATH ────────────────────────────────────────────
if [ -w /usr/local/bin ]; then
  mv "$TMP" /usr/local/bin/coded
  success "Installed to /usr/local/bin/coded"
elif [ -d "$HOME/.local/bin" ]; then
  mv "$TMP" "$HOME/.local/bin/coded"
  success "Installed to $HOME/.local/bin/coded"
else
  mkdir -p "$HOME/bin"
  mv "$TMP" "$HOME/bin/coded"
  success "Installed to $HOME/bin/coded"
  warn "Make sure $HOME/bin is in your PATH"
fi

printf '\n%s\n' "${BOLD}${GREEN}Done!${RESET}  Run: ${CYAN}coded${RESET}"
