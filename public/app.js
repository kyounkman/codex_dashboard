const els = {
  subtitle: document.querySelector("#subtitle"),
  refreshButton: document.querySelector("#refreshButton"),
  statusDot: document.querySelector("#statusDot"),
  primaryConfidence: document.querySelector("#primaryConfidence"),
  secondaryConfidence: document.querySelector("#secondaryConfidence"),
  primaryMeter: document.querySelector("#primaryMeter"),
  secondaryMeter: document.querySelector("#secondaryMeter"),
  primaryUsed: document.querySelector("#primaryUsed"),
  secondaryUsed: document.querySelector("#secondaryUsed"),
  primaryReset: document.querySelector("#primaryReset"),
  secondaryReset: document.querySelector("#secondaryReset"),
  activeNow: document.querySelector("#activeNow"),
  fiveHourEvents: document.querySelector("#fiveHourEvents"),
  weeklyEvents: document.querySelector("#weeklyEvents"),
  scanCount: document.querySelector("#scanCount"),
  heatmap: document.querySelector("#heatmap"),
  windowList: document.querySelector("#windowList"),
  sessionsTable: document.querySelector("#sessionsTable"),
  lastUpdated: document.querySelector("#lastUpdated"),
};

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const compactFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : "tracked";
}

function formatReset(iso) {
  if (!iso) return "Reset unknown";
  const date = new Date(iso);
  const diffMs = date.getTime() - Date.now();
  const absMinutes = Math.max(0, Math.round(Math.abs(diffMs) / 60000));
  const hours = Math.floor(absMinutes / 60);
  const minutes = absMinutes % 60;
  const relative = diffMs >= 0 ? "resets in" : "reset";
  const duration = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  return `${relative} ${duration} (${timeFormatter.format(date)})`;
}

function projectName(cwd) {
  if (!cwd) return "Unknown workspace";
  return cwd.split("/").filter(Boolean).at(-1) || cwd;
}

function setMeter(el, value) {
  const width = Number.isFinite(value) ? clamp(value * 100, 0, 100) : 0;
  el.style.width = `${width}%`;
  el.style.background = width >= 90 ? "var(--red)" : width >= 70 ? "var(--amber)" : "";
}

function renderLimit(prefix, limit) {
  const used = limit.usedPercent;
  els[`${prefix}Used`].textContent = formatPercent(used);
  els[`${prefix}Reset`].textContent = formatReset(limit.resetsAt);
  els[`${prefix}Confidence`].textContent = limit.source === "codex token_count" ? "measured" : "inferred";
  setMeter(els[`${prefix}Meter`], used);
}

function renderHeatmap(buckets) {
  const max = Math.max(1, ...buckets.map((bucket) => bucket.weight));
  els.heatmap.replaceChildren(
    ...buckets.map((bucket) => {
      const cell = document.createElement("span");
      const intensity = bucket.weight / max;
      cell.className = "heat-cell";
      cell.title = `${compactFormatter.format(new Date(bucket.at))}: ${bucket.weight} activity weight`;
      cell.style.background = intensity === 0
        ? "#ebefec"
        : `color-mix(in srgb, var(--teal) ${Math.round(22 + intensity * 68)}%, white)`;
      return cell;
    }),
  );
}

function renderWindows(windows) {
  if (!windows.length) {
    els.windowList.innerHTML = '<div class="window-row"><b>No activity detected</b><span>Waiting for session data</span></div>';
    return;
  }

  els.windowList.replaceChildren(
    ...windows.map((window) => {
      const row = document.createElement("div");
      row.className = "window-row";
      const start = timeFormatter.format(new Date(window.start));
      const end = timeFormatter.format(new Date(window.end));
      row.innerHTML = `
        <div>
          <b>${start} - ${end}</b>
          <span>${window.eventCount} events, ${window.sessionCount} sessions, ${window.dominantKind}</span>
        </div>
        <span>${window.durationMinutes}m</span>
      `;
      return row;
    }),
  );
}

function renderSessions(sessions) {
  els.sessionsTable.replaceChildren(
    ...sessions.map((session) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${session.lastAt ? timeFormatter.format(new Date(session.lastAt)) : "--"}</td>
        <td><strong>${projectName(session.cwd)}</strong><code>${session.cwd || "No cwd recorded"}</code></td>
        <td>${session.eventCount}<code>${session.tokenEvents} token checkpoints</code></td>
        <td><span class="${session.hasRateLimit ? "rate-yes" : "rate-no"}">${session.hasRateLimit ? "present" : "not in file"}</span></td>
      `;
      return tr;
    }),
  );
}

async function loadUsage() {
  els.statusDot.className = "status-dot";
  const response = await fetch("/api/usage", { cache: "no-store" });
  if (!response.ok) throw new Error(`Usage API failed: ${response.status}`);
  const snapshot = await response.json();

  renderLimit("primary", snapshot.limits.primary);
  renderLimit("secondary", snapshot.limits.secondary);
  renderHeatmap(snapshot.hourlyBuckets);
  renderWindows(snapshot.recentWindows);
  renderSessions(snapshot.recentSessions);

  els.activeNow.textContent = snapshot.limits.inferred.activeNow ? "active" : "idle";
  els.fiveHourEvents.textContent = snapshot.limits.inferred.fiveHourActivityEvents;
  els.weeklyEvents.textContent = snapshot.limits.inferred.weeklyActivityEvents;
  els.scanCount.textContent = `${snapshot.filesScanned} files`;
  els.lastUpdated.textContent = timeFormatter.format(new Date(snapshot.generatedAt));
  els.subtitle.textContent = `${snapshot.sessionCount} sessions scanned from ${snapshot.codexHome}`;
  els.statusDot.className = "status-dot ok";
}

async function refresh() {
  try {
    await loadUsage();
  } catch (error) {
    els.statusDot.className = "status-dot error";
    els.subtitle.textContent = error instanceof Error ? error.message : "Unable to load usage data";
  }
}

els.refreshButton.addEventListener("click", refresh);
refresh();
setInterval(refresh, 60_000);
