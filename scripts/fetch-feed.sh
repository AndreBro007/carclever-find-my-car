#!/usr/bin/env bash
# Downloads Edmunds' RICH feed from Impact over plain FTP and PROVES it is the rich file before anything touches the database.
# (Impact's help pages describe FTP as the route for catalog downloads; the server offers no FTPS.) The file is accepted only if
# it is a valid gzip, large enough, has exactly 27 header columns and the header starts "id<TAB>title<TAB>".
# Prints facts only (sizes, column counts, the header's column NAMES, folder names, timings); never prints credentials or car rows.
# Env: IMPACT_FTP_USER, IMPACT_FTP_PASS (required); MIN_BYTES (default 50000000, lowered only by tests).
# SFTP route REMOVED (T150, 28 Oct 2026): over SFTP our login sees only an empty "INCREMENTAL" folder and no Edmunds feed
# (runs #23 to #25), and curl 8.5.0 on the runner ignores --hostpubsha256. The host-key pin code (ssh-keyscan plus a verified
# known_hosts entry) and the SFTP listings are in git history (commits 45ddc39, 233a3a6, 6df73a0 on catalog-db/v1).
# Download behaviour (T150, 28 Oct 2026): the feed is about 245 MB and Impact's FTP speed varies a lot (run #24: 40 s; run #23:
# 703 s; run #21: too slow to finish in 900 s). A slow-but-moving transfer is therefore allowed to run for the whole time budget;
# only a stalled one is cut off. If a partial file is left, one resume (curl -C -) is tried; Impact's FTP server answered a resume
# with 551 on 28 Oct 2026, so when a resume is refused the partial file is deleted and the download restarts from zero.
# Tunables (defaults in brackets, overridable only by tests):
#   STALL_BYTES [20000] and STALL_SECS [120]: a transfer slower than STALL_BYTES bytes/s for STALL_SECS seconds counts as stalled.
#   ROUTE_MAX_SECS [2400]: total time budget for the download, over all attempts. With the load it stays inside the job's 90 minutes.
#   ATTEMPT_MAX_SECS [ROUTE_MAX_SECS]: cap per attempt. A download that gains no bytes in 2 attempts in a row is given up.
#   MAX_ATTEMPTS [8]; RETRY_PAUSE [10] seconds between attempts; FEED_HOST [products.impact.com] (tests point it at a local mock server).
set -uo pipefail
OUT="${1:-feed.txt.gz}"
HOST="${FEED_HOST:-products.impact.com}"
FILE="Edmunds/Edmunds-Product-Feed_CUSTOM.txt.gz"
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
# Stops at once on errors that retrying cannot fix (login, file missing). After a stall or drop it resumes once;
# if the server refuses the resume it deletes the partial file and restarts from zero (never resumes again in that run).
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
    if [ "$noprog" -ge 2 ]; then echo "  $label: no progress in 2 attempts in a row, giving up"; return 1; fi
    sleep "${RETRY_PAUSE:-10}"
  done
  echo "  $label: gave up after $MAX_ATTEMPTS attempts"
  return 1
}

# Folder names only, so the log shows what Impact's FTP server offers.
echo "folder listing over FTP (names only):";  curl -sS -m 40 --ftp-pasv -u "$CRED" --list-only "ftp://$HOST/Edmunds/" 2>&1 | sed 's/^/  /' | head -8
echo "FTP root folder (names only):"; curl -sS -m 40 --ftp-pasv -u "$CRED" --list-only "ftp://$HOST/" 2>&1 | sed 's/^/  /' | head -8
EXPECTED=$(curl -sS -m 40 --ftp-pasv -u "$CRED" -I "ftp://$HOST/$FILE" 2>/dev/null | tr -d '\r' | awk 'tolower($1)=="content-length:"{print $2}' | head -1)
echo "expected size per FTP server: ${EXPECTED:-unknown} bytes"

rm -f "$OUT"
echo "plain FTP (not encrypted; the server offers no FTPS)"
if download "FTP" "ftp://$HOST/$FILE" --ftp-pasv -u "$CRED" && check "$OUT"; then echo "ACCEPTED: plain FTP (expected size ${EXPECTED:-unknown})"; exit 0; fi
rm -f "$OUT"
echo "REFUSED: the rich 27-column feed was not delivered. Nothing was loaded."
exit 1
