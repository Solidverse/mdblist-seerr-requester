import { diagnosticError, errorContext, formatError } from "../utils/errors.js";
import { createHash } from "node:crypto";

const PAGE_SIZE = 100;
const ATTEMPTS = 3;
const TIMEOUT_MS = 30_000;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

function retryDelay(response, attempt) {
  const value = response?.headers.get("Retry-After");
  if (value !== null && value !== undefined) {
    const milliseconds = /^\d+$/.test(value)
      ? Number(value) * 1000
      : Date.parse(value) - Date.now();
    if (Number.isFinite(milliseconds)) {
      // Never retry earlier than requested due to Node's timer overflow.
      if (milliseconds > 2 ** 31 - 1) throw diagnosticError("[MDBLIST] Retry-After exceeds the supported wait time.");
      return Math.max(0, milliseconds);
    }
  }
  return 1000 * 2 ** attempt;
}

// Pass the scheduler's validated configuration snapshot; no global config state.
export function createMDBListClient(config, { fetchImpl = globalThis.fetch, logger = console } = {}) {
  if (typeof config?.mdblistApiKey !== "string" || !config.mdblistApiKey.trim()) {
    throw new TypeError("[MDBLIST] A non-empty mdblistApiKey is required.");
  }
  const apiKey = config.mdblistApiKey;
  const lists = config.lists?.map((list) => ({ ...list }));

  async function fetchPage(listId, offset) {
    const url = new URL(`https://api.mdblist.com/lists/${listId.split("/").map(encodeURIComponent).join("/")}/items`);
    url.search = new URLSearchParams({ apikey: apiKey, limit: String(PAGE_SIZE), offset: String(offset), sort: "rank", order: "asc", unified: "true", append_to_response: "ratings" });
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      let response;
      let text;
      let failure;
      let cause;
      try {
        response = await fetchImpl(url, {
          signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "application/json" }, redirect: "error",
        });
        if (response.ok) text = await response.text();
      } catch (error) {
        cause = error;
        // Native fetch errors can include the URL with its API key.
        failure = "Network failure or request timeout.";
      }
      if (!failure && response.ok) {
        let data;
        try { data = JSON.parse(text); } catch {
          throw diagnosticError("[MDBLIST] Invalid JSON response; list retrieval failed.", { code: "INVALID_RESPONSE" });
        }
        return { data, headers: response.headers };
      }
      if (response && !response.ok) {
        await response.body?.cancel().catch(() => {});
        const status = response.status;
        if (status === 401 || status === 403) throw diagnosticError("[MDBLIST] Authentication failed (401/403).", { httpStatus: status });
        if (status === 404) throw diagnosticError("[MDBLIST] List not found (404).", { httpStatus: status });
        failure = `HTTP ${status}; list retrieval failed.`;
        if (status !== 429 && status !== 408 && status < 500) throw diagnosticError(`[MDBLIST] ${failure}`, { httpStatus: status });
      }
      if (attempt === ATTEMPTS - 1) throw diagnosticError(`[MDBLIST] ${failure} Retry attempts exhausted.`, { httpStatus: response?.status, cause });
      logger.warn(`[MDBLIST] Temporary request failure; retrying. ${formatError(errorContext(cause, { operation: "GET /lists/{listid}/items", httpStatus: response?.status }))}`);
      await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
    }
  }

  async function getListItems(listId) {
    if (typeof listId !== "string" || (!(/^\d+$/.test(listId) && /[1-9]/.test(listId)) && !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(listId))) {
      throw diagnosticError("[MDBLIST] listId must be a positive numeric ID string or username/slug.", {}, TypeError);
    }
    const titles = [];
    const pages = new Set();
    let offset = 0;
    while (true) {
      const { data, headers } = await fetchPage(listId, offset);
      let items;
      const unified = Array.isArray(data) ? data : isObject(data) ? data.items : undefined;
      if (Array.isArray(unified)) {
        items = unified.map((item) => ({ item, apiType: item?.mediatype,
          mediaType: item?.mediatype === "show" ? "tv" : "movie" }));
      } else if (isObject(data) && (Array.isArray(data.movies) || Array.isArray(data.shows))
        && (data.movies === undefined || Array.isArray(data.movies))
        && (data.shows === undefined || Array.isArray(data.shows))) {
        items = [
          ...(data.movies ?? []).map((item) => ({ item, mediaType: "movie", apiType: "movie" })),
          ...(data.shows ?? []).map((item) => ({ item, mediaType: "tv", apiType: "show" })),
        ];
      } else {
        throw diagnosticError("[MDBLIST] Unexpected list response structure.");
      }
      if (items.some(({ item, apiType }) => !isObject(item) || !["movie", "show"].includes(apiType) || typeof item.title !== "string"
        || (item.mediatype !== undefined && item.mediatype !== apiType))) {
        throw diagnosticError("[MDBLIST] Unexpected list item structure.");
      }
      // Count headers can describe only this page, not the complete list.
      const more = headers.get("X-Has-More")?.trim().toLowerCase();
      if (more !== "true" && more !== "false") {
        throw diagnosticError("[MDBLIST] Missing or invalid X-Has-More; completeness cannot be verified.");
      }
      offset += items.length;
      if (!Number.isSafeInteger(offset)) throw diagnosticError("[MDBLIST] Invalid pagination offset.");
      const hasMore = more === "true";
      if (hasMore && items.length === 0) {
        throw diagnosticError("[MDBLIST] Incomplete pagination: empty page with more items.");
      }
      if (items.length) {
        // Detect ignored offsets and repeated pages without dropping any titles.
        const identity = items.map(({ item, mediaType }) => JSON.stringify([
          mediaType, item.ids?.tmdb, item.id, item.imdb_id,
        ])).sort();
        const fingerprint = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
        if (pages.has(fingerprint)) throw diagnosticError("[MDBLIST] Repeated page detected; pagination made no progress.");
        pages.add(fingerprint);
      }
      for (const { item, mediaType } of items) {
        // In the list-items response, id is the direct TMDB ID fallback.
        const tmdbId = item.ids?.tmdb ?? item.id;
        if (!positiveInteger(tmdbId)) {
          logger.warn("[MDBLIST] Skipping title with missing or invalid TMDB ID.");
          continue;
        }
        const imdbRating = Array.isArray(item.ratings)
          ? item.ratings.find((rating) => rating?.source === "imdb")?.value : undefined;
        titles.push({
          tmdbId, mediaType, title: item.title,
          rank: positiveInteger(item.rank) ? item.rank : null,
          imdbRating: Number.isFinite(imdbRating) && imdbRating >= 0 && imdbRating <= 10 ? imdbRating : null,
          releaseYear: positiveInteger(item.release_year) ? item.release_year : null,
        });
      }
      if (!hasMore) break;
    }
    // Separate movie/show arrays must be merged back into list rank order.
    return titles.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
  }

  async function getListItemsWithDiagnostics(listId) {
    try { return await getListItems(listId); } catch (error) {
      throw errorContext(error, { operation: "GET /lists/{listid}/items" });
    }
  }
  return {
    getListItems: getListItemsWithDiagnostics,
    async getEnabledLists() {
      if (!Array.isArray(lists)) throw new TypeError("[MDBLIST] A configuration lists array is required.");
      const results = [];
      for (const list of lists) {
        if (list.enabled) results.push({ ...list, items: await getListItemsWithDiagnostics(list.listId) });
      }
      return results;
    },
  };
}
