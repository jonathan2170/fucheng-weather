// 氣候統計輸出（任務 A6／0-09；規格 3.4「氣候統計」）
//
// 呼叫氣象署 C-B0027-001（地面測站月平均資料，每 10 年更新）→ 轉成 {輸出資料夾}/v1/climate-normals.json。
// - 只在檔案不存在、讀不回來、或產生超過 7 天時才重抓；抓失敗、結構不符、數值不合理都保留上一版（fail closed，與縣市預報同規則）。
// - 轉換完用 App 端解析器（src/weather/climate-normals.ts）讀回驗證才寫入；寫入用暫存檔 + rename。
// - 回應結構已依 2026-11-15 的真實鍵名結構修正（#174；見 config.ts CLIMATE_FIELDS、FIELD-MAP.md）：資料期間在各要素裡，測站沒有經緯度。
// - 座標：氣候回應沒有；runClimate 另抓測站基本資料（C-B0074-001／-002，同一把授權碼）取得 StationID → 座標。呼叫端也可注入對照表（測試用）。
//   抓不到、格式不符、座標不在臺灣範圍 → fail closed，保留上一版。

import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseClimateNormals, parseClimateNormalsText, CLIMATE_NORMALS_FORMAT, type ClimateNormalsFile, type ClimateNormalsStation } from '../../src/weather/climate-normals.ts';
import { CLIMATE_DATASET_ID, CLIMATE_FIELDS as F, CLIMATE_MAXMIN_CONFIRMED, CLIMATE_FILE, CLIMATE_FORMAT, CLIMATE_MAX_CHARS, CLIMATE_REFRESH_MS, CLIMATE_SOURCE, OUTPUT_SUBDIR, STATION_DATASET_IDS, STATION_FIELDS as SF } from './config.ts';
import { PublisherError, showRaw, type FailureCategory } from './cwa.ts';
import { atomicWrite, fetchDataset, isUsableApiKey, redact, type FetchLike } from './publish.ts';

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (category: FailureCategory, message: string): never => {
  throw new PublisherError(category, message);
};

const SHAPE_MAX_DEPTH = 4;
const SHAPE_MAX_KEYS = 30;
const SHAPE_MAX_CHARS = 1500;

/** 鍵名保留原樣（含中文等 Unicode）；只有含非 [\w.-] 字元（空白、分隔符、引號、控制字元等）才以 JSON 字串編碼，所以不同鍵名不會互相混淆、也不會破壞輸出格式 */
const shapeKey = (k: string): string => {
  const cut = k.length > 40 ? k.slice(0, 40) : k;
  return /^[\w.-]+$/.test(cut) ? cut : JSON.stringify(cut);
};

/** 診斷用：只輸出鍵名與型別（深度 ≤ 4，陣列只看第一個元素），不輸出任何數值或字串內容 */
export function describeShape(v: unknown, depth = 0, maxDepth = SHAPE_MAX_DEPTH): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length === 0 ? '[]' : depth >= maxDepth ? '[…]' : `[${describeShape(v[0], depth + 1, maxDepth)}]`;
  if (typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>);
    if (depth >= maxDepth) return keys.length ? '{…}' : '{}';
    const shown = keys.slice(0, SHAPE_MAX_KEYS).map((k) => `${shapeKey(k)}:${describeShape((v as Record<string, unknown>)[k], depth + 1, maxDepth)}`);
    if (keys.length > SHAPE_MAX_KEYS) shown.push(`…(+${keys.length - SHAPE_MAX_KEYS})`);
    return `{${shown.join(',')}}`;
  }
  return typeof v;
}
const shapeOf = (v: unknown) => describeShape(v).slice(0, SHAPE_MAX_CHARS);

/** 整數欄位（年份、月份）：只收整數或純數字字串；null、布林、空字串、小數都拒絕，不做強制轉型 */
function intField(v: unknown): number {
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v === 'string' && /^\d{1,4}$/.test(v.trim())) return Number(v.trim());
  return NaN;
}

/** 數值欄位：缺值（"-"、空字串、null、-99 哨兵）回 null，其餘必須是有限數字 */
function value(v: unknown, where: string): number | null {
  if (v === null || v === undefined || v === '' || v === '-' || v === 'X') return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fail('format', `${where} 不是數字（原始值 ${showRaw(String(v))}）`);
  if (n <= -99) return null;
  return n;
}

export type StationCoordinates = ReadonlyMap<string, { lat: number; lon: number }>;

