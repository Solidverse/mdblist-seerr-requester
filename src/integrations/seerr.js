import { createHash } from "node:crypto";

export const REQUEST_PERMISSION = 32;
const idValid = (id) => Number.isSafeInteger(id) && id > 0;
const fail = (message) => {
  throw new Error(`[SEERR] ${message}`);
};
function titleValid(id, type) {
  if (!idValid(id) || !["movie", "tv"].includes(type))
    fail("Invalid media identity.");
}
export function accountName(value) {
  if (
    typeof value !== "string" ||
    value.trim() === "mslr_" ||
    !value.trim() ||
    /[\p{Cc}]/u.test(value)
  )
    fail("Invalid requestUsername.");
  const name = value.trim();
  return name.startsWith("mslr_") ? name : `mslr_${name}`;
}
function emailFor(name) {
  return `${createHash("sha256").update(name).digest("hex").slice(0, 48)}@mslr.invalid`;
}

export function createSeerrClient(
  config,
  { fetchImpl = globalThis.fetch } = {},
) {
  const base = new URL(`${config.seerrUrl.replace(/\/+$/, "")}/api/v1/`);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    !config.seerrApiKey?.trim() ||
    typeof config.dryRun !== "boolean"
  )
    fail("Invalid Seerr configuration.");
  const usersInFlight = new Map();
  const mediaInFlight = new Set();
  const successful = new Map();
  const uncertain = new Set();
  // One client per scheduler configuration snapshot/run. Never cache failures.
  const verifiedUsers = new Map();
  let requestSnapshot;
  function refresh() {
    verifiedUsers.clear();
    requestSnapshot = undefined;
  }
  const isDry = (value = config.dryRun) => {
    if (typeof value !== "boolean") fail("dryRun must be a boolean.");
    return config.dryRun || value;
  };
  async function http(path, { method = "GET", body, userId, expectedStatus } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await fetchImpl(new URL(path, base), {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
          headers: {
            "X-Api-Key": config.seerrApiKey,
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...(userId ? { "X-API-User": String(userId) } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (expectedStatus !== undefined && response.status !== expectedStatus) {
          await response.body?.cancel().catch(() => {});
          throw Object.assign(new Error(`[SEERR] Unexpected submission HTTP ${response.status}.`), {
            httpStatus: response.status, uncertain: response.status >= 500,
          });
        }
        if (response.ok) return await response.json();
      } catch (error) {
        if (error.httpStatus !== undefined) throw error;
        if (method !== "GET")
          fail("Write outcome uncertain; verify before retrying.");
        if (attempt === 2)
          fail("GET failed: network, timeout or invalid JSON.");
      }
      if (response && !response.ok) {
        await response.body?.cancel().catch(() => {});
        if (
          method !== "GET" ||
          (response.status !== 429 && response.status < 500)
        )
          fail(`HTTP ${response.status}.`);
      }
      if (attempt === 2) fail("GET retry attempts exhausted.");
      const retry = response?.headers.get("Retry-After");
      const delay = retry
        ? /^\d+$/.test(retry)
          ? Number(retry) * 1000
          : Date.parse(retry) - Date.now()
        : 1000 * 2 ** attempt;
      if (delay > 2 ** 31 - 1) fail("Retry-After exceeds supported wait time.");
      await new Promise((resolve) =>
        setTimeout(resolve, Number.isFinite(delay) ? Math.max(0, delay) : 1000),
      );
    }
  }
  async function all(path) {
    const results = [];
    const seen = new Set();
    let total;
    while (true) {
      const page = await http(
        `${path}?take=100&skip=${results.length}&sortDirection=asc`,
      );
      if (
        !Array.isArray(page?.results) ||
        !Number.isSafeInteger(page.pageInfo?.results) ||
        page.pageInfo.results < 0
      )
        fail("Invalid paginated response.");
      if (total !== undefined && total !== page.pageInfo.results)
        fail("Collection changed during pagination.");
      total = page.pageInfo.results;
      for (const item of page.results) {
        if (!idValid(item?.id) || seen.has(item.id))
          fail("Invalid or repeated pagination item.");
        seen.add(item.id);
      }
      results.push(...page.results);
      if (
        results.length > total ||
        (!page.results.length && results.length < total)
      )
        fail("Incomplete pagination.");
      if (results.length === total) return results;
    }
  }
  function owned(user) {
    return (
      idValid(user?.id) &&
      typeof user.username === "string" &&
      user.username.startsWith("mslr_") &&
      user.email === emailFor(user.username)
    );
  }
  async function verifyUser(id, dryRun, { refresh: force = false } = {}) {
    const key = `${id}:${dryRun}`;
    if (force) verifiedUsers.delete(key);
    if (!verifiedUsers.has(key)) {
      const pending = checkUser(id, dryRun);
      verifiedUsers.set(key, pending);
      pending.catch(() => { if (verifiedUsers.get(key) === pending) verifiedUsers.delete(key); });
    }
    return verifiedUsers.get(key);
  }
  async function checkUser(id, dryRun) {
    const user = await http(`user/${id}`);
    if (user.id !== id || !owned(user))
      fail("Service account ownership could not be verified.");
    const permissions = await http(`user/${id}/settings/permissions`);
    if (!Number.isSafeInteger(permissions?.permissions))
      fail("Permissions could not be verified.");
    if (permissions.permissions !== REQUEST_PERMISSION) {
      if (dryRun) return { userId: id, wouldCorrectPermissions: true };
      await http(`user/${id}/settings/permissions`, {
        method: "POST",
        body: { permissions: REQUEST_PERMISSION },
      });
      const verified = await http(`user/${id}/settings/permissions`);
      if (verified?.permissions !== REQUEST_PERMISSION)
        fail("Permission correction could not be verified.");
    }
    return { userId: id };
  }
  async function getOrCreateUser(requestUsername, { dryRun } = {}) {
    const dry = isDry(dryRun);
    const username = accountName(requestUsername);
    const key = `${username}:${dry}`;
    if (usersInFlight.has(key)) return usersInFlight.get(key);
    const pending = (async () => {
      const users = await all("user");
      const matches = users.filter(
        (u) =>
          u.username?.toLowerCase() === username.toLowerCase() ||
          u.email === emailFor(username),
      );
      if (
        matches.length > 1 ||
        (matches.length === 1 &&
          (matches[0].username !== username || !owned(matches[0])))
      )
        fail("Service account username/email collision.");
      let user = matches[0];
      if (!user) {
        if (dry) return { userId: null, wouldCreate: true, username };
        try {
          user = await http("user", {
            method: "POST",
            body: {
              username,
              email: emailFor(username),
              permissions: REQUEST_PERMISSION,
            },
          });
        } catch {
          // Reconcile a concurrent create or a lost response, never repeat POST.
          const found = (await all("user")).filter(
            (u) => u.username === username && owned(u),
          );
          if (found.length !== 1) fail("Account creation outcome uncertain.");
          user = found[0];
        }
        if (!owned(user) || user.username !== username)
          fail("Created account could not be verified.");
      }
      const verified = await verifyUser(user.id, dry);
      return dry
        ? { ...verified, username, wouldCreate: false }
        : verified.userId;
    })();
    usersInFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      usersInFlight.delete(key);
    }
  }
  async function loadRequests() {
    const requests = await all("request");
    if (
      requests.some(
        (r) =>
          !idValid(r.media?.tmdbId) ||
          !["movie", "tv"].includes(r.media?.mediaType) ||
          ![1, 2, 3, 4, 5].includes(r.status),
      )
    )
      fail("Incomplete request identity/status.");
    return requests;
  }
  async function getExistingRequests({ refresh: force = false } = {}) {
    if (force) requestSnapshot = undefined;
    if (!requestSnapshot) {
      const pending = loadRequests();
      requestSnapshot = pending;
      pending.catch(() => { if (requestSnapshot === pending) requestSnapshot = undefined; });
    }
    return structuredClone(await requestSnapshot);
  }
  async function getMediaStatus(tmdbId, mediaType, { refresh: force = false } = {}) {
    titleValid(tmdbId, mediaType);
    const details = await http(`${mediaType}/${tmdbId}`);
    if (
      details?.id !== tmdbId ||
      (details.mediaInfo != null &&
        ![1, 2, 3, 4, 5, 6, 7].includes(details.mediaInfo.status))
    )
      fail("Ambiguous media response.");
    const requests = (await getExistingRequests({ refresh: force })).filter(
      (r) => r.media.tmdbId === tmdbId && r.media.mediaType === mediaType,
    );
    if (
      details.mediaInfo?.requests !== undefined &&
      !Array.isArray(details.mediaInfo.requests)
    )
      fail("Invalid embedded requests.");
    return {
      status: details.mediaInfo?.status ?? 1,
      requests,
      exists:
        [2, 3, 4, 5, 6].includes(details.mediaInfo?.status) ||
        requests.length > 0 ||
        (details.mediaInfo?.requests?.length ?? 0) > 0,
    };
  }
  function validRequest(request, tmdbId, mediaType, userId) {
    return (
      idValid(request?.id) &&
      [1, 2, 3, 4, 5].includes(request.status) &&
      request.requestedBy?.id === userId &&
      request.media?.tmdbId === tmdbId &&
      request.media?.mediaType === mediaType
    );
  }
  async function approveRequest(requestId, { dryRun } = {}) {
    if (!idValid(requestId)) fail("Invalid request ID.");
    if (isDry(dryRun)) return { dryRun: true, wouldApprove: true };
    const result = await http(`request/${requestId}/approve`, {
      method: "POST",
    });
    if (result?.id !== requestId || result.status !== 2)
      fail("Approval outcome uncertain.");
    return result;
  }
  async function createRequest({
    tmdbId,
    mediaType,
    userId,
    requestUsername,
    dryRun,
    autoApprove = false,
  }) {
    titleValid(tmdbId, mediaType);
    const dry = isDry(dryRun);
    if ((!idValid(userId) && !(dry && userId == null && typeof requestUsername === "string")) || typeof autoApprove !== "boolean")
      fail("Invalid request options.");
    const key = `${mediaType}:${tmdbId}`;
    if (uncertain.has(key))
      fail(
        "Submission outcome uncertain; manual verification required before retrying.",
      );
    if (mediaInFlight.has(key) || successful.has(key))
      return { submitted: false, existing: true };
    mediaInFlight.add(key);
    try {
      const verification = idValid(userId)
        ? await verifyUser(userId, dry)
        : await getOrCreateUser(requestUsername, { dryRun: true });
      const existing = await getMediaStatus(tmdbId, mediaType);
      if (existing.exists) return { submitted: false, existing: true };
      if (dry)
        return {
          submitted: false,
          dryRun: true,
          wouldSubmit: true,
          wouldApprove: autoApprove,
          ...verification,
        };
      let request;
      uncertain.add(key);
      try {
        request = await http("request", {
          method: "POST",
          userId,
          expectedStatus: 201,
          body: {
            mediaType,
            mediaId: tmdbId,
            ...(mediaType === "tv" ? { seasons: "all" } : {}),
          },
        });
        if (!validRequest(request, tmdbId, mediaType, userId))
          throw new Error();
      } catch (error) {
        if (error.httpStatus !== undefined && !error.uncertain) {
          uncertain.delete(key);
          requestSnapshot = undefined;
          throw error;
        }
        // A matching account/title alone cannot prove which POST created it.
        // Inspect fresh state, but leave attribution of an ambiguous write unresolved.
        let candidates = [];
        try {
          candidates = (await getExistingRequests({ refresh: true })).filter((r) =>
            validRequest(r, tmdbId, mediaType, userId),
          );
        } catch { /* Failed reconciliation remains uncertain. */ }
        throw Object.assign(new Error("[SEERR] Submission outcome uncertain; verify before retrying."), {
          uncertain: true,
          ...(candidates.length === 1 ? { candidateRequestId: candidates[0].id } : {}),
        });
      }
      const result = {
        submitted: true,
        requestId: request.id,
        tmdbId,
        mediaType,
        userId,
        status: request.status,
        approvalFailed: false,
      };
      // Confirm success before any optional cache maintenance or approval.
      uncertain.delete(key);
      successful.set(key, result);
      if (requestSnapshot) {
        // Chain onto the current promise synchronously: concurrent successes merge.
        const updated = requestSnapshot.then((known) => [
          ...known.filter((r) => r.id !== request.id), request,
        ]);
        requestSnapshot = updated;
        updated.catch(() => {
          if (requestSnapshot === updated) requestSnapshot = undefined;
        });
      }
      if (autoApprove && request.status === 1) {
        try {
          const approved = await approveRequest(request.id, { dryRun: false });
          if (!validRequest(approved, tmdbId, mediaType, userId))
            throw new Error();
          result.status = approved.status;
          request.status = approved.status;
        } catch {
          result.approvalFailed = true;
        }
      }
      return result;
    } finally {
      mediaInFlight.delete(key);
    }
  }
  return {
    // Call refresh() at a new run boundary when reusing this client.
    refresh,
    verifyUser: (id, { dryRun, refresh: force = false } = {}) => {
      if (!idValid(id)) fail("Invalid user ID.");
      return verifyUser(id, isDry(dryRun), { refresh: force });
    },
    getUsers: () => all("user"),
    getOrCreateUser,
    getMediaStatus,
    getExistingRequests,
    createRequest,
    approveRequest,
  };
}
