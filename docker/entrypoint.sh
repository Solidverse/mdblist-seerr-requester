#!/bin/sh
set -eu

fail() {
  echo "[INIT] ERROR: $1" >&2
  echo '[INIT] Check volume mounts, filesystem permissions and PUID/PGID.' >&2
  exit 1
}
validate_id() {
  case "$2" in ''|*[!0-9]*) fail "$1 must be a positive numeric ID." ;; esac
  [ "$2" -gt 0 ] 2>/dev/null && [ "$2" -le 4294967294 ] 2>/dev/null || fail "$1 must be between 1 and 4294967294."
}
PUID=${PUID-99}
PGID=${PGID-100}
validate_id PUID "$PUID"
validate_id PGID "$PGID"
[ "$(id -u)" = 0 ] || fail 'Initialization requires root; do not use --user. Node will run unprivileged.'
echo '[INIT] Starting MDBList Seerr Requester'
echo "[INIT] Runtime UID: $PUID"
echo "[INIT] Runtime GID: $PGID"
echo '[INIT] Checking /config permissions'
[ ! -L /config ] || fail 'Symlink at /config is unsafe.'
mkdir -p /config || fail 'Cannot create /config.'
[ -d /config ] || fail '/config must be a directory.'
config_path=${CONFIG_PATH-/config/config.yml}
db_path=${HISTORY_DB_PATH-/config/history.db}

# Check the entire path before changing anything. Reject links, hardlinks and
# special files; never traverse symlinks or chown a shared external inode.
check_file() {
  case "$1" in /*) ;; *) fail 'Configuration/database paths must be absolute.' ;; esac
  [ "$(realpath -m -- "$1")" = "$1" ] || fail 'Symlinks or non-canonical configuration/database paths are unsafe.'
  [ ! -L "$1" ] || fail 'Symlink at an application file is unsafe.'
  if [ -e "$1" ]; then
    [ -f "$1" ] || fail 'Application files must be regular files.'
    [ "$(stat -c %h -- "$1")" = 1 ] || fail 'Hardlinked application files are unsafe.'
  fi
}
for file in /config/config.yml /config/history.db /config/history.db-wal /config/history.db-shm /config/history.db-journal "$config_path" "$db_path" "$db_path-wal" "$db_path-shm" "$db_path-journal"; do
  check_file "$file"
done
own() {
  [ "$(stat -c %u:%g -- "$1")" = "$PUID:$PGID" ] || chown -h -- "$PUID:$PGID" "$1" || fail 'Cannot correct /config ownership.'
}
own /config
for file in /config/config.yml /config/history.db /config/history.db-wal /config/history.db-shm /config/history.db-journal "$config_path" "$db_path" "$db_path-wal" "$db_path-shm" "$db_path-journal"; do
  # Only direct application files inside /config are managed automatically.
  # Custom paths elsewhere must already be accessible; never chown their parents.
  if [ "$(dirname -- "$file")" = /config ] && [ -f "$file" ]; then own "$file"; fi
done
[ -f "$config_path" ] || fail 'Configuration file is missing; supply config.yml.'
gosu "$PUID:$PGID" test -r "$config_path" || fail 'Configuration is not readable by the runtime user.'
for directory in /config "$(dirname -- "$db_path")"; do
  gosu "$PUID:$PGID" sh -c 'test -x "$1" && probe=$(mktemp "$1/.mslr-write-check.XXXXXX") && rm -- "$probe"' sh "$directory" || fail 'Cannot write to configuration/database directory (possibly read-only).'
done
for file in "$db_path" "$db_path-wal" "$db_path-shm" "$db_path-journal"; do
  if [ -e "$file" ]; then
    gosu "$PUID:$PGID" sh -c 'test -r "$1" && test -w "$1"' sh "$file" || fail 'Database or journal is not readable/writable by the runtime user.'
  fi
done
echo '[INIT] Configuration directory ready'
echo '[INIT] Dropping root privileges'
exec gosu "$PUID:$PGID" "$@"
