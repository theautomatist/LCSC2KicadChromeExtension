"use strict";

function createSimpleBootstrap(scope) {
  const doc = scope.document;
  let activeModalCount = 0;

  class SimpleModal {
    constructor(element) {
      this.element = element;
      this.visible = false;
      this.backdrop = null;
      this._handleDismiss = (event) => {
        const trigger = event.target.closest('[data-bs-dismiss="modal"]');
        if (trigger) {
          event.preventDefault();
          this.hide();
        }
      };
      this._handleKeydown = (event) => {
        if (event.key === "Escape") {
          this.hide();
        }
      };
      this._maybeDismiss = false;
      this.element.addEventListener("click", this._handleDismiss);
      this.element.addEventListener("mousedown", (event) => {
        this._maybeDismiss = event.target === this.element;
      });
      this.element.addEventListener("mouseup", (event) => {
        if (this._maybeDismiss && event.target === this.element) {
          this.hide();
        }
        this._maybeDismiss = false;
      });
    }

    show() {
      if (this.visible) return;
      this.visible = true;
      activeModalCount += 1;
      doc.body.classList.add("modal-open");
	  doc.body.style.minHeight = "536px";
      this.element.style.display = "block";
      this.element.removeAttribute("aria-hidden");
      this.element.classList.add("show");
      doc.addEventListener("keydown", this._handleKeydown);
      this.element.dispatchEvent(new CustomEvent("shown.bs.modal", { bubbles: true }));
    }

    hide() {
      if (!this.visible) return;
      this.visible = false;
      activeModalCount = Math.max(0, activeModalCount - 1);
      if (activeModalCount === 0) {
        doc.body.classList.remove("modal-open");
	  	doc.body.style.minHeight = null;
      }
      this.element.classList.remove("show");
      this.element.setAttribute("aria-hidden", "true");
      this.element.style.display = "none";
      doc.removeEventListener("keydown", this._handleKeydown);
      this.element.dispatchEvent(new CustomEvent("hidden.bs.modal", { bubbles: true }));
    }

  }

  class SimpleToast {
    constructor(element, options = {}) {
      this.element = element;
      this.delay = typeof options.delay === "number" ? options.delay : 5000;
      this.timer = null;
      this._handleDismiss = (event) => {
        const trigger = event.target.closest('[data-bs-dismiss="toast"]');
        if (trigger) {
          event.preventDefault();
          this.hide();
        }
      };
      this.element.addEventListener("click", this._handleDismiss);
    }

    show() {
      clearTimeout(this.timer);
      this.element.classList.add("show");
      this.element.classList.remove("hide");
      this.element.style.display = "block";
      this.element.setAttribute("aria-hidden", "false");
      if (this.delay > 0) {
        this.timer = setTimeout(() => this.hide(), this.delay);
      }
    }

    hide() {
      clearTimeout(this.timer);
      this.element.classList.remove("show");
      this.element.style.display = "none";
      this.element.setAttribute("aria-hidden", "true");
      this.element.dispatchEvent(new CustomEvent("hidden.bs.toast", { bubbles: true }));
    }
  }

  class SimpleTab {
    constructor(element) {
      this.element = element;
    }

    show() {
      const selector = this.element.getAttribute("data-bs-target") || this.element.getAttribute("href");
      if (!selector) return;
      const target = doc.querySelector(selector);
      if (!target) return;

      const nav = this.element.closest("[role=\"tablist\"]");
      if (nav) {
        nav.querySelectorAll(".nav-link").forEach((btn) => {
          if (btn !== this.element) {
            btn.classList.remove("active");
            btn.setAttribute("aria-selected", "false");
          }
        });
      }

      this.element.classList.add("active");
      this.element.setAttribute("aria-selected", "true");

      const container = target.parentElement;
      if (container) {
        Array.from(container.children).forEach((pane) => {
          if (pane !== target) {
            pane.classList.remove("show", "active");
          }
        });
      }
      target.classList.add("show", "active");
      this.element.dispatchEvent(new CustomEvent("shown.bs.tab", { bubbles: true }));
    }
  }

  return { Modal: SimpleModal, Toast: SimpleToast, Tab: SimpleTab };
}

const globalScope = typeof window !== "undefined" ? window : globalThis;
const bootstrap = globalScope.bootstrap || (globalScope.bootstrap = createSimpleBootstrap(globalScope));

const UI_STORAGE_KEY = "popupUiState";
const TAB_IDS = ["parts", "libraries", "settings"];

const state = {
  activeTab: "parts",
  connected: false,
  libraries: [],
  libraryTotals: { symbols: 0, footprints: 0, models: 0 },
  libraryFilter: "",
  selectedLibraryPath: "",
  selectedLibraryName: "",
  jobs: {},
  history: [],
  settings: {
    serverUrl: "http://localhost:8087",
    overwrite: false,
    overwriteModel: false,
    debug: false,
    projectRelative: false,
    projectRelativePath: "",
  },
  lastJob: null,
  ready: false,
  picker: {
    mode: null,
    callback: null,
    roots: [],
    currentPath: "",
    selectedPath: "",
    parentPath: "",
    selectedType: "",
    filterExtension: null,
    requireFile: false,
    breadcrumbs: [],
  },
};

const elements = {};
const modals = {};
let pickerManualTimer = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  cacheElements();
  initModals();
  bindEvents();
  toggleLibraryProjectPath();
  toggleSettingsProjectPath();
  await loadUiPreferences();
  await hydrate();
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
}

