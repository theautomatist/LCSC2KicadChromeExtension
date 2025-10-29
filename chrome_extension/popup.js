"use strict";

const state = {
  connected: false,
  serverUrl: "http://localhost:8087",
  defaultLibraryPath: "",
  defaultLibraryName: "",
  selectedLibraryPath: "",
  selectedLibraryName: "",
  notificationsEnabled: true,
  overwriteFootprints: false,
  overwriteModels: false,
  debugLogs: false,
  jobs: [],
  jobHistory: [],
};

const elements = {};

let pathRoots = [];
let currentDirectory = null;
let currentEntries = [];
let selectedEntryIndex = -1;

function $(selector) {
  return document.querySelector(selector);
}

async function sendMessage(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) {
    throw new Error(response?.error || "Unbekannter Fehler");
  }
  return response.data;
}

function initElements() {
  elements.status = $("#connection-status");
  elements.tabs = document.querySelectorAll(".tab-button");
  elements.tabContents = document.querySelectorAll(".tab-content");
  elements.lcscId = $("#lcsc-id");
  elements.libraryName = $("#library-name");
  elements.selectedPath = $("#selected-path");
  elements.openPathBrowser = $("#open-path-browser");
  elements.pathBrowser = $("#path-browser");
  elements.pathRoots = $("#path-roots");
  elements.pathEntries = $("#path-entries");
  elements.pathBreadcrumb = $("#path-breadcrumb");
  elements.pathQuick = $("#path-quick");
  elements.pathManual = $("#path-manual");
  elements.pathGo = $("#path-go");
  elements.pathApply = $("#path-apply");
  elements.pathUp = $("#path-up");
  elements.pathClose = $("#path-close");
  elements.pathInfo = $("#path-info");
  elements.pathError = $("#path-error");
  elements.generateSymbol = $("#generate-symbol");
  elements.generateFootprint = $("#generate-footprint");
  elements.generateModel = $("#generate-model");
  elements.overwriteExisting = $("#overwrite-existing");
  elements.jobError = $("#job-error");
  elements.jobForm = $("#job-form");
  elements.jobsList = $("#jobs-list");
  elements.historyList = $("#history-list");
  elements.clearHistory = $("#clear-history");
  elements.settingServerUrl = $("#setting-server-url");
  elements.settingDefaultPath = $("#setting-default-path");
  elements.settingDefaultName = $("#setting-default-name");
  elements.settingNotifications = $("#setting-notifications");
  elements.settingOverwriteFootprints = $("#setting-overwrite-footprints");
  elements.settingOverwriteModels = $("#setting-overwrite-models");
  elements.settingDebugLogs = $("#setting-debug-logs");
  elements.settingUseSelected = $("#setting-use-selected");
  elements.settingsSave = $("#settings-save");
  elements.settingsFeedback = $("#settings-feedback");
}

function bindEvents() {
  elements.tabs.forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  elements.openPathBrowser.addEventListener("click", () => togglePathBrowser(true));
  elements.pathClose.addEventListener("click", () => togglePathBrowser(false));
  elements.pathUp.addEventListener("click", () => {
    if (currentDirectory?.parent) {
      loadDirectory(currentDirectory.parent);
    }
  });
  elements.pathApply.addEventListener("click", applyCurrentPath);
  elements.pathGo.addEventListener("click", handleManualPath);
  elements.pathManual.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleManualPath();
    }
  });

  elements.pathRoots.addEventListener("change", (event) => {
    if (event.target.value) {
      loadDirectory(event.target.value);
    }
  });
  elements.pathEntries.addEventListener("keydown", handlePathListKeydown);
  elements.pathEntries.addEventListener(
    "focus",
    () => {
      if (!currentEntries.length) {
        return;
      }
      if (selectedEntryIndex < 0) {
        setSelectedEntry(0, true);
      } else {
        setSelectedEntry(selectedEntryIndex, true);
      }
    },
    true,
  );

  elements.jobForm.addEventListener("submit", handleJobSubmit);
  elements.clearHistory.addEventListener("click", handleClearHistory);
  elements.settingUseSelected.addEventListener("click", () => {
    if (state.selectedLibraryPath) {
      elements.settingDefaultPath.value = state.selectedLibraryPath;
    }
  });
  elements.settingsSave.addEventListener("click", handleSettingsSave);
  elements.settingNotifications.addEventListener("change", handleNotificationsToggle);
}

