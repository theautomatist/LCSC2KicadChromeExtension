"use strict";

const NOTIFICATION_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAGXRFWHRTb2Z0d2FyZQBwYWludC5uZXQgNC4wLjE0Qe6JAAABGklEQVR4Xu2WQQ6DMAxF//+n7XCSdCoLMeMmprQ44tgSyq1qV0lhd6WHe/mPHDx48ODBg1/TjAaA1kW5Hn2BEFgC51W1sDRtCEALMxYBN8gFMUpjYAGheR2vHZkTorhTF1Q8YlgHFAMWG4eXeXvQy64X+RFI48s9jlEpDgsvA0ApHHLHp7J8FwS+QJaAZVTdiJgQ0C1MUgZ2FneBOBCACiUh4Kwog16iqWAZsCJVx9Se/QEjMqYkhZYl0g9DBGHgp6MkdSEnFG4W82l9JO66DC9HqOBeYg7cFsyiHZVBL+QP281hoz3trp6wVXoW+Lc93mE5fEAqwfM434SGNNbFx+LgdrOrV8J9u7t+kJT4S1x+zAFmY3/5lD0s5iWWQbGWVS6nK/O0c9kwwYMGDx48ePAgP8HHlTC/gtzpL5AAAAAElFTkSuQmCC";

const HISTORY_LIMIT = 30;
const POLL_INTERVAL = 4000;
const HEALTH_INTERVAL = 15000;

const DEFAULT_STATE = {
  serverUrl: "http://localhost:8087",
  defaultLibraryPath: "",
  defaultLibraryName: "",
  notificationsEnabled: true,
  selectedLibraryPath: "",
  selectedLibraryName: "",
  jobHistory: [],
  jobMeta: {},
  overwriteFootprints: false,
  overwriteModels: false,
  debugLogs: false,
};

let state = {
  ...DEFAULT_STATE,
  connected: false,
  jobs: {},
};

const jobPollers = new Map();
let healthTimer = null;
let initialized = false;

