"use strict";

const NOTIFICATION_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAGXRFWHRTb2Z0d2FyZQBwYWludC5uZXQgNC4wLjE0Qe6JAAABGklEQVR4Xu2WQQ6DMAxF//+n7XCSdCoLMeMmprQ44tgSyq1qV0lhd6WHe/mPHDx48ODBg1/TjAaA1kW5Hn2BEFgC51W1sDRtCEALMxYBN8gFMUpjYAGheR2vHZkTorhTF1Q8YlgHFAMWG4eXeXvQy64X+RFI48s9jlEpDgsvA0ApHHLHp7J8FwS+QJaAZVTdiJgQ0C1MUgZ2FneBOBCACiUh4Kwog16iqWAZsCJVx9Se/QEjMqYkhZYl0g9DBGHgp6MkdSEnFG4W82l9JO66DC9HqOBeYg7cFsyiHZVBL+QP281hoz3trp6wVXoW+Lc93mE5fEAqwfM434SGNNbFx+LgdrOrV8J9u7t+kJT4S1x+zAFmY3/5lD0s5iWWQbGWVS6nK/O0c9kwwYMGDx48ePAgP8HHlTC/gtzpL5AAAAAElFTkSuQmCC";

const HISTORY_LIMIT = 30;
const POLL_INTERVAL = 4000;
const HEALTH_INTERVAL = 3000;

const DEFAULT_STATE = {
  serverUrl: "http://localhost:8087",
  notificationsEnabled: true,
  libraries: [],
  jobHistory: [],
  jobMeta: {},
  overwriteFootprints: false,
  overwriteModels: false,
  debugLogs: false,
  projectRelative: false,
  projectRelativePath: "",
  libraryTotals: { symbols: 0, footprints: 0, models: 0 },
};

let state = {
  ...DEFAULT_STATE,
  connected: false,
  jobs: {},
  selectedLibraryPath: "",
  selectedLibraryName: "",
};

const jobPollers = new Map();
let healthTimer = null;
let initialized = false;

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off", ""].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function normalizeProjectRelativePath(value) {
  if (value == null) {
    return "";
  }
  let path = String(value).trim();
  if (!path) {
    return "";
  }
  if (path.startsWith("${KIPRJMOD}")) {
    path = path.slice("${KIPRJMOD}".length);
  }
  path = path.replace(/\\/g, "/");
  return path;
}

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

function isBackendOfflineError(error) {
  const message = (error && error.message) ? error.message : String(error || "");
  const normalized = message.toLowerCase();
  return normalized.includes("backend not reachable")
    || normalized.includes("failed to fetch")
    || normalized.includes("networkerror");
}

function stripLibrarySuffix(path) {
  if (!path) {
    return "";
  }
  return path.replace(/\.(kicad_sym|lib)$/i, "");
}

function deriveLibraryPrefix(library) {
  if (!library) {
    return "";
  }
  const candidate = library.path || library.resolvedPrefix || "";
  if (candidate) {
    return normalizePath(stripLibrarySuffix(candidate));
  }
  if (library.symbolPath) {
    return normalizePath(stripLibrarySuffix(library.symbolPath));
  }
  return "";
}

function getSelectedLibraryRecord() {
  const selected = normalizePath(state.selectedLibraryPath || "");
  if (selected) {
    const match = state.libraries.find((library) => {
      const prefix = normalizePath(library.path || library.resolvedPrefix || "");
      return prefix && prefix === selected;
    });
    if (match) {
      return match;
    }
  }
  return state.libraries.find((library) => library.active) || null;
}

async function ensureSelectedLibrary(force = false) {
  const previousPath = state.selectedLibraryPath || "";
  const previousName = state.selectedLibraryName || "";

  let nextPath = "";
  let nextName = "";

  if (Array.isArray(state.libraries) && state.libraries.length) {
    const active = state.libraries.find((library) => library.active && !library.missing)
      || state.libraries.find((library) => !library.missing)
      || state.libraries[0];
    if (active) {
      nextPath = deriveLibraryPrefix(active);
      nextName = sanitizeLibraryName(active.name) || deriveLibraryNameFromPath(nextPath) || "";
    }
  }

  if (!force && previousPath === nextPath && previousName === nextName) {
    return;
  }

  state.selectedLibraryPath = nextPath;
  state.selectedLibraryName = nextName;
  await persistState(["selectedLibraryPath", "selectedLibraryName"]);
}

