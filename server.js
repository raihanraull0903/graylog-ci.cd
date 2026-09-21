const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

// ============================================
// CONFIG
// ============================================

const PORT = Number(process.env.PORT) || 3001;

const LIBRENMS_URL = (
  process.env.LIBRENMS_URL || "https://mon.as.net.id"
).replace(/\/+$/, "");

const LIBRENMS_TOKEN =
  process.env.LIBRENMS_TOKEN || "";

const LIBRENMS_TIMEOUT_MS =
  Number(process.env.LIBRENMS_TIMEOUT_MS) || 5000;

const PORT_ALIAS_NOT_CONFIGURED = "Port belum disetup";
const LIBRENMS_UNAVAILABLE = "LibreNMS unavailable";

const HISTORY_RETENTION_MS =
  24 * 60 * 60 * 1000;

// ============================================
// EXPRESS + SOCKET.IO
// ============================================

const app = express();

app.use(cors({ origin: "*" }));

app.use(express.json({ limit: "10mb" }));
app.use(express.text({
  type: ["text/*", "application/*"],
  limit: "10mb",
}));

app.use((req, _res, next) => {
  if (req.method === "POST") {
    console.log("");
    console.log("========== INCOMING POST ==========");
    console.log("Time   :", new Date().toISOString());
    console.log("From   :", req.ip);
    console.log("Path   :", req.originalUrl);
    console.log("===================================");
  }

  next();
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// ============================================
// IN-MEMORY STATE
// ============================================
//
// activePorts:
//   Current port-down state.
//
// lastEventAt:
//   Latest accepted Graylog event timestamp per
//   SOURCE::INTERFACE. Prevents delayed events
//   from reopening/clearing newer state.
//
// portHistory:
//   Last 24 hours of outage occurrences.
//
// LibreNMS remains the source of truth for the
// port description. We do NOT maintain a port
// inventory database/cache here.
//

const activePorts = new Map();
const lastEventAt = new Map();
const portHistory = new Map();

// ============================================
// GENERAL HELPERS
// ============================================

function normalize(value) {
  if (
    value === undefined ||
    value === null ||
    typeof value === "object"
  ) {
    return "";
  }

  return String(value).trim();
}

function makePortKey(source, interfaceName) {
  return [
    normalize(source).toLowerCase(),
    normalize(interfaceName).toLowerCase(),
  ].join("::");
}

function getNestedValue(obj, path) {
  let current = obj;

  for (const part of path.split(".")) {
    if (
      current === undefined ||
      current === null ||
      typeof current !== "object"
    ) {
      return undefined;
    }

    current = current[part];
  }

  return current;
}

function parseBody(body) {
  if (typeof body !== "string") {
    return body;
  }

  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function isValidTimestamp(timestamp) {
  return Number.isFinite(
    new Date(timestamp).getTime()
  );
}

// ============================================
// LIBRENMS PORT LOOKUP
// ============================================
//
// Only called when a new port-down event is
// accepted. A port-up event never needs a lookup.
//
// Result:
//   { status: "ok", alias: "..." }
//   { status: "unavailable", alias: "LibreNMS unavailable" }
//
// A successful LibreNMS response with an empty
// ifAlias, or an ifAlias equal to ifName, means
// the port description has not been configured.
//

async function lookupPortAlias(source, interfaceName) {
  if (!LIBRENMS_TOKEN) {
    console.error(
      "⚠️ LibreNMS lookup skipped: LIBRENMS_TOKEN is not configured"
    );

    return {
      status: "unavailable",
      alias: LIBRENMS_UNAVAILABLE,
    };
  }

  const url =
    `${LIBRENMS_URL}/api/v0/devices/` +
    `${encodeURIComponent(source)}/ports/` +
    `${encodeURIComponent(interfaceName)}`;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    LIBRENMS_TIMEOUT_MS
  );

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Auth-Token": LIBRENMS_TOKEN,
        "Accept": "application/json",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error(
        `⚠️ LibreNMS HTTP ${response.status} for ${source} ${interfaceName}`
      );

      return {
        status: "unavailable",
        alias: LIBRENMS_UNAVAILABLE,
      };
    }

    const data = await response.json();
    const port = data?.port;

    if (!port || typeof port !== "object") {
      console.error(
        `⚠️ LibreNMS returned no port object for ${source} ${interfaceName}`
      );

      return {
        status: "unavailable",
        alias: LIBRENMS_UNAVAILABLE,
      };
    }

    const ifName =
      normalize(port.ifName) ||
      normalize(interfaceName);

    const ifAlias =
      normalize(port.ifAlias);

    if (
      !ifAlias ||
      ifAlias.toLowerCase() === ifName.toLowerCase()
    ) {
      return {
        status: "ok",
        alias: PORT_ALIAS_NOT_CONFIGURED,
      };
    }

    return {
      status: "ok",
      alias: ifAlias,
    };
  } catch (error) {
    const reason =
      error?.name === "AbortError"
        ? `timeout after ${LIBRENMS_TIMEOUT_MS}ms`
        : error?.message || "unknown error";

    console.error(
      `⚠️ LibreNMS lookup failed for ${source} ${interfaceName}: ${reason}`
    );

    return {
      status: "unavailable",
      alias: LIBRENMS_UNAVAILABLE,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================
// HISTORY
// ============================================

function addHistoryDown(port) {
  const key = port.id;

  let history = portHistory.get(key);

  if (!history) {
    history = {
      id: key,
      source: port.source,
      interface: port.interface,
      port_alias: port.port_alias,
      occurrences: [],
    };

    portHistory.set(key, history);
  } else {
    // Keep the most recently resolved description.
    history.port_alias = port.port_alias;
  }

  const last =
    history.occurrences[
      history.occurrences.length - 1
    ];

  // Same outage; do not create another occurrence.
  if (last && !last.up_timestamp) {
    return;
  }

  history.occurrences.push({
    down_timestamp: port.timestamp,
    up_timestamp: null,
  });

  pruneHistory();
}

function addHistoryUp(port) {
  const history = portHistory.get(port.id);

  if (!history) {
    return;
  }

  const last =
    history.occurrences[
      history.occurrences.length - 1
    ];

  if (!last || last.up_timestamp) {
    return;
  }

  last.up_timestamp = port.timestamp;
  pruneHistory();
}

function pruneHistory() {
  const cutoff =
    Date.now() - HISTORY_RETENTION_MS;

  for (const [key, history] of portHistory) {
    history.occurrences =
      history.occurrences.filter((occurrence) => {
        const downTime =
          new Date(
            occurrence.down_timestamp
          ).getTime();

        const upTime =
          occurrence.up_timestamp
            ? new Date(
                occurrence.up_timestamp
              ).getTime()
            : Date.now();

        return (
          Math.max(downTime, upTime) >= cutoff
        );
      });

    if (history.occurrences.length === 0) {
      portHistory.delete(key);
      lastEventAt.delete(key);
    }
  }
}

function getPortHistory() {
  pruneHistory();

  return Array.from(portHistory.values())
    .map((history) => ({
      ...history,
      occurrences: [...history.occurrences].sort(
        (a, b) =>
          new Date(b.down_timestamp) -
          new Date(a.down_timestamp)
      ),
    }))
    .sort((a, b) => {
      const aTime =
        a.occurrences[0]
          ? new Date(
              a.occurrences[0].down_timestamp
            ).getTime()
          : 0;

      const bTime =
        b.occurrences[0]
          ? new Date(
              b.occurrences[0].down_timestamp
            ).getTime()
          : 0;

      return bTime - aTime;
    });
}

// ============================================
// GRAYLOG PAYLOAD PARSER
// ============================================
//
// Supports:
//   - top-level payload
//   - event
//   - alert
//   - events[]
//   - alerts[]
//   - backlog[]
//   - nested event.fields / fields
//
// Huawei values are read from custom fields:
//   event.fields.source
//   event.fields.interface
//
// Envelope metadata named `source` or `interface`
// is deliberately not preferred.
//

function extractPortAlerts(body) {
  const payload = parseBody(body);

  if (!payload || typeof payload !== "object") {
    return [];
  }

  const candidates = [];

  if (Array.isArray(payload.events)) {
    candidates.push(...payload.events);
  }

  if (Array.isArray(payload.alerts)) {
    candidates.push(...payload.alerts);
  }

  if (Array.isArray(payload.backlog)) {
    candidates.push(...payload.backlog);
  }

  if (
    payload.event &&
    typeof payload.event === "object"
  ) {
    candidates.push(payload.event);
  }

  if (
    payload.alert &&
    typeof payload.alert === "object"
  ) {
    candidates.push(payload.alert);
  }

  candidates.push(payload);

  function extractOne(candidate) {
    if (
      !candidate ||
      typeof candidate !== "object"
    ) {
      return null;
    }

    const event =
      candidate.event &&
      typeof candidate.event === "object"
        ? candidate.event
        : candidate;

    const fieldSets = [
      event.fields,
      candidate.fields,
    ].filter(
      (fields) =>
        fields &&
        typeof fields === "object"
    );

    function firstField(names) {
      for (const fields of fieldSets) {
        for (const name of names) {
          const value = fields[name];

          if (
            value !== undefined &&
            value !== null &&
            value !== ""
          ) {
            return value;
          }
        }
      }

      return undefined;
    }

    function firstPath(paths) {
      for (const path of paths) {
        const value =
          getNestedValue(candidate, path);

        if (
          value !== undefined &&
          value !== null &&
          value !== ""
        ) {
          return value;
        }
      }

      return undefined;
    }

    const eventType = normalize(
      firstField([
        "event_type",
        "eventType",
      ]) ||
      firstPath([
        "event_type",
        "event.event_type",
      ])
    ).toLowerCase();

    const source = normalize(
      firstField(["source"]) ||
      firstPath(["event.fields.source"])
    );

    const interfaceName = normalize(
      firstField(["interface"]) ||
      firstPath(["event.fields.interface"])
    );

    const timestamp =
      firstField(["timestamp"]) ||
      firstPath([
        "timestamp",
        "event.timestamp",
      ]) ||
      new Date().toISOString();

    const message = normalize(
      firstField(["message"]) ||
      firstPath([
        "message",
        "event.message",
      ])
    );

    const eventDefinition = normalize(
      firstPath([
        "event_definition_title",
        "event_definition.title",
        "event_definition.name",
        "event.event_definition_title",
      ])
    );

    const graylogEventId =
      event.id ||
      candidate.event_id ||
      candidate.id ||
      null;

    if (
      !eventType ||
      !source ||
      !interfaceName
    ) {
      return null;
    }

    return {
      event_type: eventType,
      source,
      interface: interfaceName,
      timestamp,
      message,
      event_definition: eventDefinition,
      graylog_event_id: graylogEventId,
      raw: candidate,
    };
  }

  const alerts = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const alert = extractOne(candidate);

    if (!alert) {
      continue;
    }

    const identity =
      alert.graylog_event_id ||
      [
        alert.event_type,
        alert.source,
        alert.interface,
        alert.timestamp,
      ].join("::");

    if (seen.has(identity)) {
      continue;
    }

    seen.add(identity);
    alerts.push(alert);
  }

  return alerts;
}

// ============================================
// SOCKET.IO
// ============================================

io.on("connection", (socket) => {
  console.log(
    "🔌 Dashboard connected:",
    socket.id
  );

  socket.emit(
    "port-state",
    Array.from(activePorts.values())
  );

  socket.emit(
    "port-history",
    getPortHistory()
  );

  socket.on("disconnect", () => {
    console.log(
      "❌ Dashboard disconnected:",
      socket.id
    );
  });
});

// ============================================
// API
// ============================================

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    active_ports: activePorts.size,
    librenms_configured: Boolean(
      LIBRENMS_TOKEN
    ),
  });
});