function switchTab(tabId) {
  elements.tabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabId);
  });
  elements.tabContents.forEach((content) => {
    content.classList.toggle("active", content.id === `tab-${tabId}`);
  });
}

function togglePathBrowser(show) {
  if (show) {
    elements.pathBrowser.classList.remove("hidden");
    elements.pathManual.value = state.selectedLibraryPath || state.defaultLibraryPath || "";
    loadRoots();
  } else {
    elements.pathBrowser.classList.add("hidden");
  }
}

async function loadRoots() {
  try {
    const data = await sendMessage("fs:listRoots");
    pathRoots = data || [];
    renderRootOptions();
    renderQuickLinks();

    const manualPath = elements.pathManual.value.trim();
    if (manualPath) {
      loadDirectory(manualPath);
    } else if (pathRoots.length > 0) {
      loadDirectory(pathRoots[0].path);
    }
  } catch (error) {
    elements.pathError.textContent = error.message;
  }
}

function renderRootOptions() {
  elements.pathRoots.innerHTML = "";
  const currentPath = elements.pathManual.value.trim() || state.selectedLibraryPath || state.defaultLibraryPath;
  let matchedValue = null;
  pathRoots.forEach((root) => {
    const option = document.createElement("option");
    option.value = root.path;
    option.textContent = root.label || root.path;
    elements.pathRoots.appendChild(option);
    if (currentPath && root.path && currentPath.startsWith(root.path)) {
      matchedValue = root.path;
    }
  });
  if (matchedValue) {
    elements.pathRoots.value = matchedValue;
  }
}

function formatPathLabel(path) {
  if (!path) {
    return "";
  }
  const normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
  if (normalized === "") {
    return path;
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) {
    return path;
  }
  return parts[parts.length - 1] || path;
}

function renderQuickLinks() {
  const container = elements.pathQuick;
  if (!container) {
    return;
  }
  container.innerHTML = "";
  const seen = new Set();

  const addLink = (path, label) => {
    if (!path || seen.has(path)) {
      return;
    }
    seen.add(path);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = label || formatPathLabel(path) || path;
    button.dataset.path = path;
    button.addEventListener("click", () => {
      elements.pathManual.value = path;
      loadDirectory(path);
    });
    container.appendChild(button);
  };

  pathRoots.forEach((root) => addLink(root.path, root.label || root.path));

  [state.selectedLibraryPath, state.defaultLibraryPath].forEach((extraPath) => {
    if (extraPath && !pathRoots.some((root) => root.path === extraPath)) {
      addLink(extraPath, formatPathLabel(extraPath));
    }
  });

  container.classList.toggle("hidden", seen.size === 0);
}

function highlightQuickLink(currentPath) {
  const buttons = elements.pathQuick?.querySelectorAll("button") || [];
  buttons.forEach((button) => {
    const btnPath = button.dataset.path;
    if (!btnPath) {
      button.classList.remove("active");
      return;
    }
    const isActive = currentPath && (currentPath === btnPath || currentPath.startsWith(btnPath));
    button.classList.toggle("active", isActive);
  });
}

async function handleManualPath() {
  const manualPath = elements.pathManual.value.trim();
  if (!manualPath) {
    elements.pathError.textContent = "Pfad eingeben.";
    return;
  }
  elements.pathError.textContent = "";
  await loadDirectory(manualPath);
}