function recalcLibraryTotals() {
  const totals = { symbols: 0, footprints: 0, models: 0 };
  (state.libraries || []).forEach((library) => {
    totals.symbols += Number(library?.counts?.symbol) || 0;
    totals.footprints += Number(library?.counts?.footprint) || 0;
    totals.models += Number(library?.counts?.model) || 0;
  });
  state.libraryTotals = totals;
  return totals;
}

function buildLibraryStatus(library, validation) {
  if (!validation) {
    return library;
  }

  const exists = Boolean(validation.exists);
  const modelPath = typeof validation.model_path === "string" && validation.model_path.trim()
    ? validation.model_path.trim()
    : (library.modelPath || "");
  const counts = exists
    ? {
        symbol: Number(validation.counts?.symbol) || (validation.assets?.symbol ? 1 : 0),
        footprint: Number(validation.counts?.footprint) || 0,
        model: Number(validation.counts?.model) || 0,
      }
    : { symbol: 0, footprint: 0, model: 0 };
  const assets = exists
    ? {
        symbol: Boolean(validation.assets?.symbol),
        footprint: Boolean(validation.assets?.footprint),
        model: Boolean(validation.assets?.model),
      }
    : { symbol: false, footprint: false, model: false };
  const warnings = Array.isArray(validation.warnings) ? validation.warnings.slice() : [];
  if (!exists) {
    warnings.push("Library path missing on disk.");
  }

  return {
    ...library,
    symbolPath: normalizePath(validation.resolved_path || library.symbolPath || ""),
    assets,
    counts,
    warnings,
    missing: !exists,
    modelPath,
    active: exists ? library.active : false,
    updatedAt: new Date().toISOString(),
    lastValidation: new Date().toISOString(),
  };
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

function buildComponentStatus({ lcscId, check, libraryPrefix, selectedLibrary }) {
  const normalized = check && typeof check === "object" ? check : {};
  const result = {
    symbol_path: normalized.symbol_path || null,
    footprint_path: normalized.footprint_path || null,
    model_paths: normalized.model_paths || {},
  };
  const outputs = { symbol: true, footprint: true, model: true };
  const analysis = analyzeJobOutputs({ outputs, result });
  const completed = Boolean(result.symbol_path);
  return {
    inProgress: false,
    jobId: null,
    status: completed ? "completed" : null,
    libraryName: selectedLibrary?.name || null,
    libraryPath: libraryPrefix,
    completed,
    outputAnalysis: analysis,
    partial: Boolean(analysis && analysis.partial),
    missing: analysis?.missing || [],
    outputs,
    result,
    messages: normalized.messages || [],
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
  const normalized = stripLibrarySuffix(normalizePath(path));
  if (!normalized) {
    return "";
  }
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  if (!parts.length) {
    return sanitizeLibraryName(normalized);
  }
  let last = parts[parts.length - 1];
  last = last.replace(/\.(kicad_sym|lib)$/i, "");
  return sanitizeLibraryName(last) || "";
}

function createLibraryId() {
  return `lib_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeLibraryRecord(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const now = new Date().toISOString();
  const existingPath = normalizePath(raw.path || raw.libraryPath || "");
  const prefixPath = stripLibrarySuffix(existingPath);
  const basePath = normalizePath(raw.basePath || raw.libraryBasePath || "");
  const name = sanitizeLibraryName(
    raw.name || raw.libraryName || deriveLibraryNameFromPath(existingPath)
  );
  const resolvedPrefix = normalizePath(stripLibrarySuffix(raw.resolvedPrefix || existingPath));
  const symbolPath = normalizePath(
    raw.symbolPath || raw.symbol_path || (prefixPath ? `${prefixPath}.kicad_sym` : existingPath)
  );
  const counts = {
    symbol: Number(raw?.counts?.symbol) || 0,
    footprint: Number(raw?.counts?.footprint) || 0,
    model: Number(raw?.counts?.model) || 0,
  };
  const projectRelative = normalizeBoolean(
    raw.projectRelative ?? raw.project_relative,
    false
  );
  const projectRelativePath = normalizeProjectRelativePath(
    raw.projectRelativePath ?? raw.project_relative_path ?? ""
  );
  const modelPath = typeof raw.modelPath === "string"
    ? raw.modelPath.trim()
    : (typeof raw.model_path === "string" ? raw.model_path.trim() : "");
  return {
    id: raw.id || createLibraryId(),
    name,
    path: prefixPath,
    basePath,
    resolvedPrefix,
    symbolPath,
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || raw.createdAt || now,
    active: raw.active !== false,
    assets: {
      symbol: Boolean(raw.assets && raw.assets.symbol),
      footprint: Boolean(raw.assets && raw.assets.footprint),
      model: Boolean(raw.assets && raw.assets.model),
    },
    counts,
    warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
    projectId: raw.projectId || "default",
    projectRelative,
    projectRelativePath,
    modelPath,
    missing: Boolean(raw.missing),
    lastValidation: raw.lastValidation || null,
  };
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
    const storedLibraries = Array.isArray(stored.libraries)
      ? stored.libraries
          .map(normalizeLibraryRecord)
          .filter((item) => item && item.name)
      : [];
    state = {
      ...state,
      ...stored,
      libraries: storedLibraries,
      jobHistory: stored.jobHistory || [],
      jobMeta: stored.jobMeta || {},
      selectedLibraryPath: stored.selectedLibraryPath || stored.defaultLibraryPath || "",
      selectedLibraryName: stored.selectedLibraryName || stored.defaultLibraryName || "",
      overwriteFootprints: normalizeBoolean(stored.overwriteFootprints),
      overwriteModels: normalizeBoolean(stored.overwriteModels),
      debugLogs: normalizeBoolean(stored.debugLogs),
      projectRelative: normalizeBoolean(stored.projectRelative),
      projectRelativePath: normalizeProjectRelativePath(stored.projectRelativePath),
      libraryTotals: stored.libraryTotals || { symbols: 0, footprints: 0, models: 0 },
    };
    recalcLibraryTotals();
    await ensureSelectedLibrary(true);
  } catch (error) {
    console.warn("Failed to load stored state", error);
  }

  await checkHealth();
  try {
    await inventoryLibraries();
  } catch (error) {
    console.warn("Failed to inventory libraries", error);
  }
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

async function scaffoldLibraryOnServer(payload) {
  const response = await apiFetch("libraries/scaffold", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function validateLibraryOnServer(path) {
  const response = await apiFetch("libraries/validate", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
  return response.json();
}

async function checkComponentOnServer(path, lcscId) {
  const response = await apiFetch("libraries/component", {
    method: "POST",
    body: JSON.stringify({ path, lcsc_id: lcscId }),
  });
  return response.json();
}

async function checkComponentsOnServer(path, lcscIds) {
  const response = await apiFetch("libraries/components", {
    method: "POST",
    body: JSON.stringify({ path, lcsc_ids: lcscIds }),
  });
  return response.json();
}

async function refreshLibraryCountsForPrefix(prefix) {
  const normalizedPrefix = stripLibrarySuffix(normalizePath(prefix || ""));
  if (!normalizedPrefix) {
    return;
  }

  const index = state.libraries.findIndex((library) => {
    const candidate = stripLibrarySuffix(
      normalizePath(library.path || library.resolvedPrefix || ""),
    );
    return candidate === normalizedPrefix;
  });

  if (index === -1) {
    return;
  }

  const library = state.libraries[index];
  const symbolPath = library.symbolPath || `${normalizedPrefix}.kicad_sym`;
  if (!symbolPath) {
    return;
  }

  try {
    const validation = await validateLibraryOnServer(symbolPath);
    if (!validation) {
      return;
    }

    state.libraries[index] = buildLibraryStatus(library, validation);

    recalcLibraryTotals();
    await ensureSelectedLibrary();
    await persistState(["libraries", "libraryTotals"]);
  } catch (error) {
    console.warn(`Failed to refresh inventory for ${prefix}`, error);
  }
}

async function inventoryLibraries() {
  if (!state.libraries.length) {
    recalcLibraryTotals();
    return;
  }

  const entries = await Promise.allSettled(
    state.libraries.map((library) => {
      const symbolPath = library.symbolPath || (library.path ? `${library.path}.kicad_sym` : "");
      if (!symbolPath) {
        return Promise.resolve({ library, validation: null });
      }
      return validateLibraryOnServer(symbolPath)
        .then((validation) => ({ library, validation }))
        .catch(() => ({ library, validation: null }));
    })
  );

  const results = new Map();
  entries.forEach((entry) => {
    if (entry.status === "fulfilled" && entry.value?.library) {
      results.set(entry.value.library.id, entry.value.validation);
    }
  });

  state.libraries = state.libraries.map((library) => {
    const validation = results.get(library.id);
    if (!validation) {
      return library;
    }
    return buildLibraryStatus(library, validation);
  });

  recalcLibraryTotals();
  await ensureSelectedLibrary();
  await persistState(["libraries", "libraryTotals"]);
}

function upsertLibraryRecord(record) {
  const normalized = normalizeLibraryRecord(record);
  if (!normalized) {
    throw new Error("Ungültiger Bibliothekseintrag");
  }
  const index = state.libraries.findIndex((item) => item.id === normalized.id || item.path === normalized.path);
  if (index >= 0) {
    state.libraries[index] = {
      ...state.libraries[index],
      ...normalized,
      symbolPath: normalized.symbolPath || state.libraries[index].symbolPath,
      assets: {
        ...state.libraries[index].assets,
        ...normalized.assets,
      },
      counts: {
        ...state.libraries[index].counts,
        ...normalized.counts,
      },
      warnings: normalized.warnings,
      updatedAt: normalized.updatedAt,
    };
  } else {
    state.libraries.push(normalized);
  }
  recalcLibraryTotals();
  return normalized;
}

async function checkHealth() {
  try {
    await apiFetch("health", { method: "GET" });
    state.connected = true;
    try {
      await inventoryLibraries();
    } catch (error) {
      console.warn("Library inventory failed during health check", error);
    }
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
  if (!state.connected) {
    return;
  }
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
      if (detail.status === "completed") {
        const targetPrefix = merged.libraryPath
          || merged.libraryPrefix
          || stripLibrarySuffix(normalizePath(merged.result?.symbol_path || ""));
        if (targetPrefix) {
          try {
            await refreshLibraryCountsForPrefix(targetPrefix);
          } catch (error) {
            console.warn("Failed to update library inventory", error);
          }
        }
      }
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
    libraries: state.libraries.map((library) => ({ ...library })),
    libraryTotals: { ...state.libraryTotals },
    defaultLibraryPath: state.defaultLibraryPath,
    defaultLibraryName: state.defaultLibraryName,
    selectedLibraryPath: state.selectedLibraryPath,
    selectedLibraryName: state.selectedLibraryName,
    notificationsEnabled: state.notificationsEnabled,
    overwriteFootprints: state.overwriteFootprints,
    overwriteModels: state.overwriteModels,
    debugLogs: state.debugLogs,
    projectRelative: state.projectRelative,
    projectRelativePath: state.projectRelativePath,
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
  const providedPrefix = normalizePath(payload.libraryPath || "");
  const fallbackBase = normalizePath(
    state.selectedLibraryPath || state.defaultLibraryPath || "",
  );
  let targetPath = providedPrefix || fallbackBase;
  if (!targetPath) {
    await ensureSelectedLibrary();
    const ensuredBase = normalizePath(state.selectedLibraryPath || state.defaultLibraryPath || "");
    targetPath = providedPrefix || ensuredBase;
    if (!targetPath) {
      throw new Error("Kein Bibliothekspfad ausgewählt.");
    }
  }

  let libraryName = sanitizeLibraryName(
    payload.libraryName
      || state.selectedLibraryName
      || state.defaultLibraryName
      || deriveLibraryNameFromPath(providedPrefix || fallbackBase)
      || "easyeda2kicad",
  );
  if (!libraryName) {
    libraryName = "easyeda2kicad";
  }

  const libraryPrefix = providedPrefix || buildLibraryPrefix(targetPath, libraryName);

  const body = {
    lcsc_id: payload.lcscId,
    output_path: libraryPrefix,
    overwrite: Boolean(payload.overwrite),
    symbol: Boolean(payload.symbol),
    footprint: Boolean(payload.footprint),
    model: Boolean(payload.model),
    overwrite_model: Boolean(payload.overwrite_model),
    project_relative: Boolean(payload.projectRelative),
    project_relative_path: normalizeProjectRelativePath(payload.projectRelativePath),
    model_path: typeof payload.modelPath === "string" ? payload.modelPath : "",
  };

  const response = await apiFetch("tasks", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const summary = await response.json();
  const meta = {
    lcscId: payload.lcscId,
    libraryName,
    libraryBasePath: targetPath,
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

async function handleCreateLibrary(payload = {}) {
  const basePath = normalizePath(payload.basePath || "");
  const rawName = typeof payload.name === "string" ? payload.name : "";
  const name = sanitizeLibraryName(rawName) || deriveLibraryNameFromPath(basePath);
  if (!basePath) {
    throw new Error("Bitte einen gültigen Basisordner wählen.");
  }
  if (!name) {
    throw new Error("Bitte einen Bibliotheksnamen festlegen.");
  }
  const scaffold = await scaffoldLibraryOnServer({
    base_path: basePath,
    library_name: name,
    symbol: payload.symbol !== false,
    footprint: payload.footprint !== false,
    model: Boolean(payload.model),
    project_relative: Boolean(payload.projectRelative),
  });
  const projectRelative = normalizeBoolean(payload.projectRelative);
  const projectRelativePath = normalizeProjectRelativePath(
    payload.projectRelativePath || (projectRelative ? state.projectRelativePath : "")
  );
  const now = new Date().toISOString();
  const existing = state.libraries.find(
    (library) => library.path === normalizePath(scaffold.resolved_library_prefix),
  );
  const record = {
    id: existing?.id || createLibraryId(),
    name,
    basePath,
    path: normalizePath(scaffold.resolved_library_prefix),
    resolvedPrefix: normalizePath(scaffold.resolved_library_prefix),
    symbolPath: normalizePath(scaffold.symbol_path || `${scaffold.resolved_library_prefix}.kicad_sym`),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    active: true,
    assets: {
      symbol: Boolean(scaffold.symbol_path),
      footprint: Boolean(scaffold.footprint_dir),
      model: Boolean(scaffold.model_dir),
    },
    counts: {
      symbol: scaffold.symbol_path ? 1 : 0,
      footprint: 0,
      model: 0,
    },
    warnings: [],
    projectId: payload.projectId || existing?.projectId || "default",
    projectRelative,
    projectRelativePath,
    modelPath: "",
    missing: false,
    lastValidation: now,
  };
  const stored = upsertLibraryRecord(record);
  await ensureSelectedLibrary();
  await persistState(["libraries", "libraryTotals"]);
  broadcastState();
  return stored;
}

async function handleImportLibrary(payload = {}) {
  const rawPath = typeof payload.path === "string" ? payload.path : "";
  const symbolPath = normalizePath(rawPath);
  if (!symbolPath) {
    throw new Error("Bitte eine Bibliotheksdatei wählen.");
  }
  if (!symbolPath.toLowerCase().endsWith(".kicad_sym")) {
    throw new Error("Es muss eine .kicad_sym Datei ausgewählt werden.");
  }

  const validation = await validateLibraryOnServer(symbolPath);
  if (!validation.exists || !validation.assets?.symbol) {
    throw new Error("Die ausgewählte Datei ist keine gültige Bibliothek.");
  }

  const resolvedSymbol = normalizePath(validation.resolved_path || symbolPath);
  const name = sanitizeLibraryName(deriveLibraryNameFromPath(resolvedSymbol));
  if (!name) {
    throw new Error("Bibliotheksname konnte nicht ermittelt werden.");
  }

  const now = new Date().toISOString();
  const existing = state.libraries.find((library) => {
    const existingPrefix = normalizePath(library.path || library.resolvedPrefix || "");
    const existingSymbol = normalizePath(library.symbolPath || `${existingPrefix}.kicad_sym`);
    return existingSymbol === resolvedSymbol || existingPrefix === stripLibrarySuffix(resolvedSymbol);
  });
  const projectRelative = normalizeBoolean(
    payload.projectRelative ?? existing?.projectRelative,
    false
  );
  const projectRelativePath = normalizeProjectRelativePath(
    payload.projectRelativePath ?? existing?.projectRelativePath ?? ""
  );
  const parentPath = normalizePath(resolvedSymbol.replace(/[\\/][^\\/]*$/, ""));
  const record = {
    id: existing?.id || createLibraryId(),
    name,
    basePath: normalizePath(payload.basePath || existing?.basePath || parentPath),
    path: stripLibrarySuffix(resolvedSymbol),
    resolvedPrefix: stripLibrarySuffix(resolvedSymbol),
    symbolPath: resolvedSymbol,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    active: true,
    assets: {
      symbol: Boolean(validation.assets?.symbol),
      footprint: Boolean(validation.assets?.footprint),
      model: Boolean(validation.assets?.model),
    },
    counts: {
      symbol: Number(validation.counts?.symbol) || (validation.assets?.symbol ? 1 : 0),
      footprint: Number(validation.counts?.footprint) || 0,
      model: Number(validation.counts?.model) || 0,
    },
    warnings: Array.isArray(validation.warnings) ? validation.warnings : [],
    projectId: payload.projectId || existing?.projectId || "default",
    projectRelative,
    projectRelativePath,
    modelPath: typeof validation.model_path === "string" ? validation.model_path.trim() : "",
    missing: !validation.exists,
    lastValidation: now,
  };
  const stored = upsertLibraryRecord(record);
  await ensureSelectedLibrary();
  await persistState(["libraries", "libraryTotals"]);
  broadcastState();
  return stored;
}

async function handleValidateLibrary(payload = {}) {
  const rawPath = typeof payload.path === "string" ? payload.path : "";
  const prefix = normalizePath(rawPath);
  if (!prefix) {
    throw new Error("Bitte einen Pfad angeben.");
  }
  return validateLibraryOnServer(prefix);
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
        try {
          await inventoryLibraries();
        } catch (error) {
          console.warn("Library inventory failed during getState", error);
        }
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
      case "createLibrary": {
        const { type, ...rest } = message;
        const record = await handleCreateLibrary(rest);
        return record;
      }
      case "importLibrary": {
        const { type, ...rest } = message;
        const record = await handleImportLibrary(rest);
        return record;
      }
      case "validateLibrary":
        return handleValidateLibrary(message);
      case "updateSettings":
        if (typeof message.serverUrl === "string") {
          state.serverUrl = message.serverUrl.trim() || DEFAULT_STATE.serverUrl;
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
        if (typeof message.projectRelative === "boolean") {
          state.projectRelative = message.projectRelative;
        }
        if (typeof message.projectRelativePath === "string") {
          state.projectRelativePath = normalizeProjectRelativePath(message.projectRelativePath);
        }
        await persistState([
          "serverUrl",
          "overwriteFootprints",
          "overwriteModels",
          "debugLogs",
          "projectRelative",
          "projectRelativePath",
        ]);
        checkHealth();
        return snapshotState();
      case "updateLibraries":
        if (Array.isArray(message.libraries)) {
          state.libraries = message.libraries
            .map(normalizeLibraryRecord)
            .filter((library) => library);
          recalcLibraryTotals();
          await ensureSelectedLibrary();
          await persistState(["libraries", "libraryTotals"]);
        }
        return snapshotState();
      case "checkLibraryMigration":
        return checkSingleLibraryMigrationNeeded();
      case "performLibraryMigration":
        return performSingleLibraryMigration();
      case "validateLibraryDirectory":
        return await validateLibraryDirectory(message.path);
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
        if (!state.connected) {
          const connected = await checkHealth();
          if (!connected) {
            throw new Error("Backend not reachable. Start the backend.");
          }
        }
        const lcscId = (message.lcscId || "").trim().toUpperCase();
        if (!lcscId || !lcscId.startsWith("C")) {
          throw new Error("Ungültige LCSC ID.");
        }
        let basePath = normalizePath(state.selectedLibraryPath || state.defaultLibraryPath || "");
        if (!basePath) {
          await ensureSelectedLibrary();
          basePath = normalizePath(state.selectedLibraryPath || state.defaultLibraryPath || "");
        }
        if (!basePath) {
          throw new Error("Bitte zuerst einen Bibliothekspfad in der Extension auswählen.");
        }

        const libraryName = sanitizeLibraryName(
          state.selectedLibraryName
            || state.defaultLibraryName
            || lcscId,
        );

        const selectedLibrary = getSelectedLibraryRecord();
        const projectRelative = selectedLibrary
          ? normalizeBoolean(selectedLibrary.projectRelative, false)
          : Boolean(state.projectRelative);
        const projectRelativePath = selectedLibrary
          ? normalizeProjectRelativePath(
              selectedLibrary.projectRelativePath || state.projectRelativePath
            )
          : normalizeProjectRelativePath(state.projectRelativePath);
        const modelPath = selectedLibrary?.modelPath || "";

        const payload = {
          lcscId,
          libraryPath: basePath,
          libraryName: libraryName || lcscId,
          symbol: true,
          footprint: true,
          model: true,
          overwrite: Boolean(state.overwriteFootprints),
          overwrite_model: Boolean(state.overwriteModels),
          projectRelative,
          projectRelativePath,
          modelPath,
        };

        const summary = await submitJob(payload);
        return {
          jobId: summary?.id,
          status: summary?.status,
          libraryName: payload.libraryName,
          libraryPath: basePath,
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
        if (!state.connected) {
          const connected = await checkHealth();
          if (!connected) {
            throw new Error("Backend not reachable. Start the backend.");
          }
        }
        const lcscId = (message.lcscId || "").trim().toUpperCase();
        if (!lcscId || !lcscId.startsWith("C")) {
          throw new Error("Ungültige LCSC ID.");
        }
        const activeJob = Object.values(state.jobs || {}).find((job) => job.lcscId === lcscId);
        if (activeJob) {
          return {
            inProgress: true,
            jobId: activeJob.id,
            status: activeJob.status,
            libraryName: activeJob.libraryName,
            libraryPath: activeJob.libraryPath,
            completed: false,
            outputAnalysis: analyzeJobOutputs(activeJob),
            partial: false,
            missing: [],
            outputs: activeJob.outputs,
            result: activeJob.result,
            messages: activeJob.result?.messages || activeJob.messages || [],
          };
        }

        const selectedLibrary = getSelectedLibraryRecord();
        const libraryPrefix = normalizePath(
          deriveLibraryPrefix(selectedLibrary) || state.selectedLibraryPath || state.defaultLibraryPath || ""
        );
        if (!libraryPrefix) {
          throw new Error("Please select a library in the extension.");
        }

        const validation = await validateLibraryOnServer(libraryPrefix);
        const index = state.libraries.findIndex(
          (library) => normalizePath(library.path || library.resolvedPrefix || "") === libraryPrefix
        );
        if (index >= 0) {
          state.libraries[index] = buildLibraryStatus(state.libraries[index], validation);
          recalcLibraryTotals();
          await persistState(["libraries", "libraryTotals"]);
          broadcastState();
        }
        if (!validation.exists) {
          return {
            inProgress: false,
            jobId: null,
            status: null,
            libraryName: selectedLibrary?.name || null,
            libraryPath: libraryPrefix,
            completed: false,
            outputAnalysis: null,
            partial: false,
            missing: ["library"],
            outputs: null,
            result: null,
            messages: ["Library path is missing on disk."],
          };
        }

        const check = await checkComponentOnServer(libraryPrefix, lcscId);
        return buildComponentStatus({
          lcscId,
          check,
          libraryPrefix,
          selectedLibrary,
        });
      }
      case "checkComponentsExists": {
        if (!state.connected) {
          const connected = await checkHealth();
          if (!connected) {
            throw new Error("Backend not reachable. Start the backend.");
          }
        }
        const ids = Array.isArray(message.lcscIds)
          ? Array.from(
              new Set(
                message.lcscIds
                  .map((id) => (id || "").trim().toUpperCase())
                  .filter((id) => id),
              ),
            )
          : [];
        if (!ids.length) {
          throw new Error("No component IDs supplied.");
        }

        const selectedLibrary = getSelectedLibraryRecord();
        const libraryPrefix = normalizePath(
          deriveLibraryPrefix(selectedLibrary) || state.selectedLibraryPath || state.defaultLibraryPath || ""
        );
        if (!libraryPrefix) {
          throw new Error("Please select a library in the extension.");
        }

        const validation = await validateLibraryOnServer(libraryPrefix);
        const index = state.libraries.findIndex(
          (library) => normalizePath(library.path || library.resolvedPrefix || "") === libraryPrefix
        );
        if (index >= 0) {
          state.libraries[index] = buildLibraryStatus(state.libraries[index], validation);
          recalcLibraryTotals();
          await persistState(["libraries", "libraryTotals"]);
          broadcastState();
        }
        if (!validation.exists) {
          const results = {};
          ids.forEach((lcscId) => {
            results[lcscId] = {
              inProgress: false,
              jobId: null,
              status: null,
              libraryName: selectedLibrary?.name || null,
              libraryPath: libraryPrefix,
              completed: false,
              outputAnalysis: null,
              partial: false,
              missing: ["library"],
              outputs: null,
              result: null,
              messages: ["Library path is missing on disk."],
            };
          });
          return { results };
        }

        const activeJobs = Object.values(state.jobs || {}).reduce((acc, job) => {
          if (job?.lcscId) {
            acc[job.lcscId] = job;
          }
          return acc;
        }, {});

        const backendResult = await checkComponentsOnServer(libraryPrefix, ids);
        const checks = backendResult?.results || {};
        const results = {};

        ids.forEach((lcscId) => {
          const activeJob = activeJobs[lcscId];
          if (activeJob) {
            results[lcscId] = {
              inProgress: true,
              jobId: activeJob.id,
              status: activeJob.status,
              libraryName: activeJob.libraryName,
              libraryPath: activeJob.libraryPath,
              completed: false,
              outputAnalysis: analyzeJobOutputs(activeJob),
              partial: false,
              missing: [],
              outputs: activeJob.outputs,
              result: activeJob.result,
              messages: activeJob.result?.messages || activeJob.messages || [],
            };
            return;
          }

          const check = checks[lcscId] || {};
          results[lcscId] = buildComponentStatus({
            lcscId,
            check,
            libraryPrefix,
            selectedLibrary,
          });
        });

        return { results };
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
      if (state.connected || !isBackendOfflineError(error)) {
        console.error("Message handling failed", error);
      } else if (state.debugLogs) {
        console.warn("Message handling failed (backend offline)", error);
      }
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

// Library Management Helper Functions
function checkSingleLibraryMigrationNeeded() {
  // Check if we have old single-library settings but no new library array
  const hasOldSettings = (state.selectedLibraryPath || state.defaultLibraryPath) && 
                         state.libraries.length === 0;
  return hasOldSettings && (state.selectedLibraryPath || state.defaultLibraryPath) !== "";
}

function performSingleLibraryMigration() {
  if (!checkSingleLibraryMigrationNeeded()) {
    return null;
  }
  
  const path = state.selectedLibraryPath || state.defaultLibraryPath || "";
  const name = state.selectedLibraryName || 
               state.defaultLibraryName || 
               deriveLibraryNameFromPath(path) || 
               "easyeda2kicad";
  
  const migratedLibrary = {
    id: createLibraryId(),
    name: sanitizeLibraryName(name),
    path: normalizePath(path),
    resolvedPrefix: normalizePath(path),
    basePath: "",
    active: true,
    assets: { symbol: false, footprint: false, model: false },
    warnings: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    projectId: "default",
  };

  // Clear old settings
  state.selectedLibraryPath = "";
  state.selectedLibraryName = "";
  state.defaultLibraryPath = "";
  state.defaultLibraryName = "";
  
  // Add to new libraries array
  state.libraries = [normalizeLibraryRecord(migratedLibrary)].filter(Boolean);
  
  // Persist the changes
  persistState([
    "libraries", 
    "selectedLibraryPath", 
    "selectedLibraryName", 
    "defaultLibraryPath", 
    "defaultLibraryName"
  ]);
  
  return migratedLibrary;
}

async function validateLibraryDirectory(path) {
  try {
    const validation = await handleValidateLibrary({ path });
    const name = sanitizeLibraryName(deriveLibraryNameFromPath(validation.resolved_path));
    return {
      valid: validation.exists && Boolean(validation.assets?.symbol),
      name: name || "Imported Library",
      path: validation.resolved_path,
      assets: validation.assets,
      counts: validation.counts || { symbol: 0, footprint: 0, model: 0 },
      warnings: validation.warnings,
    };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

// Initialize the service worker
ensureInitialized();