function cacheElements() {
  elements.tabButtons = Array.from(document.querySelectorAll(".tab-button"));
  elements.panels = TAB_IDS.reduce((acc, id) => {
    acc[id] = document.getElementById(`tab-panel-${id}`);
    return acc;
  }, {});
  elements.connectionStatus = document.getElementById("connection-status");
  elements.connectionStatusDot = document.getElementById("connection-status-dot");
  elements.headerActive = document.getElementById("header-active");
  elements.toastContainer = document.getElementById("toast-container");

  // Parts tab
  elements.partsForm = document.getElementById("parts-form");
  elements.partsLcsc = document.getElementById("parts-lcsc");
  elements.partsSubmit = document.getElementById("parts-submit");
  elements.partsSymbol = document.getElementById("parts-symbol");
  elements.partsFootprint = document.getElementById("parts-footprint");
  elements.partsModel = document.getElementById("parts-model");
  elements.partsFeedback = document.getElementById("parts-feedback");
  elements.partsResult = document.getElementById("parts-result");
  elements.partsResultDetails = document.getElementById("parts-result-details");
  elements.partsOpenLibrary = document.getElementById("parts-open-library");

  // Libraries tab
  elements.libraryList = document.getElementById("library-list");
  elements.libraryEmpty = document.getElementById("library-empty");
  elements.libraryAdd = document.getElementById("library-add");
  elements.libraryModal = document.getElementById("library-modal");
  elements.libraryModalTabs = document.getElementById("library-modal-tabs");
  elements.libraryModalSubmit = document.getElementById("library-modal-submit");
  elements.libraryModalError = document.getElementById("library-modal-error");
  elements.libraryImportForm = document.getElementById("library-import-form");
  elements.libraryImportPath;
  elements.libraryImportInfo = document.getElementById("library-import-info");
  elements.librarySummary = document.getElementById("library-summary");
  elements.librarySearch = document.getElementById("library-search");
  elements.libraryCreateForm = document.getElementById("library-create-form");
  elements.libraryCreateName = document.getElementById("library-create-name");
  elements.libraryCreatePath = document.getElementById("library-create-path");
  elements.libraryCreateSymbol = document.getElementById("library-create-symbol");
  elements.libraryCreateFootprint = document.getElementById("library-create-footprint");
  elements.libraryCreateModel = document.getElementById("library-create-model");
  elements.libraryCreateProject = document.getElementById("library-create-project");
  elements.libraryCreateProjectPathGroup = document.getElementById("library-create-project-path-group");
  elements.libraryCreateProjectPath = document.getElementById("library-create-project-path");

  // Settings
  elements.settingsForm = document.getElementById("settings-form");
  elements.settingsServer = document.getElementById("settings-server");
  elements.settingsTest = document.getElementById("settings-test");
  elements.settingsOverwrite = document.getElementById("settings-overwrite");
  elements.settingsOverwriteModel = document.getElementById("settings-overwrite-model");
  elements.settingsDebug = document.getElementById("settings-debug");
  elements.settingsProjectRelative = document.getElementById("settings-project-relative");
  elements.settingsProjectRelativePathGroup = document.getElementById("settings-project-relative-path-group");
  elements.settingsProjectRelativePath = document.getElementById("settings-project-relative-path");
  elements.settingsFeedback = document.getElementById("settings-feedback");

  // Modals shared
  elements.libraryRequiredModal = document.getElementById("library-required-modal");
  elements.pickerModal = document.getElementById("picker-modal");
  elements.pickerModalTitle = document.getElementById("picker-modal-title");
  elements.pickerManual = document.getElementById("picker-manual");
  elements.pickerPathBreadcrumb = document.getElementById("picker-path-breadcrumb");
  elements.pickerList = document.getElementById("picker-list");
  elements.pickerError = document.getElementById("picker-error");
  elements.pickerApply = document.getElementById("picker-apply");
}

function initModals() {
  modals.libraryRequired = elements.libraryRequiredModal ? new bootstrap.Modal(elements.libraryRequiredModal) : null;
  modals.library = elements.libraryModal ? new bootstrap.Modal(elements.libraryModal) : null;
  modals.picker = elements.pickerModal ? new bootstrap.Modal(elements.pickerModal) : null;

  if (elements.libraryModal) {
    elements.libraryModal.addEventListener("hidden.bs.modal", () => {
      clearLibraryModalError();
      elements.libraryImportForm?.reset();
      elements.libraryCreateForm?.reset();
      if (elements.libraryCreateProjectPath) {
        elements.libraryCreateProjectPath.value = "";
      }
      elements.libraryImportInfo.textContent = "";
      elements.libraryImportInfo.className = "form-text";
      toggleLibraryProjectPath();
    });
  }
}

function bindEvents() {
  elements.tabButtons.forEach((button) => {
    button.addEventListener("click", () => setActiveTab(button.dataset.tab));
  });

  elements.partsOpenLibrary?.addEventListener("click", () => {
    if (modals.library) {
      modals.library.show();
      setLibraryModalTab("import");
    } else {
      setActiveTab("libraries");
    }
  });

  elements.partsForm?.addEventListener("submit", handlePartsSubmit);
  elements.partsLcsc?.addEventListener("blur", () => {
    elements.partsLcsc.value = elements.partsLcsc.value.trim().toUpperCase();
  });

  const pickerButtons = document.querySelectorAll("[data-picker]");
  pickerButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const mode = button.dataset.picker;
      openDirectoryPicker({
        mode,
        applyLabel: mode === "import" ? "Import library" : "Use this folder",
        initialPath: mode === "import" ? elements.libraryImportPath : elements.libraryCreatePath.value,
        onSelect: (selectedPath) => {
          if (mode === "import") {
            elements.libraryImportPath = selectedPath;
			submitImportLibrary();
          } else {
            elements.libraryCreatePath.value = selectedPath;
          }
        },
      });
    });
  });

  elements.libraryAdd?.addEventListener("click", () => {
    setLibraryModalTab("import");
    modals.library?.show();
  });
  elements.librarySearch?.addEventListener("input", handleLibrarySearch);

  elements.libraryModalTabs?.addEventListener("shown.bs.tab", clearLibraryModalError);
  elements.libraryModalTabs?.addEventListener("click", (event) => {
    const trigger = event.target.closest('[data-bs-toggle="pill"]');
    if (!trigger) return;
    event.preventDefault();
    const tab = new bootstrap.Tab(trigger);
    tab.show();
  });
  elements.libraryModalSubmit?.addEventListener("click", submitCreateLibrary);
  elements.libraryCreateProject?.addEventListener("change", toggleLibraryProjectPath);

  elements.libraryList?.addEventListener("change", handleLibraryListChange);
  elements.libraryList?.addEventListener("click", handleLibraryListClick);

  elements.settingsForm?.addEventListener("change", debounce(handleSettingsChange, 250));
  elements.settingsTest?.addEventListener("click", testServerConnection);
  elements.settingsProjectRelative?.addEventListener("change", toggleSettingsProjectPath);

  elements.pickerManual?.addEventListener("input", handlePickerManualInput);
  elements.pickerManual?.addEventListener("change", handlePickerManualChange);
  elements.pickerManual?.addEventListener("keydown", handlePickerManualKeydown);

  elements.pickerApply?.addEventListener("click", applyPickerSelection);

  elements.pickerList?.addEventListener("click", handlePickerListClick);
  elements.pickerList?.addEventListener("dblclick", handlePickerListDoubleClick);
  elements.pickerList?.addEventListener("keydown", handlePickerListKeydown);

  elements.libraryRequiredModal?.addEventListener("click", (event) => {
    const target = event.target.closest("[data-focus-tab]");
    if (target) {
      const tab = target.dataset.focusTab;
      if (tab) {
        requestAnimationFrame(() => setActiveTab(tab));
      }
    }
  });
}

