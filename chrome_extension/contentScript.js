"use strict";

const BUTTON_ID = "easyeda2kicad-download-btn";
const LIST_BUTTON_CLASS = "easyeda2kicad-list-download-btn";
const LIST_CONTAINER_CLASS = "easyeda2kicad-list-container";
const INIT_ATTR = "easyeda2kicadInitialized";
const SVG_NS = "http://www.w3.org/2000/svg";
const PRODUCT_REGEX = /\/product-detail\/(C\d+)(?:\.html)?/i;
const LIST_REGEX = /\/list\/list\?.*/i;

const COLORS = {
  primary: "#1f6feb",
  success: "#15803d",
  error: "#b91c1c",
  warning: "#d97706",
  spinner: "#1f6feb",
};

const jobWatchers = new Map();
let spinnerStyleInjected = false;
let debugEnabled = false;

const ICONS = {
  download: "M5 20h14v-2H5v2zm7-18v12h4l-5 5-5-5h4V2h2z",
  check: "M9 16.17 5.53 12.7 4.47 13.76 9 18.29 20 7.29 18.93 6.23 9 16.17z",
  spinner: "M12 2a10 10 0 1 0 10 10h-2a8 8 0 1 1 -8 -8V2z",
};

function ensureSpinnerStyle() {
  if (spinnerStyleInjected) {
    return;
  }
  const style = document.createElement("style");
  style.textContent = `
    @keyframes easyeda2kicad-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .easyeda2kicad-spin-icon { animation: easyeda2kicad-spin 0.9s linear infinite; transform-origin: center; }
  `;
  document.head.appendChild(style);
  spinnerStyleInjected = true;
}

function dbg(...args) {
  if (debugEnabled) {
    console.log("[easyeda2kicad]", ...args);
  }
}

function initDebug() {
  try {
    chrome.runtime.sendMessage({ type: "getState" }, (response) => {
      if (chrome.runtime.lastError) {
        return;
      }
      if (response?.ok && response.data) {
        debugEnabled = Boolean(response.data.debugLogs);
        dbg("debug flag initial", debugEnabled);
      }
    });
  } catch (_error) {
    // ignore
  }
}

function clearJobWatcher(jobId) {
  const timer = jobWatchers.get(jobId);
  if (timer) {
    clearTimeout(timer);
    jobWatchers.delete(jobId);
  }
}

function extractLcscIdFromString(str = "") {
  const match = str.match(/C\d+/i);
  return match ? match[0].toUpperCase() : null;
}

function extractLcscIdFromElement(element) {
  if (!element) {
    return null;
  }
  if (element.dataset && element.dataset.lcscId) {
    return element.dataset.lcscId.toUpperCase();
  }
  if (element.getAttribute) {
    const fromTitle = extractLcscIdFromString(element.getAttribute("title") || "");
    if (fromTitle) {
      return fromTitle;
    }
  }
  if (element.href) {
    const fromHref = extractLcscIdFromString(element.href);
    if (fromHref) {
      return fromHref;
    }
  }
  return extractLcscIdFromString(element.textContent || "");
}