app.get("/port-alerts", (_req, res) => {
  res.json(
    Array.from(activePorts.values())
  );
});

app.get("/port-history", (_req, res) => {
  res.json(getPortHistory());
});

app.post("/port-debug", (req, res) => {
  console.log("");
  console.log("============================================");
  console.log("GRAYLOG PORT DEBUG");
  console.log("============================================");
  console.log(
    JSON.stringify(req.body, null, 2)
  );
  console.log("============================================");
  console.log("");

  res.json({
    ok: true,
    received: req.body,
  });
});

// ============================================
// GRAYLOG PORT ALERT WEBHOOK
// ============================================

app.post("/port-alert", async (req, res) => {
  const alerts = extractPortAlerts(req.body);

  console.log("");
  console.log("============================================");
  console.log("GRAYLOG PORT ALERT");
  console.log("============================================");
  console.log(
    `HTTP payload produced ${alerts.length} port alert(s)`
  );

  if (alerts.length === 0) {
    console.log(
      "⚠️ No usable port alert found in payload"
    );
    console.log("============================================");

    return res.status(200).json({
      ok: true,
      ignored: true,
      alerts_processed: 0,
    });
  }

  let processed = 0;

  for (const port of alerts) {
    console.log("");
    console.log(
      `Event type : ${port.event_type}`
    );
    console.log(
      `Source     : ${port.source}`
    );
    console.log(
      `Interface  : ${port.interface}`
    );
    console.log(
      `Timestamp  : ${port.timestamp}`
    );
    console.log(
      `Definition : ${port.event_definition}`
    );

    const key = makePortKey(
      port.source,
      port.interface
    );

    if (!isValidTimestamp(port.timestamp)) {
      console.log(
        `⚠️ Invalid event timestamp; ignoring ${key}`
      );
      continue;
    }

    const eventTime =
      new Date(port.timestamp).getTime();

    const previousEventTime =
      lastEventAt.get(key);

    if (
      previousEventTime !== undefined &&
      eventTime < previousEventTime
    ) {
      console.log(
        `⚠️ STALE EVENT IGNORED: ${port.event_type} ${port.source} ${port.interface}`
      );
      console.log(
        `Previous event time: ${new Date(
          previousEventTime
        ).toISOString()}`
      );
      console.log(
        `Incoming event time: ${new Date(
          eventTime
        ).toISOString()}`
      );
      continue;
    }

    // ------------------------------------------
    // PORT DOWN
    // ------------------------------------------

    if (port.event_type === "port_down") {
      const alreadyDown =
        activePorts.has(key);

      // Duplicate DOWN while already active:
      // do not hit LibreNMS again.
      if (alreadyDown) {
        lastEventAt.set(key, eventTime);
        processed++;

        console.log(
          `⚠️ DUPLICATE PORT DOWN: ${port.source} ${port.interface}`
        );

        continue;
      }

      // Mark the event before the asynchronous
      // LibreNMS request. This prevents a concurrent
      // PORT UP from being overwritten when the lookup
      // finishes later.
      lastEventAt.set(key, eventTime);

      // Only a NEW outage performs the LibreNMS
      // lookup. LibreNMS remains the source of truth;
      // no local port inventory is maintained.
      const lookup =
        await lookupPortAlias(
          port.source,
          port.interface
        );

      // A newer event may have arrived while the
      // LibreNMS request was in flight. In that case,
      // discard this older DOWN result rather than
      // reopening a port that has already recovered.
      const latestEventTime =
        lastEventAt.get(key);

      if (
        latestEventTime !== undefined &&
        latestEventTime > eventTime
      ) {
        console.log(
          `⚠️ DOWN RESULT DISCARDED: newer event already accepted for ${key}`
        );
        continue;
      }

      // Another identical DOWN may have completed
      // while this lookup was in flight. Keep the
      // first accepted active record.
      if (activePorts.has(key)) {
        processed++;

        console.log(
          `⚠️ DUPLICATE PORT DOWN AFTER LOOKUP: ${port.source} ${port.interface}`
        );

        continue;
      }

      const portAlert = {
        id: key,
        event_type: port.event_type,
        source: port.source,
        interface: port.interface,
        port_alias: lookup.alias,
        timestamp: port.timestamp,
        message: port.message,
        event_definition: port.event_definition,
        graylog_event_id: port.graylog_event_id,
        received_at: new Date().toISOString(),
      };

      processed++;

      activePorts.set(
        key,
        portAlert
      );

      addHistoryDown(portAlert);

      io.emit(
        "port-down",
        portAlert
      );

      io.emit(
        "port-state",
        Array.from(activePorts.values())
      );

      io.emit(
        "port-history",
        getPortHistory()
      );

      console.log(
        `🔴 PORT DOWN: ${port.source} ${port.interface}`
      );
      console.log(
        `Port alias : ${portAlert.port_alias}`
      );
      console.log(
        `Active ports: ${activePorts.size}`
      );

      continue;
    }

    // ------------------------------------------
    // PORT UP
    // ------------------------------------------

    if (port.event_type === "port_up") {
      const existing =
        activePorts.get(key);

      activePorts.delete(key);
      lastEventAt.set(key, eventTime);
      processed++;

      if (existing) {
        addHistoryUp({
          id: key,
          source: port.source,
          interface: port.interface,
          timestamp: port.timestamp,
        });

        console.log(
          `🟢 PORT UP: ${port.source} ${port.interface}`
        );
        console.log(
          "Removed from active alerts: true"
        );
      } else {
        console.log(
          `🟢 PORT UP: ${port.source} ${port.interface}`
        );
        console.log(
          "Removed from active alerts: false"
        );
      }

      // The frontend can safely remove the card
      // even if Node/React were temporarily out
      // of sync.
      io.emit("port-up", {
        id: key,
        source: port.source,
        interface: port.interface,
        timestamp: port.timestamp,
      });

      io.emit(
        "port-state",
        Array.from(activePorts.values())
      );

      io.emit(
        "port-history",
        getPortHistory()
      );

      console.log(
        `Active ports: ${activePorts.size}`
      );

      continue;
    }

    // ------------------------------------------
    // UNKNOWN EVENT
    // ------------------------------------------

    console.log(
      `⚠️ Unknown event type: ${port.event_type}`
    );
  }

  console.log("");
  console.log(
    `Processed alerts: ${processed}/${alerts.length}`
  );
  console.log("============================================");
  console.log("");

  res.status(200).json({
    ok: true,
    alerts_received: alerts.length,
    alerts_processed: processed,
    active_ports: activePorts.size,
  });
});

