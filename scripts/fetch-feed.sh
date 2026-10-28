#!/usr/bin/env bash
# Downloads Edmunds' RICH feed from Impact and PROVES it is the rich file before anything touches the database.
# Tries encrypted SFTP (pinned host key) first, then plain FTP (the server offers no FTPS). A route's file is accepted
# only if it is a valid gzip, large enough, has exactly 27 header columns and the header starts "id<TAB>title<TAB>".
# Prints facts only (sizes, column counts, the header's column NAMES, public host-key fingerprints, timings); never prints
# credentials or car rows.
# Env: IMPACT_FTP_USER, IMPACT_FTP_PASS (required); MIN_BYTES (default 50000000, lowered only by tests).
# SFTP host-key pin (T150): curl 8.5.0 on the runner rejects --hostpubsha256 even when the pin is right (exit 60; reproduced on a
# local server 28 Oct 2026), so the pin is enforced here instead: ssh-keyscan reads the server's keys, ONLY a key whose SHA256
# fingerprint equals HOSTKEY is written to ~/.ssh/known_hosts, and curl then verifies the SFTP connection against that file.
# If the server shows no key with the pinned fingerprint, the SFTP route is skipped (never used unverified).
# Download behaviour (T150, 28 Oct 2026): the feed is about 246 MB and Impact's FTP server delivers roughly 0.2 to 0.4 MB/s, so a
# healthy download takes 11 to 20 minutes. A slow-but-moving transfer is therefore allowed to run for the whole route budget;
# only a stalled one is cut off. If a partial file is left, one resume (curl -C -) is tried; Impact's FTP server answered a resume
# with 551 on 28 Oct 2026, so when a resume is refused the partial file is deleted and the download restarts from zero.
# Tunables (defaults in brackets, overridable only by tests):
#   STALL_BYTES [20000] and STALL_SECS [120]: a transfer slower than STALL_BYTES bytes/s for STALL_SECS seconds counts as stalled.
#   ROUTE_MAX_SECS [2400]: total time budget per route, over all attempts. Two routes plus the load stay inside the job's 90 minutes.
#   ATTEMPT_MAX_SECS [ROUTE_MAX_SECS]: cap per attempt. A route that gains no bytes in 2 attempts in a row is dropped.
#   MAX_ATTEMPTS [8]; RETRY_PAUSE [10] seconds between attempts; FEED_HOST [products.impact.com] (tests point it at a local mock server).
set -uo pipefail
OUT="${1:-feed.txt.gz}"
HOST="${FEED_HOST:-products.impact.com}"
FILE="Edmunds/Edmunds-Product-Feed_CUSTOM.txt.gz"
# Host key fingerprint read from a screenshot on Oct 12, 2026: verify it before relying on it.
HOSTKEY="VnpT96wJuWk5n+mOCab3Tw084xZgZ6ojm4ZtRh82vTs"
MIN_BYTES="${MIN_BYTES:-50000000}"
STALL_BYTES="${STALL_BYTES:-20000}"
STALL_SECS="${STALL_SECS:-120}"
ROUTE_MAX_SECS="${ROUTE_MAX_SECS:-2400}"
ATTEMPT_MAX_SECS="${ATTEMPT_MAX_SECS:-$ROUTE_MAX_SECS}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-8}"
: "${IMPACT_FTP_USER:?IMPACT_FTP_USER is not set}" "${IMPACT_FTP_PASS:?IMPACT_FTP_PASS is not set}"
CRED="$IMPACT_FTP_USER:$IMPACT_FTP_PASS"

check() { # 0 = this file is the rich feed
  local f="$1" size hdr cols
  [ -s "$f" ] || { echo "  nothing downloaded"; return 1; }
  size=$(stat -c %s "$f")
  gzip -t "$f" 2>/dev/null || { echo "  not a valid gzip ($size bytes)"; return 1; }
  hdr=$(gzip -dc "$f" 2>/dev/null | head -n1 | tr -d '\r\357\273\277')
  cols=$(printf '%s' "$hdr" | awk -F'\t' '{print NF}')
  echo "  size: $size bytes | header columns: $cols | header begins: $(printf '%s' "$hdr" | cut -c1-110 | tr '\t' '|')"
  [ "$size" -ge "$MIN_BYTES" ] || { echo "  too small (minimum $MIN_BYTES bytes)"; return 1; }
  [ "$cols" -eq 27 ] || { echo "  not the 27-column rich format"; return 1; }
  [[ "$hdr" == id$'\t'title$'\t'* ]] || { echo "  header does not start with id, title"; return 1; }
  return 0
}

