/* ============================================================
   Trollas. Inc. OS — Admin
   ------------------------------------------------------------
   Uses only the public Supabase anon/publishable key. The
   ingest secret and the service_role key are never used here.

   Database setup: run telemetry-admin.sql once in the Supabase
   SQL editor and grant the app_metadata claim to the
   administrator account.
   ============================================================ */

"use strict";

const SUPABASE_URL = "https://hvhwvzuxswpqokgysetx.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_BaehH5ev2awPrvuyXiDG_Q_JShIupvM";

const SESSION_KEY = "trollas.admin.session.v1";
const PAGE_SIZE = 100;
const AUTO_REFRESH_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;
const LOCALE = "en-US";

const els = {
  bootView: document.getElementById("boot-view"),
  authView: document.getElementById("auth-view"),
  dashboardView: document.getElementById("dashboard-view"),

  loginForm: document.getElementById("login-form"),
  email: document.getElementById("email"),
  password: document.getElementById("password"),
  togglePassword: document.getElementById("toggle-password"),
  loginButton: document.getElementById("login-button"),
  loginError: document.getElementById("login-error"),

  navbarUser: document.getElementById("navbar-user"),
  refreshButton: document.getElementById("refresh-button"),
  logoutButton: document.getElementById("logout-button"),

  dashboardError: document.getElementById("dashboard-error"),
  dashboardErrorMessage: document.getElementById("dashboard-error-message"),
  retryButton: document.getElementById("retry-button"),

  unauthorizedView: document.getElementById("unauthorized-view"),
  unauthorizedEmail: document.getElementById("unauthorized-email"),
  retryAccessButton: document.getElementById("retry-access-button"),
  unauthorizedLogoutButton: document.getElementById("unauthorized-logout-button"),

  dashboardContent: document.getElementById("dashboard-content"),
  statTotal: document.getElementById("stat-total"),
  statDevices: document.getElementById("stat-devices"),
  statLast: document.getElementById("stat-last"),
  statLastRelative: document.getElementById("stat-last-relative"),

  reportsSummary: document.getElementById("reports-summary"),
  tableLoading: document.getElementById("table-loading"),
  reloadButton: document.getElementById("reload-button"),
  tableWrap: document.getElementById("table-wrap"),
  table: document.getElementById("reports-table"),
  reportsBody: document.getElementById("reports-body"),
  tableEmpty: document.getElementById("table-empty"),
  tableSkeleton: document.getElementById("table-skeleton"),
  pageSummary: document.getElementById("page-summary"),
  pageIndicator: document.getElementById("page-indicator"),
  prevPage: document.getElementById("prev-page"),
  nextPage: document.getElementById("next-page"),
  lastUpdated: document.getElementById("last-updated"),
};

const state = {
  session: null,
  page: 0,
  total: 0,
  uniqueDevices: 0,
  lastReceivedAt: null,
  reports: [],
  loading: false,
  authorized: false,
  hasLoaded: false,
  lastLoadedAt: 0,
  refreshTimer: null,
  refreshing: null,
  epoch: 0,
};

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
  }
}

const numberFormatter = new Intl.NumberFormat(LOCALE);
const dateTimeFormatter = new Intl.DateTimeFormat(LOCALE, {
  dateStyle: "medium",
  timeStyle: "short",
});
const relativeFormatter = new Intl.RelativeTimeFormat(LOCALE, {
  numeric: "auto",
});

/* ============================================================
   Session storage
   ============================================================ */

function readStoredSession() {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;

    const session = JSON.parse(raw);
    if (
      !session ||
      typeof session.access_token !== "string" ||
      typeof session.refresh_token !== "string" ||
      typeof session.expires_at !== "number"
    ) {
      window.localStorage.removeItem(SESSION_KEY);
      return null;
    }

    return session;
  } catch {
    return null;
  }
}

function storeSession(session) {
  try {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* Storage can be unavailable in private browsing; the in-memory
       session still works for the current tab. */
  }
}

function removeStoredSession() {
  try {
    window.localStorage.removeItem(SESSION_KEY);
  } catch {
    /* Ignore storage errors. */
  }
}

