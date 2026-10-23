# MDBList Seerr Requester

A lightweight, self-hosted application that automatically discovers movies and TV shows from MDBList and submits requests to Seerr.

Built with Node.js, SQLite, and YAML configuration. Designed to run continuously in Docker with minimal resource usage.

## Features

- **Multiple Lists** — Fetch and process multiple MDBList lists.
- **List Priority** — YAML list order determines priority when titles overlap.
- **Per-List Configuration** — Configure request attribution and approval per list.
- **Seerr Integration** — Automatically submit movie and TV requests.
- **Request Attribution** — Assign a Seerr user to each list to identify the request source.
- **Duplicate Prevention** — Prevent duplicate requests across lists.
- **Persistent History** — SQLite remembers every successfully submitted request.
- **No Automatic Re-requests** — Previously requested titles are never automatically requested again, even after removal from Seerr.
- **Scheduled Execution** — Automatically process lists at configurable intervals.
- **Dry Run** — Preview requests without submitting them.
- **Docker Ready** — Lightweight container designed for self-hosted environments.

## How It Works

```text
MDBList
   |
   v
Fetch Complete Lists
   |
   v
Apply List Priority
   |
   v
Check SQLite History
   |
   v
Check Seerr
   |
   v
Submit Request
   |
   v
Save Successful Request
```

### One Request Per Title

The core principle:

**Once successfully requested, never automatically request again.**

Every successfully submitted request is permanently recorded in SQLite using its TMDB ID and media type.

This history remains independent of Seerr, Radarr, Sonarr, Plex, or Maintainerr.

## Configuration

All settings are managed through an external YAML configuration file.

No web interface or external database server is required.

## Technology

- Node.js
- SQLite
- YAML
- Docker
- MDBList API
- Seerr API

## Project Status

**Under Development**

The core request workflow is implemented. Validate production configuration with dry-run before enabling requests.

## Production on Docker / Unraid

Image: `ghcr.io/solidverse/mdblist-seerr-requester:latest` (`linux/amd64`).
The publishing workflow tests every main-branch push before building and publishing.
Version tags such as `v1.0.0` publish matching image tags; each build also gets a
`sha-<full-commit>` tag. A version build does not replace `latest`.
The workflow uses the repository's `GITHUB_TOKEN`; no publishing PAT is needed.
After the first successful workflow run, check GHCR package visibility and make
it public if anonymous pulls are desired. Repository Actions and package-write
permissions must be allowed by organization policy.

Mount `/mnt/user/appdata/mdblist-seerr-requester/` to `/config` with read/write
access. Place your external `config.yml` there, using `config.example.yml` as a
reference. Start with `dryRun: true`. Nothing in the image creates or overwrites
configuration; missing/invalid YAML prevents startup. `/config/history.db` is
created only when absent; existing history is reused without clearing records.
`CONFIG_PATH` defaults to `/config/config.yml`; `HISTORY_DB_PATH` defaults to
`/config/history.db` and can override the database location when needed.

Production initializes as root, then uses `gosu` to execute Node as UID/GID
`99:100` by default (Unraid). Override with `-e PUID=1000 -e PGID=1000` on other
Linux hosts. IDs must be positive; UID/GID 0 are rejected. No `--user` override
or manual `chown` is needed on ordinary writable local appdata storage.

Initialization corrects ownership of `/config` and its known configuration,
SQLite database and journal files only. Contents and restrictive modes are
preserved; unrelated files/subdirectories are untouched. Symlinks, hardlinks and
special files at application paths are rejected. Keep the mount under trusted
administrative control during initialization. Read-only mounts, restrictive
modes, unusual filesystems and network shares that prohibit ownership changes
may fail startup with a clear diagnostic; the app never falls back to root.

Custom `CONFIG_PATH` / `HISTORY_DB_PATH` values must be canonical absolute paths.
Direct application files under `/config` are managed automatically. Custom paths
elsewhere (including nested directories) must already be readable/writable by the
runtime UID/GID; initialization does not change their ownership or create their
parent directories. Preserve existing history when changing paths.

Example for a future deployment (do not run alongside development):

```bash
docker run -d --name mdblist-seerr-requester \
  --restart unless-stopped \
  --security-opt no-new-privileges:true \
  --stop-timeout 120 \
  -e TZ=Europe/Amsterdam \
  --mount type=bind,src=/mnt/user/appdata/mdblist-seerr-requester,dst=/config \
  ghcr.io/solidverse/mdblist-seerr-requester:latest
```

Use ordinary bridge networking and a reachable Seerr URL, for example
`http://192.168.1.57:5055`. No ports are published, no web interface or API server
runs, and no companion containers or external database server are needed. No
privileged mode, host networking or Docker socket mount is required. Node starts
immediately; YAML controls startup execution and cron scheduling in the container's
local timezone (`TZ`). Logs are available through Unraid or
`docker logs mdblist-seerr-requester`.

SIGTERM/SIGINT stop new scheduling and wait for the active run before closing
SQLite. Allow enough stop time for large lists and API retry delays; increase the
example's 120 seconds if required. Forced termination can interrupt a run.

### Preserve development history when migrating

Stop the development container (`docker compose stop -t 120`) and confirm its
process has exited. Stop any other writers before taking a backup. Never run
development and production simultaneously against Seerr with separate histories.

Keep an untouched backup of the stopped `dev-config` directory, including any
`history.db-wal`, `history.db-shm` and `history.db-journal` files. Do not copy only
`history.db` while a WAL or journal might still contain uncheckpointed changes.
Use SQLite's backup command against the stopped database to create a standalone
migration copy (requires the host's `sqlite3` tool). Use a fresh backup filename if
the temporary file already exists:

```bash
sqlite3 dev-config/history.db ".backup '/tmp/mdblist-history-migration.db'"
sqlite3 /tmp/mdblist-history-migration.db 'PRAGMA integrity_check; SELECT COUNT(*) FROM requests;'
```

Choose a fresh backup filename if that temporary file already exists. Confirm
`integrity_check` reports `ok` and retain the row count. Transfer this standalone
backup and your configuration securely to TIGRI. Install the backup as
`/mnt/user/appdata/mdblist-seerr-requester/history.db` only if no database already
exists there. If a destination history exists, stop and reconcile it separately;
never overwrite or discard it. Verify integrity and the same row count at the
destination, before starting the container; production initialization handles ownership.
Keep the original backup for recovery. Do not delete or recreate request history.

### Development remains unchanged

`docker compose up -d` still uses the existing `/config` and source bind mounts,
with `npm run dev` / `node --watch src/index.js`. Compose selects the
`development` build target, runs as the existing `node` user and bypasses the
production ownership entrypoint, so WSL/source bind mounts are not chowned. Production uses the same source
with `node src/index.js`, without live reload.


Docker permissions validation (temporary fixtures only; requires a local Docker daemon):

```bash
docker build -t mdblist-seerr-requester:local .
docker build --target development -t mdblist-seerr-requester:dev-validation .
node --test tests/docker-permissions.test.js
```

These container tests are explicitly invoked and are not part of offline `npm test`.
