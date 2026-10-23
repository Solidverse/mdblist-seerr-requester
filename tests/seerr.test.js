import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createSeerrClient } from "../src/integrations/seerr.js";

const username = "mslr_Trending";
const email = `${createHash("sha256").update(username).digest("hex").slice(0, 48)}@mslr.invalid`;
const user = () => ({ id: 2, username, email, permissions: 32 });
function setup(options = {}) {
  const state = { users: [user()], permissions: 32, requests: [], status: 1, ...options };
  const calls = [];
  const client = createSeerrClient({ seerrUrl: "http://seerr:5055", seerrApiKey: "SECRET", dryRun: options.dryRun ?? false }, {
    fetchImpl: async (url, init) => {
      const path = url.pathname.replace("/api/v1/", "");
      const body = init.body ? JSON.parse(init.body) : undefined;
      const { password, ...publicBody } = body ?? {};
      calls.push({ path, ...init, body: body ? publicBody : undefined,
        ...(password !== undefined ? { passwordInfo: {
          length: password.length, bytes: Buffer.from(password, "base64url").length,
          fingerprint: createHash("sha256").update(password).digest("hex"),
          isBase64url: /^[A-Za-z0-9_-]+$/.test(password),
          predictable: password.includes(body.username) || password === "SECRET",
        } } : {}) });
      if (options.override) {
        const response = options.override(path, init, body, state);
        if (response) return response;
      }
      if (path === "user" && init.method === "GET") {
        const skip = Number(url.searchParams.get("skip"));
        return Response.json({ pageInfo: { results: state.users.length }, results: state.users.slice(skip, skip + (options.pageSize ?? 100)) });
      }
      if (path === "user") {
        const created = { id: 2, ...publicBody }; state.users.push(created); return Response.json(created);
      }
      if (path === "user/2") return Response.json(state.users.find((u) => u.id === 2));
      if (path === "user/2/settings/permissions") {
        if (body && !options.refusePermissions) state.permissions = body.permissions;
        return Response.json({ permissions: state.permissions });
      }
      if (/^(movie|tv)\//.test(path)) return Response.json({ id: 123, mediaInfo: state.status === null ? null : { status: state.status } });
      if (path === "request" && init.method === "GET") return Response.json({ pageInfo: { results: state.requests.length }, results: state.requests });
      if (path === "request") {
        const request = { id: 10 + state.requests.length, status: 1, media: { tmdbId: body.mediaId, mediaType: body.mediaType }, requestedBy: { id: Number(init.headers["X-API-User"]) } };
        state.requests.push(request); return Response.json(request, { status: 201 });
      }
      if (path === "request/10/approve") return Response.json({ ...state.requests[0], status: 2 });
      throw new Error("Unexpected mocked call");
    },
  });
  return { client, calls, state };
}
const submit = (client, extra = {}) => client.createRequest({ tmdbId: 123, mediaType: "movie", userId: 2, ...extra });

test("owned user is reused with request-only permissions", async () => {
  const { client, calls } = setup();
  assert.equal(await client.getOrCreateUser("Trending"), 2);
  assert.ok(calls.every((c) => c.headers["X-Api-Key"] === "SECRET"));
  assert.ok(calls.every((c) => c.method === "GET"));
});
test("new user uses prefix, deterministic invalid-domain email and permission 32", async () => {
  const { client, calls } = setup({ users: [] });
  const ids = await Promise.all([client.getOrCreateUser("Trending"), client.getOrCreateUser("Trending")]);
  assert.deepEqual(ids, [2, 2]);
  assert.deepEqual(calls.find((c) => c.method === "POST").body, { username, email, permissions: 32 });
  assert.equal(calls.filter((c) => c.path === "user" && c.method === "POST").length, 1);
  const password = calls.find((c) => c.path === "user" && c.method === "POST").passwordInfo;
  assert.ok(password.length >= 43 && password.bytes >= 32 && password.isBase64url && !password.predictable, "Creation must use a cryptographically random password.");
});
test("user lookup handles pagination", async () => {
  const { client } = setup({ pageSize: 1, users: [{ id: 3, username: "Other", email: "other@example.com" }, user()] });
  assert.equal(await client.getOrCreateUser("mslr_Trending"), 2);
});
test("username collision is never modified", async () => {
  const { client, calls } = setup({ users: [{ ...user(), email: "unrelated@example.com" }] });
  await assert.rejects(client.getOrCreateUser("Trending"), /collision/);
  assert.ok(calls.every((c) => c.method === "GET"));
});
test("incorrect permissions are corrected and read back", async () => {
  const { client, state } = setup({ permissions: 2 });
  assert.equal(await client.getOrCreateUser("Trending"), 2);
  assert.equal(state.permissions, 32);
});
test("unverifiable permissions prevent submission", async () => {
  const { client, calls } = setup({ permissions: 2, refusePermissions: true });
  await assert.rejects(submit(client), /Permission correction/);
  assert.ok(!calls.some((c) => c.path === "request" && c.method === "POST"));
});
for (const status of [1, 2, 3, 4, 5, 6, 7, null]) {
  test(`media status ${status} is detected conservatively`, async () => {
    const { client } = setup({ status });
    assert.equal((await client.getMediaStatus(123, "movie")).exists, [2, 3, 4, 5, 6].includes(status));
  });
}
for (const mediaType of ["movie", "tv"]) {
  for (const status of [1, 2, 3, 4, 5]) {
    test(`existing ${mediaType} request status ${status} blocks submission`, async () => {
      const { client } = setup({ requests: [{ id: 5, status, media: { tmdbId: 123, mediaType } }] });
      assert.equal((await client.getMediaStatus(123, mediaType)).exists, true);
    });
  }
  for (const autoApprove of [false, true]) {
    test(`${mediaType} submission with autoApprove=${autoApprove}`, async () => {
      const { client, calls } = setup();
      const result = await submit(client, { mediaType, autoApprove });
      assert.equal(result.submitted, true);
      assert.equal(result.status, autoApprove ? 2 : 1);
      const post = calls.find((c) => c.path === "request" && c.method === "POST");
      assert.equal(post.headers["X-API-User"], "2");
      assert.deepEqual(post.body, { mediaType, mediaId: 123, ...(mediaType === "tv" ? { seasons: "all" } : {}) });
      const approval = calls.find((c) => c.path.endsWith("approve"));
      assert.equal(Boolean(approval), autoApprove);
      if (approval) assert.equal(approval.headers["X-API-User"], undefined);
      assert.equal((await submit(client, { mediaType })).submitted, false);
    });
  }
}
test("approval failure preserves confirmed submission", async () => {
  const { client, calls } = setup({ override: (path) => path.endsWith("approve") ? new Response(null, { status: 500 }) : null });
  const result = await submit(client, { autoApprove: true });
  assert.equal(result.submitted, true);
  assert.equal(result.requestId, 10);
  assert.equal(result.approvalFailed, true);
  assert.equal(calls.filter((c) => c.path === "request" && c.method === "POST").length, 1);
});
test("shared account supports independent movie and TV approval", async () => {
  const { client, state } = setup();
  assert.equal((await submit(client, { autoApprove: true })).status, 2);
  assert.equal((await submit(client, { mediaType: "tv", autoApprove: false })).status, 1);
  assert.equal(state.permissions, 32);
});
test("lost POST response identifies a candidate without claiming confirmed success", async () => {
  const { client, calls } = setup({ override: (path, init, body, state) => {
    if (path === "request" && init.method === "POST") {
      state.requests.push({ id: 7, status: 1, media: { tmdbId: 123, mediaType: "movie" }, requestedBy: { id: 2 } });
      throw new Error("SECRET");
    }
  } });
  await assert.rejects(submit(client), (error) => {
    assert.equal(error.uncertain, true);
    assert.equal(error.candidateRequestId, 7);
    return true;
  });
  assert.equal(calls.filter((c) => c.path === "request" && c.method === "POST").length, 1);
});
test("uncertain submission never claims another user's request", async () => {
  const { client } = setup({ override: (path, init, body, state) => {
    if (path === "request" && init.method === "POST") {
      state.requests.push({ id: 7, status: 1, media: { tmdbId: 123, mediaType: "movie" }, requestedBy: { id: 9 } });
      throw new Error("SECRET");
    }
  } });
  await assert.rejects(submit(client), /Submission outcome uncertain/);
});
test("dry-run protects every write even with an explicit false override", async () => {
  const { client, calls } = setup({ dryRun: true, permissions: 2 });
  await client.getOrCreateUser("Trending", { dryRun: false });
  await submit(client, { autoApprove: true, dryRun: false });
  await client.approveRequest(10, { dryRun: false });
  assert.ok(calls.every((c) => c.method === "GET"));
  const missing = setup({ dryRun: true, users: [] });
  assert.equal((await missing.client.getOrCreateUser("Trending")).wouldCreate, true);
});
test("unexpected media responses fail safely", async () => {
  const { client } = setup({ status: 999 });
  await assert.rejects(client.getMediaStatus(123, "movie"), /Ambiguous/);
});
test("GET network failures retry and sanitize errors", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { client, calls } = setup({ override: () => { throw new Error("SECRET"); } });
  const pending = assert.rejects(client.getUsers(), /GET failed/);
  await setImmediate(); t.mock.timers.tick(1000);
  await setImmediate(); t.mock.timers.tick(2000);
  await pending;
  assert.equal(calls.length, 3);
});