// ============================================
// MANUAL CLEANUP
// ============================================

app.delete("/port-alerts/cleanup", (_req, res) => {
  const count = activePorts.size;

  activePorts.clear();
  lastEventAt.clear();

  io.emit("port-state", []);

  console.log(
    `🧹 Cleared ${count} active port alerts`
  );

  res.json({
    ok: true,
    deleted: count,
  });
});

// ============================================
// TEST ENDPOINTS
// ============================================

app.post("/test/port-down", async (req, res) => {
  const source =
    normalize(req.body?.source) ||
    "SW-TEST-HUWE";

  const interfaceName =
    normalize(req.body?.interface) ||
    "GigabitEthernet0/2/5";

  const now =
    new Date().toISOString();

  const key = makePortKey(
    source,
    interfaceName
  );

  const alreadyDown =
    activePorts.has(key);

  if (alreadyDown) {
    return res.json({
      ok: true,
      already_down: true,
      port: activePorts.get(key),
      history: getPortHistory(),
    });
  }

  const lookup =
    await lookupPortAlias(
      source,
      interfaceName
    );

  const portAlert = {
    id: key,
    event_type: "port_down",
    source,
    interface: interfaceName,
    port_alias: lookup.alias,
    timestamp: now,
    message: "TEST PORT DOWN",
    event_definition: "Test Port Down",
    received_at: now,
  };

  activePorts.set(
    key,
    portAlert
  );

  lastEventAt.set(
    key,
    new Date(now).getTime()
  );

  addHistoryDown(portAlert);

  io.emit(
    "port-down",
    portAlert
  );

  io.emit(
    "port-state",
    Array.from(activePorts.values())
  );

  io.emit(
    "port-history",
    getPortHistory()
  );

  console.log(
    `🔴 TEST PORT DOWN: ${source} ${interfaceName}`
  );
  console.log(
    `Port alias : ${portAlert.port_alias}`
  );

  res.json({
    ok: true,
    already_down: false,
    port: portAlert,
    history: getPortHistory(),
  });
});

