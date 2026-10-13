#!/usr/bin/env bash
# Downloads Edmunds' RICH feed from Impact and PROVES it is the rich file before anything touches the database.
# Tries encrypted SFTP (pinned host key) first, then plain FTP (the server offers no FTPS). A route's file is accepted
# only if it is a valid gzip, large enough, has exactly 27 header columns and the header starts "id<TAB>title<TAB>".
# Prints facts only (sizes, column counts, the header's column NAMES); never prints credentials or car rows.
# Env: IMPACT_FTP_USER, IMPACT_FTP_PASS (required); MIN_BYTES (default 50000000, lowered only by tests).
set -uo pipefail
OUT="${1:-feed.txt.gz}"
HOST="products.impact.com"
FILE="Edmunds/Edmunds-Product-Feed_CUSTOM.txt.gz"
# Host key fingerprint read from a screenshot on Oct 12, 2026: verify it before relying on it.
HOSTKEY="VnpT96wJuWk5n+mOCab3Tw084xZgZ6ojm4ZtRh82vTs"
MIN_BYTES="${MIN_BYTES:-50000000}"
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

echo "folder listing over SFTP (names only):"; curl -sS -m 40 --hostpubsha256 "$HOSTKEY" -u "$CRED" --list-only "sftp://$HOST/Edmunds/" 2>&1 | sed 's/^/  /' | head -8
echo "folder listing over FTP (names only):";  curl -sS -m 40 --ftp-pasv -u "$CRED" --list-only "ftp://$HOST/Edmunds/" 2>&1 | sed 's/^/  /' | head -8

rm -f "$OUT"
echo "route 1: SFTP (encrypted, pinned host key)"
if curl --fail -sS --retry 3 -m 900 --hostpubsha256 "$HOSTKEY" -u "$CRED" -o "$OUT" "sftp://$HOST/$FILE" && check "$OUT"; then echo "ACCEPTED: SFTP"; exit 0; fi
rm -f "$OUT"
echo "route 2: plain FTP (not encrypted; the server offers no FTPS)"
if curl --fail -sS --retry 3 -m 900 --ftp-pasv -u "$CRED" -o "$OUT" "ftp://$HOST/$FILE" && check "$OUT"; then echo "ACCEPTED: plain FTP"; exit 0; fi
rm -f "$OUT"
echo "REFUSED: neither route delivered the rich 27-column feed. Nothing was loaded."
exit 1
