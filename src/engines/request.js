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
  logger.log("[ENGINE] Starting scheduled run.");
  const prepared = [];
  for (const list of config.lists) {
    if (!list.enabled) { summary.listsSkipped++; continue; }
    try {
      const items = await mdblist.getListItems(list.listId);
      if (!Array.isArray(items)) throw new Error();
      summary.titlesRetrieved += items.length;
      const valid = items.filter((item) => {
        const ok = validId(item?.tmdbId) && ["movie", "tv"].includes(item.mediaType) && typeof item.title === "string";
        if (!ok) summary.invalidTitles++;
        return ok;
      });
      prepared.push({ list, items: valid });
    } catch {
      summary.listsFailed++;
      logger.error(`[ENGINE] MDBList retrieval failed for list position ${config.lists.indexOf(list) + 1}; skipping list.`);
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
      if (!validId(userId) && !(config.dryRun && userId === null && account?.wouldCreate === true)) throw new Error();
    } catch {
      summary.listsFailed++;
      logger.error("[ENGINE] Service account resolution failed; skipping affected list.");
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
    try { recorded = history.hasRequest(tmdbId, mediaType); } catch {
      logger.error("[ENGINE] CRITICAL: History lookup failed; stopping run.");
      throw Object.assign(new Error("[ENGINE] History lookup failed; run stopped."), { summary });
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
        logger.error(`[ENGINE] ${mediaType}:${tmdbId} UNCERTAIN; manual verification required.`);
      } else {
        summary.failed++;
        logger.error(`[ENGINE] ${mediaType}:${tmdbId} FAILED`);
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
    } catch {
      logger.error(`[ENGINE] CRITICAL: History persistence failed for ${mediaType}:${tmdbId}, Seerr request ${result.requestId}; stopping run without approval.`);
      throw Object.assign(new Error("[ENGINE] Confirmed request could not be persisted; run stopped."), {
        tmdbId, mediaType, requestId: result.requestId, summary,
      });
    }
    if (result.status === 1) {
      if (approve) {
        try {
          const approved = await seerr.approveRequest(result.requestId, { dryRun: false });
          if (approved?.id !== result.requestId || approved.status !== 2) throw new Error();
          summary.approved++;
        } catch {
          summary.approvalFailures++;
          summary.pending++;
          logger.error(`[ENGINE] Approval failed for Seerr request ${result.requestId}; history retained.`);
        }
      } else summary.pending++;
    }
    logger.log(`[ENGINE] ${mediaType}:${tmdbId} SUBMITTED (Seerr request ${result.requestId})`);
  }
  logger.log(`[ENGINE] Run completed: ${JSON.stringify(summary)}`);
  return summary;
}
