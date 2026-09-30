#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# HELP Telecare Bridge — iOS Build Script
# Builds web assets, copies to xtool project, builds iOS app.
#
# Usage:
#   ./build-ios.sh          # Build debug + install to iPhone
#   ./build-ios.sh --ipa    # Build signed .ipa for distribution
#   ./build-ios.sh --clean  # Clean build
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_DIR="$SCRIPT_DIR"
XTOOL_DIR="$BRIDGE_DIR/ios-xtool"
WEB_DIST="$BRIDGE_DIR/dist"
RESOURCES_DIR="$XTOOL_DIR/Sources/HELPBridge/Resources"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
fail()  { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }

# ── Check prerequisites ──
check_prereqs() {
    info "Checking prerequisites..."

    if ! command -v xtool &>/dev/null; then
        if [ -f "$HOME/.local/bin/xtool" ]; then
            export PATH="$HOME/.local/bin:$PATH"
        else
            fail "xtool not found. Install: curl -sSf https://xtool.sh/install.sh | sh"
        fi
    fi
    ok "xtool $(xtool --version 2>&1)"

    # Check SDK
    local sdk_status
    sdk_status=$(xtool sdk status 2>&1)
    if [[ "$sdk_status" == "Not installed" ]]; then
        fail "iOS SDK not installed. Run: xtool setup"
    fi
    ok "SDK: $sdk_status"

    # Check auth
    local auth_status
    auth_status=$(xtool auth status 2>&1)
    if [[ "$auth_status" == "Logged out" ]]; then
        warn "Not authenticated with Apple. Run: xtool auth login"
        warn "Continuing without signing (build-only mode)"
    else
        ok "Auth: $auth_status"
    fi

    # Check for iPhone
    local devices
    devices=$(xtool devices 2>&1)
    if [[ -z "$devices" || "$devices" == *"No devices"* ]]; then
        warn "No iPhone connected via USB"
    else
        ok "Device: $devices"
    fi
}

# ── Build web assets ──
build_web() {
    info "Building web assets..."

    if [ ! -f "$BRIDGE_DIR/package.json" ]; then
        fail "package.json not found in $BRIDGE_DIR"
    fi

    cd "$BRIDGE_DIR"
    npm run build 2>&1 | tail -5

    if [ ! -d "$WEB_DIST" ]; then
        fail "Build failed — dist/ not created"
    fi

    ok "Web assets built: $(du -sh "$WEB_DIST" | cut -f1)"
}

# ── Copy web assets to xtool project ──
copy_assets() {
    info "Copying web assets to iOS project..."

    # Clean old resources
    rm -rf "$RESOURCES_DIR"
    mkdir -p "$RESOURCES_DIR"

    # Copy dist/ contents to Resources/
    cp -r "$WEB_DIST/"* "$RESOURCES_DIR/"

    local file_count
    file_count=$(find "$RESOURCES_DIR" -type f | wc -l)
    ok "Copied $file_count files to Resources/ ($(du -sh "$RESOURCES_DIR" | cut -f1))"
}

# ── Build iOS app ──
build_ios() {
    local mode="${1:-debug}"

    info "Building iOS app (${mode})..."
    cd "$XTOOL_DIR"

    case "$mode" in
        debug)
            xtool dev build 2>&1
            ok "Debug build complete"
            ;;
        release)
            xtool dev build --configuration release --sign 2>&1
            ok "Release build complete (signed)"
            ;;
        ipa)
            xtool dev build --configuration release --sign --ipa 2>&1
            ok "IPA generated"
            # Find and report the IPA
            local ipa_path
            ipa_path=$(find "$XTOOL_DIR" -name "*.ipa" -newer "$XTOOL_DIR/Package.swift" | head -1)
            if [ -n "$ipa_path" ]; then
                ok "IPA: $ipa_path ($(du -h "$ipa_path" | cut -f1))"
            fi
            ;;
    esac
}

# ── Install to iPhone ──
install_to_device() {
    info "Installing to iPhone..."
    cd "$XTOOL_DIR"
    xtool dev run 2>&1
    ok "App installed and launched on iPhone"
}

# ── Main ──
main() {
    echo ""
    echo "═══════════════════════════════════════════════"
    echo "  HELP Telecare Bridge — iOS Build"
    echo "═══════════════════════════════════════════════"
    echo ""

    check_prereqs

    case "${1:-}" in
        --ipa)
            build_web
            copy_assets
            build_ios "ipa"
            ;;
        --release)
            build_web
            copy_assets
            build_ios "release"
            install_to_device
            ;;
        --clean)
            info "Cleaning..."
            rm -rf "$XTOOL_DIR/.build"
            rm -rf "$RESOURCES_DIR"
            ok "Clean complete"
            ;;
        --copy-only)
            build_web
            copy_assets
            ;;
        *)
            build_web
            copy_assets
            build_ios "debug"
            install_to_device
            ;;
    esac

    echo ""
    ok "Done! 🎉"
}

main "$@"
