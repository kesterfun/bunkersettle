import { useEffect, useMemo, useState } from "react";
import "./MarketPanel.css";

/* MPA "Bunker Sales Breakdown, Monthly" on data.gov.sg. Values are thousand tonnes by bunker type
   (the metadata says "tonnes", but monthly totals of ~4,700 only match Singapore's ~4.7 Mt/month in thousands). */
const RESOURCE_ID = "d_4f5abbf4486bf8e52bbed3be56dde562";
const API = "https://data.gov.sg/api/action/datastore_search";
const PAGE_SIZE = 5000;
const UNIT = "thousand tonnes";
const WINDOW_MONTHS = 36;
const TABLE_MONTHS = 12;

interface SalesRecord {
  month: string;
  bunker_type: string;
  bunker_sales: number;
}

interface SavedFile {
  fetchedAt: string;
  source: string;
  records: SalesRecord[];
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; records: SalesRecord[]; source: { kind: "live" } | { kind: "saved"; fetchedAt: string } };

/** Main grades shown as optional lines and table columns. The total always includes every type. */
const GRADES: { type: string; label: string; colour: string }[] = [
  { type: "Marine Diesel Oil", label: "MDO", colour: "var(--green)" },
  { type: "Marine Gas Oil", label: "MGO", colour: "var(--yellow-dark)" },
  { type: "Marine Fuel Oil", label: "MFO", colour: "var(--red)" },
  { type: "Low Sulphur Fuel Oil", label: "LSFO", colour: "var(--blue)" },
  { type: "Ultra Low Sulphur Fuel Oil", label: "ULSFO", colour: "var(--magenta)" },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthLabel(month: string): string {
  const [y, m] = month.split("-");
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

function fmtTonnes(v: number): string {
  return Math.round(v).toLocaleString("en-US");
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** Live API returns bunker_sales as strings; the saved file already holds numbers. */
function parseRecords(raw: { month: string; bunker_type: string; bunker_sales: string | number }[]): SalesRecord[] {
  return raw.map((r) => ({ month: r.month, bunker_type: r.bunker_type, bunker_sales: Number(r.bunker_sales) }));
}

/** Tries the data.gov.sg API from the browser. Throws if CORS or the network blocks it. */
async function fetchLive(signal: AbortSignal): Promise<SalesRecord[]> {
  const out: SalesRecord[] = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const url = `${API}?resource_id=${RESOURCE_ID}&limit=${PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!body.success) throw new Error("API reported failure");
    total = body.result.total;
    if (body.result.records.length === 0) break;
    out.push(...parseRecords(body.result.records));
    offset += body.result.records.length;
  }
  return out;
}

async function fetchSaved(signal: AbortSignal): Promise<SavedFile> {
  const res = await fetch(`${import.meta.env.BASE_URL}bunker-sales.json`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SavedFile;
}

interface MonthRow {
  month: string;
  total: number;
  byType: Map<string, number>;
}

function toMonths(records: SalesRecord[]): MonthRow[] {
  const map = new Map<string, MonthRow>();
  for (const r of records) {
    let row = map.get(r.month);
    if (!row) {
      row = { month: r.month, total: 0, byType: new Map() };
      map.set(r.month, row);
    }
    row.total += r.bunker_sales;
    row.byType.set(r.bunker_type, (row.byType.get(r.bunker_type) ?? 0) + r.bunker_sales);
  }
  return [...map.values()].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
}

/** A round step so that the axis has about five intervals. */
function niceStep(max: number): number {
  const raw = max / 5;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * mag >= raw) return m * mag;
  }
  return 10 * mag;
}

const W = 920;
const H = 360;
const PAD = { l: 92, r: 28, t: 40, b: 40 };

function LineChart({ rows, showGrades }: { rows: MonthRow[]; showGrades: string[] }) {
  const max = Math.max(...rows.map((r) => r.total), 1);
  const step = niceStep(max);
  const yMax = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= yMax + step / 2; v += step) ticks.push(v);

  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (rows.length === 1 ? plotW / 2 : (i / (rows.length - 1)) * plotW);
  const y = (v: number) => PAD.t + plotH * (1 - v / yMax);
  const path = (vals: number[]) =>
    vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

  const last = rows.length - 1;
  const xLabels = rows.map((r, i) => ({ i, month: r.month })).filter((r) => /-(01|07)$/.test(r.month));
  const grades = GRADES.filter((g) => showGrades.includes(g.type));

  return (
    <svg
      className="mp-chart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Monthly total bunker sales in ${UNIT}, last ${rows.length} months`}
    >
      {ticks.map((t) => (
        <g key={t}>
          <line className="mp-grid" x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />
          <text className="mp-axis" x={PAD.l - 10} y={y(t)} textAnchor="end" dominantBaseline="middle">
            {fmtTonnes(t)}
          </text>
        </g>
      ))}
      <text className="mp-unit" x={PAD.l} y={16} textAnchor="start">
        {UNIT}
      </text>
      {xLabels.map((l) => (
        <text key={l.i} className="mp-axis" x={x(l.i)} y={H - PAD.b + 22} textAnchor="middle">
          {monthLabel(l.month)}
        </text>
      ))}
      {grades.map((g) => (
        <path
          key={g.type}
          className="mp-grade-line"
          d={path(rows.map((r) => r.byType.get(g.type) ?? 0))}
          stroke={g.colour}
        />
      ))}
      <path className="mp-total-line" d={path(rows.map((r) => r.total))} />
      <circle className="mp-latest-dot" cx={x(last)} cy={y(rows[last].total)} r={6} />
      <text className="mp-latest-label" x={x(last)} y={y(rows[last].total) - 14} textAnchor="end">
        {fmtTonnes(rows[last].total)}
      </text>
    </svg>
  );
}

export function MarketPanel() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [showGrades, setShowGrades] = useState<string[]>([]);

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const records = await fetchLive(ctrl.signal);
        if (!ctrl.signal.aborted) setState({ status: "ready", records, source: { kind: "live" } });
      } catch {
        if (ctrl.signal.aborted) return;
        try {
          const saved = await fetchSaved(ctrl.signal);
          if (!ctrl.signal.aborted) {
            setState({ status: "ready", records: saved.records, source: { kind: "saved", fetchedAt: saved.fetchedAt } });
          }
        } catch {
          if (!ctrl.signal.aborted) {
            setState({
              status: "error",
              message: "Could not load sales data. The live data.gov.sg request was blocked and the saved copy is missing.",
            });
          }
        }
      }
    })();
    return () => ctrl.abort();
  }, []);

  const months = useMemo(() => (state.status === "ready" ? toMonths(state.records) : []), [state]);
  const windowRows = months.slice(-WINDOW_MONTHS);
  const latest = windowRows[windowRows.length - 1];
  const yearAgo = months.length > 12 ? months[months.length - 13] : undefined;
  const tableRows = windowRows.slice(-TABLE_MONTHS).reverse();
  const shownGrades = GRADES.filter((g) => showGrades.includes(g.type));

  const sourceText =
    state.status === "loading"
      ? "Loading"
      : state.status === "error"
        ? "Unavailable"
        : state.source.kind === "live"
          ? "Live from data.gov.sg"
          : `Saved copy, fetched ${fmtDate(state.source.fetchedAt)}`;

  function toggleGrade(type: string) {
    setShowGrades((cur) => (cur.includes(type) ? cur.filter((t) => t !== type) : [...cur, type]));
  }

  return (
    <>
      <h1 className="page-title">
        Market
        <small>Singapore bunker sales by month, from MPA via data.gov.sg.</small>
      </h1>
      <section className="panel mp">
        <div className="panel-head">
          <span className="label">
            Monthly total, last {WINDOW_MONTHS} months ({UNIT})
          </span>
          <span className="mp-source mono">{sourceText}</span>
        </div>

        {state.status === "loading" && <div className="panel-body empty">Loading sales data...</div>}
        {state.status === "error" && <div className="panel-body empty">{state.message}</div>}

        {state.status === "ready" && latest && (
          <div className="panel-body">
            <div className="mp-summary">
              <div>
                <div className="label">Latest month: {monthLabel(latest.month)} (preliminary)</div>
                <div className="figure">
                  {fmtTonnes(latest.total)}
                  <span className="unit">{UNIT}</span>
                </div>
                {yearAgo && (
                  <div className="mp-yoy">
                    {latest.total >= yearAgo.total ? "+" : ""}
                    {(((latest.total - yearAgo.total) / yearAgo.total) * 100).toFixed(1)}% vs{" "}
                    {monthLabel(yearAgo.month)}
                  </div>
                )}
              </div>
              <div className="mp-toggles" role="group" aria-label="Optional grade lines">
                <span className="label">Show grades</span>
                <div className="mp-toggle-row">
                  {GRADES.map((g) => (
                    <button
                      key={g.type}
                      type="button"
                      className="toggle"
                      aria-pressed={showGrades.includes(g.type)}
                      onClick={() => toggleGrade(g.type)}
                      title={g.type}
                    >
                      {g.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="mp-chart-wrap">
              <LineChart rows={windowRows} showGrades={showGrades} />
            </div>

            <div className="table-wrap">
              <table className="data mp-table">
                <thead>
                  <tr>
                    <th>Month</th>
                    <th className="mp-num">Total ({UNIT})</th>
                    {shownGrades.map((g) => (
                      <th key={g.type} className="mp-num">
                        {g.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((r) => (
                    <tr key={r.month}>
                      <td className="mono">{monthLabel(r.month)}</td>
                      <td className="mono mp-num">{fmtTonnes(r.total)}</td>
                      {shownGrades.map((g) => (
                        <td key={g.type} className="mono mp-num">
                          {fmtTonnes(r.byType.get(g.type) ?? 0)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mp-note">
              Total covers every bunker type in the dataset, including bio-blended blends. The latest month is a preliminary
              estimate from MPA.
            </p>
          </div>
        )}
      </section>
    </>
  );
}
