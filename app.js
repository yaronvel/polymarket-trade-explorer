"use strict";

const GAMMA_API = "https://gamma-api.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";
const PAGE_SIZE = 500;
// The trades API rejects offsets above this; older trades are reached by moving the `end` cursor.
const MAX_OFFSET = 10000;
const HOUR = 3600;
const OUTCOME_COLORS = ["#2fbf71", "#e5484d"];

const $ = (id) => document.getElementById(id);

const state = {
  events: [],
  event: null,
  markets: [],
  market: null,
  records: [],
  range: null,
  abort: null,
};

// ---------- helpers ----------

function slugify(text) {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parsePolymarketUrl(text) {
  try {
    const url = new URL(text.trim());
    if (!url.hostname.endsWith("polymarket.com")) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    const i = parts.indexOf("event");
    if (i === -1 || !parts[i + 1]) return null;
    return { eventSlug: parts[i + 1], marketSlug: parts[i + 2] || null };
  } catch {
    return null;
  }
}

async function getJSON(base, path, params = {}, signal) {
  const url = new URL(path, base);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const resp = await fetch(url, { signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url.hostname}`);
      const data = await resp.json();
      if (data && !Array.isArray(data) && data.error) throw new Error(data.error);
      return data;
    } catch (err) {
      if (err.name === "AbortError") throw err;
      lastError = err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastError;
}

function setStatus(message, isError = false) {
  const el = $("status");
  el.hidden = !message;
  el.textContent = message || "";
  el.classList.toggle("error", isError);
}

function fmtUsd(v) {
  return "$" + Math.round(v).toLocaleString("en-US");
}

function fmtDate(ts) {
  return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16);
}

function dateToTs(value, endOfDay) {
  if (!value) return null;
  const ts = Date.parse(value + "T00:00:00Z") / 1000;
  return endOfDay ? ts + 86400 - 1 : ts;
}

function marketLabel(m) {
  return m.groupItemTitle || m.question;
}

function parseList(value) {
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value || "[]");
  } catch {
    return [];
  }
}

// ---------- event & market lookup ----------

async function fetchEventBySlug(slug) {
  const events = await getJSON(GAMMA_API, "/events", { slug });
  return events[0] || null;
}

async function searchEvents(query) {
  const fromUrl = parsePolymarketUrl(query);
  const exact = await fetchEventBySlug(fromUrl ? fromUrl.eventSlug : slugify(query));
  if (exact) return { events: [exact], marketSlug: fromUrl?.marketSlug ?? null };

  const result = await getJSON(GAMMA_API, "/public-search", { q: query, limit_per_type: 20 });
  const events = result.events || [];
  const wanted = query.trim().toLowerCase();
  events.sort((a, b) => (b.title.trim().toLowerCase() === wanted) - (a.title.trim().toLowerCase() === wanted));
  return { events, marketSlug: null };
}

async function onSearch(preselectMarket = null) {
  const query = $("eventQuery").value.trim();
  if (!query) return;
  setStatus("Searching events…");
  $("searchBtn").disabled = true;
  try {
    const { events, marketSlug } = await searchEvents(query);
    state.events = events;
    const select = $("eventSelect");
    select.innerHTML = "";
    if (!events.length) {
      select.innerHTML = "<option>No events found</option>";
      select.disabled = true;
      $("marketSelect").disabled = true;
      $("loadBtn").disabled = true;
      setStatus(`No Polymarket events found for “${query}”.`, true);
      return;
    }
    events.forEach((e, i) => {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = e.title + (e.closed ? " (closed)" : "");
      select.appendChild(opt);
    });
    select.disabled = false;
    await onEventSelected(preselectMarket ?? marketSlug);
    setStatus("");
  } catch (err) {
    setStatus(`Search failed: ${err.message}`, true);
  } finally {
    $("searchBtn").disabled = false;
  }
}

async function onEventSelected(preselectMarket = null) {
  const summary = state.events[Number($("eventSelect").value)];
  if (!summary) return;
  // Search results may omit markets; always load the full event.
  const event = summary.markets?.length && summary.markets[0].conditionId ? summary : await fetchEventBySlug(summary.slug);
  state.event = event;
  state.markets = (event?.markets || []).filter((m) => m.conditionId);

  const select = $("marketSelect");
  select.innerHTML = "";
  state.markets.forEach((m, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    const vol = Number(m.volume || 0);
    opt.textContent = `${marketLabel(m)}${m.closed ? " (closed)" : ""}${vol ? ` — ${fmtUsd(vol)} vol` : ""}`;
    select.appendChild(opt);
  });
  select.disabled = !state.markets.length;
  $("loadBtn").disabled = !state.markets.length;

  if (preselectMarket) {
    const wanted = slugify(preselectMarket);
    const idx = state.markets.findIndex(
      (m) => m.slug === preselectMarket || slugify(marketLabel(m)) === wanted || slugify(m.question) === wanted,
    );
    const partial = idx >= 0 ? idx : state.markets.findIndex((m) => slugify(marketLabel(m)).includes(wanted));
    if (partial >= 0) select.value = partial;
  }
}

// ---------- trades ----------

function tradeKey(t) {
  return [t.transactionHash, t.asset, t.side, t.proxyWallet, t.size, t.price, t.timestamp].join("|");
}

async function fetchAllTrades(conditionId, { start, end, takerOnly }, onProgress, signal) {
  const trades = [];
  let cursor = end ?? Math.floor(Date.now() / 1000);
  let offset = 0;
  // `end` is inclusive, so after moving the cursor the boundary-second trades come back again.
  let boundary = new Map();

  while (true) {
    const page = await getJSON(
      DATA_API,
      "/trades",
      { market: conditionId, limit: PAGE_SIZE, offset, takerOnly: String(takerOnly), end: cursor, start },
      signal,
    );
    if (!page.length) break;

    for (const t of page) {
      if (t.timestamp === cursor) {
        const k = tradeKey(t);
        const n = boundary.get(k) || 0;
        if (n > 0) {
          boundary.set(k, n - 1);
          continue;
        }
      }
      trades.push(t);
    }
    onProgress(trades.length, page[page.length - 1].timestamp);

    if (page.length < PAGE_SIZE) break;
    if (offset + PAGE_SIZE < MAX_OFFSET) {
      offset += PAGE_SIZE;
      continue;
    }
    const last = trades[trades.length - 1].timestamp;
    if (last === cursor) throw new Error(`More than ${MAX_OFFSET} trades share one timestamp; cannot page further`);
    cursor = last;
    offset = 0;
    boundary = new Map();
    for (const t of trades) {
      if (t.timestamp === cursor) boundary.set(tradeKey(t), (boundary.get(tradeKey(t)) || 0) + 1);
    }
  }
  return trades;
}

function toRecord(t) {
  const shares = Number(t.size);
  const price = Number(t.price);
  return {
    timestamp: t.timestamp,
    datetime_utc: new Date(t.timestamp * 1000).toISOString(),
    tx_hash: t.transactionHash,
    outcome: t.outcome,
    token_id: t.asset,
    side: t.side,
    shares,
    price,
    usdc_size: shares * price,
    wallet: t.proxyWallet,
    pseudonym: t.pseudonym || "",
  };
}

async function onLoad(ev) {
  ev?.preventDefault();
  const market = state.markets[Number($("marketSelect").value)];
  if (!market) return;

  const start = dateToTs($("fromDate").value, false);
  const end = dateToTs($("toDate").value, true);
  if (start !== null && end !== null && start > end) {
    setStatus("“From” must be before “To”.", true);
    return;
  }

  state.abort?.abort();
  const controller = new AbortController();
  state.abort = controller;
  $("loadBtn").disabled = true;
  $("cancelBtn").hidden = false;
  updateUrl();

  const takerOnly = !$("includeMakers").checked;
  try {
    const raw = await fetchAllTrades(
      market.conditionId,
      { start, end, takerOnly },
      (n, oldest) => setStatus(`Loading trades… ${n.toLocaleString()} so far (back to ${fmtDate(oldest)} UTC)`),
      controller.signal,
    );
    state.market = market;
    state.records = raw.map(toRecord).sort((a, b) => a.timestamp - b.timestamp);
    state.range = { start, end };
    setStatus(state.records.length ? "" : "No trades in this range.");
    render();
  } catch (err) {
    if (err.name === "AbortError") setStatus("Cancelled.");
    else setStatus(`Failed to load trades: ${err.message}`, true);
  } finally {
    $("loadBtn").disabled = false;
    $("cancelBtn").hidden = true;
    if (state.abort === controller) state.abort = null;
  }
}

// ---------- rendering ----------

function hourlySeries(records, rangeStart, rangeEnd) {
  const buckets = new Map();
  for (const r of records) {
    const h = Math.floor(r.timestamp / HOUR) * HOUR;
    const b = buckets.get(h) || { volume: 0, count: 0 };
    b.volume += r.usdc_size;
    b.count += 1;
    buckets.set(h, b);
  }
  const first = Math.floor(rangeStart / HOUR) * HOUR;
  const last = Math.floor(rangeEnd / HOUR) * HOUR;
  const x = [];
  const volume = [];
  const count = [];
  for (let h = first; h <= last; h += HOUR) {
    const b = buckets.get(h);
    x.push(new Date(h * 1000));
    volume.push(b ? b.volume : 0);
    count.push(b ? b.count : 0);
  }
  return { x, volume, count };
}

function baseLayout(title, yTitle, xRange) {
  return {
    title: { text: title, font: { size: 14 }, x: 0.02 },
    paper_bgcolor: "#171e2e",
    plot_bgcolor: "#171e2e",
    font: { color: "#e6e9f0", size: 11 },
    margin: { l: 60, r: 16, t: 40, b: 40 },
    xaxis: { type: "date", range: xRange, gridcolor: "#283149" },
    yaxis: { title: { text: yTitle }, gridcolor: "#283149", rangemode: "tozero" },
    bargap: 0,
    hovermode: "closest",
  };
}

const PLOT_CONFIG = { responsive: true, displaylogo: false };
let syncing = false;

function syncZoom(ids) {
  for (const id of ids) {
    const el = $(id);
    el.removeAllListeners?.("plotly_relayout");
    el.on("plotly_relayout", (e) => {
      if (syncing) return;
      const update = {};
      if (e["xaxis.range[0]"] !== undefined) {
        update["xaxis.range"] = [e["xaxis.range[0]"], e["xaxis.range[1]"]];
      } else if (e["xaxis.autorange"]) {
        update["xaxis.autorange"] = true;
      } else return;
      syncing = true;
      Promise.all(ids.filter((o) => o !== id).map((o) => Plotly.relayout(o, update))).finally(() => (syncing = false));
    });
  }
}

function render() {
  const market = state.market;
  const records = state.records;
  const outcomes = parseList(market.outcomes);
  const names = outcomes.length >= 2 ? outcomes.slice(0, 2) : ["Yes", "No"];

  $("results").hidden = false;
  $("marketTitle").textContent = market.question;
  const { start, end } = state.range;
  const rangeText =
    start || end
      ? `${start ? fmtDate(start).slice(0, 10) : "start"} → ${end ? fmtDate(end).slice(0, 10) : "now"}`
      : "full history";
  $("marketMeta").textContent =
    `${state.event.title} · ${marketLabel(market)} · ${rangeText} · ${records.length.toLocaleString()} trades` +
    ($("includeMakers").checked ? " (incl. maker records)" : "");

  const rangeStart = start ?? (records[0]?.timestamp || Date.now() / 1000);
  const rangeEnd = end ?? Math.max(records[records.length - 1]?.timestamp || 0, Math.floor(Date.now() / 1000));
  const xRange = [new Date(rangeStart * 1000), new Date(rangeEnd * 1000)];

  const summaryRows = [];
  const chartIds = [];

  names.forEach((name, col) => {
    const color = OUTCOME_COLORS[col];
    const rs = records.filter((r) => r.outcome === name);
    $(`colTitle${col}`).innerHTML = `<span style="color:${color}">${name}</span>`;

    const volume = rs.reduce((s, r) => s + r.usdc_size, 0);
    const shares = rs.reduce((s, r) => s + r.shares, 0);
    summaryRows.push({
      name,
      color,
      trades: rs.length,
      buys: rs.filter((r) => r.side === "BUY").length,
      sells: rs.filter((r) => r.side === "SELL").length,
      volume,
      vwap: shares ? volume / shares : null,
      first: rs[0]?.price,
      last: rs[rs.length - 1]?.price,
    });

    const priceId = `chart-${col}-price`;
    Plotly.react(
      priceId,
      [
        {
          type: "scattergl",
          mode: "markers",
          x: rs.map((r) => new Date(r.timestamp * 1000)),
          y: rs.map((r) => r.price),
          marker: { size: 4, color, opacity: 0.45 },
          customdata: rs.map((r) => [r.side, r.shares, r.usdc_size]),
          hovertemplate: "%{x|%Y-%m-%d %H:%M:%S}<br>price %{y:.3f}<br>%{customdata[0]} %{customdata[1]:,.2f} sh ($%{customdata[2]:,.2f})<extra></extra>",
        },
      ],
      { ...baseLayout(`${name} price`, "Price (USDC/share)", xRange), yaxis: { title: { text: "Price" }, range: [0, 1], gridcolor: "#283149" } },
      PLOT_CONFIG,
    );

    const hourly = hourlySeries(rs, rangeStart, rangeEnd);
    const volumeId = `chart-${col}-volume`;
    Plotly.react(
      volumeId,
      [
        {
          type: "bar",
          x: hourly.x,
          y: hourly.volume,
          marker: { color },
          hovertemplate: "%{x|%Y-%m-%d %H:00} UTC<br>$%{y:,.0f}<extra></extra>",
        },
      ],
      baseLayout(`${name} hourly volume (USDC)`, "USDC / hour", xRange),
      PLOT_CONFIG,
    );

    const countId = `chart-${col}-count`;
    Plotly.react(
      countId,
      [
        {
          type: "bar",
          x: hourly.x,
          y: hourly.count,
          marker: { color },
          hovertemplate: "%{x|%Y-%m-%d %H:00} UTC<br>%{y} trades<extra></extra>",
        },
      ],
      baseLayout(`${name} hourly trades`, "Trades / hour", xRange),
      PLOT_CONFIG,
    );

    chartIds.push(priceId, volumeId, countId);
  });

  syncZoom(chartIds);
  renderSummary(summaryRows);
}

function renderSummary(rows) {
  const p = (v) => (v === null || v === undefined ? "—" : v.toFixed(3));
  $("summary").innerHTML =
    "<tr><th>Outcome</th><th>Trades</th><th>Buys</th><th>Sells</th><th>Volume (USDC)</th><th>VWAP</th><th>First price</th><th>Last price</th></tr>" +
    rows
      .map(
        (r) =>
          `<tr><td style="color:${r.color};font-weight:600">${r.name}</td><td>${r.trades.toLocaleString()}</td>` +
          `<td>${r.buys.toLocaleString()}</td><td>${r.sells.toLocaleString()}</td><td>${fmtUsd(r.volume)}</td>` +
          `<td>${p(r.vwap)}</td><td>${p(r.first)}</td><td>${p(r.last)}</td></tr>`,
      )
      .join("");
}

// ---------- CSV, URL state ----------

function downloadCsv() {
  if (!state.records.length) return;
  const cols = Object.keys(state.records[0]);
  const escape = (v) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(","), ...state.records.map((r) => cols.map((c) => escape(r[c])).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `trades_${slugify(marketLabel(state.market))}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function updateUrl() {
  const params = new URLSearchParams();
  const event = state.events[Number($("eventSelect").value)];
  const market = state.markets[Number($("marketSelect").value)];
  if (event) params.set("event", event.slug);
  if (market) params.set("market", marketLabel(market));
  if ($("fromDate").value) params.set("from", $("fromDate").value);
  if ($("toDate").value) params.set("to", $("toDate").value);
  if ($("includeMakers").checked) params.set("makers", "1");
  history.replaceState(null, "", `${location.pathname}?${params}`);
}

async function loadFromUrl() {
  const params = new URLSearchParams(location.search);
  const event = params.get("event");
  if (!event) return;
  $("eventQuery").value = event;
  $("fromDate").value = params.get("from") || "";
  $("toDate").value = params.get("to") || "";
  $("includeMakers").checked = params.get("makers") === "1";
  await onSearch(params.get("market"));
  if (state.markets.length) await onLoad();
}

// ---------- wiring ----------

$("searchBtn").addEventListener("click", () => onSearch());
$("eventQuery").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    onSearch();
  }
});
$("eventSelect").addEventListener("change", () => onEventSelected());
$("form").addEventListener("submit", onLoad);
$("cancelBtn").addEventListener("click", () => state.abort?.abort());
$("csvBtn").addEventListener("click", downloadCsv);
$("copyLinkBtn").addEventListener("click", async () => {
  updateUrl();
  await navigator.clipboard.writeText(location.href);
  $("copyLinkBtn").textContent = "Copied!";
  setTimeout(() => ($("copyLinkBtn").textContent = "Copy link"), 1500);
});

loadFromUrl();
