import { formatError, safeContext, diagnosticError } from "../utils/errors.js";
import { createMDBListClient } from "../integrations/mdblist.js";
import { createSeerrClient, accountName } from "../integrations/seerr.js";

const validId = (id) => Number.isSafeInteger(id) && id > 0;

export async function runRequestEngine(snapshot, {
  history, mdblistFactory = createMDBListClient, seerrFactory = createSeerrClient, logger = console,
}) {
  // Isolate even callers that mutate their config while discovery is pending.
  const config = structuredClone(snapshot);
  const mdblist = mdblistFactory(config);
  const seerr = seerrFactory(config);
  const summary = {
    listsProcessed: 0, listsFailed: 0, listsSkipped: 0, titlesRetrieved: 0,
    invalidTitles: 0, uniqueTitles: 0, duplicates: 0, skippedHistory: 0,
    skippedSeerr: 0, submitted: 0, approved: 0, pending: 0,
    approvalFailures: 0, failed: 0, uncertain: 0, dryRun: 0,
  };
  const context = (list, username, item) => safeContext({ list: list?.listId, account: username,
    media: item ? `${item.mediaType}:${item.tmdbId}` : undefined }, [config.seerrApiKey, config.mdblistApiKey]);
  logger.log("[ENGINE] Starting scheduled run.");
  const prepared = [];
  for (const list of config.lists) {
    if (!list.enabled) { summary.listsSkipped++; continue; }
    try {
      const items = await mdblist.getListItems(list.listId);
      if (!Array.isArray(items)) throw diagnosticError("Invalid MDBList list response.", { code: "INVALID_RESPONSE" });
      summary.titlesRetrieved += items.length;
      const valid = items.filter((item) => {
        const ok = validId(item?.tmdbId) && ["movie", "tv"].includes(item.mediaType) && typeof item.title === "string";
        if (!ok) summary.invalidTitles++;
        return ok;
      });
      let filtered = valid;
      if (list.minImdbRating !== undefined) {
        let missing = 0;
        let below = 0;
        filtered = filtered.filter(({ imdbRating }) => {
          if (!Number.isFinite(imdbRating) || imdbRating < 0 || imdbRating > 10) { missing++; return false; }
          if (imdbRating < list.minImdbRating) { below++; return false; }
          return true;
        });
        logger.log(`[ENGINE] ${context(list)} IMDb filter rejected ${missing + below}: missing or invalid IMDb rating=${missing}, IMDb rating below minimum ${list.minImdbRating}=${below}.`);
      }
      if (list.maxReleaseAge !== undefined) {
        const currentYear = new Date().getFullYear();
        const minimumYear = currentYear - list.maxReleaseAge;
        let missing = 0;
        let outside = 0;
        filtered = filtered.filter(({ releaseYear }) => {
          if (!Number.isSafeInteger(releaseYear) || releaseYear <= 0) { missing++; return false; }
          if (releaseYear < minimumYear || releaseYear > currentYear) { outside++; return false; }
          return true;
        });
        logger.log(`[ENGINE] ${context(list)} Release age filter rejected ${missing + outside}: missing or invalid release year=${missing}, release year outside allowed range ${minimumYear}–${currentYear}=${outside}.`);
      }
      prepared.push({ list, items: filtered });
    } catch (error) {
      summary.listsFailed++;
      logger.error(`[ENGINE] MDBList retrieval failed; skipping list. ${context(list)} ${formatError(error)}`);
    }
  }
  // Finish discovery before resolving accounts or assigning title ownership.
  const accounts = new Map();
  const titles = new Map();
  for (const { list, items } of prepared) {
    if (!items.length) { summary.listsProcessed++; continue; }
    let userId;
    let username;
    try {
      username = accountName(list.requestUsername);
      if (!accounts.has(username)) {
        accounts.set(username, seerr.getOrCreateUser(list.requestUsername, { dryRun: config.dryRun }));
      }
      const account = await accounts.get(username);
      userId = config.dryRun ? account?.userId : account;
      if (!validId(userId) && !(config.dryRun && userId === null && account?.wouldCreate === true)) throw diagnosticError("Invalid service account resolution result.", { code: "INVALID_RESPONSE" });
    } catch (error) {
      summary.listsFailed++;
      logger.error(`[ENGINE] Service account resolution failed; skipping affected list. ${context(list, username)} ${formatError(error)}`);
      continue;
    }
    summary.listsProcessed++;
    for (const item of items) {
      const key = `${item.mediaType}:${item.tmdbId}`;
      if (titles.has(key)) { summary.duplicates++; continue; }
      titles.set(key, { item, list, userId, username });
    }
  }
  summary.uniqueTitles = titles.size;
  for (const { item, list, userId, username } of titles.values()) {
    const { tmdbId, mediaType } = item;
    let recorded;
    try { recorded = history.hasRequest(tmdbId, mediaType); } catch (error) {
      logger.error(`[ENGINE] CRITICAL: History lookup failed; stopping run. ${context(list, username, item)} ${formatError(error)}`);
      throw Object.assign(diagnosticError("[ENGINE] History lookup failed; run stopped."), { summary, cause: error, operation: "SQLite history lookup" });
    }
    if (recorded) {
      summary.skippedHistory++;
      logger.log(`[ENGINE] ${mediaType}:${tmdbId} SKIPPED_HISTORY`);
      continue;
    }
    const approve = mediaType === "movie" ? list.autoApproveMovies : list.autoApproveSeries;
    let result;
    try {
      result = await seerr.createRequest({ tmdbId, mediaType, userId, requestUsername: list.requestUsername,
        dryRun: config.dryRun, autoApprove: config.dryRun ? approve : false });
    } catch (error) {
      if (error?.uncertain) {
        summary.uncertain++;
        logger.error(`[ENGINE] ${mediaType}:${tmdbId} UNCERTAIN; manual verification required; continuing other titles. ${context(list, username, item)} ${formatError(error)}`);
      } else {
        summary.failed++;
        logger.error(`[ENGINE] ${mediaType}:${tmdbId} FAILED; continuing other titles. ${context(list, username, item)} ${formatError(error)}`);
      }
      continue;
    }
    if (result?.submitted === false && result.existing === true) {
      summary.skippedSeerr++;
      logger.log(`[ENGINE] ${mediaType}:${tmdbId} SKIPPED_SEERR`);
      continue;
    }
    if (config.dryRun) {
      if (result?.submitted === false && result.dryRun === true && result.wouldSubmit === true) {
        summary.dryRun++;
        logger.log(`[ENGINE] DRY_RUN ${JSON.stringify({ tmdbId, mediaType, title: item.title, sourceList: list.listId, seerrUser: username, approve })}`);
      } else { summary.failed++; logger.error("[ENGINE] Invalid dry-run result."); }
      continue;
    }
    if (result?.submitted !== true || !validId(result.requestId) || result.tmdbId !== tmdbId
      || result.mediaType !== mediaType || result.userId !== userId || ![1, 2, 3, 4, 5].includes(result.status)) {
      summary.uncertain++;
      logger.error(`[ENGINE] ${mediaType}:${tmdbId} UNCERTAIN: invalid submission result; manual verification required.`);
      continue;
    }
    summary.submitted++;
    // No asynchronous work may intervene between confirmed submission and history.
    try {
      const inserted = history.recordSuccessfulRequest({ tmdbId, mediaType, sourceList: list.listId,
        seerrUser: username, seerrRequestId: result.requestId }, { dryRun: false });
      if (!inserted && !history.hasRequest(tmdbId, mediaType)) throw new Error();
    } catch (error) {
      logger.error(`[ENGINE] CRITICAL: History persistence failed for ${mediaType}:${tmdbId}, Seerr request ${result.requestId}; stopping run without approval. ${context(list, username, item)} ${formatError(error)}`);
      throw Object.assign(diagnosticError("[ENGINE] Confirmed request could not be persisted; run stopped."), {
        tmdbId, mediaType, requestId: result.requestId, summary, cause: error, operation: "SQLite history persistence",
      });
    }
    if (result.status === 1) {
      if (approve) {
        try {
          const approved = await seerr.approveRequest(result.requestId, { dryRun: false });
          if (approved?.id !== result.requestId || approved.status !== 2) throw new Error();
          summary.approved++;
        } catch (error) {
          summary.approvalFailures++;
          summary.pending++;
          logger.error(`[ENGINE] Approval failed for Seerr request ${result.requestId}; history retained; continuing. ${context(list, username, item)} ${formatError(error)}`);
        }
      } else summary.pending++;
    }
    logger.log(`[ENGINE] ${mediaType}:${tmdbId} SUBMITTED (Seerr request ${result.requestId})`);
  }
  logger.log(`[ENGINE] Run completed: ${JSON.stringify(summary)}`);
  return summary;
}
