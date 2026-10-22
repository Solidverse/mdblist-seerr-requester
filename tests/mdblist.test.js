import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createMDBListClient } from "../src/integrations/mdblist.js";

const movie = (id, extra = {}) => ({ id: id + 10_000, ids: { tmdb: id, mdblist: `m${id + 10_000}` }, title: `Title ${id}`, rank: id, mediatype: "movie", ...extra });
const show = (id, extra = {}) => movie(id, { mediatype: "show", ...extra });
function page(movies = [], shows = [], more = false, headers = {}) {
  return Response.json({ movies, shows }, { headers: { "X-Has-More": String(more), ...headers } });
}

function setup(responses, config = {}) {
  const requests = [];
  const warnings = [];
  const client = createMDBListClient({ mdblistApiKey: "TOP_SECRET", ...config }, {
    logger: { warn: (message) => warnings.push(message) },
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      if (typeof responses === "function") return responses(url, options, requests.length);
      assert.ok(responses.length, "Unexpected extra HTTP request");
      return responses.shift();
    },
  });
  return { client, requests, warnings };
}

async function tick(t, ms) {
  await setImmediate();
  t.mock.timers.tick(ms);
  await setImmediate();
}

test("single-page retrieval uses the documented endpoint, authentication and TMDB ID", async () => {
  const { client, requests } = setup([page([movie(123)])]);
  assert.deepEqual(await client.getListItems("1176"), [{ tmdbId: 123, mediaType: "movie", title: "Title 123", rank: 123 }]);
  const { url, options } = requests[0];
  assert.equal(url.origin, "https://api.mdblist.com");
  assert.equal(url.pathname, "/lists/1176/items");
  assert.equal(url.searchParams.get("apikey"), "TOP_SECRET");
  assert.equal(url.searchParams.get("limit"), "100");
  assert.equal(url.searchParams.get("offset"), "0");
  assert.equal(url.searchParams.get("sort"), "rank");
  assert.equal(url.searchParams.get("unified"), "true");
  assert.equal(options.redirect, "error");
  assert.ok(options.signal instanceof AbortSignal);
});

test("movie and TV arrays merge into rank order without changing original titles", async () => {
  const { client } = setup([page([movie(2, { title: "Één film" })], [show(1)])]);
  assert.deepEqual(await client.getListItems("1"), [
    { tmdbId: 1, mediaType: "tv", title: "Title 1", rank: 1 },
    { tmdbId: 2, mediaType: "movie", title: "Één film", rank: 2 },
  ]);
});

test("show-only lists and missing rank are supported", async () => {
  const { client } = setup([page([], [show(1, { rank: undefined })])]);
  assert.deepEqual(await client.getListItems("1"), [{ tmdbId: 1, mediaType: "tv", title: "Title 1", rank: null }]);
});

test("empty list returns an empty array", async () => {
  const { client } = setup([page([], [], false, { "X-Total-Items": "0" })]);
  assert.deepEqual(await client.getListItems("1"), []);
});

test("unified mixed arrays and items wrappers support direct TMDB IDs", async () => {
  for (const wrapped of [false, true]) {
    const items = [movie(1, { ids: undefined, id: 123 }), show(2, { ids: { tmdb: null }, id: 456 })];
    const { client } = setup([Response.json(wrapped ? { items } : items, { headers: { "X-Has-More": "false" } })]);
    assert.deepEqual((await client.getListItems("1")).map(({ tmdbId, mediaType }) => ({ tmdbId, mediaType })), [
      { tmdbId: 123, mediaType: "movie" }, { tmdbId: 456, mediaType: "tv" },
    ]);
  }
});

test("nested TMDB IDs take precedence; invalid non-null IDs are not replaced", async () => {
  const { client, warnings } = setup([page([movie(1, { id: 999 }), movie(2, { ids: { tmdb: 0 } })])]);
  assert.deepEqual((await client.getListItems("1")).map((item) => item.tmdbId), [1]);
  assert.equal(warnings.length, 1);
});

test("username/slug uses the shared mixed-list endpoint and retains configured identity", async () => {
  const { client, requests } = setup([Response.json([movie(1), show(2)], { headers: { "X-Has-More": "false" } })], {
    lists: [{ listId: "linaspurinis/latest-certified-fresh-releases", enabled: true }],
  });
  const lists = await client.getEnabledLists();
  assert.equal(requests[0].url.pathname, "/lists/linaspurinis/latest-certified-fresh-releases/items");
  assert.equal(requests[0].url.searchParams.get("unified"), "true");
  assert.equal(lists[0].listId, "linaspurinis/latest-certified-fresh-releases");
  assert.deepEqual(lists[0].items.map((item) => item.mediaType), ["movie", "tv"]);
});