/** 座標欄位：數字或純小數字串；其他一律 NaN（之後由 convertClimate 的範圍檢查擋下，不猜） */
function coordField(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && /^-?\d{1,3}(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return NaN;
}

/**
 * 測站基本資料 → StationID → 座標。結構不符（找不到測站陣列、項目缺代碼、代碼重複、一站座標都讀不到）→ format 失敗並印鍵名結構。
 * 單一測站座標讀不出來時存成 NaN：只有它出現在氣候回應時才會被 convertClimate 的範圍檢查擋下（整份 range 失敗），不影響其他測站。
 */
export function convertStationList(raw: unknown, datasetId: string): Map<string, { lat: number; lon: number }> {
  if (!isRec(raw) || (raw.success !== 'true' && raw.success !== true)) return fail('format', `${datasetId} 的 success 不是 true`);
  if (!isRec(raw.records)) return fail('format', `${datasetId} 缺少 records；回應結構=${shapeOf(raw)}`);
  let node: unknown = raw.records;
  for (const key of SF.path) node = isRec(node) ? node[key] : undefined;
  if (!Array.isArray(node)) return fail('format', `${datasetId} 找不到測站清單；records 結構=${shapeOf(raw.records)}`);
  const out = new Map<string, { lat: number; lon: number }>();
  let usable = 0;
  for (const item of node as unknown[]) {
    if (!isRec(item)) return fail('format', `${datasetId} 的測站項目不是物件`);
    const id = item[SF.stationId];
    if (typeof id !== 'string' || !id.trim()) return fail('format', `${datasetId} 的測站項目缺少代碼；項目結構=${shapeOf(item)}`);
    if (out.has(id)) return fail('format', `${datasetId} 測站代碼重複：${id}`);
    const lat = coordField(item[SF.latitude]);
    const lon = coordField(item[SF.longitude]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) usable += 1;
    out.set(id, { lat, lon });
  }
  if (usable === 0) return fail('format', `${datasetId} 沒有任何讀得出經緯度的測站（欄位改名？）；項目結構=${shapeOf(node[0])}`);
  return out;
}

/** 抓兩份測站基本資料並合併；任一份失敗或兩份有重複代碼 → 失敗（不用不完整的清單） */
export async function fetchStationCoordinates(o: { apiKey: string; fetchImpl: FetchLike; sleep: (ms: number) => Promise<void> }): Promise<Map<string, { lat: number; lon: number }>> {
  const all = new Map<string, { lat: number; lon: number }>();
  for (const id of STATION_DATASET_IDS) {
    const one = convertStationList(await fetchDataset(id, o), id);
    for (const [k, v] of one) {
      if (all.has(k)) return fail('format', `測站基本資料跨資料集代碼重複：${k}`);
      all.set(k, v);
    }
  }
  return all;
}

/** 要素的資料期間：整數、起 ≤ 迄、1800 ≤ 起、迄 ≤ 今年；缺少或不合理回 null（該測站略過，不猜年份） */
function elementPeriod(el: unknown, now: Date): { startYear: number; endYear: number } | null {
  if (!isRec(el)) return null;
  const startYear = intField(el[F.startYear]);
  const endYear = intField(el[F.endYear]);
  if (!Number.isInteger(startYear) || !Number.isInteger(endYear) || startYear < 1800 || endYear > now.getUTCFullYear() || startYear > endYear) return null;
  return { startYear, endYear };
}

/**
 * 純轉換：回應 → 氣候統計檔。
 * - 結構不符、月份不合法或重複、數值非數字 → 整份 format 失敗（不猜）。
 * - 單月缺值、缺／不合理的資料期間、沒有座標 → 該測站略過（不補洞）；沒有任何可用測站則 coverage 失敗，訊息列出各原因的站數。
 * - 範圍與高低溫關係、已提供的座標，都在略過判定之前就對回應內每個測站檢查；任何一站不合理 → 整份 range 失敗（被略過的測站也不例外）。
 * - Maximum／Minimum 語意未確認（CLIMATE_MAXMIN_CONFIRMED）前，即使有座標也拒絕產出（fail closed）。
 * - coordinates：StationID → 座標。氣候回應沒有座標；runClimate 從測站基本資料取得後傳入，這裡預設空表 → 全部測站因缺座標略過。
 */
export function convertClimate(raw: unknown, now: Date, coordinates: StationCoordinates = new Map(), options: { maxMinConfirmed?: boolean } = {}): ClimateNormalsFile {
  const maxMinConfirmed = options.maxMinConfirmed ?? CLIMATE_MAXMIN_CONFIRMED;
  if (!isRec(raw) || (raw.success !== 'true' && raw.success !== true)) return fail('format', '氣候回應的 success 不是 true');
  if (!isRec(raw.records)) return fail('format', `氣候回應缺少 records；回應結構=${shapeOf(raw)}`);
  let node: unknown = raw.records;
  for (const key of F.path.slice(0, -1)) node = isRec(node) ? node[key] : undefined;
  if (!isRec(node)) return fail('format', `氣候回應結構不符（surfaceObs）；records 結構=${shapeOf(raw.records)}`);
  const list = node[F.path[F.path.length - 1]];
  if (!Array.isArray(list)) return fail('format', `氣候回應缺少測站清單；surfaceObs 結構=${shapeOf(node)}`);

  const stations: ClimateNormalsStation[] = [];
  const seen = new Set<string>();
  const skipped = { value: 0, period: 0, coordinates: 0 };
  for (const loc of list as unknown[]) {
    if (!isRec(loc) || !isRec(loc[F.station]) || !isRec(loc[F.stats])) return fail('format', '氣候回應的測站結構不符');
    const st = loc[F.station] as Record<string, unknown>;
    const id = st[F.stationId];
    const name = st[F.stationName];
    if (typeof id !== 'string' || !id.trim() || typeof name !== 'string' || !name.trim()) return fail('format', '氣候回應的測站缺少代碼或名稱');
    if (seen.has(id)) return fail('format', `氣候回應測站代碼重複：${id}`);
    seen.add(id);
    const stats = loc[F.stats] as Record<string, unknown>;
    const tempEl = stats[F.temperature];
    const rainEl = stats[F.precipitation];
    const temp = isRec(tempEl) ? tempEl[F.monthly] : undefined;
    const rain = isRec(rainEl) ? rainEl[F.monthly] : undefined;
    // 要素整個消失 = 欄位改名，整份不發布；單月缺值才略過該測站
    if (!Array.isArray(temp) || !Array.isArray(rain)) return fail('format', `${id} 缺少氣溫或降水月資料（欄位改名？）`);
    const byMonth = (rows: unknown[], where: string) => {
      const m = new Map<number, Record<string, unknown>>();
      for (const r of rows) {
        if (!isRec(r)) return fail('format', `${id} ${where} 月資料不是物件`);
        const month = intField(r[F.month]);
        if (!Number.isInteger(month) || month < 1 || month > 12 || m.has(month)) return fail('format', `${id} ${where} 月份不合法或重複`);
        m.set(month, r);
      }
      return m;
    };
    const t = byMonth(temp, '氣溫');
    const p = byMonth(rain, '降水');
    // 數值先全部驗證（非數字整份失敗），再決定略過與否；這樣沒有座標時也會抓到壞數字
    const months = [];
    let complete = true;
    for (let month = 1; month <= 12; month++) {
      const tr = t.get(month);
      const pr = p.get(month);
      const avgTemp = tr ? value(tr[F.mean], `${id} ${month} 月平均氣溫`) : null;
      const avgHigh = tr ? value(tr[F.meanMax], `${id} ${month} 月最高氣溫`) : null;
      const avgLow = tr ? value(tr[F.meanMin], `${id} ${month} 月最低氣溫`) : null;
      const precip = pr ? value(pr[F.accumulation], `${id} ${month} 月降水量`) : null;
      const inRange = (n: number | null, lo: number, hi: number, what: string) => {
        if (n !== null && (n < lo || n > hi)) fail('range', `${id} ${month} 月${what}超出合理範圍`);
      };
      inRange(avgTemp, -30, 50, '平均氣溫');
      inRange(avgHigh, -30, 50, '最高氣溫');
      inRange(avgLow, -30, 50, '最低氣溫');
      inRange(precip, 0, 5000, '降水量');
      if (avgHigh !== null && avgLow !== null && avgHigh < avgLow) fail('range', `${id} ${month} 月最高氣溫低於最低氣溫`);
      if (avgTemp !== null && ((avgLow !== null && avgTemp < avgLow) || (avgHigh !== null && avgTemp > avgHigh))) fail('range', `${id} ${month} 月平均氣溫不在最低與最高之間`);
      if (avgTemp === null || avgHigh === null || avgLow === null || precip === null) complete = false;
      else months.push({ month, avgTemp, avgHigh, avgLow, precip });
    }
    const at = coordinates.get(id);
    if (at && !(Number.isFinite(at.lat) && Number.isFinite(at.lon) && at.lat >= 21.5 && at.lat <= 26.5 && at.lon >= 118 && at.lon <= 122.5)) {
      return fail('range', `${id} 的座標不在臺灣範圍內`);
    }
    if (!complete) {
      skipped.value += 1;
      continue;
    }
    const temperature = elementPeriod(tempEl, now);
    const precipitation = elementPeriod(rainEl, now);
    if (!temperature || !precipitation) {
      skipped.period += 1;
      continue;
    }
    if (!at) {
      skipped.coordinates += 1;
      continue;
    }
    stations.push({ id, name, lat: at.lat, lon: at.lon, months, periods: { temperature, precipitation } });
  }
  if (stations.length === 0) {
    return fail('coverage', `氣候回應沒有任何可輸出的測站（缺值 ${skipped.value} 站、缺／不合理的資料期間 ${skipped.period} 站、沒有座標 ${skipped.coordinates} 站；回應本身沒有經緯度，座標需另有來源）`);
  }
  if (!maxMinConfirmed) {
    return fail('format', 'Maximum／Minimum 的語意尚未確認（日最高／最低的月平均，或月極值）；確認前不產出氣候統計');
  }
  const all = stations.flatMap((s) => [s.periods!.temperature, s.periods!.precipitation]);
  const file: ClimateNormalsFile = {
    format: CLIMATE_NORMALS_FORMAT,
    generatedAt: now.toISOString(),
    source: { ...CLIMATE_SOURCE },
    // 涵蓋範圍（最早起、最晚迄）；各站各要素實際期間見 stations[].periods
    period: { startYear: Math.min(...all.map((x) => x.startYear)), endYear: Math.max(...all.map((x) => x.endYear)) },
    stations: stations.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
  // 用 App 端解析器讀回：數值範圍、月份順序、座標範圍任何一項不過都不發布
  try {
    parseClimateNormals(JSON.parse(JSON.stringify(file)));
  } catch (error) {
    return fail('range', `氣候統計檔未通過 App 端檢查：${error instanceof Error ? error.message : 'unknown'}`);
  }
  return file;
}

export interface ClimateResult {
  /** 'fresh'：檔案仍新，沒有請求；'updated'：已更新；'kept'：失敗，保留上一版（或沒有上一版） */
  status: 'fresh' | 'updated' | 'kept';
  generatedAt: string | null;
  error?: FailureCategory;
  detail?: string;
}

async function readPublished(file: string): Promise<ClimateNormalsFile | null> {
  try {
    return parseClimateNormalsText(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function runClimate(options: {
  apiKey: string;
  outDir: string;
  fetchImpl: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** StationID → 座標；沒給就從測站基本資料（C-B0074-001／-002）抓。給了就不連網抓（測試用） */
  coordinates?: StationCoordinates;
  /** Maximum／Minimum 語意是否已確認；預設取 CLIMATE_MAXMIN_CONFIRMED（false） */
  maxMinConfirmed?: boolean;
}): Promise<ClimateResult> {
  const { apiKey, outDir } = options;
  if (!isUsableApiKey(apiKey)) throw new PublisherError('config', '授權碼未設定或格式不符');
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const dir = path.join(outDir, OUTPUT_SUBDIR);
  const file = path.join(dir, CLIMATE_FILE);
  const previous = await readPublished(file);
  if (previous && now().getTime() - Date.parse(previous.generatedAt) < CLIMATE_REFRESH_MS && Date.parse(previous.generatedAt) <= now().getTime()) {
    return { status: 'fresh', generatedAt: previous.generatedAt };
  }
  try {
    const raw = await fetchDataset(CLIMATE_DATASET_ID, { apiKey, fetchImpl: options.fetchImpl, sleep });
    const coordinates = options.coordinates ?? (await fetchStationCoordinates({ apiKey, fetchImpl: options.fetchImpl, sleep }));
    const built = convertClimate(raw, now(), coordinates, { maxMinConfirmed: options.maxMinConfirmed });
    const body = `${JSON.stringify(built)}\n`;
    if (body.length > CLIMATE_MAX_CHARS) return fail('size', '氣候統計檔過大');
    await mkdir(dir, { recursive: true });
    await atomicWrite(file, body);
    return { status: 'updated', generatedAt: built.generatedAt };
  } catch (error) {
    const known = error instanceof PublisherError;
    return {
      status: 'kept',
      generatedAt: previous?.generatedAt ?? null,
      error: known ? error.category : 'internal',
      detail: redact(known ? error.message : `未預期的錯誤（${error instanceof Error ? error.name : 'unknown'}）`, apiKey),
    };
  }
}

export { CLIMATE_FORMAT };