function hasModelPaths(result) {
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

function computeOutputAnalysis(job = {}) {
  const requested = {
    symbol: Boolean(job.outputs && job.outputs.symbol),
    footprint: Boolean(job.outputs && job.outputs.footprint),
    model: Boolean(job.outputs && job.outputs.model),
  };
  const result = job.result || {};
  const actual = {
    symbol: Boolean(result.symbol_path),
    footprint: Boolean(result.footprint_path),
    model: hasModelPaths(result),
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
  return {
    requested,
    actual,
    missing,
    partial: requestedAny && missing.length > 0,
    complete: requestedAny ? missing.length === 0 : true,
  };
}

function mapMissingLabel(key) {
  switch (key) {
    case "symbol":
      return "Symbol";
    case "footprint":
      return "Footprint";
    case "model":
      return "3D-Modell";
    default:
      return key;
  }
}

function formatMissingTooltip(missing = []) {
  if (!missing.length) {
    return "Teilweise importiert";
  }
  const labels = missing.map(mapMissingLabel);
  if (labels.length === 1) {
    return `Unvollständig: ${labels[0]} fehlt`;
  }
  const head = labels.slice(0, -1).join(", ");
  const tail = labels[labels.length - 1];
  return `Unvollständig: ${head} und ${tail} fehlen`;
}

function buildSuccessTooltip(analysis, messages) {
  const parts = [];
  if (Array.isArray(messages) && messages.length) {
    parts.push(messages.join(" • "));
  }
  if (analysis && analysis.missing && analysis.missing.length) {
    parts.push(formatMissingTooltip(analysis.missing));
  }
  return parts.length ? parts.join(" | ") : null;
}

function extractLcscId() {
  const match = window.location.pathname.match(PRODUCT_REGEX);
  if (!match) {
    return null;
  }
  return match[1].toUpperCase();
}

function findInsertionPoint() {
  try {
    return document
      .querySelector(".productImgSlide")
      ?.parentNode?.parentNode?.children?.[1]?.querySelector("tbody")
      || null;
  } catch (_error) {
    return null;
  }
}

function createButton(variant = "product") {
  ensureSpinnerStyle();
  const button = document.createElement("button");
  if (variant === "product") {
    button.id = BUTTON_ID;
  } else {
    button.classList.add(LIST_BUTTON_CLASS);
  }
  button.type = "button";
  button.setAttribute("title", "easyeda2kicad Download");
  button.style.marginLeft = variant === "list" ? "8px" : "12px";
  button.style.padding = variant === "list" ? "4px" : "6px";
  button.style.borderRadius = "999px";
  button.style.border = "1px solid transparent";
  button.style.background = "transparent";
  button.style.cursor = "pointer";
  button.style.display = "inline-flex";
  button.style.alignItems = "center";
  button.style.justifyContent = "center";
  button.style.width = variant === "list" ? "32px" : "36px";
  button.style.height = variant === "list" ? "32px" : "36px";
  button.style.transition = "transform 0.2s ease, opacity 0.2s ease";
  button.style.position = "relative";

  button.addEventListener("mouseenter", () => {
    if (!button.disabled) {
      button.style.transform = "scale(1.08)";
    }
  });
  button.addEventListener("mouseleave", () => {
    button.style.transform = "scale(1)";
  });

  const iconSvg = document.createElementNS(SVG_NS, "svg");
  iconSvg.setAttribute("width", variant === "list" ? "24" : "28");
  iconSvg.setAttribute("height", variant === "list" ? "24" : "28");
  iconSvg.setAttribute("viewBox", "0 0 24 24");
  iconSvg.style.position = "relative";
  iconSvg.style.zIndex = "2";
  iconSvg.id = "easyeda2kicad-icon";

  const iconPath = document.createElementNS(SVG_NS, "path");
  iconPath.setAttribute("d", ICONS.download);
  iconPath.setAttribute("fill", COLORS.primary);
  iconPath.setAttribute("id", "easyeda2kicad-icon-path");
  iconSvg.appendChild(iconPath);
  button.appendChild(iconSvg);

  return button;
}

function setIcon(button, color, type = "download") {
  const path = button.querySelector("#easyeda2kicad-icon-path");
  if (!path) {
    return;
  }
  const resolvedColor = typeof color === "string" && color ? color : COLORS.primary;
  const iconPath = ICONS[type] || ICONS.download;
  path.setAttribute("d", iconPath);
  path.setAttribute("fill", resolvedColor);
  path.setAttribute("opacity", resolvedColor === "transparent" ? "0" : "1");
  button.dataset.iconType = type;
}

function setSpin(button, enable) {
  const svg = button.querySelector("#easyeda2kicad-icon");
  if (!svg) {
    return;
  }
  if (enable) {
    ensureSpinnerStyle();
    svg.classList.add("easyeda2kicad-spin-icon");
  } else {
    svg.classList.remove("easyeda2kicad-spin-icon");
  }
}


function updateButtonState(button, state, options = {}) {
  switch (state) {
    case "idle":
      button.disabled = false;
      setSpin(button, false);
      setIcon(button, COLORS.primary, "download");
      button.setAttribute("title", options.message || "easyeda2kicad Download");
      break;
    case "pending":
      button.disabled = true;
      setSpin(button, true);
      setIcon(button, COLORS.spinner, "spinner");
      button.setAttribute("title", options.message || "Konvertierung wird gestartet…");
      break;
    case "progress":
      button.disabled = true;
      setSpin(button, true);
      setIcon(button, COLORS.spinner, "spinner");
      button.setAttribute(
        "title",
        options.message || `Konvertierung läuft… ${Math.round(options.progress ?? 0)}%`,
      );
      break;
    case "success":
      button.disabled = false;
      setSpin(button, false);
      setIcon(button, COLORS.success, "check");
      button.setAttribute("title", options.message || "In Bibliothek vorhanden");
      break;
    case "partial":
      button.disabled = false;
      setSpin(button, false);
      setIcon(button, COLORS.warning, options.iconType || "download");
      button.setAttribute("title", options.message || "Unvollständig – teilweise importiert");
      break;
    case "error":
      button.disabled = false;
      setSpin(button, false);
      setIcon(button, COLORS.error, options.iconType || "download");
      button.setAttribute("title", options.message || "Download fehlgeschlagen");
      break;
    default:
      break;
  }
}

function attachButton(lcscId) {
  const tbody = findInsertionPoint();
  if (!tbody) {
    dbg("attachButton: no tbody found");
    return false;
  }

  if (document.getElementById(BUTTON_ID)) {
    dbg("attachButton: product button already present");
    return true;
  }

  const button = createButton("product");
  button.dataset.lcscId = lcscId;
  updateButtonState(button, "idle");
  button.addEventListener("click", () => handleDownloadClick(button, lcscId));
  button.dataset[INIT_ATTR] = "false";

  const row = document.createElement("tr");
  row.id = `${BUTTON_ID}-row`;

  const labelCell = document.createElement("td");
  labelCell.textContent = "Download";
  labelCell.style.fontWeight = "600";
  labelCell.style.whiteSpace = "nowrap";

  const actionCell = document.createElement("td");
  actionCell.style.padding = "6px 0";
  actionCell.appendChild(button);

  row.appendChild(labelCell);
  row.appendChild(actionCell);
  tbody.appendChild(row);

  initialiseButtonState(button, lcscId);
  dbg("attachButton: inserted product button", lcscId);
  return true;
}

function insertListButton(container, lcscId) {
  if (!container) {
    dbg("insertListButton: missing container", lcscId);
    return;
  }

  const existingHolder = container.querySelector(`.${LIST_CONTAINER_CLASS}`);
  if (existingHolder) {
    const existingId = existingHolder.dataset.lcscId;
    const button = existingHolder.querySelector("button");
    if (existingId === lcscId) {
      dbg("insertListButton: holder already bound to", lcscId);
      if (button && button.dataset[INIT_ATTR] !== "true") {
        updateButtonState(button, "idle");
        button.dataset[INIT_ATTR] = "false";
        initialiseButtonState(button, lcscId);
      }
      return;
    }
    dbg("insertListButton: reusing holder, old id", existingId, "new id", lcscId);
    existingHolder.dataset.lcscId = lcscId;
    existingHolder.innerHTML = "";
    const newButton = createButton("list");
    newButton.dataset.lcscId = lcscId;
    updateButtonState(newButton, "idle");
    newButton.dataset[INIT_ATTR] = "false";
    newButton.addEventListener("click", () => handleDownloadClick(newButton, lcscId));
    existingHolder.appendChild(newButton);
    initialiseButtonState(newButton, lcscId);
    return;
  }

  const button = createButton("list");
  button.dataset.lcscId = lcscId;
  updateButtonState(button, "idle");
  button.dataset[INIT_ATTR] = "false";
  button.addEventListener("click", () => handleDownloadClick(button, lcscId));

  const holder = document.createElement("span");
  holder.className = LIST_CONTAINER_CLASS;
  holder.dataset.lcscId = lcscId;
  holder.style.display = "inline-flex";
  holder.style.alignItems = "center";
  holder.style.marginLeft = "6px";
  holder.appendChild(button);
  container.appendChild(holder);

  initialiseButtonState(button, lcscId);
  dbg("insertListButton: added", lcscId);
}

function attachListButtons() {
  const tableBody = document.querySelector(".tableContentTable > tbody");
  if (!tableBody) {
    dbg("attachListButtons: no table body");
    return false;
  }
  dbg("attachListButtons: row count", tableBody.children.length);
  let inserted = false;
  Array.from(tableBody.children).forEach((row, index) => {
    if (!row || !row.children || row.children.length < 2) {
      dbg("attachListButtons: skip row", index, "unexpected structure");
      return;
    }
    const cell = row.children[1];
    const wrapper = cell?.children?.[0];
    if (!wrapper) {
      dbg("attachListButtons: skip row", index, "missing wrapper");
      return;
    }
    const targetSlot = wrapper.children && wrapper.children[1] ? wrapper.children[1] : wrapper;
    const anchor = wrapper.querySelector("span > a") || wrapper.querySelector("a");
    const lcscId = extractLcscIdFromElement(anchor);
    if (!lcscId) {
      dbg("attachListButtons: skip row", index, "no LCSC id");
      return;
    }
    insertListButton(targetSlot, lcscId);
    inserted = true;
  });
  dbg("attachListButtons: inserted?", inserted);
  return inserted;
}

async function handleDownloadClick(button, lcscId) {
  dbg("handleDownloadClick", lcscId);
  updateButtonState(button, "pending", { progress: 0, message: "Konvertierung wird gestartet…" });
  try {
    const response = await chrome.runtime.sendMessage({
      type: "quickDownload",
      lcscId,
      source: "contentScript",
    });
    if (!response?.ok) {
      dbg("handleDownloadClick: backend returned error", response);
      throw new Error(response?.error || "Unbekannter Fehler");
    }
    const data = response.data || {};
    const jobId = data.jobId;
    if (jobId) {
      updateButtonState(button, "progress", { progress: 0, message: "Konvertierung läuft…" });
      startJobWatcher(button, jobId);
    } else {
      updateButtonState(button, "success", { message: "Job eingereiht" });
    }
  } catch (error) {
    console.error("easyeda2kicad quick download failed", error);
    updateButtonState(button, "error", { message: error.message || "Fehler beim Start" });
    dbg("handleDownloadClick: failed", lcscId, error);
  }
}

async function initialiseButtonState(button, lcscId) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "checkComponentExists",
      lcscId,
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Fehler beim Prüfen der Bibliothek");
    }
    const data = response.data || {};
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const analysis = data.outputAnalysis
      || computeOutputAnalysis({ outputs: data.outputs, result: data.result });
    dbg("initialiseButtonState", lcscId, data);
    if (data.completed) {
      if (analysis.partial) {
        updateButtonState(button, "partial", {
          message: messages.join(" • ") || formatMissingTooltip(analysis.missing),
          iconType: "download",
        });
        button.dataset[INIT_ATTR] = "true";
      } else {
        const tooltip = buildSuccessTooltip(analysis, messages);
        updateButtonState(button, "success", {
          message: tooltip || "Bereits in Bibliothek",
        });
        button.dataset[INIT_ATTR] = "true";
      }
    } else if (data.inProgress && data.jobId) {
      updateButtonState(button, "progress", {
        progress: 0,
        message: "Konvertierung läuft…",
      });
      startJobWatcher(button, data.jobId);
      button.dataset[INIT_ATTR] = "true";
    } else {
      updateButtonState(button, "idle");
      button.dataset[INIT_ATTR] = "true";
    }
  } catch (error) {
    console.warn("checkComponentExists failed", error);
    updateButtonState(button, "idle");
    button.dataset[INIT_ATTR] = "true";
  }
}

