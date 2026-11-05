#!/usr/bin/env bash
# Builds bot/sdk/vendor/, which the bot image's zoom stage is built from: the pinned
# headless sample with bwat-sample.patch applied, and the Zoom Meeting SDK from the
# archive an install downloaded, checked against zoom-sdk.lock.
#
#   bot/sdk/prepare-vendor.sh <archive>     (or BWAT_ZOOM_SDK_ARCHIVE=<archive>)
#   bot/sdk/prepare-vendor.sh --untested <version> [--known <sha256>] <archive>
#                             (setup/zoom-sdk, for Zoom's newer SDK; --known: the library
#                             that built on this computer before, at that version)
#   docker build --target zoom -t bwat-bot:zoom bot
#
# It leaves the library's sha256 in vendor/zoom-sdk.sha256, for setup/zoom-sdk to record.
#
# Used by a self-hosted install's setup and by any pipeline that builds the bot image, each
# with the archive the company downloaded from Zoom.
set -euo pipefail
cd "$(dirname "$0")"

# shellcheck source=zoom-sdk.lock
. ./zoom-sdk.lock

# Only an argument names an untested version, never the environment, so nothing a caller
# happens to have set can skip the hash check; the tested version is always checked.
untested= known=
if [ "${1:-}" = --untested ]; then
    untested=${2:-}
    shift 2 || true
    [ "$untested" != "$ZOOM_SDK_VERSION" ] || untested=
fi
if [ "${1:-}" = --known ]; then
    known=${2:-}
    shift 2 || true
fi
ARCHIVE="${1:-${BWAT_ZOOM_SDK_ARCHIVE:-}}"
if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
    echo "bwat: give the Zoom Meeting SDK $ZOOM_SDK_VERSION archive for Linux x86_64: prepare-vendor.sh <archive>" >&2
    exit 1
fi

SAMPLE="vendor/meetingsdk-headless-linux-sample"
rm -rf vendor
git -c core.autocrlf=false clone --quiet "$ZOOM_SAMPLE_REPO" "$SAMPLE"
git -C "$SAMPLE" -c advice.detachedHead=false checkout --quiet "$ZOOM_SAMPLE_REF"
git -C "$SAMPLE" apply ../../bwat-sample.patch

# The archive's layout differs by where it came from; the library marks the SDK's root.
UNPACKED="$(mktemp -d)"
trap 'rm -rf "$UNPACKED"' EXIT
tar xf "$ARCHIVE" -C "$UNPACKED"
LIBRARY="$(find "$UNPACKED" -name libmeetingsdk.so -type f | head -n 1)"
if [ -z "$LIBRARY" ]; then
    echo "bwat: $ARCHIVE holds no libmeetingsdk.so; is it the Linux SDK?" >&2
    exit 1
fi
hash_check() { if command -v sha256sum >/dev/null; then sha256sum -c --status -; else shasum -a 256 -c --status -; fi; }  # macOS has only shasum
sum=$(if command -v sha256sum >/dev/null; then sha256sum "$LIBRARY"; else shasum -a 256 "$LIBRARY"; fi | cut -d' ' -f1)
# A newer SDK than the tested one (setup/zoom-sdk names it with --untested) has no known
# hash: it is trusted as the company's own download from Zoom, and its compile checks only
# that its headers fit bwat's patch. Without --untested, as in a pipeline that builds the bot image, only the tested
# library passes. A library that built here before (--known) is the same file again: said
# so, and the one honest line stays.
if [ -n "$untested" ] && [ -n "$known" ] && [ "$known" = "$sum" ]; then
    echo "bwat: Zoom Meeting SDK $untested has built on this computer before (bwat is tested with $ZOOM_SDK_VERSION)."
    echo "bwat: no hash from bwat was checked for this version: its library is the one that built here."
elif [ -n "$untested" ]; then
    echo "bwat: Zoom Meeting SDK $untested, untested (bwat is tested with $ZOOM_SDK_VERSION)."
    [ -z "$known" ] || echo "bwat: this is not the library of the $untested that built on this computer before."
    echo "bwat: no hash was checked for this version: use only an SDK you downloaded from Zoom yourself."
    echo "bwat: its libmeetingsdk.so sha256 is $sum; adding it to zoom-sdk.lock makes this version a tested one."
elif ! echo "$ZOOM_SDK_SO_SHA256  $LIBRARY" | hash_check 2>/dev/null; then
    echo "bwat: $ARCHIVE is not Zoom Meeting SDK $ZOOM_SDK_VERSION (see zoom-sdk.lock)" >&2
    exit 1
fi
echo "$sum" > vendor/zoom-sdk.sha256
rm -rf "$SAMPLE/lib/zoomsdk"
mv "$(dirname "$LIBRARY")" "$SAMPLE/lib/zoomsdk"
# The SDK's loader asks for the versioned name.
ln -sf libmeetingsdk.so "$SAMPLE/lib/zoomsdk/libmeetingsdk.so.1"

echo "bwat: vendor ready, sample ${ZOOM_SAMPLE_REF:0:7} + Zoom Meeting SDK ${untested:-$ZOOM_SDK_VERSION}"
