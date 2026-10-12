#!/bin/sh
# fetch-pinned.sh — download one file from the first source that answers, then
# check it against a pinned sha256.
#
#   fetch-pinned.sh <dest> <sha256> <url> [<url>...]
#
# Used by the Dockerfile's whisper-build stage for the Whisper model. The URLs
# are tried in order, and any curl failure hands over to the next one. A wrong
# hash does NOT: it is checked once, after whichever source delivered, so wrong
# bytes fail the build no matter which source served them, and nothing is left
# at <dest>.
#
# Per source, curl retries every error (`--retry-all-errors`): a connection
# reset in the middle of a 148 MB transfer is the likeliest transient failure,
# and plain `--retry` does not retry it. The price is that a 404 is retried too
# before the next source is asked. A source that goes quiet, or trickles below
# 1 KiB/s for FETCH_SPEED_TIME seconds, is cut off; no attempt runs longer than
# FETCH_MAX_TIME seconds, and no new attempt starts after FETCH_RETRY_MAX_TIME.
# With the defaults a source that only ever fails fast (5xx, 404) costs about a
# minute (6 retries × 10 s); the worst case — every attempt running into a
# limit — is bounded by roughly 300 s + 300 s per source.
#
# Why more than one source: a single source gave up the whole image build when
# it answered 504 for longer than its retry window. The sources must serve the
# same bytes — the pin is what says so, not the URL.
#
# FETCH_RETRIES, FETCH_RETRY_DELAY, FETCH_RETRY_MAX_TIME, FETCH_CONNECT_TIMEOUT,
# FETCH_SPEED_TIME and FETCH_MAX_TIME (seconds) default to what the image build
# uses; the tests lower them. `-q` keeps a ~/.curlrc out of it.
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
connect=${FETCH_CONNECT_TIMEOUT:-20}
stall=${FETCH_SPEED_TIME:-60}
maxtime=${FETCH_MAX_TIME:-300}
retrymax=${FETCH_RETRY_MAX_TIME:-300}
tmp="$dest.partial"

got=
for url in "$@"; do
  if curl -q -fL --retry "$retries" --retry-delay "$delay" --retry-all-errors \
      --retry-max-time "$retrymax" \
      --connect-timeout "$connect" --speed-limit 1024 --speed-time "$stall" \
      --max-time "$maxtime" -o "$tmp" "$url"; then
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