test("uncertain outcomes prevent subsequent POST attempts", async () => {
  const { client, calls } = setup({ override: (path, init) => {
    if (path === "request" && init.method === "POST") throw new Error("timeout SECRET");
  } });
  await assert.rejects(submit(client), /uncertain/);
  await assert.rejects(submit(client), /uncertain/);
  assert.equal(calls.filter((c) => c.path === "request" && c.method === "POST").length, 1);
});
test("malformed paginated user response is rejected", async () => {
  const { client } = setup({ override: () => Response.json({ results: [] }) });
  await assert.rejects(client.getUsers(), /Invalid paginated/);
});
test("HTTP authentication failure is sanitized without retries", async () => {
  const { client, calls } = setup({ override: () => new Response("SECRET", { status: 401 }) });
  await assert.rejects(client.getUsers(), /HTTP 401/);
  assert.equal(calls.length, 1);
});
test("request lists paginate and preserve both media types", async () => {
  let calls = 0;
  const { client } = setup({ override: (path, init) => {
    if (path === "request" && init.method === "GET") return Response.json({
      pageInfo: { results: 2 }, results: [{ id: ++calls, status: 1, media: { tmdbId: 123, mediaType: calls === 1 ? "movie" : "tv" } }],
    });
  } });
  assert.equal((await client.getExistingRequests()).length, 2);
  assert.equal(calls, 2);
});