function toggleLibraryProjectPath() {
  if (!elements.libraryCreateProjectPathGroup || !elements.libraryCreateProject) {
    return;
  }
  const show = elements.libraryCreateProject.checked;
  elements.libraryCreateProjectPathGroup.hidden = !show;
  if (show && elements.libraryCreateProjectPath) {
    if (!elements.libraryCreateProjectPath.value) {
      elements.libraryCreateProjectPath.value = state.settings.projectRelativePath || "";
    }
  } else if (elements.libraryCreateProjectPath) {
    elements.libraryCreateProjectPath.value = "";
  }
}

async function loadUiPreferences() {
  try {
    const stored = await chrome.storage.local.get(UI_STORAGE_KEY);
    const data = stored?.[UI_STORAGE_KEY];
    if (data && typeof data === "object" && TAB_IDS.includes(data.activeTab)) {
      state.activeTab = data.activeTab;
    }
    if (data && typeof data.projectRelative === "boolean") {
      state.settings.projectRelative = data.projectRelative;
    }
  } catch (error) {
    console.warn("Failed to read UI preferences", error);
  }
  setActiveTab(state.activeTab, { silent: true });
}

async function saveUiPreferences() {
  try {
    await chrome.storage.local.set({
      [UI_STORAGE_KEY]: {
        activeTab: state.activeTab,
        projectRelative: state.settings.projectRelative,
      },
    });
  } catch (error) {
    console.warn("Failed to persist UI preferences", error);
  }
}

async function hydrate() {
  try {
    const snapshot = await sendMessage("getState");
    applyState(snapshot);
  } catch (error) {
    console.error("Failed to load state", error);
    showToast(error.message || "Failed to load state", "danger");
  }
}

function handleRuntimeMessage(message) {
  if (message?.type === "stateUpdate") {
    applyState(message.state);
  }
}

function applyState(snapshot = {}) {
  state.connected = Boolean(snapshot.connected);
  state.libraries = Array.isArray(snapshot.libraries)
    ? snapshot.libraries.map((item) => ({
        ...item,
        counts: {
          symbol: Number(item?.counts?.symbol) || 0,
          footprint: Number(item?.counts?.footprint) || 0,
          model: Number(item?.counts?.model) || 0,
        },
      }))
    : [];
  state.libraryTotals = {
    symbols: Number(snapshot.libraryTotals?.symbols) || 0,
    footprints: Number(snapshot.libraryTotals?.footprints) || 0,
    models: Number(snapshot.libraryTotals?.models) || 0,
  };
  state.selectedLibraryPath = typeof snapshot.selectedLibraryPath === "string" ? snapshot.selectedLibraryPath : "";
  state.selectedLibraryName = typeof snapshot.selectedLibraryName === "string" ? snapshot.selectedLibraryName : "";
  state.jobs = snapshot.jobs && typeof snapshot.jobs === "object" ? { ...snapshot.jobs } : {};
  state.history = Array.isArray(snapshot.jobHistory) ? snapshot.jobHistory.slice() : [];
  state.lastJob = state.history[0] || null;

  const serverUrl = typeof snapshot.serverUrl === "string" && snapshot.serverUrl.trim().length
    ? snapshot.serverUrl.trim()
    : state.settings.serverUrl;

  state.settings.serverUrl = serverUrl;
  state.settings.overwrite = Boolean(snapshot.overwriteFootprints);
  state.settings.overwriteModel = Boolean(snapshot.overwriteModels);
  state.settings.debug = Boolean(snapshot.debugLogs);

  if (typeof snapshot.projectRelative === "boolean") {
    state.settings.projectRelative = snapshot.projectRelative;
  }
  if (typeof snapshot.projectRelativePath === "string") {
    state.settings.projectRelativePath = snapshot.projectRelativePath;
  }

  renderConnectionStatus();
  renderPartsDefaults();
  renderLibraries();
  renderPartsResult();
  renderSettings();

  state.ready = true;
}

function renderConnectionStatus() {
  if (!elements.connectionStatus) return;
  elements.connectionStatusDot.classList.toggle("badge-online", state.connected);
  elements.connectionStatusDot.classList.toggle("badge-offline", !state.connected);
}

function renderPartsDefaults() {
  if (!state.ready) {
    return;
  }

}