function createBreadcrumbSegments(path) {
  if (!path) {
    return [];
  }

  const segments = [];
  const windowsDrive = path.match(/^[A-Za-z]:/);

  if (windowsDrive) {
    let current = `${windowsDrive[0]}\\`;
    segments.push({ label: `${windowsDrive[0]}\\`, path: current });
    const remainder = path.slice(current.length).replace(/^[\\/]+/, "");
    if (!remainder) {
      return segments;
    }
    remainder.split(/[\\/]+/).filter(Boolean).forEach((part) => {
      current = current.endsWith("\\") ? `${current}${part}` : `${current}\\${part}`;
      segments.push({ label: part, path: current });
    });
    return segments;
  }

  if (path.startsWith("/")) {
    let current = "/";
    segments.push({ label: " / ".trim(), path: current });
    const parts = path.split("/").filter(Boolean);
    parts.forEach((part) => {
      current = current === "/" ? `/${part}` : `${current}/${part}`;
      segments.push({ label: part, path: current });
    });
    return segments;
  }

  let current = "";
  path.split(/[\\/]+/)
    .filter(Boolean)
    .forEach((part, index) => {
      current = index === 0 ? part : `${current}/${part}`;
      segments.push({ label: part, path: current });
    });
  return segments;
}

function renderBreadcrumb(path) {
  if (!elements.pathBreadcrumb) {
    return;
  }
  const container = elements.pathBreadcrumb;
  container.innerHTML = "";
  const segments = createBreadcrumbSegments(path);
  if (!segments.length) {
    container.textContent = path || "";
    return;
  }
  segments.forEach((segment, index) => {
    const button = document.createElement("span");
    button.className = "breadcrumb-item";
    button.textContent = segment.label;
    button.tabIndex = 0;
    button.addEventListener("click", () => loadDirectory(segment.path));
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        loadDirectory(segment.path);
      }
    });
    container.appendChild(button);
    if (index < segments.length - 1) {
      const separator = document.createElement("span");
      separator.className = "breadcrumb-separator";
      separator.textContent = "›";
      container.appendChild(separator);
    }
  });
}

function setSelectedEntry(index, focus = false) {
  const items = elements.pathEntries.querySelectorAll("li");
  if (index < 0 || index >= items.length) {
    selectedEntryIndex = -1;
    items.forEach((item) => item.setAttribute("aria-selected", "false"));
    return;
  }
  selectedEntryIndex = index;
  items.forEach((item, itemIndex) => {
    const isSelected = itemIndex === index;
    item.setAttribute("aria-selected", isSelected ? "true" : "false");
    if (isSelected && focus) {
      item.focus();
    }
  });
}

function renderDirectoryEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  currentEntries = list.filter((entry) => entry.is_dir);
  elements.pathEntries.innerHTML = "";

  if (!currentEntries.length) {
    const empty = document.createElement("li");
    empty.textContent = "Keine Unterordner";
    empty.className = "path-empty";
    empty.setAttribute("aria-disabled", "true");
    empty.tabIndex = -1;
    elements.pathEntries.appendChild(empty);
    selectedEntryIndex = -1;
    return;
  }

  currentEntries.forEach((entry, index) => {
    const li = document.createElement("li");
    li.dataset.index = String(index);
    li.dataset.path = entry.path;
    li.tabIndex = 0;

    const icon = document.createElement("span");
    icon.className = "entry-icon";
    icon.textContent = "📁";

    const label = document.createElement("span");
    label.textContent = entry.name;

    li.appendChild(icon);
    li.appendChild(label);

    li.addEventListener("click", () => {
      setSelectedEntry(index, true);
    });

    li.addEventListener("dblclick", () => {
      loadDirectory(entry.path);
    });

    li.addEventListener("focus", () => {
      if (selectedEntryIndex !== index) {
        setSelectedEntry(index);
      }
    });

    elements.pathEntries.appendChild(li);
  });

  if (selectedEntryIndex < 0) {
    selectedEntryIndex = 0;
  }
  selectedEntryIndex = Math.min(selectedEntryIndex, currentEntries.length - 1);
  setSelectedEntry(selectedEntryIndex, true);
}

function openSelectedEntry() {
  if (selectedEntryIndex < 0 || !currentEntries[selectedEntryIndex]) {
    return;
  }
  loadDirectory(currentEntries[selectedEntryIndex].path);
}