function startJobWatcher(button, jobId) {
  clearJobWatcher(jobId);
  dbg("startJobWatcher", jobId);

  const poll = async () => {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "getJobStatus",
        jobId,
      });
      if (!response?.ok) {
        throw new Error(response?.error || "Jobstatus nicht verfügbar");
      }
      const job = response.data || {};
      const messages = Array.isArray(job.messages) ? job.messages : [];
      const progress = Number.isFinite(job.progress) ? job.progress : job.status === "queued" ? 5 : 50;

      const analysis = job.outputAnalysis
        || computeOutputAnalysis({ outputs: job.outputs, result: job.result });
      dbg("job status", jobId, job.status, progress, analysis);
      if (job.status === "completed") {
        if (analysis.partial) {
          updateButtonState(button, "partial", {
            message: messages.join(" • ") || formatMissingTooltip(analysis.missing),
          });
        } else {
          const tooltip = buildSuccessTooltip(analysis, messages);
          updateButtonState(button, "success", {
            message: tooltip || "Konvertierung abgeschlossen",
          });
        }
        clearJobWatcher(jobId);
        return;
      }
      if (job.status === "failed") {
        updateButtonState(button, "error", { message: job.message || "Konvertierung fehlgeschlagen" });
        clearJobWatcher(jobId);
        return;
      }

      const message = job.status === "queued"
        ? "Wartet auf Verarbeitung"
        : `Konvertierung läuft – ${Math.round(progress)}%`;
      updateButtonState(button, "progress", { progress, message });
      const delay = job.status === "queued" ? 2000 : 1200;
      const timer = setTimeout(poll, delay);
      jobWatchers.set(jobId, timer);
    } catch (error) {
      console.warn("Polling job status failed", error);
      updateButtonState(button, "error", { message: error.message || "Statusabfrage fehlgeschlagen" });
      clearJobWatcher(jobId);
      dbg("job watcher error", jobId, error);
    }
  };

  poll();
}

