#!/bin/sh

set -eu

for command_name in zip sha256sum stat lsof inotifywait wmctrl pgrep; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "missing required command: $command_name" >&2
    exit 1
  fi
done

run_dir=$(mktemp -d /tmp/wps-kylin-lifecycle.XXXXXX)
log_dir=$(mktemp -d /tmp/wps-kylin-lifecycle-evidence.XXXXXX)
fixture_dir="$run_dir/fixture"
work_copy="$run_dir/Kylin-WPS-Work-Copy.docx"
evidence="$log_dir/evidence.log"
events="$log_dir/directory-events.log"
mkdir -p "$fixture_dir/_rels" "$fixture_dir/word"

cat >"$fixture_dir/[Content_Types].xml" <<'XML'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>
XML

cat >"$fixture_dir/_rels/.rels" <<'XML'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
XML

cat >"$fixture_dir/word/document.xml" <<'XML'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Kylin WPS lifecycle prototype</w:t></w:r></w:p>
    <w:p><w:r><w:t>Edit below this line only when prompted.</w:t></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>
XML

(
  cd "$fixture_dir"
  zip -q -r "$work_copy" '[Content_Types].xml' _rels word
)
rm -rf "$fixture_dir"

timestamp() {
  date '+%Y-%m-%dT%H:%M:%S.%3N%z'
}

file_state() {
  printf 'size=%s mtime=%s sha256=%s' \
    "$(stat -c '%s' "$work_copy")" \
    "$(stat -c '%y' "$work_copy")" \
    "$(sha256sum "$work_copy" | cut -d ' ' -f 1)"
}

holder_state() {
  holders=$(lsof -nP -F pcn -- "$work_copy" 2>/dev/null | tr '\n' ' ' || true)
  if [ -n "$holders" ]; then
    printf '%s' "$holders"
  else
    printf 'none'
  fi
}

window_state() {
  pids=$(pgrep -d, -x 'wps|wpsoffice' 2>/dev/null || true)
  if [ -z "$pids" ]; then
    printf 'none'
    return
  fi
  windows=$(wmctrl -lp 2>/dev/null | awk -v pids=",$pids," 'index(pids, "," $3 ",") {printf "%s || ", $0}' || true)
  if [ -n "$windows" ]; then
    printf '%s' "$windows"
  else
    printf 'none'
  fi
}

log() {
  line="$(timestamp) $*"
  printf '%s\n' "$line" | tee -a "$evidence"
}

finish() {
  status=$?
  trap - EXIT INT TERM
  if [ -n "${watcher_pid:-}" ]; then
    kill "$watcher_pid" 2>/dev/null || true
    wait "$watcher_pid" 2>/dev/null || true
  fi
  log "FINAL file $(file_state)"
  log "FINAL holders $(holder_state)"
  log "FINAL windows $(window_state)"
  log "ARTIFACT work_copy=$work_copy"
  log "ARTIFACT directory_events=$events"
  log "ARTIFACT evidence=$evidence"
  exit "$status"
}
trap finish EXIT INT TERM

log "PROTOTYPE throwaway=true"
log "LAUNCH command=/usr/bin/wps $work_copy"
log "INITIAL file $(file_state)"
log "INITIAL holders $(holder_state)"
log "INITIAL windows $(window_state)"

inotifywait -m -q \
  -e close_write -e modify -e attrib \
  -e create -e delete -e moved_from -e moved_to \
  --format '%T event=%e path=%w%f' --timefmt '%Y-%m-%dT%H:%M:%S%z' \
  "$run_dir" >>"$events" 2>&1 &
watcher_pid=$!

/usr/bin/wps "$work_copy" &
launcher_pid=$!
log "LAUNCHER pid=$launcher_pid"

previous_file=$(file_state)
previous_holders=$(holder_state)
previous_windows=$(window_state)
previous_event_count=0

while :; do
  current_file=$(file_state)
  current_holders=$(holder_state)
  current_windows=$(window_state)
  event_count=$(wc -l <"$events")

  if [ "$current_file" != "$previous_file" ]; then
    log "FILE $current_file"
    previous_file=$current_file
  fi
  if [ "$current_holders" != "$previous_holders" ]; then
    log "HOLDERS $current_holders"
    previous_holders=$current_holders
  fi
  if [ "$current_windows" != "$previous_windows" ]; then
    log "WINDOWS $current_windows"
    previous_windows=$current_windows
  fi
  if [ "$event_count" != "$previous_event_count" ]; then
    tail -n "$((event_count - previous_event_count))" "$events" | while IFS= read -r event; do
      log "FS_EVENT $event"
    done
    previous_event_count=$event_count
  fi

  sleep 0.25
done