function handlePathListKeydown(event) {
  if (!currentEntries.length) {
    if (event.key === "Backspace") {
      event.preventDefault();
      if (currentDirectory?.parent) {
        loadDirectory(currentDirectory.parent);
      }
    }
    return;
  }

  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      if (selectedEntryIndex < currentEntries.length - 1) {
        setSelectedEntry(selectedEntryIndex + 1, true);
      }
      break;
    case "ArrowUp":
      event.preventDefault();
      if (selectedEntryIndex > 0) {
        setSelectedEntry(selectedEntryIndex - 1, true);
      }
      break;
    case "Home":
      event.preventDefault();
      setSelectedEntry(0, true);
      break;
    case "End":
      event.preventDefault();
      setSelectedEntry(currentEntries.length - 1, true);
      break;
    case "Enter":
    case "ArrowRight":
      event.preventDefault();
      openSelectedEntry();
      break;
    case "Backspace":
    case "ArrowLeft":
      event.preventDefault();
      if (currentDirectory?.parent) {
        loadDirectory(currentDirectory.parent);
      }
      break;
    default:
      break;
  }
}

async function updatePathInfo(path) {
  if (!path) {
    elements.pathInfo.textContent = "";
    elements.pathInfo.classList.remove("invalid");
    return;
  }
  try {
    const info = await sendMessage("fs:check", { path });
    let message = "";
    if (info.exists) {
      message = info.is_dir ? "Ordner vorhanden" : "Pfad existiert";
    } else {
      message = "Ordner wird neu erstellt";
    }
    if (info.writable) {
      message += " – beschreibbar";
      elements.pathInfo.classList.remove("invalid");
    } else {
      message += " – keine Schreibrechte";
      elements.pathInfo.classList.add("invalid");
    }
    elements.pathInfo.textContent = message;
  } catch (error) {
    elements.pathInfo.textContent = error.message;
    elements.pathInfo.classList.add("invalid");
  }
}

async function loadDirectory(path) {
  try {
    const data = await sendMessage("fs:listDirectory", { path });
    currentDirectory = data;
    selectedEntryIndex = -1;
    updateDirectoryView();
    await updatePathInfo(currentDirectory.path);
    elements.pathError.textContent = "";
  } catch (error) {
    elements.pathError.textContent = error.message;
  }
}

function updateDirectoryView() {
  if (!currentDirectory) {
    return;
  }
  const matchingRoot = pathRoots.find((root) => currentDirectory.path.startsWith(root.path));
  if (matchingRoot) {
    elements.pathRoots.value = matchingRoot.path;
  }
  const currentPath = currentDirectory.path;
  elements.pathManual.value = currentPath;
  renderBreadcrumb(currentPath);
  renderDirectoryEntries(currentDirectory.entries);
  highlightQuickLink(currentPath);
}

async function applyCurrentPath() {
  if (!currentDirectory?.path) {
    elements.pathError.textContent = "Bitte Ordner auswählen.";
    return;
  }
  const userName = elements.libraryName.value.trim();
  const fallbackName =
    userName
    || state.selectedLibraryName
    || state.defaultLibraryName
    || formatPathLabel(currentDirectory.path)
    || "easyeda2kicad";
  try {
    const result = await sendMessage("setSelectedLibrary", {
      path: currentDirectory.path,
      name: fallbackName,
    });
    state.selectedLibraryPath = result?.path || currentDirectory.path;
    state.selectedLibraryName = result?.name || fallbackName;
    elements.libraryName.value = state.selectedLibraryName || "";
    elements.selectedPath.textContent = state.selectedLibraryPath;
    elements.pathManual.value = state.selectedLibraryPath;
    highlightQuickLink(state.selectedLibraryPath);
    updatePathInfo(state.selectedLibraryPath);
    elements.pathBrowser.classList.add("hidden");
    elements.pathError.textContent = "";
  } catch (error) {
    elements.pathError.textContent = error.message;
  }
}