test("has-more takes precedence over page size, including server-capped short pages", async () => {
  const { client, requests } = setup([page([movie(1)], [], true), page([movie(2)])]);
  assert.equal((await client.getListItems("1")).length, 2);
  assert.deepEqual(requests.map(({ url }) => url.searchParams.get("offset")), ["0", "1"]);
});

test("complete mixed list with more than 1000 titles is retrieved without a request limit", async () => {
  const total = 1257;
  const { client, requests } = setup((url) => {
    const offset = Number(url.searchParams.get("offset"));
    const end = Math.min(offset + 100, total);
    const movies = [];
    const shows = [];
    for (let id = offset + 1; id <= end; id++) {
      if (id % 2) movies.push(movie(id));
      else shows.push(show(id));
    }
    return Response.json([...movies, ...shows], { headers: {
      "X-Has-More": String(end < total),
      "X-Total-Items": String(end - offset), "X-Matched-Items": String(end - offset),
    } });
  });
  const items = await client.getListItems("1");
  assert.equal(items.length, total);
  assert.deepEqual(items.map((item) => item.tmdbId), Array.from({ length: total }, (_, index) => index + 1));
  assert.equal(requests.length, 13);
  assert.equal(requests.at(-1).url.searchParams.get("offset"), "1200");
});

test("missing or invalid TMDB IDs are warned about without substituting other IDs", async () => {
  const invalid = [undefined, null, 0, -1, 1.5, "123", Number.MAX_SAFE_INTEGER + 1];
  const { client, warnings, requests } = setup([
    page(invalid.map((tmdb, index) => movie(index + 1, { id: undefined, ids: { tmdb, imdb: "tt123", tvdb: 12 } })), [], true),
    page([movie(99)]),
  ]);
  assert.deepEqual((await client.getListItems("1")).map((item) => item.tmdbId), [99]);
  assert.equal(warnings.length, invalid.length);
  assert.ok(warnings.every((message) => message.includes("TMDB ID")));
  assert.equal(requests[1].url.searchParams.get("offset"), String(invalid.length));
});

for (const status of [401, 403, 404, 400]) {
  test(`HTTP ${status} fails without retries or exposing response details`, async () => {
    const { client, requests } = setup([new Response("TOP_SECRET", { status })]);
    await assert.rejects(client.getListItems("1"), (error) => {
      assert.match(error.message, status === 401 || status === 403 ? /Authentication failed/ : status === 404 ? /List not found/ : /HTTP 400/);
      assert.doesNotMatch(error.message, /TOP_SECRET/);
      return true;
    });
    assert.equal(requests.length, 1);
  });
}

test("rate limiting respects Retry-After seconds before retrying", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { client, requests } = setup([new Response(null, { status: 429, headers: { "Retry-After": "2" } }), page([movie(1)])]);
  const pending = client.getListItems("1");
  await tick(t, 1999);
  assert.equal(requests.length, 1);
  await tick(t, 1);
  assert.equal((await pending).length, 1);
  assert.equal(requests.length, 2);
});

test("Retry-After HTTP dates are respected", async (t) => {
  const now = Date.parse("2026-10-22T12:00:00Z");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const { client, requests } = setup([new Response(null, { status: 503, headers: { "Retry-After": new Date(now + 3000).toUTCString() } }), page()]);
  const pending = client.getListItems("1");
  await tick(t, 2999);
  assert.equal(requests.length, 1);
  await tick(t, 1);
  assert.deepEqual(await pending, []);
});

test("temporary server errors use bounded exponential retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { client, requests } = setup([new Response(null, { status: 500 }), new Response(null, { status: 502 }), page([movie(1)])]);
  const pending = client.getListItems("1");
  await tick(t, 1000);
  assert.equal(requests.length, 2);
  await tick(t, 2000);
  assert.equal((await pending).length, 1);
  assert.equal(requests.length, 3);
});

test("persistent network failure exhausts retries without leaking the request URL", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { client, requests, warnings } = setup(() => { throw new Error("https://api.mdblist.com/?apikey=TOP_SECRET"); });
  const pending = assert.rejects(client.getListItems("1"), (error) => {
    assert.match(error.message, /Network failure.*Retry attempts exhausted/);
    assert.doesNotMatch(error.message, /TOP_SECRET/);
    return true;
  });
  await tick(t, 1000);
  await tick(t, 2000);
  await pending;
  assert.equal(requests.length, 3);
  assert.doesNotMatch(warnings.join("\n"), /TOP_SECRET/);
});