function renderLibraries() {
  if (!elements.libraryList) return;

  elements.libraryList.innerHTML = "";
  const sortedLibraries = state.libraries
    .slice()
    .sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }));
  const totalLibraries = sortedLibraries.length;

  if (elements.librarySearch && elements.librarySearch.value !== state.libraryFilter) {
    elements.librarySearch.value = state.libraryFilter;
  }

  const query = state.libraryFilter.trim().toLowerCase();
  let libraries = sortedLibraries;
  if (query) {
    libraries = sortedLibraries.filter((library) => {
      const name = (library.name || "").toLowerCase();
      const symbolPath = (library.symbolPath || "").toLowerCase();
      const basePath = (library.path || library.resolvedPrefix || "").toLowerCase();
      return name.includes(query) || symbolPath.includes(query) || basePath.includes(query);
    });
  }

  const visibleCount = libraries.length;

  const totals = state.libraryTotals || { symbols: 0, footprints: 0, models: 0 };
  if (elements.librarySummary) {
    if (!totalLibraries) {
      elements.librarySummary.textContent = "No libraries available yet.";
    } else {
      let summary = `Symbol: ${totals.symbols} · Footprints: ${totals.footprints} · 3D: ${totals.models}`;
      if (query) {
        summary += ` · Treffer: ${visibleCount}/${totalLibraries}`;
      }
      elements.librarySummary.textContent = summary;
    }
  }

  if (elements.headerActive) {
    const active = sortedLibraries.find((item) => item.active)
      || sortedLibraries.find((item) => !item.missing)
      || sortedLibraries[0];
    if (active) {
      elements.headerActive.innerHTML = `
        <span class="header-active-arrow">➜</span>
        <span class="header-active-label">Active library</span>
        <span class="header-active-name">${escapeHtml(active.name || "Untitled library")}</span>
      `;
    } else {
      elements.headerActive.innerHTML = "";
    }
  } else if (elements.headerActive) {
    elements.headerActive.innerHTML = "";
  }

  if (!totalLibraries) {
    if (elements.libraryEmpty) {
      elements.libraryEmpty.textContent = "No libraries yet. Add one to get started.";
      elements.libraryEmpty.classList.remove("d-none");
    }
    return;
  }

  if (!visibleCount) {
    if (elements.libraryEmpty) {
      elements.libraryEmpty.textContent = "No libraries matched your search.";
      elements.libraryEmpty.classList.remove("d-none");
    }
    elements.libraryList.innerHTML = "";
    return;
  }

  if (elements.libraryEmpty) {
    elements.libraryEmpty.classList.add("d-none");
    elements.libraryEmpty.textContent = "No libraries yet. Add one to get started.";
  }

  syncSelectedLibrary();

  libraries.forEach((library) => {
    const item = document.createElement("div");
    item.className = "library-entry";
	if (library.active) item.className += " active";
    if (library.missing) item.className += " missing";
    item.dataset.id = library.id;

    const info = document.createElement("div");
    info.className = "library-info";

    const titleRow = document.createElement("div");
    titleRow.className = "d-flex align-items-center";

    const title = document.createElement("span");
    title.className = "fw-semibold fs-6";
    title.textContent = library.name || "Untitled library";
    titleRow.appendChild(title);

	const actionWrapper = document.createElement("div");
    actionWrapper.className = "flex-fill d-flex flex-row-reverse gap-2";

	const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn btn-outline-danger library-remove";
    removeBtn.setAttribute("aria-label", `Remove library ${library.name || ""}`.trim());
    removeBtn.innerHTML = `
      <svg class="icon icon-trash" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 3a1 1 0 0 0-1 1v1H5.5a1 1 0 0 0 0 2H6v11a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7h.5a1 1 0 1 0 0-2H16V4a1 1 0 0 0-1-1H9Zm1 2h4v1h-4V5Zm-1 4a1 1 0 1 1 2 0v8a1 1 0 1 1-2 0V9Zm6-1a1 1 0 0 0-1 1v8a1 1 0 1 0 2 0V9a1 1 0 0 0-1-1Z" />
      </svg>
    `;
    removeBtn.dataset.id = library.id;
    actionWrapper.appendChild(removeBtn);

    const toggle = document.createElement("input");
    toggle.type = "button";
    toggle.className = "library-toggle";
    toggle.disabled = Boolean(library.active || library.missing);
	toggle.value = library.active ? "Active" : (library.missing ? "Missing" : "Activate");
    toggle.dataset.id = library.id;
	toggle.onclick = (event) => {
		toggle.disabled = true;
		handleLibraryListChange(event);
	};
    actionWrapper.appendChild(toggle);	

    titleRow.appendChild(actionWrapper);
    info.appendChild(titleRow);

    const assets = document.createElement("div");
    assets.className = "library-assets mb-2 mt-1";
    assets.appendChild(renderAssetBadge("Symbol", library.assets?.symbol, library.counts?.symbol));
    assets.appendChild(renderAssetBadge("Footprint", library.assets?.footprint, library.counts?.footprint));
    assets.appendChild(renderAssetBadge("3D", library.assets?.model, library.counts?.model));
    info.appendChild(assets);
	
    const path = document.createElement("div");
    path.className = "library-meta";
    path.textContent = library.symbolPath || library.path || library.resolvedPrefix || "";
    info.appendChild(path);

    if (library.missing) {
      const warning = document.createElement("div");
      warning.className = "library-warning";
      warning.textContent = "Library missing on disk.";
      info.appendChild(warning);
    }
    item.append(info);
    elements.libraryList.appendChild(item);
  });
}

function renderAssetBadge(label, active, count = 0) {
  const badge = document.createElement("span");
  const hasEntries = active && count > 0;
  const displayCount = typeof count === "number" && count >= 0 ? ` (${count})` : "";
  badge.className = `badge rounded-pill ${hasEntries ? "text-bg-success" : "text-bg-secondary"}`;
  badge.innerHTML = `<span class="badge-label">${escapeHtml(label)}</span><span class="badge-count">${escapeHtml(displayCount.trim())}</span>`;
  return badge;
}

function renderPartsResult() {
  if (!elements.partsResult) return;
  const job = state.lastJob;
  if (!job) {
    elements.partsResult.hidden = true;
    elements.partsResultDetails.innerHTML = "";
    return;
  }

  elements.partsResult.hidden = false;
  const outputs = [];
  if (job.outputs?.symbol || job.result?.symbol_path) outputs.push("Symbol");
  if (job.outputs?.footprint || job.result?.footprint_path) outputs.push("Footprint");
  if (job.outputs?.model || hasModelPaths(job.result)) outputs.push("3D");

  const rows = [
    ["Status", (job.status || "").toUpperCase()],
    ["LCSC", job.lcscId || job.lcsc_id || "–"],
    ["Library", job.libraryName || "–"],
    ["Path", job.libraryPath || job.output_path || "–"],
    ["Outputs", outputs.length ? outputs.join(" · ") : "–"],
    ["Message", job.message || job.error || "–"],
  ];

  elements.partsResultDetails.innerHTML = rows
    .map(([key, value]) => `
      <dt class="col-4">${key}</dt>
      <dd class="col-8">${escapeHtml(value)}</dd>
    `)
    .join("");
}

function hasModelPaths(result) {
  if (!result) return false;
  if (Array.isArray(result.model_paths)) {
    return result.model_paths.length > 0;
  }
  if (typeof result.model_paths === "object" && result.model_paths !== null) {
    return Object.keys(result.model_paths).length > 0;
  }
  return Boolean(result.model_paths);
}

