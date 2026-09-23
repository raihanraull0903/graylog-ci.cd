import { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

// ============================================
// CONFIG
// ============================================
const BACKEND = "";
const HISTORY_VISIBLE_COUNT = 7;
const CLOCK_TICK_MS = 1000;

// ============================================
// HELPERS
// ============================================

function formatClockTime(date) {
  return date ? date.toLocaleTimeString([], { hour12: false }) : "—";
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

// Duration bucket drives the color of a badge — short outages read as
// routine blips, long ones read as the thing that needs attention.
function durationSeverity(seconds) {
  if (seconds == null) return "ongoing";
  if (seconds < 60) return "short";
  if (seconds < 600) return "medium";
  return "long";
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ============================================
// MAIN APP
// ============================================

export default function App() {
  const [ports, setPorts] = useState([]);
  const [history, setHistory] = useState([]);
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [expandedHistory, setExpandedHistory] = useState({});
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  // ==========================================
  // LIVE CLOCK — drives active-outage timers
  // ==========================================

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(tick);
  }, []);

  // ==========================================
  // INITIAL DATA
  // ==========================================

  useEffect(() => {
    let cancelled = false;

    async function loadInitialData() {
      const [alertsResult, historyResult] = await Promise.allSettled([
        fetch(`${BACKEND}/port-alerts`),
        fetch(`${BACKEND}/port-history`),
      ]);

      if (cancelled) return;

      if (alertsResult.status === "fulfilled" && alertsResult.value.ok) {
        try {
          const data = await alertsResult.value.json();
          setPorts(Array.isArray(data) ? data : []);
          setLastUpdate(new Date());
        } catch (err) {
          console.error("Initial port alert JSON parse failed:", err);
        }
      } else if (alertsResult.status === "rejected") {
        console.error("Initial port alert fetch failed:", alertsResult.reason);
      }

      if (historyResult.status === "fulfilled" && historyResult.value.ok) {
        try {
          const data = await historyResult.value.json();
          setHistory(Array.isArray(data) ? data : []);
        } catch (err) {
          console.error("Initial port history JSON parse failed:", err);
        }
      } else if (historyResult.status === "rejected") {
        console.error("Initial port history fetch failed:", historyResult.reason);
      }

      if (!cancelled) setLoading(false);
    }

    loadInitialData();

    return () => {
      cancelled = true;
    };
  }, []);

  // ==========================================
  // SOCKET.IO
  // ==========================================

  useEffect(() => {
    const socket = io(BACKEND, {
      transports: ["websocket", "polling"],
      reconnection: true,
    });

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));

    socket.on("port-state", (data) => {
      setPorts(Array.isArray(data) ? data : []);
      setLastUpdate(new Date());
      setLoading(false);
    });

    socket.on("port-down", (port) => {
      setPorts((current) => {
        const exists = current.some((item) => item.id === port.id);
        if (exists) {
          return current.map((item) => (item.id === port.id ? port : item));
        }
        return [port, ...current];
      });
      setLastUpdate(new Date());
    });

    socket.on("port-up", (port) => {
      setPorts((current) => current.filter((item) => item.id !== port.id));
      setLastUpdate(new Date());
    });

    socket.on("port-history", (data) => {
      setHistory(Array.isArray(data) ? data : []);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  // ==========================================
  // DERIVED DATA
  // ==========================================

  const sortedPorts = useMemo(
    () =>
      [...ports].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)),
    [ports]
  );

  const longestActiveSeconds = useMemo(() => {
    if (ports.length === 0) return 0;
    return Math.max(
      ...ports.map((port) => {
        const down = safeDate(port.timestamp);
        return down ? (now - down.getTime()) / 1000 : 0;
      })
    );
  }, [ports, now]);

  const outagesToday = useMemo(
    () =>
      history.reduce(
        (sum, item) =>
          sum + (Array.isArray(item.occurrences) ? item.occurrences.length : 0),
        0
      ),
    [history]
  );

  // Reflect alert count in the browser tab — useful when this is left
  // open in a background tab on a NOC workstation.
  useEffect(() => {
    document.title =
      ports.length > 0
        ? `(${ports.length}) Port Alert Monitor`
        : "Port Alert Monitor";
  }, [ports.length]);

  // ==========================================
  // RENDER
  // ==========================================

  return (
    <div className="app">
      {!connected && (
        <div className="connection-banner" role="alert">
          <span className="connection-banner-dot" aria-hidden="true" />
          Connection to the monitoring server was lost — attempting to reconnect…
        </div>
      )}

      <span className="sr-only" role="status" aria-live="polite">
        {ports.length === 0
          ? "All monitored ports are up."
          : `${ports.length} port${ports.length === 1 ? "" : "s"} currently down.`}
      </span>

      <header className="header">
        <div className="header-title">
          <span className="header-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="3" y="4" width="18" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
              <rect x="3" y="14" width="18" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
              <circle cx="7" cy="7" r="1" fill="currentColor" />
              <circle cx="7" cy="17" r="1" fill="currentColor" />
            </svg>
          </span>
          <div>
            <h1>Port Alert Monitor Test</h1>
            <p>Monitored via Graylog | {__APP_VERSION__}</p>
          </div>
        </div>

        <div className="header-meta">
          <span className={connected ? "status-pill online" : "status-pill offline"}>
            <span className="status-dot" aria-hidden="true" />
            {connected ? "Connected" : "Disconnected"}
          </span>
          <span className="header-updated">
            Last updated {formatClockTime(new Date(now))}
          </span>
        </div>
      </header>

      <section className="stats" aria-label="Alert summary">
        <div className={`stat-card ${ports.length > 0 ? "stat-critical" : ""}`}>
          <div className="stat-number">{ports.length}</div>
          <div className="stat-label">Active alerts</div>
        </div>

        <div className={`stat-card ${ports.length > 0 ? severityStatClass(longestActiveSeconds) : ""}`}>
          <div className="stat-number stat-number-mono">
            {ports.length > 0 ? formatDuration(longestActiveSeconds) : "—"}
          </div>
          <div className="stat-label">Longest active outage</div>
        </div>

        <div className="stat-card">
          <div className="stat-number">{outagesToday}</div>
          <div className="stat-label">Outages, last 24h</div>
        </div>
      </section>

      <main className="content">
        {loading ? (
          <div className="port-grid">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        ) : sortedPorts.length === 0 ? (
          <div className="empty">
            <div className="empty-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <h2>All ports are up</h2>
            <p>No active alerts. New port-down events will appear here in real time.</p>
          </div>
        ) : (
          <div className="port-grid">
            {sortedPorts.map((port) => (
              <PortCard key={port.id} port={port} now={now} />
            ))}
          </div>
        )}
      </main>

      <section className="history-section">
        <div className="history-title-row">
          <div>
            <h2>Outage history</h2>
            <p>Down / up events from the last 24 hours</p>
          </div>
        </div>

        {history.length === 0 ? (
          <div className="history-empty">No port outages recorded in the last 24 hours.</div>
        ) : (
          <div className="history-grid">
            {history.map((item) => (
              <PortHistoryCard
                key={item.id}
                history={item}
                now={now}
                expanded={Boolean(expandedHistory[item.id])}
                onToggle={() =>
                  setExpandedHistory((current) => ({
                    ...current,
                    [item.id]: !current[item.id],
                  }))
                }
              />
            ))}
          </div>
        )}
      </section>

      <footer></footer>
    </div>
  );
}

function severityStatClass(seconds) {
  const severity = durationSeverity(seconds);
  if (severity === "long") return "stat-critical";
  if (severity === "medium") return "stat-warning";
  return "";
}

// ============================================
// SMALL SHARED PIECES
// ============================================

function Field({ label, value, mono }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      <div className={mono ? "field-value field-value-mono" : "field-value"}>
        {value || "—"}
      </div>
    </div>
  );
}