app.post("/test/port-up", (req, res) => {
  const source =
    normalize(req.body?.source) ||
    "SW-TEST-HUWE";

  const interfaceName =
    normalize(req.body?.interface) ||
    "GigabitEthernet0/2/5";

  const now =
    new Date().toISOString();

  const key = makePortKey(
    source,
    interfaceName
  );

  const existing =
    activePorts.get(key);

  activePorts.delete(key);

  lastEventAt.set(
    key,
    new Date(now).getTime()
  );

  if (existing) {
    addHistoryUp({
      id: key,
      source,
      interface: interfaceName,
      timestamp: now,
    });
  }

  io.emit("port-up", {
    id: key,
    source,
    interface: interfaceName,
    timestamp: now,
  });

  io.emit(
    "port-state",
    Array.from(activePorts.values())
  );

  io.emit(
    "port-history",
    getPortHistory()
  );

  console.log(
    `🟢 TEST PORT UP: ${source} ${interfaceName}`
  );
  console.log(
    `Removed from active alerts: ${Boolean(existing)}`
  );
  console.log(
    `Active ports: ${activePorts.size}`
  );

  res.json({
    ok: true,
    removed: Boolean(existing),
    history: getPortHistory(),
  });
});

// ============================================
// HISTORY CLEANUP
// ============================================
//
// Runs once per minute. Unref keeps this timer from
// preventing a clean Node process shutdown in scripts.
//

