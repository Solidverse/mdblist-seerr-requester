import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { createSeerrClient } from "../src/integrations/seerr.js";

const validId = (id) => Number.isSafeInteger(id) && id > 0;
const emailFor = (name) => `${createHash("sha256").update(name).digest("hex").slice(0, 48)}@mslr.invalid`;

test("real Seerr API read-only integration", async (t) => {
  const seerrUrl = process.env.SEERR_URL;
  const seerrApiKey = process.env.SEERR_API_KEY;
  assert.ok(typeof seerrUrl === "string" && seerrUrl.trim(), "Set SEERR_URL in integration-test.env.");
  assert.ok(typeof seerrApiKey === "string" && seerrApiKey.trim(), "Set SEERR_API_KEY in integration-test.env.");
  let endpoint;
  try { endpoint = new URL(seerrUrl); } catch { assert.fail("SEERR_URL must be a valid HTTP/HTTPS URL."); }
  assert.ok(["http:", "https:"].includes(endpoint.protocol) && !endpoint.username && !endpoint.password
    && !endpoint.search && !endpoint.hash, "SEERR_URL must be an HTTP/HTTPS URL without credentials, query or fragment.");

  const methods = [];
  let blocked = 0;
  const pagination = new Map();
  async function readOnlyFetch(url, options) {
    // Require an explicit method; never let fetch defaults or redirects bypass this guard.
    methods.push(options?.method);
    if (options?.method !== "GET") {
      blocked++;
      throw new Error("Read-only integration test blocked a non-GET operation.");
    }
    try {
      const response = await fetch(url, { ...options, method: "GET", redirect: "error" });
      const target = new URL(url);
      if (response.ok && /\/api\/v1\/(user|request)$/.test(target.pathname)) {
        const page = await response.clone().json();
        const skip = Number(target.searchParams.get("skip"));
        assert.ok(Array.isArray(page?.results) && Number.isSafeInteger(page.pageInfo?.results), "Invalid pagination structure.");
        const previous = skip === 0 ? { count: 0 } : pagination.get(target.pathname);
        assert.ok(previous && previous.count === skip, "Pagination skipped or repeated a page.");
        const count = skip + page.results.length;
        assert.ok(count <= page.pageInfo.results, "Pagination exceeds advertised total.");
        pagination.set(target.pathname, { count, total: page.pageInfo.results });
      }
      return response;
    } catch {
      // Never propagate URLs, headers, response bodies or native error details.
      throw new Error("Read-only Seerr HTTP call or pagination validation failed.");
    }
  }
  const client = createSeerrClient({ seerrUrl, seerrApiKey, dryRun: true }, { fetchImpl: readOnlyFetch });
  t.after(() => {
    assert.ok(methods.length > 0 && methods.every((method) => method === "GET") && blocked === 0,
      "All integration operations must be explicitly GET; writes are forbidden.");
  });
  async function checkCall(callback, message) {
    try { return await callback(); } catch { assert.fail(message); }
  }
  function completePagination() {
    assert.ok(pagination.size > 0 && [...pagination.values()].every((page) => page.count === page.total),
      "Every paginated collection must be retrieved completely.");
  }

  const users = await checkCall(() => client.getUsers(), "Seerr user retrieval failed: check connectivity, admin API key and response compatibility.");
  assert.ok(Array.isArray(users) && users.every((u) => validId(u?.id)), "Users must have valid numeric IDs.");
  assert.ok(new Set(users.map((u) => u.id)).size === users.length, "Duplicate user IDs returned.");
  completePagination();
  t.diagnostic(`Seerr API connection successful. Retrieved ${users.length} users.`);

  const requests = await checkCall(() => client.getExistingRequests(), "Seerr request retrieval failed: check API access and request response compatibility.");
  assert.ok(Array.isArray(requests) && requests.every((r) => validId(r?.id) && validId(r.media?.tmdbId)
    && ["movie", "tv"].includes(r.media?.mediaType) && [1, 2, 3, 4, 5].includes(r.status)), "Invalid request ID, media identity or request status.");
  assert.ok(new Set(requests.map((r) => r.id)).size === requests.length, "Duplicate request IDs returned.");
  completePagination();
  const movies = requests.filter((r) => r.media.mediaType === "movie").length;
  t.diagnostic(`Retrieved ${requests.length} existing requests: ${movies} movies, ${requests.length - movies} TV requests. Pagination validated.`);

  await t.test("existing media status detection", { skip: requests.length === 0 ? "No existing requests; media status check skipped without creating data." : false }, async () => {
    const sample = requests[0];
    const status = await checkCall(() => client.getMediaStatus(sample.media.tmdbId, sample.media.mediaType), "Seerr media status retrieval failed or returned an incompatible response.");
    assert.ok([1, 2, 3, 4, 5, 6, 7].includes(status.status) && typeof status.exists === "boolean"
      && Array.isArray(status.requests), "Invalid normalized media status.");
    assert.ok(status.exists && status.requests.some((r) => r.id === sample.id), "Existing request was not recognized.");
    t.diagnostic("Media status detection successful.");
  });

  const managed = users.find((u) => typeof u.username === "string" && u.username.startsWith("mslr_")
    && u.username.length > 5 && u.username === u.username.trim() && !/[\p{Cc}]/u.test(u.username)
    && u.email === emailFor(u.username));
  let name = managed?.username;
  if (!name) {
    do { name = `mslr_integration_${randomUUID()}`; }
    while (users.some((u) => u.username?.toLowerCase() === name.toLowerCase() || u.email === emailFor(name)));
  }
  const account = await checkCall(() => client.getOrCreateUser(name, { dryRun: true }), "Seerr dry-run account lookup or permission inspection failed.");
  if (managed) {
    assert.ok(validId(account?.userId) && account.userId === managed.id && account.wouldCreate === false, "Managed account lookup failed.");
    assert.ok(account.wouldCorrectPermissions === undefined || account.wouldCorrectPermissions === true, "Invalid permission inspection result.");
    t.diagnostic("Existing service account lookup and permission inspection verified without modifications.");
  } else {
    assert.ok(account?.userId === null && account.wouldCreate === true, "Missing account must only be planned in dry-run.");
    t.diagnostic("No verified service account exists; dry-run account creation plan verified without creating a user.");
  }
  completePagination();
  t.diagnostic(`Read-only safety verified: ${methods.length} GET calls, no writes.`);
});
