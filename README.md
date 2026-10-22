# MDBList Seerr Requester

A lightweight, self-hosted application that automatically discovers movies and TV shows from MDBList and submits requests to Seerr.

Built with Node.js, SQLite, and YAML configuration. Designed to run continuously in Docker with minimal resource usage.

## Features

- **Multiple Lists** — Fetch and process multiple MDBList lists.
- **List Priority** — YAML list order determines priority when titles overlap.
- **Per-List Configuration** — Configure filters and limits individually.
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
Fetch & Filter Lists
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

All settings will be managed through a YAML configuration file.

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

This project is currently in its initial development phase. Features described above are planned and not yet implemented.
