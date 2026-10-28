/**
 * Downloads the MPA "Bunker Sales Breakdown, Monthly" dataset (data.gov.sg, datastore_search)
 * and saves every record to ui/public/bunker-sales.json as { fetchedAt, source, records }.
 * Used because data.gov.sg does not send Access-Control-Allow-Origin, so the browser cannot
 * call the API directly. Units: thousand tonnes (see docs/DECISIONS.md). Run from the project root: npm run fetch-sales
 */
import * as fs from "fs";
import * as path from "path";

const RESOURCE_ID = "d_4f5abbf4486bf8e52bbed3be56dde562";
const API = "https://data.gov.sg/api/action/datastore_search";
const PAGE_SIZE = 5000;
const OUT_FILE = path.join(__dirname, "..", "ui", "public", "bunker-sales.json");

interface ApiRecord {
  _id: number;
  month: string;
  bunker_type: string;
  bunker_sales: string;
}

interface ApiResponse {
  success: boolean;
  result: { records: ApiRecord[]; total: number };
}

interface SalesRecord {
  month: string;
  bunker_type: string;
  bunker_sales: number;
}

async function fetchPage(offset: number): Promise<ApiResponse["result"]> {
  const url = `${API}?resource_id=${RESOURCE_ID}&limit=${PAGE_SIZE}&offset=${offset}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} at offset ${offset}`);
  const body = (await res.json()) as ApiResponse;
  if (!body.success) throw new Error(`API returned success=false at offset ${offset}`);
  return body.result;
}

async function main(): Promise<void> {
  const records: SalesRecord[] = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const page = await fetchPage(offset);
    total = page.total;
    if (page.records.length === 0) break;
    for (const r of page.records) {
      const value = Number(r.bunker_sales);
      if (!/^\d{4}-\d{2}$/.test(r.month) || Number.isNaN(value)) {
        throw new Error(`Unexpected record ${r._id}: ${JSON.stringify(r)}`);
      }
      records.push({ month: r.month, bunker_type: r.bunker_type, bunker_sales: value });
    }
    offset += page.records.length;
    console.log(`Fetched ${offset} of ${total}`);
  }
  if (records.length !== total) {
    throw new Error(`Expected ${total} records, got ${records.length}`);
  }

  const out = {
    fetchedAt: new Date().toISOString(),
    source: `data.gov.sg dataset ${RESOURCE_ID} (Bunker Sales Breakdown, Monthly, MPA). Unit: thousand tonnes.`,
    records,
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));
  console.log(`Wrote ${records.length} records to ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
