import { DatabaseSync } from "node:sqlite";

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer.`);
  }
}

function validateTitle(tmdbId, mediaType) {
  positiveInteger(tmdbId, "tmdbId");
  if (mediaType !== "movie" && mediaType !== "tv") {
    throw new TypeError('mediaType must be "movie" or "tv".');
  }
}

function validateDryRun(dryRun) {
  if (typeof dryRun !== "boolean") {
    throw new TypeError("An explicit dryRun boolean is required for history modifications.");
  }
}

export function createHistory(path = process.env.HISTORY_DB_PATH ?? "/config/history.db") {
  let db;
  let lookup;
  let insert;
  let remove;
  try {
    db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        tmdb_id INTEGER NOT NULL,
        media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
        source_list TEXT NOT NULL,
        seerr_user TEXT NOT NULL,
        requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        seerr_request_id INTEGER,
        PRIMARY KEY (tmdb_id, media_type)
      );
    `);
    lookup = db.prepare("SELECT 1 FROM requests WHERE tmdb_id = ? AND media_type = ?");
    insert = db.prepare(`
      INSERT INTO requests (tmdb_id, media_type, source_list, seerr_user, seerr_request_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (tmdb_id, media_type) DO NOTHING
    `);
    remove = db.prepare("DELETE FROM requests WHERE tmdb_id = ? AND media_type = ?");
  } catch {
    db?.close();
    throw new Error("History database could not be opened or initialized. Check HISTORY_DB_PATH and directory permissions.");
  }

  let closed = false;
  function ensureOpen() {
    if (closed) throw new Error("History database is closed.");
  }

  return {
    hasRequest(tmdbId, mediaType) {
      ensureOpen();
      validateTitle(tmdbId, mediaType);
      return lookup.get(tmdbId, mediaType) !== undefined;
    },
    // Call only after Seerr confirms a successful submission by this app,
    // including pending approval. Verify uncertain outcomes before retrying.
    recordSuccessfulRequest(record, { dryRun } = {}) {
      ensureOpen();
      validateDryRun(dryRun);
      if (!record || typeof record !== "object") throw new TypeError("A history record is required.");
      const { tmdbId, mediaType, sourceList, seerrUser, seerrRequestId = null } = record;
      validateTitle(tmdbId, mediaType);
      if (typeof sourceList !== "string" || sourceList.trim().length === 0) {
        throw new TypeError("sourceList must be a non-empty string.");
      }
      if (typeof seerrUser !== "string" || !seerrUser.startsWith("mslr_") || seerrUser.slice(5).trim().length === 0) {
        throw new TypeError("seerrUser must be an actual Seerr username with the mslr_ prefix.");
      }
      if (seerrRequestId !== null) positiveInteger(seerrRequestId, "seerrRequestId");
      if (dryRun) return false;
      return insert.run(tmdbId, mediaType, sourceList, seerrUser, seerrRequestId).changes === 1;
    },
    // Explicit manual removal only; never synchronize deletions or rejections
    // from Seerr. The caller must pass the execution's validated dryRun setting.
    removeRequest(tmdbId, mediaType, { dryRun } = {}) {
      ensureOpen();
      validateTitle(tmdbId, mediaType);
      validateDryRun(dryRun);
      if (dryRun) return false;
      return remove.run(tmdbId, mediaType).changes === 1;
    },
    close() {
      if (closed) return;
      db.close();
      closed = true;
    },
  };
}