function saveSession(payload, fallbackEmail) {
  const user = payload && payload.user ? payload.user : {};
  const session = {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at:
      Date.now() + (Number(payload.expires_in) || 3600) * 1000,
    user: {
      id: user.id || null,
      email: user.email || fallbackEmail || "",
    },
  };

  state.session = session;
  storeSession(session);
  return session;
}

function clearSession() {
  state.session = null;
  removeStoredSession();
}

/* ============================================================
   HTTP helpers
   ============================================================ */

async function readResponse(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractMessage(payload, fallback) {
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  if (!payload || typeof payload !== "object") return fallback;

  return (
    payload.msg ||
    payload.error_description ||
    payload.message ||
    payload.error ||
    fallback
  );
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = window.setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS,
  );

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

async function authRequest(path, body) {
  let response;

  try {
    response = await fetchWithTimeout(`${SUPABASE_URL}${path}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new ApiError(
      0,
      "network",
      "Could not reach Supabase. Check your connection and try again.",
    );
  }

  const payload = await readResponse(response);

  if (!response.ok) {
    throw new ApiError(
      response.status,
      (payload && (payload.code || payload.error_code)) || null,
      extractMessage(payload, "Authentication failed."),
    );
  }

  return payload;
}

async function login(email, password) {
  const payload = await authRequest(
    "/auth/v1/token?grant_type=password",
    { email, password },
  );

  if (!payload || !payload.access_token || !payload.refresh_token) {
    throw new ApiError(400, "auth", "Sign in failed. Check your credentials.");
  }

  return saveSession(payload, email);
}

async function refreshSession(force) {
  if (
    !force &&
    state.session &&
    state.session.expires_at - Date.now() > 60_000
  ) {
    return state.session;
  }

  if (!state.session || !state.session.refresh_token) {
    throw new AuthError("No active session.");
  }

  if (state.refreshing) return state.refreshing;

  const previousEmail = state.session.user ? state.session.user.email : "";
  const refreshToken = state.session.refresh_token;

  state.refreshing = (async () => {
    try {
      const payload = await authRequest(
        "/auth/v1/token?grant_type=refresh_token",
        { refresh_token: refreshToken },
      );

      if (!payload || !payload.access_token || !payload.refresh_token) {
        throw new AuthError("Could not refresh the session.");
      }

      return saveSession(payload, previousEmail);
    } catch (error) {
      if (error instanceof ApiError && error.status === 0) throw error;

      clearSession();
      throw new AuthError("Your session expired. Sign in again.");
    }
  })().finally(() => {
    state.refreshing = null;
  });

  return state.refreshing;
}

async function ensureSession() {
  if (!state.session) throw new AuthError("Not signed in.");

  if (state.session.expires_at - Date.now() <= 60_000) {
    await refreshSession(true);
  }

  return state.session;
}

async function apiFetch(path, options) {
  const settings = options || {};
  const method = settings.method || "GET";
  const body = settings.body;
  const retry = settings.retry !== false;

  await ensureSession();

  let response;
  try {
    response = await fetchWithTimeout(`${SUPABASE_URL}${path}`, {
      method,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${state.session.access_token}`,
        Accept: "application/json",
        ...(body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new ApiError(
      0,
      "network",
      "Could not reach Supabase. Check your connection and try again.",
    );
  }

  if (response.status === 401 && retry) {
    await refreshSession(true);
    return apiFetch(path, { method, body, retry: false });
  }

  const payload = await readResponse(response);

  if (!response.ok) {
    throw new ApiError(
      response.status,
      (payload && payload.code) || null,
      extractMessage(payload, `Request failed (${response.status}).`),
    );
  }

  return payload;
}

async function fetchStats() {
  const payload = await apiFetch("/rest/v1/rpc/telemetry_admin_stats", {
    method: "POST",
    body: {},
  });

  const row = Array.isArray(payload) ? payload[0] : payload;

  if (!row || typeof row !== "object") {
    throw new ApiError(
      500,
      "bad_response",
      "The stats function returned an unexpected response.",
    );
  }

  return {
    total: Number(row.total_reports) || 0,
    uniqueDevices: Number(row.unique_devices) || 0,
    lastReceivedAt: row.last_received_at || null,
  };
}

async function fetchReports(page) {
  const query = new URLSearchParams({
    select: "id,device_id,reported_at,received_at,model,os,ui,build",
    order: "received_at.desc,id.desc",
    limit: String(PAGE_SIZE),
    offset: String(page * PAGE_SIZE),
  });

  const payload = await apiFetch(
    `/rest/v1/telemetry_reports?${query.toString()}`,
  );

  return Array.isArray(payload) ? payload : [];
}

/* ============================================================
   Formatting
   ============================================================ */

function formatNumber(value) {
  return numberFormatter.format(Number(value) || 0);
}

function formatDateTime(value) {
  if (!value) return "—";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  return dateTimeFormatter.format(date);
}

function formatRelative(value) {
  if (!value) return "No reports yet";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";

  const diff = date.getTime() - Date.now();
  const absolute = Math.abs(diff);

  if (absolute < 45_000) return "just now";

  const units = [
    ["year", 31_536_000_000],
    ["month", 2_592_000_000],
    ["week", 604_800_000],
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
    ["second", 1_000],
  ];

  for (const [unit, milliseconds] of units) {
    if (absolute >= milliseconds || unit === "second") {
      return relativeFormatter.format(
        Math.round(diff / milliseconds),
        unit,
      );
    }
  }

  return "just now";
}

/* ============================================================
   Rendering
   ============================================================ */

function setLoginLoading(loading) {
  els.loginButton.disabled = loading;
  els.loginButton.classList.toggle("is-loading", loading);

  const label = els.loginButton.querySelector(".button-label");
  if (label) label.textContent = loading ? "Signing in…" : "Sign in";
}

function setLoginError(message) {
  const text = message || "";
  els.loginError.textContent = text;
  els.loginError.hidden = !text;
}

function setDashboardError(message) {
  const text = message || "";
  els.dashboardErrorMessage.textContent = text;
  els.dashboardError.hidden = !text;
}

function clearDashboardError() {
  setDashboardError("");
}

function setLoading(loading) {
  els.tableLoading.hidden = !loading;
  els.refreshButton.disabled = loading;
  els.reloadButton.disabled = loading;
  els.refreshButton.classList.toggle("is-loading", loading);
  els.tableWrap.setAttribute("aria-busy", String(loading));

  if (!loading) {
    els.tableSkeleton.hidden = true;
    return;
  }

  if (!state.hasLoaded) {
    els.table.hidden = true;
    els.tableEmpty.hidden = true;
    els.tableSkeleton.hidden = false;
    els.reportsSummary.textContent = "Loading reports…";
  }
}

function showAuth() {
  els.bootView.hidden = true;
  els.authView.hidden = false;
  els.dashboardView.hidden = true;
}

function showDashboard() {
  els.bootView.hidden = true;
  els.authView.hidden = true;
  els.dashboardView.hidden = false;
  els.navbarUser.textContent =
    (state.session && state.session.user && state.session.user.email) || "";
}

function showAuthorized() {
  els.unauthorizedView.hidden = true;
  els.dashboardContent.hidden = false;
}

function showUnauthorized() {
  els.unauthorizedView.hidden = false;
  els.dashboardContent.hidden = true;
  els.unauthorizedEmail.textContent =
    (state.session && state.session.user && state.session.user.email) ||
    "this account";
  els.lastUpdated.textContent = "Access denied";
}

function renderStats() {
  els.statTotal.textContent = formatNumber(state.total);
  els.statDevices.textContent = formatNumber(state.uniqueDevices);

  if (state.lastReceivedAt) {
    els.statLast.textContent = formatDateTime(state.lastReceivedAt);
    els.statLastRelative.textContent = formatRelative(state.lastReceivedAt);
  } else {
    els.statLast.textContent = "—";
    els.statLastRelative.textContent = "No reports yet";
  }
}

function createTextCell(value, className) {
  const cell = document.createElement("td");
  if (className) cell.className = className;

  const text = value === null || value === undefined || value === ""
    ? "—"
    : String(value);

  cell.textContent = text;

  if (text !== "—" && text.length > 18) {
    cell.title = text;
  }

  return cell;
}

function createDateCell(value) {
  const cell = document.createElement("td");
  cell.className = "cell-date";

  if (!value) {
    cell.textContent = "—";
    return cell;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    cell.textContent = "—";
    return cell;
  }

  const time = document.createElement("time");
  time.dateTime = date.toISOString();
  time.textContent = formatDateTime(value);
  time.title = date.toISOString();
  cell.append(time);

  return cell;
}

function renderTable() {
  const rows = state.reports;
  els.reportsBody.replaceChildren();
  els.table.hidden = rows.length === 0;
  els.tableEmpty.hidden = rows.length > 0;

  if (rows.length === 0) return;

  const fragment = document.createDocumentFragment();

  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.append(
      createTextCell(row.device_id, "cell-device"),
      createTextCell(row.model, "cell-text"),
      createTextCell(row.os, "cell-text"),
      createTextCell(row.ui, "cell-text"),
      createTextCell(row.build, "cell-text"),
      createDateCell(row.reported_at),
      createDateCell(row.received_at),
    );
    fragment.append(tr);
  }

  els.reportsBody.append(fragment);
}

function renderPagination() {
  const total = state.total;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const start = total === 0 ? 0 : state.page * PAGE_SIZE + 1;
  const end = Math.min(total, (state.page + 1) * PAGE_SIZE);

  els.reportsSummary.textContent =
    total === 0
      ? "No submissions received yet."
      : `${formatNumber(total)} submission${
          total === 1 ? "" : "s"
        } · newest first`;

  els.pageSummary.textContent =
    total === 0
      ? "Showing 0 of 0"
      : `Showing ${formatNumber(start)}–${formatNumber(end)} of ${formatNumber(
          total,
        )}`;

  els.pageIndicator.textContent = `Page ${state.page + 1} of ${pages}`;
  els.prevPage.disabled = state.page <= 0;
  els.nextPage.disabled = end >= total;
}

function updateLastUpdated() {
  state.lastLoadedAt = Date.now();
  const time = new Date().toLocaleTimeString(LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  els.lastUpdated.textContent = `Updated ${time}`;
}

/* ============================================================
   Dashboard loading
   ============================================================ */

function isPermissionError(error) {
  return (
    error instanceof ApiError &&
    (error.status === 403 ||
      error.code === "42501" ||
      error.code === "PT403")
  );
}

function handleAuthFailure(message) {
  stopAutoRefresh();
  clearSession();

  state.epoch += 1;
  state.loading = false;
  state.authorized = false;
  state.hasLoaded = false;
  state.reports = [];
  state.total = 0;
  state.uniqueDevices = 0;
  state.lastReceivedAt = null;

  setLoading(false);
  showAuth();
  setLoginError(message || "Your session expired. Sign in again.");
}

function handleDashboardError(error) {
  if (error instanceof AuthError) {
    handleAuthFailure(error.message);
    return;
  }

  if (error instanceof ApiError && error.status === 401) {
    if (error.code === "42501") {
      showUnauthorized();
    } else {
      handleAuthFailure("Your session expired. Sign in again.");
    }
    return;
  }

  if (isPermissionError(error)) {
    showUnauthorized();
    return;
  }

  setDashboardError(
    error instanceof Error
      ? error.message
      : "Could not load admin data.",
  );

  if (!state.hasLoaded) {
    els.reportsSummary.textContent = "Could not load reports.";
  }
}

async function loadDashboard(options) {
  const settings = options || {};

  if (state.loading) return;
  if (settings.resetPage) state.page = 0;

  const epoch = state.epoch;

  state.loading = true;
  setLoading(true);
  clearDashboardError();

  try {
    const stats = await fetchStats();
    if (epoch !== state.epoch) return;

    state.total = stats.total;
    state.uniqueDevices = stats.uniqueDevices;
    state.lastReceivedAt = stats.lastReceivedAt;

    const lastPage = Math.max(0, Math.ceil(state.total / PAGE_SIZE) - 1);
    if (state.page > lastPage) state.page = lastPage;

    let rows = await fetchReports(state.page);
    if (epoch !== state.epoch) return;

    if (rows.length === 0 && state.page > 0) {
      state.page = lastPage;
      rows = await fetchReports(state.page);
      if (epoch !== state.epoch) return;
    }

    state.reports = rows;
    state.authorized = true;
    state.hasLoaded = true;

    showAuthorized();
    renderStats();
    renderTable();
    renderPagination();
    updateLastUpdated();
  } catch (error) {
    if (epoch !== state.epoch) return;
    handleDashboardError(error);
  } finally {
    if (epoch === state.epoch) {
      state.loading = false;
      setLoading(false);
    }
  }
}

/* ============================================================
   Auto refresh
   ============================================================ */

function stopAutoRefresh() {
  if (state.refreshTimer !== null) {
    window.clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}

function startAutoRefresh() {
  stopAutoRefresh();

  state.refreshTimer = window.setInterval(() => {
    if (
      document.visibilityState !== "visible" ||
      state.loading ||
      !state.authorized
    ) {
      return;
    }

    loadDashboard();
  }, AUTO_REFRESH_MS);
}

/* ============================================================
   Actions
   ============================================================ */

async function signOut() {
  const token = state.session ? state.session.access_token : null;

  stopAutoRefresh();
  clearSession();

  state.epoch += 1;
  state.loading = false;
  state.authorized = false;
  state.hasLoaded = false;
  state.reports = [];
  state.total = 0;
  state.uniqueDevices = 0;
  state.lastReceivedAt = null;
  state.page = 0;

  els.password.value = "";
  els.password.type = "password";
  els.togglePassword.textContent = "Show";
  els.togglePassword.setAttribute("aria-label", "Show password");

  setLoading(false);
  showAuth();
  setLoginError("");

  if (token) {
    fetchWithTimeout(`${SUPABASE_URL}/auth/v1/logout`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
    }).catch(() => {
      /* Local sign-out succeeded even if the network call failed. */
    });
  }
}

async function retryAccess() {
  if (state.loading) return;

  els.retryAccessButton.disabled = true;
  clearDashboardError();

  try {
    await refreshSession(true);
    await loadDashboard({ resetPage: true });
  } catch (error) {
    if (error instanceof AuthError) {
      handleAuthFailure(error.message);
    } else {
      handleDashboardError(error);
    }
  } finally {
    els.retryAccessButton.disabled = false;
  }
}

/* ============================================================
   Events and boot
   ============================================================ */

function bindEvents() {
  els.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const email = els.email.value.trim();
    const password = els.password.value;

    if (!email || !password) {
      setLoginError("Enter your email and password.");
      return;
    }

    setLoginError("");
    setLoginLoading(true);

    try {
      await login(email, password);
      state.epoch += 1;
      state.authorized = true;
      showDashboard();
      startAutoRefresh();
      await loadDashboard({ resetPage: true });
    } catch (error) {
      setLoginError(
        error instanceof Error
          ? error.message
          : "Sign in failed. Check your credentials.",
      );
    } finally {
      setLoginLoading(false);
    }
  });

  els.togglePassword.addEventListener("click", () => {
    const showing = els.password.type === "text";
    els.password.type = showing ? "password" : "text";
    els.togglePassword.textContent = showing ? "Show" : "Hide";
    els.togglePassword.setAttribute(
      "aria-label",
      showing ? "Show password" : "Hide password",
    );
    els.password.focus();
  });

  els.refreshButton.addEventListener("click", () => loadDashboard());
  els.reloadButton.addEventListener("click", () => loadDashboard());
  els.retryButton.addEventListener("click", () => loadDashboard());

  els.logoutButton.addEventListener("click", signOut);
  els.unauthorizedLogoutButton.addEventListener("click", signOut);
  els.retryAccessButton.addEventListener("click", retryAccess);

  els.prevPage.addEventListener("click", () => {
    if (state.page <= 0) return;
    state.page -= 1;
    loadDashboard();
  });

  els.nextPage.addEventListener("click", () => {
    if ((state.page + 1) * PAGE_SIZE >= state.total) return;
    state.page += 1;
    loadDashboard();
  });

  document.addEventListener("visibilitychange", () => {
    if (
      document.visibilityState === "visible" &&
      state.authorized &&
      !state.loading &&
      Date.now() - state.lastLoadedAt > AUTO_REFRESH_MS
    ) {
      loadDashboard();
    }
  });

  window.addEventListener("storage", (event) => {
    if (event.key !== SESSION_KEY || event.newValue) return;

    stopAutoRefresh();
    state.session = null;
    state.authorized = false;
    showAuth();
  });
}

async function init() {
  bindEvents();

  const stored = readStoredSession();

  if (!stored) {
    showAuth();
    return;
  }

  state.session = stored;
  state.epoch += 1;
  state.authorized = true;
  showDashboard();
  startAutoRefresh();

  await loadDashboard({ resetPage: true });
}

document.addEventListener("DOMContentLoaded", init);