async function handleJobSubmit(event) {
  event.preventDefault();
  elements.jobError.textContent = "";
  const lcscId = elements.lcscId.value.trim();
  const libraryName = elements.libraryName.value.trim() || state.selectedLibraryName || state.defaultLibraryName || "easyeda2kicad";
  const libraryPath = state.selectedLibraryPath || state.defaultLibraryPath;

  if (!lcscId || !lcscId.toUpperCase().startsWith("C")) {
    elements.jobError.textContent = "Bitte eine gültige LCSC ID (z. B. C1234) eingeben.";
    return;
  }
  if (!libraryPath) {
    elements.jobError.textContent = "Bibliothekspfad auswählen oder in den Einstellungen hinterlegen.";
    return;
  }

  const outputs = {
    symbol: elements.generateSymbol.checked,
    footprint: elements.generateFootprint.checked,
    model: elements.generateModel.checked,
  };

  if (!outputs.symbol && !outputs.footprint && !outputs.model) {
    elements.jobError.textContent = "Mindestens eine Ausgabeoption auswählen.";
    return;
  }

  const payload = {
    lcscId,
    libraryName,
    libraryPath,
    symbol: outputs.symbol,
    footprint: outputs.footprint,
    model: outputs.model,
    overwrite: elements.overwriteExisting.checked,
    overwrite_model: elements.overwriteExisting.checked,
    kicadVersion: "v6",
    projectRelative: false,
  };

  const submitButton = $("#submit-job");
  submitButton.disabled = true;
  try {
    await sendMessage("submitJob", { payload });
    elements.jobError.textContent = "";
    if (!state.selectedLibraryName) {
      state.selectedLibraryName = libraryName;
    }
  } catch (error) {
    elements.jobError.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
}

async function handleClearHistory() {
  try {
    await sendMessage("clearHistory");
    state.jobHistory = [];
    renderHistory();
  } catch (error) {
    console.error(error);
  }
}

async function handleSettingsSave() {
  elements.settingsFeedback.textContent = "";
  try {
    const snapshot = await sendMessage("updateSettings", {
      serverUrl: elements.settingServerUrl.value.trim() || state.serverUrl,
      defaultLibraryPath: elements.settingDefaultPath.value.trim(),
      defaultLibraryName: elements.settingDefaultName.value.trim(),
      overwriteFootprints: elements.settingOverwriteFootprints.checked,
      overwriteModels: elements.settingOverwriteModels.checked,
      debugLogs: elements.settingDebugLogs.checked,
    });
    applyState(snapshot);
    elements.settingsFeedback.textContent = "Gespeichert.";
    setTimeout(() => {
      elements.settingsFeedback.textContent = "";
    }, 2000);
  } catch (error) {
    elements.settingsFeedback.textContent = error.message;
  }
}

async function handleNotificationsToggle() {
  try {
    const snapshot = await sendMessage("toggleNotifications", {
      enabled: elements.settingNotifications.checked,
    });
    applyState(snapshot);
  } catch (error) {
    console.error(error);
  }
}

function applyState(newState) {
  if (!newState) {
    return;
  }
  state.connected = Boolean(newState.connected);
  state.serverUrl = newState.serverUrl || state.serverUrl;
  state.defaultLibraryPath = newState.defaultLibraryPath || "";
  state.defaultLibraryName = newState.defaultLibraryName || "";
  state.selectedLibraryPath = newState.selectedLibraryPath || state.selectedLibraryPath || "";
  state.selectedLibraryName = newState.selectedLibraryName || state.selectedLibraryName || "";
  state.notificationsEnabled = Boolean(newState.notificationsEnabled);
  state.overwriteFootprints = Boolean(newState.overwriteFootprints);
  state.overwriteModels = Boolean(newState.overwriteModels);
  state.debugLogs = Boolean(newState.debugLogs);
  state.jobs = Array.isArray(newState.jobs) ? newState.jobs : [];
  state.jobHistory = Array.isArray(newState.jobHistory) ? newState.jobHistory : [];
  render();
}

function render() {
  updateStatusIndicator();
  elements.settingServerUrl.value = state.serverUrl;
  elements.settingDefaultPath.value = state.defaultLibraryPath;
  elements.settingDefaultName.value = state.defaultLibraryName;
  elements.settingNotifications.checked = state.notificationsEnabled;
  elements.settingOverwriteFootprints.checked = state.overwriteFootprints;
  elements.settingOverwriteModels.checked = state.overwriteModels;
  elements.settingDebugLogs.checked = state.debugLogs;

  elements.selectedPath.textContent = state.selectedLibraryPath || "Kein Pfad gewählt";
  if (!elements.libraryName.value) {
    elements.libraryName.value = state.selectedLibraryName || state.defaultLibraryName || "";
  }

  renderJobs();
  renderHistory();
}

function updateStatusIndicator() {
  elements.status.textContent = state.connected ? "Verbunden" : "Offline";
  elements.status.classList.toggle("status-online", state.connected);
  elements.status.classList.toggle("status-offline", !state.connected);
}

function renderJobs() {
  const container = elements.jobsList;
  container.innerHTML = "";
  if (!state.jobs.length) {
    container.classList.add("empty");
    container.innerHTML = "<p>Keine aktiven Jobs.</p>";
    return;
  }
  container.classList.remove("empty");

  state.jobs
    .sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0))
    .forEach((job) => {
      const item = document.createElement("div");
      item.className = "job-item";

      const header = document.createElement("div");
      header.className = "job-header";
      const title = document.createElement("div");
      title.innerHTML = `<strong>${job.lcscId || job.id}</strong> – ${job.libraryName || "Bibliothek"}`;
      const status = document.createElement("span");
      status.className = `status-pill status-${job.status}`;
      status.textContent = job.status;
      header.appendChild(title);
      header.appendChild(status);

      const details = document.createElement("div");
      details.className = "job-details";
      details.innerHTML = `
        <div>Pfad: <code>${job.libraryPath || "–"}</code></div>
        <div>Warteschlange: ${job.queue_position || "-"} | Nachricht: ${job.message || "-"}</div>
      `;

      const progress = document.createElement("div");
      progress.className = "job-progress";
      const progressInner = document.createElement("span");
      const percent = Number.isFinite(job.progress) ? Math.max(0, Math.min(100, job.progress)) : 0;
      progressInner.style.width = `${percent}%`;
      progress.appendChild(progressInner);

      item.appendChild(header);
      item.appendChild(details);
      item.appendChild(progress);
      container.appendChild(item);
    });
}

