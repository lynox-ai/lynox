#!/bin/sh
# fetch-pinned.sh — download one file from the first source that answers, then
# check it against a pinned sha256.
#
#   fetch-pinned.sh <dest> <sha256> <url> [<url>...]
#
# Used by the Dockerfile's whisper-build stage for the Whisper model. The URLs
# are tried in order; a source that fails (HTTP error after its retries, network
# error) hands over to the next one. Only a DOWNLOAD failure moves on. The hash
# is checked once, after whichever source delivered, so wrong bytes fail the
# build no matter which source served them, and nothing is left at <dest>.
#
# Why more than one source: a single source gave up the whole image build when
# it answered 504 for longer than its retry window. The sources must serve the
# same bytes — the pin is what says so, not the URL.
#
# FETCH_RETRIES / FETCH_RETRY_DELAY (seconds) set curl's retry per source; the
# defaults are what the image build uses. The tests set them to 0.
#
# POSIX sh on purpose: it runs in the build stage's /bin/sh (dash).

set -eu

if [ "$#" -lt 3 ]; then
  echo "usage: fetch-pinned.sh <dest> <sha256> <url> [<url>...]" >&2
  exit 2
fi

dest=$1
sha=$2
shift 2

retries=${FETCH_RETRIES:-6}
delay=${FETCH_RETRY_DELAY:-10}
tmp="$dest.partial"

got=
for url in "$@"; do
  if curl -fL --retry "$retries" --retry-delay "$delay" --retry-all-errors -o "$tmp" "$url"; then
    got=$url
    break
  fi
  echo "fetch-pinned: $url failed, trying the next source" >&2
  rm -f "$tmp"
done

if [ -z "$got" ]; then
  echo "fetch-pinned: every source failed for $dest" >&2
  exit 1
fi

if ! echo "$sha  $tmp" | sha256sum -c - >&2; then
  echo "fetch-pinned: $got served bytes that do not match the pinned sha256" >&2
  rm -f "$tmp"
  exit 1
fi

mv "$tmp" "$dest"
echo "fetch-pinned: $dest from $got" >&2