const historyCleanupTimer = setInterval(() => {
  const before =
    JSON.stringify(getPortHistory());

  pruneHistory();

  const after =
    JSON.stringify(getPortHistory());

  if (before !== after) {
    io.emit(
      "port-history",
      getPortHistory()
    );
  }
}, 60 * 1000);

historyCleanupTimer.unref();

// ============================================
// START
// ============================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log("");
    console.log("============================================");
    console.log("🚀 Graylog Port Alert Backend");
    console.log("============================================");
    console.log(`Port: ${PORT}`);
    console.log(
      `LibreNMS: ${LIBRENMS_URL}`
    );
    console.log(
      `LibreNMS token configured: ${Boolean(
        LIBRENMS_TOKEN
      )}`
    );
    console.log(
      `LibreNMS timeout: ${LIBRENMS_TIMEOUT_MS}ms`
    );
    console.log("");
    console.log(
      `Health:      http://0.0.0.0:${PORT}/health`
    );
    console.log(
      `Port alerts: http://0.0.0.0:${PORT}/port-alerts`
    );
    console.log(
      `History:     http://0.0.0.0:${PORT}/port-history`
    );
    console.log(
      `Debug:       POST /port-debug`
    );
    console.log(
      `Webhook:     POST /port-alert`
    );
    console.log("============================================");
    console.log("");
  }
);
