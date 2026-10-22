import assert from "node:assert/strict";
import { test } from "node:test";
import { createMDBListClient } from "../src/integrations/mdblist.js";

test("real MDBList API retrieves a complete, ordered list", async (t) => {
  const apiKey = process.env.MDBLIST_API_KEY;
  const listId = process.env.MDBLIST_TEST_LIST;
  assert.ok(typeof apiKey === "string" && apiKey.trim().length > 0, "Set MDBLIST_API_KEY in integration-test.env.");
  assert.ok(typeof listId === "string" && listId.trim().length > 0, "Set MDBLIST_TEST_LIST to a numeric ID or username/slug in integration-test.env.");

  const pages = [];
  const expected = [];
  let skipped = 0;
  const client = createMDBListClient({ mdblistApiKey: apiKey }, {
    logger: { warn() { /* Report only the final skipped-title count. */ } },
    // Observe real responses to verify pagination independently of the result.
    fetchImpl: async (url, options) => {
      const response = await fetch(url, options);
      if (response.ok) {
        const data = await response.clone().json();
        const items = Array.isArray(data) ? data : Array.isArray(data?.items)
          ? data.items : [
            ...(data.movies ?? []).map((item) => ({ ...item, mediatype: item.mediatype ?? "movie" })),
            ...(data.shows ?? []).map((item) => ({ ...item, mediatype: item.mediatype ?? "show" })),
          ];
        pages.push({ offset: Number(url.searchParams.get("offset")), count: items.length,
          more: response.headers.get("X-Has-More")?.trim().toLowerCase() });
        for (const item of items) {
          const id = item.ids?.tmdb ?? item.id;
          if (!Number.isSafeInteger(id) || id <= 0) { skipped++; continue; }
          expected.push({ id, mediaType: item.mediatype === "show" ? "tv" : "movie",
            rank: Number.isSafeInteger(item.rank) && item.rank > 0 ? item.rank : Infinity });
        }
      }
      return response;
    },
  });

  let titles;
  try {
    titles = await client.getListItems(listId);
  } catch {
    // Never expose native fetch errors, URLs, response bodies or credentials.
    assert.fail("MDBList retrieval failed. Check credentials, list identifier, connectivity and API availability.");
  }
  assert.ok(Array.isArray(titles), "List response must be an array.");
  assert.ok(titles.every((item) => Number.isSafeInteger(item.tmdbId) && item.tmdbId > 0), "All titles must have valid TMDB IDs.");
  assert.ok(titles.every((item) => item.mediaType === "movie" || item.mediaType === "tv"), "All media types must be movie or tv.");
  assert.ok(titles.every((item) => typeof item.title === "string"), "All titles must contain a title string.");

  assert.ok(pages.length > 0 && pages.at(-1).more === "false", "Pagination must reach X-Has-More=false.");
  let offset = 0;
  for (const [index, page] of pages.entries()) {
    assert.ok(page.offset === offset, "Pagination must advance by the raw page length.");
    assert.ok(index === pages.length - 1 || page.more === "true", "Every intermediate page must indicate more items.");
    offset += page.count;
  }
  assert.ok(titles.length === expected.length, "Every source title with a valid TMDB ID must be returned.");
  expected.sort((a, b) => a.rank - b.rank);
  assert.ok(titles.every((item, index) => item.tmdbId === expected[index].id), "List rank ordering must be preserved.");
  assert.ok(titles.every((item, index) => item.mediaType === expected[index].mediaType), "Movie and TV classifications must match the source titles.");

  const movies = titles.filter((item) => item.mediaType === "movie").length;
  const series = titles.filter((item) => item.mediaType === "tv").length;
  t.diagnostic(`MDBList API connection successful. Retrieved ${titles.length} titles: ${movies} movies, ${series} TV series across ${pages.length} pages.`);
  t.diagnostic(`TMDB IDs, media types, ordering and pagination validated. Skipped ${skipped} titles without valid TMDB IDs.`);
});