function sanitizeLibraryName(name) {
  if (!name) {
    return "";
  }
  return name.trim().replace(/[\\/:*?"<>|]/g, "_");
}

function normalizePath(path) {
  if (!path) {
    return "";
  }
  return path.trim().replace(/[\\\/]+$/, "");
}

function hasModelOutput(result) {
  if (!result) {
    return false;
  }
  const modelPaths = result.model_paths;
  if (!modelPaths) {
    return false;
  }
  if (Array.isArray(modelPaths)) {
    return modelPaths.length > 0;
  }
  if (typeof modelPaths === "object") {
    return Object.values(modelPaths).some(Boolean);
  }
  return Boolean(modelPaths);
}

function analyzeJobOutputs(job = {}) {
  const requested = {
    symbol: Boolean(job.outputs && job.outputs.symbol),
    footprint: Boolean(job.outputs && job.outputs.footprint),
    model: Boolean(job.outputs && job.outputs.model),
  };

  const result = job.result || {};
  const actual = {
    symbol: Boolean(result.symbol_path),
    footprint: Boolean(result.footprint_path),
    model: hasModelOutput(result),
  };

  const requestedAny = Object.values(requested).some(Boolean);
  const missing = [];
  if (requested.symbol && !actual.symbol) {
    missing.push("symbol");
  }
  if (requested.footprint && !actual.footprint) {
    missing.push("footprint");
  }
  if (requested.model && !actual.model) {
    missing.push("model");
  }

  const partial = requestedAny && missing.length > 0;
  const complete = requestedAny ? missing.length === 0 : true;

  return {
    requested,
    actual,
    missing,
    partial,
    complete,
    requestedAny,
  };
}

function buildLibraryPrefix(basePath, libraryName) {
  const normalizedBase = normalizePath(basePath);
  let sanitizedName = sanitizeLibraryName(libraryName);
  if (!sanitizedName) {
    sanitizedName = "easyeda2kicad";
  }
  if (!normalizedBase) {
    return sanitizedName;
  }
  const separator = normalizedBase.includes("\\") && !normalizedBase.includes("/")
    ? "\\"
    : "/";
  const cleanedName = sanitizedName.replace(/^[\\\/]+/, "");
  return `${normalizedBase}${separator}${cleanedName}`;
}

function deriveLibraryNameFromPath(path) {
  if (!path) {
    return "";
  }
  const normalized = normalizePath(path);
  if (!normalized) {
    return "";
  }
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  if (!parts.length) {
    return sanitizeLibraryName(normalized);
  }
  const last = parts[parts.length - 1];
  return sanitizeLibraryName(last) || "";
}

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

async function init() {
  if (initialized) {
    return;
  }
  initialized = true;

  try {
    const stored = await storageGet(Object.keys(DEFAULT_STATE));
    state = {
      ...state,
      ...stored,
      jobHistory: stored.jobHistory || [],
      jobMeta: stored.jobMeta || {},
      selectedLibraryPath: stored.selectedLibraryPath || stored.defaultLibraryPath || "",
      selectedLibraryName: stored.selectedLibraryName || stored.defaultLibraryName || "",
      overwriteFootprints: Boolean(stored.overwriteFootprints),
      overwriteModels: Boolean(stored.overwriteModels),
      debugLogs: Boolean(stored.debugLogs),
    };
  } catch (error) {
    console.warn("Failed to load stored state", error);
  }

  await checkHealth();
  await syncExistingTasks();
  startHealthMonitor();
  broadcastState();
}

async function ensureInitialized() {
  if (!initialized) {
    await init();
  }
}

function buildUrl(path) {
  const base = state.serverUrl || DEFAULT_STATE.serverUrl;
  const normalized = base.endsWith("/") ? base : `${base}/`;
  const cleanedPath = path.startsWith("/") ? path.slice(1) : path;
  return new URL(cleanedPath, normalized).toString();
}

async function apiFetch(path, options = {}) {
  const url = buildUrl(path);
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API request failed (${response.status}): ${text || response.statusText}`);
  }
  return response;
}

async function checkHealth() {
  try {
    await apiFetch("health", { method: "GET" });
    state.connected = true;
  } catch (error) {
    state.connected = false;
  }
  updateBadge();
  broadcastState();
  return state.connected;
}

function updateBadge() {
  const text = state.connected ? "ON" : "OFF";
  const color = state.connected ? "#1b873f" : "#c0392b";
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
}

function startHealthMonitor() {
  if (healthTimer) {
    clearInterval(healthTimer);
  }
  healthTimer = setInterval(() => {
    checkHealth();
  }, HEALTH_INTERVAL);
}

async function syncExistingTasks() {
  try {
    const response = await apiFetch("tasks");
    const tasks = await response.json();
    const active = {};

    tasks.forEach((task) => {
      const meta = state.jobMeta[task.id] || {};
      const merged = { ...task, ...meta };
      if (task.status === "completed" || task.status === "failed") {
        addHistoryEntry(merged);
      } else {
        active[task.id] = merged;
        scheduleJobPoll(task.id, 500);
      }
    });

    state.jobs = active;
    broadcastState();
  } catch (error) {
    console.warn("syncExistingTasks failed", error);
  }
}

function scheduleJobPoll(id, delay = POLL_INTERVAL) {
  if (jobPollers.has(id)) {
    clearTimeout(jobPollers.get(id));
  }
  const timer = setTimeout(() => pollJob(id), delay);
  jobPollers.set(id, timer);
}

async function pollJob(id) {
  try {
    const response = await apiFetch(`tasks/${id}`);
    const detail = await response.json();
    const meta = state.jobMeta[id] || {};
    const merged = { ...detail, ...meta };

    if (detail.status === "completed" || detail.status === "failed") {
      if (jobPollers.has(id)) {
        clearTimeout(jobPollers.get(id));
        jobPollers.delete(id);
      }
      delete state.jobs[id];
      addHistoryEntry({ ...merged, log: detail.log || [] });
      if (state.jobMeta[id]) {
        delete state.jobMeta[id];
        await persistState(["jobMeta"]);
      }
      notifyJobResult(merged);
    } else {
      state.jobs[id] = merged;
      scheduleJobPoll(id);
    }

    broadcastState();
  } catch (error) {
    console.warn(`pollJob failed for ${id}`, error);
    scheduleJobPoll(id, POLL_INTERVAL * 2);
  }
}

function addHistoryEntry(entry) {
  const clone = JSON.parse(JSON.stringify(entry));
  const filtered = state.jobHistory.filter((item) => item.id !== clone.id);
  state.jobHistory = [clone, ...filtered].slice(0, HISTORY_LIMIT);
  persistState(["jobHistory"]);
}

function notifyJobResult(job) {
  if (!state.notificationsEnabled) {
    return;
  }
  const statusLabel = job.status === "completed" ? "Konvertierung abgeschlossen" : "Konvertierung fehlgeschlagen";
  const messageParts = [];
  if (job.libraryName) {
    messageParts.push(job.libraryName);
  }
  if (job.libraryPath) {
    messageParts.push(job.libraryPath);
  }
  if (job.lcscId) {
    messageParts.push(job.lcscId);
  }
  const message = messageParts.join(" – ") || job.id;

  chrome.notifications
    .create({
      type: "basic",
      iconUrl: NOTIFICATION_ICON,
      title: statusLabel,
      message,
    })
    .catch((error) => console.warn("Failed to create notification", error));
}

function snapshotState() {
  const jobsArray = Object.values(state.jobs || {}).map((job) => ({ ...job }));
  const historyArray = (state.jobHistory || []).map((item) => ({ ...item }));
  return {
    connected: state.connected,
    serverUrl: state.serverUrl,
    defaultLibraryPath: state.defaultLibraryPath,
    defaultLibraryName: state.defaultLibraryName,
    selectedLibraryPath: state.selectedLibraryPath,
    selectedLibraryName: state.selectedLibraryName,
    notificationsEnabled: state.notificationsEnabled,
    overwriteFootprints: state.overwriteFootprints,
    overwriteModels: state.overwriteModels,
    debugLogs: state.debugLogs,
    jobs: jobsArray,
    jobHistory: historyArray,
  };
}

function broadcastState() {
  const snapshot = snapshotState();
  chrome.runtime.sendMessage({ type: "stateUpdate", state: snapshot }).catch(() => {
    /* no listeners */
  });
}

async function persistState(keys) {
  const payload = {};
  keys.forEach((key) => {
    payload[key] = state[key];
  });
  await storageSet(payload);
}

async function submitJob(payload) {
  const basePath = normalizePath(
    payload.libraryPath || state.selectedLibraryPath || state.defaultLibraryPath || "",
  );
  if (!basePath) {
    throw new Error("Kein Bibliothekspfad ausgewählt.");
  }

  let libraryName = sanitizeLibraryName(
    payload.libraryName
      || state.selectedLibraryName
      || state.defaultLibraryName
      || deriveLibraryNameFromPath(basePath)
      || "easyeda2kicad",
  );
  if (!libraryName) {
    libraryName = "easyeda2kicad";
  }

  const libraryPrefix = buildLibraryPrefix(basePath, libraryName);

  const body = {
    lcsc_id: payload.lcscId,
    output_path: libraryPrefix,
    overwrite: Boolean(payload.overwrite),
    symbol: Boolean(payload.symbol),
    footprint: Boolean(payload.footprint),
    model: Boolean(payload.model),
    kicad_version: payload.kicadVersion || "v6",
    project_relative: Boolean(payload.projectRelative),
  };

  const response = await apiFetch("tasks", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const summary = await response.json();
  const meta = {
    lcscId: payload.lcscId,
    libraryName,
    libraryBasePath: basePath,
    libraryPath: libraryPrefix,
    outputs: {
      symbol: Boolean(payload.symbol),
      footprint: Boolean(payload.footprint),
      model: Boolean(payload.model),
    },
  };

  state.jobMeta[summary.id] = meta;
  state.jobs[summary.id] = { ...summary, ...meta };
  await persistState(["jobMeta"]);
  broadcastState();
  scheduleJobPoll(summary.id, 1000);
  return summary;
}

async function fetchRoots() {
  const response = await apiFetch("fs/roots");
  return response.json();
}

async function fetchDirectory(path) {
  const response = await apiFetch(`fs/list?${new URLSearchParams({ path })}`);
  return response.json();
}

async function checkPath(path) {
  const response = await apiFetch("fs/check", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
  return response.json();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    await ensureInitialized();
    switch (message.type) {
      case "getState":
        return snapshotState();
      case "setServerUrl":
        state.serverUrl = message.url || DEFAULT_STATE.serverUrl;
        await persistState(["serverUrl"]);
        await checkHealth();
        return snapshotState();
      case "toggleNotifications":
        state.notificationsEnabled = Boolean(message.enabled);
        await persistState(["notificationsEnabled"]);
        return snapshotState();
      case "updateSettings":
        if (typeof message.serverUrl === "string") {
          state.serverUrl = message.serverUrl.trim() || DEFAULT_STATE.serverUrl;
        }
        if (typeof message.defaultLibraryPath === "string") {
          state.defaultLibraryPath = normalizePath(message.defaultLibraryPath);
        }
        if (typeof message.defaultLibraryName === "string") {
          state.defaultLibraryName = sanitizeLibraryName(message.defaultLibraryName);
        }
        if (typeof message.overwriteFootprints === "boolean") {
          state.overwriteFootprints = message.overwriteFootprints;
        }
        if (typeof message.overwriteModels === "boolean") {
          state.overwriteModels = message.overwriteModels;
        }
        if (typeof message.debugLogs === "boolean") {
          state.debugLogs = message.debugLogs;
        }
        await persistState([
          "serverUrl",
          "defaultLibraryPath",
          "defaultLibraryName",
          "overwriteFootprints",
          "overwriteModels",
          "debugLogs",
        ]);
        await checkHealth();
        return snapshotState();
      case "setSelectedLibrary":
        state.selectedLibraryPath = normalizePath(message.path || "");
        let requestedName = "";
        if (typeof message.name === "string") {
          requestedName = message.name.trim();
        }
        let sanitizedName = sanitizeLibraryName(requestedName);
        if (!sanitizedName) {
          sanitizedName = sanitizeLibraryName(state.defaultLibraryName)
            || deriveLibraryNameFromPath(state.selectedLibraryPath)
            || "easyeda2kicad";
        }
        state.selectedLibraryName = sanitizedName;
        await persistState(["selectedLibraryPath", "selectedLibraryName"]);
        broadcastState();
        return {
          path: state.selectedLibraryPath,
          name: state.selectedLibraryName,
        };
      case "quickDownload": {
        const lcscId = (message.lcscId || "").trim().toUpperCase();
        if (!lcscId || !lcscId.startsWith("C")) {
          throw new Error("Ungültige LCSC ID.");
        }
        const basePath = normalizePath(state.selectedLibraryPath || state.defaultLibraryPath || "");
        if (!basePath) {
          throw new Error("Bitte zuerst einen Bibliothekspfad in der Extension auswählen.");
        }

        const libraryName = sanitizeLibraryName(
          state.selectedLibraryName
            || state.defaultLibraryName
            || lcscId,
        );

        const payload = {
          lcscId,
          libraryPath: basePath,
          libraryName: libraryName || lcscId,
          symbol: true,
          footprint: true,
          model: true,
          overwrite: Boolean(state.overwriteFootprints),
          overwrite_model: Boolean(state.overwriteModels),
          kicadVersion: "v6",
          projectRelative: false,
        };

        const summary = await submitJob(payload);
        return {
          jobId: summary?.id,
          status: summary?.status,
          libraryName: payload.libraryName,
          libraryPath: buildLibraryPrefix(basePath, payload.libraryName),
        };
      }
      case "getJobStatus": {
        const jobId = message.jobId;
        if (!jobId) {
          throw new Error("jobId fehlt");
        }
        const job = state.jobs[jobId];
        if (job) {
          return {
            ...job,
            outputAnalysis: analyzeJobOutputs(job),
            messages: job.result?.messages || job.messages || [],
          };
        }
        const history = state.jobHistory.find((entry) => entry.id === jobId);
        if (!history) {
          throw new Error("Job nicht gefunden");
        }
        return {
          ...history,
          outputAnalysis: analyzeJobOutputs(history),
          messages: history.result?.messages || history.messages || [],
        };
      }
      case "checkComponentExists": {
        const lcscId = (message.lcscId || "").trim().toUpperCase();
        if (!lcscId || !lcscId.startsWith("C")) {
          throw new Error("Ungültige LCSC ID.");
        }
        const historyMatch = state.jobHistory.find(
          (entry) => entry.lcscId === lcscId && entry.status === "completed",
        );
        if (!historyMatch) {
          return {
            inProgress: false,
            jobId: null,
            status: null,
            libraryName: null,
            libraryPath: null,
            completed: false,
            outputAnalysis: null,
            partial: false,
            missing: [],
            outputs: null,
            result: null,
            messages: [],
          };
        }
        const analysis = analyzeJobOutputs(historyMatch);
        return {
          inProgress: false,
          jobId: historyMatch.id,
          status: historyMatch.status,
          libraryName: historyMatch.libraryName,
          libraryPath: historyMatch.libraryPath,
          completed: true,
          outputAnalysis: analysis,
          partial: Boolean(analysis && analysis.partial),
          missing: analysis?.missing || [],
          outputs: historyMatch.outputs,
          result: historyMatch.result,
          messages: historyMatch.result?.messages || historyMatch.messages || [],
        };
      }
      case "submitJob":
        return submitJob(message.payload);
      case "fs:listRoots":
        return fetchRoots();
      case "fs:listDirectory":
        return fetchDirectory(message.path);
      case "fs:check":
        return checkPath(message.path);
      case "clearHistory":
        state.jobHistory = [];
        await persistState(["jobHistory"]);
        broadcastState();
        return { cleared: true };
      default:
        return null;
    }
  })()
    .then((result) => sendResponse({ ok: true, data: result }))
    .catch((error) => {
      console.error("Message handling failed", error);
      sendResponse({ ok: false, error: error.message || String(error) });
    });
  return true;
});

self.addEventListener("install", () => {
  if (self.skipWaiting) {
    self.skipWaiting();
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(init());
});

chrome.runtime.onStartup.addListener(() => {
  ensureInitialized();
});

ensureInitialized();