function renderHistory() {
  const container = elements.historyList;
  container.innerHTML = "";
  if (!state.jobHistory.length) {
    container.classList.add("empty");
    container.innerHTML = "<p>Noch keine Einträge.</p>";
    return;
  }
  container.classList.remove("empty");

  state.jobHistory.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "history-item";

    const header = document.createElement("div");
    header.className = "history-header-row";
    const title = document.createElement("div");
    title.innerHTML = `<strong>${entry.lcscId || entry.id}</strong> – ${entry.libraryName || "Bibliothek"}`;
    const status = document.createElement("span");
    status.className = `status-pill status-${entry.status}`;
    status.textContent = entry.status;
    header.appendChild(title);
    header.appendChild(status);

    const details = document.createElement("div");
    const finishedAt = entry.finished_at ? new Date(entry.finished_at).toLocaleString() : "–";
    details.innerHTML = `
      <div>Pfad: <code>${entry.libraryPath || "–"}</code></div>
      <div>Abgeschlossen: ${finishedAt}</div>
      <div>Nachricht: ${entry.message || "-"}</div>
    `;

    item.appendChild(header);
    item.appendChild(details);
    container.appendChild(item);
  });
}

async function bootstrap() {
  initElements();
  bindEvents();
  try {
    const initialState = await sendMessage("getState");
    applyState(initialState);
  } catch (error) {
    console.error("Konnte Zustand nicht laden", error);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "stateUpdate") {
    applyState(message.state);
  }
});

document.addEventListener("DOMContentLoaded", bootstrap);