function renderSettings() {
  if (!elements.settingsServer) return;
  if (!elements.settingsServer.matches(":focus")) {
    elements.settingsServer.value = state.settings.serverUrl;
  }
  elements.settingsOverwrite.checked = state.settings.overwrite;
  elements.settingsOverwriteModel.checked = state.settings.overwriteModel;
  elements.settingsDebug.checked = state.settings.debug;
  elements.settingsProjectRelative.checked = state.settings.projectRelative;
  if (elements.settingsProjectRelativePath && !elements.settingsProjectRelativePath.matches(":focus")) {
    elements.settingsProjectRelativePath.value = state.settings.projectRelativePath || "";
  }
  toggleSettingsProjectPath();
}

function setActiveTab(tab, options = {}) {
  if (!TAB_IDS.includes(tab)) {
    tab = "parts";
  }
  state.activeTab = tab;
  elements.tabButtons.forEach((button) => {
    const isActive = button.dataset.tab === tab;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });
  TAB_IDS.forEach((id) => {
    const panel = elements.panels[id];
    if (panel) {
      panel.classList.toggle("active", id === tab);
    }
  });
  if (!options.silent) {
    saveUiPreferences();
  }
}

function handlePartsSubmit(event) {
  event.preventDefault();
  if (!elements.partsForm) return;

  clearPartsFeedback();
  const lcscRaw = elements.partsLcsc.value.trim().toUpperCase();
  const outputs = {
    symbol: elements.partsSymbol.checked,
    footprint: elements.partsFootprint.checked,
    model: elements.partsModel.checked,
  };

  const hasOutput = outputs.symbol || outputs.footprint || outputs.model;
  if (!lcscRaw || !lcscRaw.startsWith("C")) {
	showToast("Please provide a valid LCSC number (e.g. C8734)", "danger");
    elements.partsLcsc.classList.add("is-invalid");
    return;
  }
  elements.partsLcsc.classList.remove("is-invalid");

  if (!hasOutput) {
	showToast("Select at least one output (symbol, footprint or 3D).", "danger");
    return;
  }

  const activeLibrary = getActiveLibrary();
  if (!activeLibrary) {
    modals.libraryRequired?.show();
    return;
  }

  const libraryPrefix = getLibraryPrefix(activeLibrary);
  if (!libraryPrefix) {
    setPartsFeedback("Library path is invalid.", "danger");
    return;
  }

  const payload = {
    lcscId: lcscRaw,
    libraryPath: libraryPrefix,
    libraryName: activeLibrary.name,
    symbol: outputs.symbol,
    footprint: outputs.footprint,
    model: outputs.model,
    overwrite: state.settings.overwrite,
    overwrite_model: state.settings.overwriteModel,
    projectRelative: Boolean(activeLibrary?.projectRelative),
    projectRelativePath: activeLibrary?.projectRelativePath || state.settings.projectRelativePath || "",
  };

  elements.partsSubmit.disabled = true;

  sendMessage("submitJob", { payload })
    .then((summary) => {
      state.lastJob = {
        ...summary,
        ...payload,
        outputs,
        status: summary.status || "queued",
        lcscId: lcscRaw,
      };
      renderPartsResult();
      setPartsFeedback(`${payload.lcscId} was sent to ${payload.libraryName}.`, "success");
    })
    .catch((error) => {
      setPartsFeedback(error.message || "Download failed.", "danger");
      showToast(error.message || "Download failed", "danger");
    })
    .finally(() => {
      elements.partsSubmit.disabled = false;
    });
}

function handleLibraryModalSubmit() {
  const activeTab = elements.libraryModalTabs?.querySelector(".nav-link.active");
  const target = activeTab?.getAttribute("data-bs-target") || "";
  if (target === "#library-modal-create") {
    submitCreateLibrary();
  } else {
    submitImportLibrary();
  }
}

function handleLibrarySearch(event) {
  const value = event?.target?.value ?? "";
  if (state.libraryFilter === value) {
    return;
  }
  state.libraryFilter = value;
  renderLibraries();
}

function handleLibraryListChange(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  if (!input.classList.contains("library-toggle")) return;
  const id = input.dataset.id;
  if (!id) return;
  const library = state.libraries.find((item) => item.id === id);
  if (!library) return;

  if (input.disabled) {
    state.libraries = state.libraries.map((item) => ({
      ...item,
      active: item.id === id,
    }));
  } else {
    const otherActive = state.libraries.some((item) => item.id !== id && item.active);
    if (!otherActive) {
      input.disabled = true;
      showToast("At least one library must remain active.", "warning");
      return;
    }
    state.libraries = state.libraries.map((item) => ({
      ...item,
      active: item.id === id ? false : item.active,
    }));
  }

  syncSelectedLibrary();
  renderLibraries();
  persistLibraries();
}

function handleLibraryListClick(event) {
  const button = event.target.closest("button");
  if (!button) return;
  const id = button.dataset.id;
  if (!id) return;
  const library = state.libraries.find((item) => item.id === id);
  if (!library) return;
  if (button.classList.contains("library-remove")) {
    if (!confirm(`Remove library "${library.name}"?`)) {
      return;
    }
    state.libraries = state.libraries.filter((item) => item.id !== id);
    if (!state.libraries.some((item) => item.active) && state.libraries.length) {
      state.libraries[0].active = true;
    }
    syncSelectedLibrary();
    renderLibraries();
    persistLibraries();
    showToast("Library removed", "success");
  }
}

function submitImportLibrary() {
  clearLibraryModalError();
  const path = elements.libraryImportPath.trim();
  if (!path) {
    setLibraryModalError("Please choose a file.");
    return;
  }
  if (!path.toLowerCase().endsWith(".kicad_sym")) {
    setLibraryModalError("Please select a .kicad_sym file.");
    return;
  }
  elements.libraryModalSubmit.disabled = true;
  sendMessage("importLibrary", { path })
    .then((record) => {
      state.libraries = upsertLibrary(record, true);
      syncSelectedLibrary();
      renderLibraries();
      persistLibraries();
      showToast(`Library "${record.name}" imported.`, "success");
      modals.library?.hide();
    })
    .catch((error) => setLibraryModalError(error.message || "Import failed."))
    .finally(() => {
      elements.libraryModalSubmit.disabled = false;
    });
}