test("request timeout aborts the request and retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(AbortSignal, "timeout", (ms) => {
    assert.equal(ms, 30_000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
  const { client, requests } = setup((_url, { signal }, attempt) => {
    if (attempt > 1) return page([movie(1)]);
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("TOP_SECRET")), { once: true }));
  });
  const pending = client.getListItems("1");
  await tick(t, 30_000);
  await tick(t, 1000);
  assert.equal((await pending).length, 1);
  assert.equal(requests.length, 2);
});

for (const [name, response] of [
  ["invalid JSON", () => new Response("{TOP_SECRET")],
  ["null body", () => Response.json(null)],
  ["missing arrays", () => Response.json({})],
  ["invalid movie array", () => Response.json({ movies: {}, shows: [] })],
  ["invalid item", () => page([null])],
  ["invalid title", () => page([movie(1, { title: null })])],
  ["inconsistent media type", () => page([show(1)])],
  ["missing pagination metadata", () => Response.json({ movies: [], shows: [] })],
  ["invalid pagination boolean", () => page([], [], false, { "X-Has-More": "maybe" })],
  ["empty page with more items", () => page([], [], true)],
]) {
  test(`malformed response fails safely: ${name}`, async () => {
    const { client, requests } = setup([response()]);
    await assert.rejects(client.getListItems("1"), (error) => {
      assert.match(error.message, /\[MDBLIST\]/);
      assert.doesNotMatch(error.message, /TOP_SECRET/);
      return true;
    });
    assert.equal(requests.length, 1);
  });
}

test("count headers cannot substitute for missing X-Has-More", async () => {
  const { client } = setup([
    Response.json({ movies: [movie(1)] }, { headers: { "X-Total-Items": "1" } }),
  ]);
  await assert.rejects(client.getListItems("1"), /X-Has-More/);
});

test("repeated pages terminate with an error rather than returning incomplete data", async () => {
  const { client, requests } = setup([page([movie(1)], [], true), page([movie(1)], [], true)]);
  await assert.rejects(client.getListItems("1"), /Repeated page/);
  assert.equal(requests.length, 2);
});

test("page counts do not stop or invalidate pagination", async () => {
  const { client } = setup([
    page([movie(1), movie(2)], [], true, { "X-Total-Items": "2", "X-Matched-Items": "2" }),
    page([movie(3)], [], false, { "X-Total-Items": "1", "X-Matched-Items": "1" }),
  ]);
  assert.equal((await client.getListItems("1")).length, 3);
});

test("a failed later page rejects the whole list instead of returning partial results", async () => {
  const { client } = setup([page([movie(1)], [], true), new Response(null, { status: 403 })]);
  await assert.rejects(client.getListItems("1"), /Authentication failed/);
});

test("enabled lists retain YAML priority and overlapping titles without altering the snapshot", async () => {
  const config = { lists: [
    { listId: "3", enabled: true, requestUsername: "First" },
    { listId: "1", enabled: false },
    { listId: "2", enabled: true, requestUsername: "Second" },
  ] };
  const original = structuredClone(config);
  const { client, requests } = setup([page([movie(1)]), page([movie(1)])], config);
  const lists = await client.getEnabledLists();
  assert.deepEqual(lists.map((list) => list.listId), ["3", "2"]);
  assert.deepEqual(lists[0].items, lists[1].items);
  assert.equal(lists[0].requestUsername, "First");
  assert.deepEqual(requests.map(({ url }) => url.pathname), ["/lists/3/items", "/lists/2/items"]);
  assert.deepEqual(config, original);
});

test("all disabled lists issue no HTTP requests", async () => {
  const { client, requests } = setup([], { lists: [{ listId: "1", enabled: false }] });
  assert.deepEqual(await client.getEnabledLists(), []);
  assert.equal(requests.length, 0);
});

test("failed enabled lists are not represented as empty lists", async () => {
  const { client } = setup([new Response(null, { status: 404 })], { lists: [{ listId: "1", enabled: true }] });
  await assert.rejects(client.getEnabledLists(), /List not found/);
});

test("client validates authentication and numeric list IDs without disclosing input", async () => {
  assert.throws(() => createMDBListClient({ mdblistApiKey: " " }), /mdblistApiKey/);
  const { client, requests } = setup([]);
  for (const id of ["TOP_SECRET", "0", "-1", "a/b/c", "../slug", 1, ""]) {
    await assert.rejects(client.getListItems(id), /positive numeric ID string/);
  }
  assert.equal(requests.length, 0);
});
