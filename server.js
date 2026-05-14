import { createServer } from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 4177);
const MAX_DAYS = Number(process.env.CODEX_DASHBOARD_DAYS || 45);
const ACTIVITY_GAP_MINUTES = Number(process.env.CODEX_ACTIVITY_GAP_MINUTES || 30);
const CACHE_MS = Number(process.env.CODEX_DASHBOARD_CACHE_MS || 10_000);
let snapshotCache = null;

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function normalizeTimestamp(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function unixResetToIso(value) {
  if (!Number.isFinite(value)) return null;
  const ms = value > 10_000_000_000 ? value : value * 1000;
  return new Date(ms).toISOString();
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectJsonlFiles(root) {
  const files = [];
  const cutoff = Date.now() - MAX_DAYS * 24 * 60 * 60 * 1000;

  async function walk(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

      try {
        const stat = await fs.stat(fullPath);
        if (stat.mtimeMs >= cutoff) files.push({ path: fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {
        // File may disappear while Codex rotates sessions.
      }
    }
  }

  await walk(root);
  return files;
}

async function parseJsonlFile(file) {
  const text = await fs.readFile(file.path, "utf8");
  const lines = text.split(/\r?\n/);
  const session = {
    id: path.basename(file.path, ".jsonl"),
    file: file.path,
    cwd: null,
    originator: null,
    models: new Set(),
    startedAt: null,
    lastAt: null,
    eventCount: 0,
    tokenEvents: 0,
    lastUsage: null,
    lastRateLimits: null,
    activity: [],
  };

  for (const line of lines) {
    if (!line.trim()) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const at = normalizeTimestamp(record.timestamp || record.payload?.timestamp);
    if (!at) continue;

    session.startedAt = session.startedAt && session.startedAt < at ? session.startedAt : at;
    session.lastAt = session.lastAt && session.lastAt > at ? session.lastAt : at;
    session.eventCount += 1;

    if (record.type === "session_meta") {
      session.id = record.payload?.id || session.id;
      session.cwd = record.payload?.cwd || session.cwd;
      session.originator = record.payload?.originator || session.originator;
      if (record.payload?.model_provider) session.models.add(record.payload.model_provider);
      session.activity.push({ at: at.toISOString(), kind: "session", weight: 1, sessionId: session.id });
      continue;
    }

    const payload = record.payload || {};
    const isTokenCount = record.type === "event_msg" && payload.type === "token_count";
    if (isTokenCount) {
      session.tokenEvents += 1;
      session.lastUsage = payload.info?.total_token_usage || payload.info?.last_token_usage || session.lastUsage;
      session.lastRateLimits = payload.rate_limits || session.lastRateLimits;
      session.activity.push({ at: at.toISOString(), kind: "usage", weight: 5, sessionId: session.id });
      continue;
    }

    if (record.type === "response_item" && payload.type === "function_call") {
      session.activity.push({ at: at.toISOString(), kind: "tool", weight: 2, sessionId: session.id });
      continue;
    }

    if (record.type === "response_item" && payload.type === "message") {
      session.activity.push({ at: at.toISOString(), kind: payload.role || "message", weight: 2, sessionId: session.id });
    }
  }

  session.models = Array.from(session.models);
  return session;
}

function mergeWindows(activity) {
  const gapMs = ACTIVITY_GAP_MINUTES * 60 * 1000;
  const sorted = activity
    .map((item) => ({ ...item, ms: Date.parse(item.at) }))
    .filter((item) => Number.isFinite(item.ms))
    .sort((a, b) => a.ms - b.ms);

  const windows = [];
  for (const item of sorted) {
    const last = windows.at(-1);
    if (!last || item.ms - last.endMs > gapMs) {
      windows.push({
        startMs: item.ms,
        endMs: item.ms,
        weight: item.weight,
        eventCount: 1,
        sessions: new Set([item.sessionId]),
        kinds: new Map([[item.kind, 1]]),
      });
      continue;
    }

    last.endMs = Math.max(last.endMs, item.ms);
    last.weight += item.weight;
    last.eventCount += 1;
    last.sessions.add(item.sessionId);
    last.kinds.set(item.kind, (last.kinds.get(item.kind) || 0) + 1);
  }

  return windows.map((window) => ({
    start: new Date(window.startMs).toISOString(),
    end: new Date(window.endMs).toISOString(),
    durationMinutes: Math.max(1, Math.round((window.endMs - window.startMs) / 60000)),
    weight: window.weight,
    eventCount: window.eventCount,
    sessionCount: window.sessions.size,
    dominantKind: Array.from(window.kinds.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || "activity",
  }));
}

function summarizeLimits(rateLimits, activity) {
  const nowMs = Date.now();
  const fiveHourStartMs = nowMs - 5 * 60 * 60 * 1000;
  const weekStartMs = nowMs - 7 * 24 * 60 * 60 * 1000;
  const activityMs = activity.map((item) => Date.parse(item.at)).filter(Number.isFinite);
  const inFiveHours = activityMs.filter((ms) => ms >= fiveHourStartMs).length;
  const inWeek = activityMs.filter((ms) => ms >= weekStartMs).length;

  const primary = rateLimits?.primary
    ? {
        source: "codex token_count",
        usedPercent: rateLimits.primary.used_percent ?? null,
        windowMinutes: rateLimits.primary.window_minutes ?? 300,
        resetsAt: unixResetToIso(rateLimits.primary.resets_at),
        reachedType: rateLimits.rate_limit_reached_type || null,
      }
    : {
        source: "inferred local activity",
        usedPercent: null,
        windowMinutes: 300,
        resetsAt: null,
        reachedType: null,
      };

  const secondary = rateLimits?.secondary
    ? {
        source: "codex token_count",
        usedPercent: rateLimits.secondary.used_percent ?? null,
        windowMinutes: rateLimits.secondary.window_minutes ?? 10080,
        resetsAt: unixResetToIso(rateLimits.secondary.resets_at),
        reachedType: rateLimits.rate_limit_reached_type || null,
      }
    : {
        source: "inferred local activity",
        usedPercent: null,
        windowMinutes: 10080,
        resetsAt: null,
        reachedType: null,
      };

  return {
    primary,
    secondary,
    inferred: {
      fiveHourActivityEvents: inFiveHours,
      weeklyActivityEvents: inWeek,
      activeNow: activityMs.some((ms) => nowMs - ms < 15 * 60 * 1000),
    },
  };
}

function buildHourlyBuckets(activity) {
  const now = Date.now();
  const start = now - 7 * 24 * 60 * 60 * 1000;
  const buckets = new Map();

  for (let ms = start; ms <= now; ms += 60 * 60 * 1000) {
    const d = new Date(ms);
    d.setMinutes(0, 0, 0);
    buckets.set(d.toISOString(), 0);
  }

  for (const item of activity) {
    const ms = Date.parse(item.at);
    if (!Number.isFinite(ms) || ms < start || ms > now) continue;
    const d = new Date(ms);
    d.setMinutes(0, 0, 0);
    const key = d.toISOString();
    buckets.set(key, (buckets.get(key) || 0) + item.weight);
  }

  return Array.from(buckets.entries()).map(([at, weight]) => ({ at, weight }));
}

async function buildSnapshot() {
  if (snapshotCache && Date.now() - snapshotCache.createdAt < CACHE_MS) {
    return snapshotCache.value;
  }

  const roots = [path.join(CODEX_HOME, "sessions"), path.join(CODEX_HOME, "archived_sessions")];
  const existingRoots = [];
  for (const root of roots) {
    if (await fileExists(root)) existingRoots.push(root);
  }

  const files = (await Promise.all(existingRoots.map(collectJsonlFiles))).flat();
  const sessions = [];
  for (const file of files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 800)) {
    try {
      sessions.push(await parseJsonlFile(file));
    } catch {
      // Keep the dashboard alive if a file is being written mid-read.
    }
  }

  const activity = sessions.flatMap((session) => session.activity);
  const latestSession = sessions
    .filter((session) => session.lastAt)
    .sort((a, b) => b.lastAt - a.lastAt)[0];
  const latestRateSession = sessions
    .filter((session) => session.lastRateLimits && session.lastAt)
    .sort((a, b) => b.lastAt - a.lastAt)[0];
  const windows = mergeWindows(activity).slice(-40).reverse();
  const limits = summarizeLimits(latestRateSession?.lastRateLimits, activity);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    codexHome: CODEX_HOME,
    filesScanned: files.length,
    sessionCount: sessions.length,
    activityEventCount: activity.length,
    latestSession: latestSession
      ? {
          id: latestSession.id,
          cwd: latestSession.cwd,
          originator: latestSession.originator,
          startedAt: latestSession.startedAt?.toISOString() || null,
          lastAt: latestSession.lastAt?.toISOString() || null,
          tokenEvents: latestSession.tokenEvents,
          eventCount: latestSession.eventCount,
        }
      : null,
    limits,
    recentWindows: windows,
    hourlyBuckets: buildHourlyBuckets(activity),
    recentSessions: sessions
      .filter((session) => session.lastAt)
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, 20)
      .map((session) => ({
        id: session.id,
        cwd: session.cwd,
        originator: session.originator,
        startedAt: session.startedAt?.toISOString() || null,
        lastAt: session.lastAt?.toISOString() || null,
        eventCount: session.eventCount,
        tokenEvents: session.tokenEvents,
        hasRateLimit: Boolean(session.lastRateLimits),
      })),
  };

  snapshotCache = { createdAt: Date.now(), value: snapshot };
  return snapshot;
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "content-type": MIME_TYPES.get(path.extname(filePath)) || "application/octet-stream",
      "cache-control": "no-cache",
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/api/usage") {
      sendJson(res, 200, await buildSnapshot());
      return;
    }
    if (url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, generatedAt: new Date().toISOString(), codexHome: CODEX_HOME });
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : "Unknown error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Codex Usage Watch listening on http://${HOST}:${PORT}`);
  console.log(`Reading Codex data from ${CODEX_HOME}`);
});