function submitCreateLibrary() {
  clearLibraryModalError();
  const name = elements.libraryCreateName.value.trim();
  const basePath = elements.libraryCreatePath.value.trim();
  if (!name || !basePath) {
    setLibraryModalError("Name and base folder are required.");
    return;
  }
  const payload = {
    name,
    basePath,
    symbol: elements.libraryCreateSymbol.checked,
    footprint: elements.libraryCreateFootprint.checked,
    model: elements.libraryCreateModel.checked,
    projectRelative: elements.libraryCreateProject.checked,
    projectRelativePath: elements.libraryCreateProject.checked
      ? (elements.libraryCreateProjectPath?.value.trim()
          || state.settings.projectRelativePath
          || "")
      : "",
  };

  elements.libraryModalSubmit.disabled = true;
  sendMessage("createLibrary", payload)
    .then((record) => {
      state.libraries = upsertLibrary(record, true);
      syncSelectedLibrary();
      renderLibraries();
      persistLibraries();
      showToast(`Library "${record.name}" created.`, "success");
      modals.library?.hide();
    })
    .catch((error) => setLibraryModalError(error.message || "Creation failed."))
    .finally(() => {
      elements.libraryModalSubmit.disabled = false;
    });
}

function upsertLibrary(record, activate = false) {
  const libraries = state.libraries.slice();
  const index = libraries.findIndex((item) => item.id === record.id);
  const normalized = {
    ...record,
    active: activate ? true : Boolean(record.active),
    counts: {
      symbol: Number(record?.counts?.symbol) || 0,
      footprint: Number(record?.counts?.footprint) || 0,
      model: Number(record?.counts?.model) || 0,
    },
  };
  if (activate) {
    libraries.forEach((item) => {
      item.active = item.id === record.id;
    });
  }
  if (index >= 0) {
    libraries[index] = { ...libraries[index], ...normalized };
  } else {
    if (activate) {
      libraries.forEach((item) => (item.active = false));
    }
    libraries.push(normalized);
  }
  return libraries;
}

function persistLibraries() {
  sendMessage("updateLibraries", { libraries: state.libraries })
    .then((snapshot) => {
      if (snapshot) {
        applyState(snapshot);
      }
    })
    .catch((error) => showToast(error.message || "Saving failed", "danger"));
}

function handleSettingsChange() {
  const rawProjectPath = elements.settingsProjectRelativePath?.value.trim() || "";
  const projectRelativePath = elements.settingsProjectRelative.checked
    ? rawProjectPath
    : (state.settings.projectRelativePath || rawProjectPath);
  const payload = {
    serverUrl: elements.settingsServer.value.trim(),
    overwriteFootprints: elements.settingsOverwrite.checked,
    overwriteModels: elements.settingsOverwriteModel.checked,
    debugLogs: elements.settingsDebug.checked,
    projectRelative: elements.settingsProjectRelative.checked,
    projectRelativePath,
  };
  state.settings.projectRelative = payload.projectRelative;
  state.settings.projectRelativePath = projectRelativePath;
  saveUiPreferences();
  sendMessage("updateSettings", payload)
    .then((snapshot) => {
      applyState(snapshot);
      setSettingsFeedback("Saved", "text-success");
    })
    .catch((error) => {
      setSettingsFeedback(error.message || "Saving failed", "text-danger");
    });
}

function toggleSettingsProjectPath() {
  if (!elements.settingsProjectRelativePathGroup || !elements.settingsProjectRelative) {
    return;
  }
  const show = elements.settingsProjectRelative.checked;
  elements.settingsProjectRelativePathGroup.hidden = !show;
}

function testServerConnection() {
  setSettingsFeedback("Checking connection…", "text-muted");
  sendMessage("updateSettings", { serverUrl: elements.settingsServer.value.trim() })
    .then((status) => {
		if(status.connected) setSettingsFeedback("Server reachable", "text-success");
		else setSettingsFeedback("Server not reachable", "text-danger");
	})
}

function clearPartsFeedback() {
  if (elements.partsFeedback) {
    elements.partsFeedback.innerHTML = "";
    elements.partsFeedback.classList.add("d-none");
  }
}

function setPartsFeedback(message, variant) {
  if (!elements.partsFeedback) return;
  const alert = document.createElement("div");
  alert.className = `alert alert-${variant}`;
  alert.textContent = message;
  elements.partsFeedback.innerHTML = "";
  elements.partsFeedback.appendChild(alert);
  elements.partsFeedback.classList.remove("d-none");
}

function setSettingsFeedback(message, cls) {
  if (!elements.settingsFeedback) return;
  elements.settingsFeedback.className = `card-footer small ${cls}`.trim();
  elements.settingsFeedback.textContent = message;
  elements.settingsFeedback.classList.toggle("d-none", !message);
}

function clearLibraryModalError() {
  if (!elements.libraryModalError) return;
  elements.libraryModalError.textContent = "";
  elements.libraryModalError.classList.remove("text-danger");
}

function setLibraryModalError(message) {
  if (!elements.libraryModalError) return;
  elements.libraryModalError.textContent = message;
  elements.libraryModalError.classList.add("text-danger");
}

function setLibraryModalTab(mode) {
  const targetId = mode === "create" ? "library-modal-create" : "library-modal-import";
  const tabTrigger = elements.libraryModalTabs?.querySelector(`[data-bs-target="#${targetId}"]`);
  if (tabTrigger) {
    const tab = new bootstrap.Tab(tabTrigger);
    tab.show();
  }
  if (mode === "create") {
    if (elements.libraryCreateProject) {
      elements.libraryCreateProject.checked = state.settings.projectRelative;
    }
    if (elements.libraryCreateProjectPath) {
      elements.libraryCreateProjectPath.value = state.settings.projectRelativePath || "";
    }
    toggleLibraryProjectPath();
  }
}