# Downloads $2 (URL) into $OUT. $1 = label; further arguments are extra curl options.
# Stops at once on errors that retrying cannot fix (host key, login, file missing). After a stall or drop it resumes once;
# if the server refuses the resume it deletes the partial file and restarts from zero (never resumes again on that route).
download() {
  local label="$1" url="$2"; shift 2
  local start=$SECONDS attempt left cap rc before got noprog=0 resume_ok=1 resumed
  local -a rarg
  rm -f "$OUT"
  for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
    left=$(( ROUTE_MAX_SECS - (SECONDS - start) ))
    if [ "$left" -lt 30 ]; then echo "  $label: time budget of ${ROUTE_MAX_SECS}s used up"; return 1; fi
    cap=$left; [ "$cap" -gt "$ATTEMPT_MAX_SECS" ] && cap=$ATTEMPT_MAX_SECS
    before=$(stat -c %s "$OUT" 2>/dev/null || echo 0)
    resumed=0; rarg=()
    if [ "$resume_ok" -eq 1 ] && [ "$before" -gt 0 ]; then resumed=1; rarg=(-C -); fi
    curl --fail -sS ${rarg[@]+"${rarg[@]}"} --connect-timeout 30 -m "$cap" --speed-limit "$STALL_BYTES" --speed-time "$STALL_SECS" "$@" -o "$OUT" "$url"
    rc=$?
    got=$(stat -c %s "$OUT" 2>/dev/null || echo 0)
    echo "  $label attempt $attempt: curl exit $rc | $got bytes on disk | $(( SECONDS - start ))s elapsed$([ "$resumed" -eq 1 ] && echo ' | resumed from '"$before")"
    [ "$rc" -eq 0 ] && return 0
    if [ "$got" -gt 0 ] && gzip -t "$OUT" 2>/dev/null; then echo "  $label: the file on disk is already a complete gzip"; return 0; fi
    if [ "$resumed" -eq 1 ] && [ "$got" -le "$before" ]; then
      echo "  $label: the server did not accept the resume (curl exit $rc); deleting the partial file and restarting from zero"
      rm -f "$OUT"; resume_ok=0; noprog=0; continue
    fi
    case "$rc" in
      9|19|22|60|67|78) echo "  $label: curl exit $rc is not retryable"; return 1 ;;
    esac
    if [ "$got" -gt "$before" ]; then noprog=0; else noprog=$(( noprog + 1 )); fi
    if [ "$noprog" -ge 2 ]; then echo "  $label: no progress in 2 attempts in a row, dropping this route"; return 1; fi
    sleep "${RETRY_PAUSE:-10}"
  done
  echo "  $label: gave up after $MAX_ATTEMPTS attempts"
  return 1
}

# Public information only: the host keys the server shows THIS runner. Only a key matching the pinned fingerprint is trusted.
echo "SFTP host keys as seen from this runner (public fingerprints; the pin is SHA256:$HOSTKEY):"
KS_HOST="${HOST%%:*}"; KS_PORT=22; case "$HOST" in *:*) KS_PORT="${HOST##*:}" ;; esac
SCAN=$(timeout 40 ssh-keyscan -T 15 -p "$KS_PORT" "$KS_HOST" 2>/dev/null)
SFTP_OK=0
mkdir -p "$HOME/.ssh"; : > "$HOME/.ssh/known_hosts"
while IFS= read -r line; do
  [ -n "$line" ] || continue
  fp=$(printf '%s\n' "$line" | ssh-keygen -lf - 2>/dev/null | awk '{print $2 "  " $4}')
  [ -n "$fp" ] || continue
  if [ "${fp%% *}" = "SHA256:$HOSTKEY" ]; then
    echo "  $fp  <- matches the pin, trusted"; printf '%s\n' "$line" >> "$HOME/.ssh/known_hosts"; SFTP_OK=1
  else
    echo "  $fp  (does not match the pin, not trusted)"
  fi
done <<< "$SCAN"
[ -n "$SCAN" ] || echo "  no host keys returned by ssh-keyscan"
[ "$SFTP_OK" -eq 1 ] || echo "  SFTP will be skipped: no server key matches the pin"

if [ "$SFTP_OK" -eq 1 ]; then
  # curl SFTP URLs are absolute from the server's root; "/~/" means the login's home folder, which is where FTP starts.
  # Run #23 (28 Oct 2026): "/Edmunds/" gave "No such file or directory", so the home-relative path "/~/Edmunds/" is used and the
  # root, the home folder and the Edmunds folder are listed (names only) so the log shows where the files really are.
  for d in "" "~/" "~/Edmunds/"; do
    echo "SFTP folder /$d (names only):"; curl -sS -m 40 -u "$CRED" --list-only "sftp://$HOST/$d" 2>&1 | sed 's/^/  /' | head -8
  done
fi
echo "folder listing over FTP (names only):";  curl -sS -m 40 --ftp-pasv -u "$CRED" --list-only "ftp://$HOST/Edmunds/" 2>&1 | sed 's/^/  /' | head -8
EXPECTED=$(curl -sS -m 40 --ftp-pasv -u "$CRED" -I "ftp://$HOST/$FILE" 2>/dev/null | tr -d '\r' | awk 'tolower($1)=="content-length:"{print $2}' | head -1)
echo "expected size per FTP server: ${EXPECTED:-unknown} bytes"

rm -f "$OUT"
echo "route 1: SFTP (encrypted, host key pinned via known_hosts)"
if [ "$SFTP_OK" -ne 1 ]; then echo "  skipped: no server key matches the pin"
elif download "SFTP" "sftp://$HOST/~/$FILE" -u "$CRED" && check "$OUT"; then echo "ACCEPTED: SFTP"; exit 0; fi
rm -f "$OUT"
echo "route 2: plain FTP (not encrypted; the server offers no FTPS)"
if download "FTP" "ftp://$HOST/$FILE" --ftp-pasv -u "$CRED" && check "$OUT"; then echo "ACCEPTED: plain FTP (expected size ${EXPECTED:-unknown})"; exit 0; fi
rm -f "$OUT"
echo "REFUSED: neither route delivered the rich 27-column feed. Nothing was loaded."
exit 1