test("request snapshots and verified permissions are reused within a run", async () => {
  const { client, calls } = setup();
  await client.getOrCreateUser("Trending");
  await submit(client);
  await submit(client, { mediaType: "tv" });
  assert.equal(calls.filter((c) => c.path === "request" && c.method === "GET").length, 1);
  assert.equal(calls.filter((c) => c.path === "user/2/settings/permissions").length, 1);
  assert.equal((await client.getExistingRequests()).length, 2);
});
test("request snapshots refresh explicitly and failed loads are not cached", async () => {
  const { client, state } = setup();
  assert.equal((await client.getExistingRequests()).length, 0);
  state.requests.push({ id: 55, status: 5, media: { tmdbId: 123, mediaType: "movie" } });
  assert.equal((await client.getExistingRequests()).length, 0);
  assert.equal((await client.getExistingRequests({ refresh: true })).length, 1);
});
test("refreshing permissions detects changed privileges before submission", async () => {
  const { client, state, calls } = setup();
  await client.getOrCreateUser("Trending");
  state.permissions = 2;
  await client.verifyUser(2, { refresh: true });
  assert.equal(state.permissions, 32);
  assert.ok(calls.some((c) => c.path.endsWith("permissions") && c.method === "POST"));
  client.refresh();
  await client.verifyUser(2);
  assert.equal(calls.filter((c) => c.path === "user/2").length, 3);
});
test("dry-run simulates submission and approval for an account that would be created", async () => {
  const { client, calls } = setup({ dryRun: true, users: [] });
  const account = await client.getOrCreateUser("Trending");
  const result = await submit(client, { userId: account.userId, requestUsername: account.username, autoApprove: true });
  assert.equal(result.wouldCreate, true);
  assert.equal(result.wouldSubmit, true);
  assert.equal(result.wouldApprove, true);
  assert.equal(result.userId, null);
  assert.ok(calls.every((c) => c.method === "GET"));
  await assert.rejects(submit(client, { userId: null }), /Invalid request options/);
});
test("non-dry-run never accepts an account plan instead of a numeric ID", async () => {
  const { client } = setup();
  await assert.rejects(submit(client, { userId: null, requestUsername: "Trending" }), /Invalid request options/);
});