function DurationBadge({ seconds, ongoing }) {
  const severity = ongoing ? "ongoing" : durationSeverity(seconds);
  const label = ongoing ? "Still down" : formatDuration(seconds);
  return <span className={`duration-badge duration-${severity}`}>{label}</span>;
}

function SkeletonCard() {
  return (
    <div className="port-card port-card-skeleton" aria-hidden="true">
      <div className="skeleton-line skeleton-w-40" />
      <div className="skeleton-line skeleton-w-70" />
      <div className="skeleton-line skeleton-w-55" />
      <div className="skeleton-line skeleton-w-60" />
    </div>
  );
}

// ============================================
// ACTIVE PORT CARD
// ============================================

function PortCard({ port, now }) {
  const downSince = safeDate(port.timestamp);
  const downSeconds = downSince ? (now - downSince.getTime()) / 1000 : null;

  return (
    <article className="port-card">
      <div className="card-header">
        <span className="down-indicator">
          <span className="down-indicator-dot" aria-hidden="true" />
          Down
        </span>
        {downSeconds != null && <DurationBadge seconds={downSeconds} />}
      </div>

      <div className="card-identity">
        <div className="card-source">{port.source || "Unknown source"}</div>
        <div className="card-interface">{port.interface || "—"}</div>
      </div>

      <div className="card-fields">
        <Field label="Port description" value={port.port_alias || "LibreNMS unavailable"} />
        <Field label="Event" value={port.event_type || "port_down"} mono />
      </div>

      <div className="card-footer">Since {port.timestamp ? new Date(port.timestamp).toLocaleString() : "—"}</div>
    </article>
  );
}