function validateImportPath(path) {
  if (!path) {
    elements.libraryImportInfo.textContent = "";
    elements.libraryImportInfo.className = "form-text";
    return;
  }
  if (!path.toLowerCase().endsWith(".kicad_sym")) {
    elements.libraryImportInfo.textContent = "Please select a .kicad_sym file.";
    elements.libraryImportInfo.className = "form-text text-danger";
    return;
  }
  elements.libraryImportInfo.textContent = "Checking path…";
  elements.libraryImportInfo.className = "form-text text-muted";
  sendMessage("validateLibrary", { path })
    .then((result) => {
      const counts = result.counts || {};
      const parts = [];
      parts.push(`Symbol (${counts.symbol ?? (result.assets?.symbol ? 1 : 0)})`);
      parts.push(`Footprint (${counts.footprint ?? 0})`);
      parts.push(`3D (${counts.model ?? 0})`);
      const libraryName = deriveLibraryName(path);
      const assetsLabel = parts.join(" · ");
      elements.libraryImportInfo.textContent = libraryName
        ? `${libraryName} – ${assetsLabel}`
        : assetsLabel;
      elements.libraryImportInfo.className = "form-text text-muted";
    })
    .catch((error) => {
      elements.libraryImportInfo.textContent = error.message || "Not a valid library.";
      elements.libraryImportInfo.className = "form-text text-danger";
    });
}

function openDirectoryPicker({ mode, onSelect, applyLabel, initialPath }) {
  state.picker.mode = mode;
  state.picker.callback = onSelect;
  state.picker.selectedPath = "";
  state.picker.parentPath = "";
  state.picker.currentPath = initialPath || "";
  state.picker.selectedType = "";
  state.picker.filterExtension = mode === "import" ? ".kicad_sym" : null;
  state.picker.requireFile = mode === "import";
  state.picker.breadcrumbs = [];
  elements.pickerModalTitle.innerHTML = mode === "import" ? "Select file" : "Select folder";
  elements.pickerManual.value = initialPath || "";
  elements.pickerError.textContent = "";
  elements.pickerApply.textContent = applyLabel || "Select";

  loadRoots()
    .then((roots) => {
      state.picker.roots = roots;
      const trimmedInitial = initialPath && initialPath.trim() ? initialPath.trim() : "";
      const extension = state.picker.filterExtension ? state.picker.filterExtension.toLowerCase() : null;
      let startPath = trimmedInitial;
      if (state.picker.requireFile && extension && trimmedInitial.toLowerCase().endsWith(extension)) {
        state.picker.selectedPath = trimmedInitial;
        state.picker.selectedType = "file";
        startPath = trimmedInitial.replace(/[\\/][^\\/]*$/, "");
        elements.pickerManual.value = trimmedInitial;
      }
      if (!startPath) {
        startPath = roots[0]?.path || "";
      }
      if (startPath) {
        const shouldRetain = state.picker.requireFile && state.picker.selectedType === "file";
        return loadDirectory(startPath, { retainSelection: shouldRetain });
      }
      renderPickerList([]);
      modals.picker?.show();
      return null;
    })
    .catch((error) => {
      elements.pickerError.textContent = error.message || "Failed to load folders.";
      renderPickerList([]);
      modals.picker?.show();
    });
}

function loadRoots() {
  if (state.picker.roots.length) {
    return Promise.resolve(state.picker.roots);
  }
  return sendMessage("fs:listRoots");
}

function loadDirectory(path, options = {}) {
  const { retainSelection = false } = options;
  const previousSelection = retainSelection ? state.picker.selectedPath : "";
  const previousType = retainSelection ? state.picker.selectedType : "";
  return sendMessage("fs:listDirectory", { path })
    .then((data) => {
      state.picker.currentPath = data.path;
      state.picker.parentPath = data.parent || "";
      if (retainSelection) {
        state.picker.selectedPath = previousSelection;
        state.picker.selectedType = previousType;
      } else {
        state.picker.selectedPath = "";
        state.picker.selectedType = "";
      }
      state.picker.breadcrumbs = Array.isArray(data.breadcrumbs) ? data.breadcrumbs : [];
      elements.pickerManual.value = data.path;
      renderPickerPathBreadcrumb();
      renderPickerList(data.entries || []);
      if (retainSelection && state.picker.selectedPath) {
        if (state.picker.selectedType === "file") {
          elements.pickerManual.value = state.picker.selectedPath;
        }
        const match = Array.from(elements.pickerList.querySelectorAll("li[data-path]"))
          .find((node) => node.dataset.path === state.picker.selectedPath);
        match?.classList.add("active");
      }
      elements.pickerError.textContent = "";
      modals.picker?.show();
      return data;
    })
    .catch((error) => {
      elements.pickerError.textContent = error.message || "Failed to load path.";
      renderPickerPathBreadcrumb();
      renderPickerList([]);
      modals.picker?.show();
      return null;
    });
}

function renderPickerPathBreadcrumb() {
  if (!elements.pickerPathBreadcrumb) return;
  const wrapper = document.createElement("div");
  wrapper.className = "d-flex flex-wrap align-items-center gap-2";
  const crumbs = Array.isArray(state.picker.breadcrumbs) ? state.picker.breadcrumbs : [];

  if (!crumbs.length) {
    const none = document.createElement("span");
    none.className = "small text-muted";
    none.textContent = "No path";
    wrapper.appendChild(none);
  } else {
    crumbs.forEach((crumb, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn-sm btn-secondary";
      button.textContent = crumb?.label || crumb?.path || "";
      if (index === crumbs.length - 1) {
        button.disabled = true;
        button.classList.add("active");
      } else if (crumb?.path) {
        button.addEventListener("click", () => loadDirectory(crumb.path));
      }
      wrapper.appendChild(button);
    });
  }

  elements.pickerPathBreadcrumb.innerHTML = "";
  elements.pickerPathBreadcrumb.appendChild(wrapper);
}

function renderPickerList(entries) {
  elements.pickerList.innerHTML = "";
  const extension = state.picker.filterExtension ? state.picker.filterExtension.toLowerCase() : null;
  const directories = entries.filter((entry) => entry.is_dir);
  const files = extension
    ? entries.filter((entry) => !entry.is_dir && entry.name.toLowerCase().endsWith(extension))
    : [];

  if (!directories.length && !files.length) {
    const empty = document.createElement("li");
    empty.className = "list-group-item text-muted";
    empty.textContent = state.picker.requireFile
      ? `No ${extension || ""} files`
      : "No entries";
    elements.pickerList.appendChild(empty);
    return;
  }

  const displayEntries = [...directories, ...files];
  displayEntries.forEach((entry) => {
    const isDir = Boolean(entry.is_dir);
    const item = document.createElement("li");
    item.className = "list-group-item list-group-item-action d-flex justify-content-between align-items-center";
    item.dataset.path = entry.path;
    item.dataset.type = isDir ? "dir" : "file";
    item.tabIndex = 0;
    const icon = isDir ? "&#128193;" : "&#128196;";
    item.innerHTML = `
      <span>${escapeHtml(entry.name)}</span>
      <span aria-hidden="true">${icon}</span>
    `;
    elements.pickerList.appendChild(item);
    if (state.picker.selectedPath && state.picker.selectedPath === entry.path) {
      item.classList.add("active");
    }
  });
}