function init() {
  initDebug();
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "stateUpdate" && message.state) {
      const previous = debugEnabled;
      debugEnabled = Boolean(message.state.debugLogs);
      if (!previous && debugEnabled) {
        console.log("[easyeda2kicad] debug logs enabled");
      } else if (previous && !debugEnabled) {
        console.log("[easyeda2kicad] debug logs disabled");
      }
    }
  });

  const path = window.location.pathname || "";
  dbg("init path", path);

  if (PRODUCT_REGEX.test(path)) {
    const lcscId = extractLcscId();
    if (!lcscId) {
      dbg("product page but no lcsc id in url");
      return;
    }

    if (attachButton(lcscId)) {
      dbg("product button inserted immediately");
      return;
    }

    const observer = new MutationObserver(() => {
      if (attachButton(lcscId)) {
        observer.disconnect();
        dbg("product MutationObserver inserted button");
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    setTimeout(() => observer.disconnect(), 10000);
    return;
  }

  if (LIST_REGEX.test(path) || document.querySelector(".tableContentTable")) {
    attachListButtons();
    const tableBody = document.querySelector(".tableContentTable > tbody");
    if (!tableBody) {
      return;
    }
    const observer = new MutationObserver(() => {
      attachListButtons();
    });
    observer.observe(tableBody, {
      childList: true,
      subtree: true,
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
    dbg("list table detected, setting up observer");