for (const status of [200, 202, 403, 409]) {
  test(`submission HTTP ${status} never claims another matching request as newly created`, async () => {
    const { client, calls } = setup({ override: (path, init, body, state) => {
      if (path === "request" && init.method === "POST") {
        const match = { id: 90, status: 1, media: { tmdbId: 123, mediaType: "movie" }, requestedBy: { id: 2 } };
        state.requests.push(match);
        return Response.json(match, { status });
      }
    } });
    await assert.rejects(submit(client, { autoApprove: true }), (error) => {
      assert.equal(error.httpStatus, status);
      assert.equal(error.uncertain, false);
      assert.doesNotMatch(error.message, /SECRET/);
      return true;
    });
    assert.equal(calls.filter((c) => c.path === "request" && c.method === "GET").length, 1);
    assert.equal(calls.filter((c) => c.path === "request" && c.method === "POST").length, 1);
    assert.ok(!calls.some((c) => c.path.endsWith("approve")));
  });
}

test("confirmed 201 survives a failing cache refresh and still performs approval", async () => {
  let afterPost = false;
  let refreshFailed;
  const { client, calls } = setup({ override: (path, init, body, state) => {
    if (path === "request" && init.method === "GET" && afterPost) return new Response(null, { status: 403 });
    if (path === "request" && init.method === "POST") {
      afterPost = true;
      refreshFailed = client.getExistingRequests({ refresh: true }).catch(() => {});
    }
  } });
  const result = await submit(client, { autoApprove: true });
  await refreshFailed;
  assert.equal(result.submitted, true);
  assert.equal(result.requestId, 10);
  assert.equal(result.status, 2);
  assert.equal(result.approvalFailed, false);
  assert.equal((await submit(client)).submitted, false);
  assert.equal(calls.filter((c) => c.path === "request" && c.method === "POST").length, 1);
});

test("concurrent confirmed submissions merge their cache updates", async () => {
  const { client, calls } = setup();
  const results = await Promise.all([submit(client), submit(client, { mediaType: "tv" })]);
  assert.ok(results.every((r) => r.submitted));
  const requests = await client.getExistingRequests();
  assert.equal(requests.length, 2);
  assert.deepEqual(new Set(requests.map((r) => r.media.mediaType)), new Set(["movie", "tv"]));
  assert.equal(calls.filter((c) => c.path === "request" && c.method === "GET").length, 1);
});

test("server error with a matching request remains uncertain", async () => {
  const { client } = setup({ override: (path, init, body, state) => {
    if (path === "request" && init.method === "POST") {
      state.requests.push({ id: 91, status: 1, media: { tmdbId: 123, mediaType: "movie" }, requestedBy: { id: 2 } });
      return new Response("SECRET", { status: 500 });
    }
  } });
  await assert.rejects(submit(client), (error) => {
    assert.equal(error.uncertain, true);
    assert.equal(error.candidateRequestId, 91);
    return true;
  });
});