function handlePickerListClick(event) {
  const item = event.target.closest("li[data-path]");
  if (!item) return;
  selectPickerItem(item);
}

function handlePickerListDoubleClick(event) {
  const item = event.target.closest("li[data-path]");
  if (!item) return;
  if (item.dataset.type === "file") {
    selectPickerItem(item);
    applyPickerSelection();
  } else {
    loadDirectory(item.dataset.path);
  }
}

function handlePickerListKeydown(event) {
  const items = Array.from(elements.pickerList.querySelectorAll("li[data-path]"));
  if (!items.length) return;
  const currentIndex = items.findIndex((item) => item.classList.contains("active"));

  if (event.key === "ArrowDown") {
    event.preventDefault();
    const next = items[(currentIndex + 1) % items.length];
    selectPickerItem(next);
    next?.focus();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    const prev = items[(currentIndex - 1 + items.length) % items.length];
    selectPickerItem(prev);
    prev?.focus();
  } else if (event.key === "Enter" && currentIndex >= 0) {
    event.preventDefault();
    const current = items[currentIndex];
    if (current.dataset.type === "file") {
      selectPickerItem(current);
      applyPickerSelection();
    } else {
      loadDirectory(current.dataset.path);
    }
  }
}

function scheduleManualPathLoad(path, { immediate = false } = {}) {
  clearTimeout(pickerManualTimer);
  if (!path) {
    elements.pickerError.textContent = "";
    return;
  }
  const extension = state.picker.filterExtension ? state.picker.filterExtension.toLowerCase() : null;
  if (state.picker.requireFile && extension && path.toLowerCase().endsWith(extension)) {
    state.picker.selectedPath = path;
    state.picker.selectedType = "file";
    elements.pickerError.textContent = "";
    return;
  }
  state.picker.selectedPath = "";
  state.picker.selectedType = "";
  const perform = () => loadDirectory(path);
  if (immediate) {
    perform();
    return;
  }
  pickerManualTimer = setTimeout(() => {
    if (elements.pickerManual.value.trim() === path) {
      perform();
    }
  }, 400);
}

function handlePickerManualInput() {
  scheduleManualPathLoad(elements.pickerManual.value.trim());
}

function handlePickerManualChange() {
  scheduleManualPathLoad(elements.pickerManual.value.trim(), { immediate: true });
}

function handlePickerManualKeydown(event) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  scheduleManualPathLoad(elements.pickerManual.value.trim(), { immediate: true });
}

function selectPickerItem(item) {
  Array.from(elements.pickerList.querySelectorAll("li[data-path]")).forEach((node) => {
    node.classList.remove("active");
  });
  item.classList.add("active");
  state.picker.selectedPath = item.dataset.path;
  state.picker.selectedType = item.dataset.type || "";
  if (item.dataset.type === "file") {
    elements.pickerManual.value = item.dataset.path;
  }
}

function applyPickerSelection() {
  const selected = state.picker.selectedPath || state.picker.currentPath;
  if (!selected) {
    elements.pickerError.textContent = state.picker.requireFile
      ? "Please select a file."
      : "Please select a folder.";
    return;
  }
  if (state.picker.requireFile && state.picker.selectedType !== "file") {
    elements.pickerError.textContent = "Please choose a .kicad_sym file.";
    return;
  }
  state.picker.callback?.(selected);
  modals.picker?.hide();
}

function getActiveLibrary() {
  return state.libraries.find((library) => library.active);
}

function stripLibrarySuffix(path) {
  if (!path) return "";
  return path.replace(/\.(kicad_sym|lib)$/i, "");
}

function deriveLibraryName(path) {
  if (!path) return "";
  const normalized = stripLibrarySuffix(path.trim());
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return "";
  const last = parts[parts.length - 1];
  return last;
}

function getLibraryPrefix(library) {
  if (!library) return "";
  let candidate = library.path || library.resolvedPrefix || "";
  if (!candidate && library.symbolPath) {
    candidate = stripLibrarySuffix(library.symbolPath);
  }
  return stripLibrarySuffix(candidate);
}

function syncSelectedLibrary() {
  const activeLibrary = getActiveLibrary();
  if (!activeLibrary) {
    return;
  }
  const prefix = getLibraryPrefix(activeLibrary);
  if (!prefix) {
    return;
  }
  const currentPath = state.selectedLibraryPath || "";
  const currentName = state.selectedLibraryName || "";
  if (currentPath === prefix && currentName === (activeLibrary.name || "")) {
    return;
  }
  state.selectedLibraryPath = prefix;
  state.selectedLibraryName = activeLibrary.name || "";
  sendMessage("setSelectedLibrary", {
    path: prefix,
    name: activeLibrary.name || "",
  }).catch((error) => {
    console.warn("Failed to sync selected library", error);
  });
}

function debounce(fn, delay = 200) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn.apply(null, args), delay);
  };
}

function sendMessage(type, payload = {}) {
  return chrome.runtime
    .sendMessage({ type, ...payload })
    .then((response) => {
      if (!response?.ok) {
        throw new Error(response?.error || "Unknown error");
      }
      return response.data;
    });
}

function showToast(message, variant = "primary") {
  if (!elements.toastContainer) return;
  const toastElement = document.createElement("div");
  toastElement.className = `toast align-items-center text-bg-${variant}`;
  toastElement.role = "status";
  toastElement.ariaLive = "assertive";
  toastElement.ariaAtomic = "true";
  toastElement.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${escapeHtml(message)}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
    </div>
  `;
  elements.toastContainer.appendChild(toastElement);
  const toast = new bootstrap.Toast(toastElement, { delay: 4000 });
  toast.show();
  toastElement.addEventListener("hidden.bs.toast", () => {
    toastElement.remove();
  });
}

function escapeHtml(value) {
  if (value == null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