// ============================================
// PORT HISTORY CARD
// ============================================

function PortHistoryCard({ history, expanded, onToggle, now }) {
  const occurrences = Array.isArray(history.occurrences) ? history.occurrences : [];
  const count = occurrences.length;

  const visibleOccurrences =
    expanded || count <= HISTORY_VISIBLE_COUNT
      ? occurrences
      : occurrences.slice(0, HISTORY_VISIBLE_COUNT);

  const hiddenCount = Math.max(0, count - HISTORY_VISIBLE_COUNT);
  const panelId = `history-panel-${history.id}`;

  return (
    <article className="history-card">
      <div className="history-card-header">
        <div>
          <div className="history-source">{history.source || "Unknown source"}</div>
          <div className="history-interface">{history.interface || "—"}</div>
          <div className="history-port-alias">{history.port_alias || "LibreNMS unavailable"}</div>
        </div>

        <div className="history-count">
          <span className="history-count-number">{count}</span>
          <span className="history-count-label">{count === 1 ? "outage" : "outages"}</span>
        </div>
      </div>

      <ol className="history-timeline" id={panelId}>
        {visibleOccurrences.map((occurrence, index) => {
          const down = safeDate(occurrence.down_timestamp);
          const up = safeDate(occurrence.up_timestamp);
          const ongoing = down && !up;
          const seconds =
            down && up ? (up.getTime() - down.getTime()) / 1000 :
            down && ongoing ? (now - down.getTime()) / 1000 : null;

          return (
            <li className="history-event" key={`${history.id}-${index}`}>
              <span className={`history-event-marker ${ongoing ? "marker-ongoing" : ""}`} aria-hidden="true" />
              <div className="history-event-body">
                <div className="history-event-times">
                  <span>
                    <span className="history-event-label">Down</span>
                    {down ? down.toLocaleString() : "—"}
                  </span>
                  <span>
                    <span className="history-event-label">{up ? "Up" : "Status"}</span>
                    {up ? up.toLocaleString() : "Still down"}
                  </span>
                </div>
              </div>
              {seconds != null && <DurationBadge seconds={seconds} ongoing={ongoing} />}
            </li>
          );
        })}
      </ol>

      {count > HISTORY_VISIBLE_COUNT && (
        <button
          type="button"
          className="history-more-button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={panelId}
        >
          {expanded ? "Show fewer outages" : `Show ${hiddenCount} more outage${hiddenCount === 1 ? "" : "s"}`}
          <svg
            className={`chevron ${expanded ? "chevron-up" : ""}`}
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </article>
  );
}