for (const status of [401, 403]) {
  test(`user lookup preserves HTTP ${status} and operation without extra calls`, async () => {
    const { formatError } = await import("../src/utils/errors.js");
    const { client, calls } = setup({ override: () => new Response("SECRET private@example.com", { status }) });
    await assert.rejects(client.getOrCreateUser("Trending"), (error) => {
      assert.equal(error.httpStatus, status); assert.equal(error.operation, "GET /api/v1/user");
      assert.match(formatError(error), new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(formatError(error), /SECRET|private@example/); return true;
    });
    assert.equal(calls.length, 1);
  });
}
for (const kind of ["network", "timeout", "invalid JSON"]) {
  test(`GET diagnostics distinguish ${kind} after existing bounded retries`, async (t) => {
    const { formatError } = await import("../src/utils/errors.js");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { client, calls } = setup({ override: () => {
      if (kind === "invalid JSON") return new Response("SECRET malformed");
      if (kind === "timeout") throw new DOMException("SECRET", "TimeoutError");
      throw Object.assign(new Error("SECRET"), { cause: Object.assign(new Error("private@example.com"), { code: "ECONNREFUSED" }) });
    } });
    const pending = assert.rejects(client.getUsers(), (error) => {
      const text = formatError(error);
      assert.match(text, /GET \/api\/v1\/user/);
      assert.match(text, kind === "network" ? /ECONNREFUSED/ : kind === "timeout" ? /TIMEOUT/ : /INVALID_RESPONSE/);
      assert.doesNotMatch(text, /SECRET|private@example/); return true;
    });
    await setImmediate(); t.mock.timers.tick(1000); await setImmediate(); t.mock.timers.tick(2000);
    await pending; assert.equal(calls.length, 3);
  });
}

test("new accounts get distinct random passwords while existing users receive none", async () => {
  const fingerprints = [];
  for (const name of ["Trending", "Popular"]) {
    const s = setup({ users: [] });
    await s.client.getOrCreateUser(name);
    const creation = s.calls.find((c) => c.path === "user" && c.method === "POST");
    assert.ok(creation.passwordInfo.bytes >= 32 && !creation.passwordInfo.predictable);
    fingerprints.push(creation.passwordInfo.fingerprint);
    await s.client.getOrCreateUser(name);
    assert.equal(s.calls.filter((c) => c.passwordInfo).length, 1);
  }
  assert.ok(fingerprints[0] !== fingerprints[1], "Each new account must receive independent random bytes.");
});

test("email-disabled server accepts explicit password and default ADMIN permissions are removed", async () => {
  const { client, calls, state } = setup({ users: [], permissions: 2, override: (path, init, body) => {
    if (path === "user" && init.method === "POST" && !body.password) return new Response(null, { status: 500 });
  } });
  assert.equal(await client.getOrCreateUser("Trending"), 2);
  assert.equal(state.permissions, 32);
  const permissions = calls.filter((c) => c.path.endsWith("settings/permissions"));
  assert.deepEqual(permissions.map((c) => c.method), ["GET", "POST", "GET"]);
  assert.deepEqual(permissions[1].body, { permissions: 32 });
});

for (const failure of ["refused", "http", "verification"]) {
  test(`created account with failed permission correction (${failure}) is not usable or replaced`, async () => {
    const { client, calls, state } = setup({ users: [], permissions: 2, refusePermissions: failure === "refused",
      override: (path, init) => {
        if (path.endsWith("settings/permissions") && failure === "http" && init.method === "POST") return new Response(null, { status: 403 });
        if (path.endsWith("settings/permissions") && failure === "verification" && init.method === "GET") return Response.json({});
      },
    });
    await assert.rejects(client.getOrCreateUser("Trending"));
    await assert.rejects(client.getOrCreateUser("Trending"));
    assert.equal(state.users.length, 1);
    assert.equal(calls.filter((c) => c.path === "user" && c.method === "POST").length, 1);
    assert.ok(!calls.some((c) => c.path === "request"));
  });
}

for (const outcome of ["lost", 500, 409]) {
  test(`ambiguous/colliding user creation (${outcome}) reconciles exact owned account without another POST`, async () => {
    const { client, calls, state } = setup({ users: [], permissions: 2,
      override: (path, init, body, state) => {
        if (path === "user" && init.method === "POST") {
          state.users.push({ id: 2, username: body.username, email: body.email });
          if (outcome === "lost") throw new Error("Lost response");
          return new Response(null, { status: outcome });
        }
      },
    });
    assert.equal(await client.getOrCreateUser("Trending"), 2);
    assert.equal(state.permissions, 32);
    assert.equal(calls.filter((c) => c.path === "user" && c.method === "POST").length, 1);
  });
}

test("passwords are absent from creation failures, cause metadata and diagnostics", async () => {
  const { formatError } = await import("../src/utils/errors.js");
  let secret;
  const { client, calls } = setup({ users: [], override: (path, init, body) => {
    if (path === "user" && init.method === "POST") {
      secret = body.password;
      // Deliberately hostile transport error echoing the full secret payload.
      throw Object.assign(new Error(secret), { password: secret, body });
    }
  } });
  await assert.rejects(client.getOrCreateUser("Trending"), (error) => {
    assert.equal(error.uncertain, true);
    assert.ok(typeof secret === "string" && secret.length >= 43);
    const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
    assert.ok(!serialized.includes(secret) && !formatError(error).includes(secret) && !error.message.includes(secret), "Creation error must not retain the password.");
    for (let cause = error.cause; cause; cause = cause.cause) {
      assert.ok(!JSON.stringify(cause, Object.getOwnPropertyNames(cause)).includes(secret), "Cause must not retain credentials.");
    }
    return true;
  });
  assert.equal(calls.filter((c) => c.path === "user" && c.method === "POST").length, 1);
});

test("dry-run missing user sends no password or writes", async () => {
  const { client, calls } = setup({ users: [], dryRun: true });
  assert.equal((await client.getOrCreateUser("Trending")).wouldCreate, true);
  assert.ok(calls.every((c) => c.method === "GET" && !c.passwordInfo && c.body === undefined));
});

test("creation without email verifies ownership and permissions through authenticated GET", async () => {
  const { client, calls, state } = setup({ users: [], permissions: 2,
    override: (path, init, body, state) => {
      if (path === "user" && init.method === "POST") {
        state.users.push({ id: 2, username: body.username, email: body.email });
        return Response.json({ id: 2, username: body.username }, { status: 201 });
      }
    },
  });
  assert.equal(await client.getOrCreateUser("Trending"), 2);
  assert.equal(state.permissions, 32);
  const post = calls.findIndex((c) => c.path === "user" && c.method === "POST");
  assert.deepEqual(calls.slice(post + 1).map((c) => `${c.method} ${c.path}`), [
    "GET user/2", "GET user/2/settings/permissions",
    "POST user/2/settings/permissions", "GET user/2/settings/permissions",
  ]);
});

test("filtered creation response does not bypass ownership verification", async () => {
  const { client, calls } = setup({ users: [],
    override: (path, init, body, state) => {
      if (path === "user" && init.method === "POST") {
        state.users.push({ id: 2, username: body.username, email: "unrelated@example.com" });
        return Response.json({ id: 2, username: body.username }, { status: 201 });
      }
    },
  });
  await assert.rejects(client.getOrCreateUser("Trending"), /ownership could not be verified/);
  assert.ok(!calls.some((c) => c.path.endsWith("settings/permissions")));
  assert.equal(calls.filter((c) => c.path === "user" && c.method === "POST").length, 1);
});
