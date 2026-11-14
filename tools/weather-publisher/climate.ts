// 氣候統計輸出（任務 A6／0-09；規格 3.4「氣候統計」）
//
// 呼叫氣象署 C-B0027-001（地面測站月平均資料，每 10 年更新）→ 轉成 {輸出資料夾}/v1/climate-normals.json。
// - 只在檔案不存在、讀不回來、或產生超過 7 天時才重抓；抓失敗、結構不符、數值不合理都保留上一版（fail closed，與縣市預報同規則）。
// - 轉換完用 App 端解析器（src/weather/climate-normals.ts）讀回驗證才寫入；寫入用暫存檔 + rename。
// - ⚠ 回應結構依公開文件推測，尚未以真實授權碼實測（見 config.ts CLIMATE_FIELDS、FIELD-MAP.md）。

import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseClimateNormals, parseClimateNormalsText, CLIMATE_NORMALS_FORMAT, type ClimateNormalsFile, type ClimateNormalsStation } from '../../src/weather/climate-normals.ts';
import { CLIMATE_DATASET_ID, CLIMATE_FIELDS as F, CLIMATE_FILE, CLIMATE_FORMAT, CLIMATE_MAX_CHARS, CLIMATE_REFRESH_MS, CLIMATE_SOURCE, OUTPUT_SUBDIR } from './config.ts';
import { PublisherError, type FailureCategory } from './cwa.ts';
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
export function describeShape(v: unknown, depth = 0): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length === 0 ? '[]' : depth >= SHAPE_MAX_DEPTH ? '[…]' : `[${describeShape(v[0], depth + 1)}]`;
  if (typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>);
    if (depth >= SHAPE_MAX_DEPTH) return keys.length ? '{…}' : '{}';
    const shown = keys.slice(0, SHAPE_MAX_KEYS).map((k) => `${shapeKey(k)}:${describeShape((v as Record<string, unknown>)[k], depth + 1)}`);
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
  if (!Number.isFinite(n)) return fail('format', `${where} 不是數字`);
  if (n <= -99) return null;
  return n;
}

/** 純轉換：回應 → 氣候統計檔。單一測站有任一個月缺值就整站略過（不補洞）；沒有任何可用測站則失敗 */
export function convertClimate(raw: unknown, now: Date): ClimateNormalsFile {
  if (!isRec(raw) || (raw.success !== 'true' && raw.success !== true)) return fail('format', '氣候回應的 success 不是 true');
  if (!isRec(raw.records)) return fail('format', `氣候回應缺少 records；回應結構=${shapeOf(raw)}`);
  let node: unknown = raw.records;
  for (const key of F.path.slice(0, -1)) node = isRec(node) ? node[key] : undefined;
  if (!isRec(node)) return fail('format', `氣候回應結構不符（surfaceObs）；records 結構=${shapeOf(raw.records)}`);
  const period = node[F.period];
  if (!isRec(period)) return fail('format', `氣候回應缺少資料期間；surfaceObs 結構=${shapeOf(node)}`);
  const startYear = intField(period[F.startYear]);
  const endYear = intField(period[F.endYear]);
  if (!Number.isInteger(startYear) || !Number.isInteger(endYear) || startYear < 1800 || endYear > 2200 || startYear > endYear) return fail('format', '氣候回應資料期間不合法');
  const list = node[F.path[F.path.length - 1]];
  if (!Array.isArray(list)) return fail('format', `氣候回應缺少測站清單；surfaceObs 結構=${shapeOf(node)}`);

  const stations: ClimateNormalsStation[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const loc of list as unknown[]) {
    if (!isRec(loc) || !isRec(loc[F.station]) || !isRec(loc[F.stats])) return fail('format', '氣候回應的測站結構不符');
    const st = loc[F.station] as Record<string, unknown>;
    const id = st[F.stationId];
    const name = st[F.stationName];
    if (typeof id !== 'string' || !id.trim() || typeof name !== 'string' || !name.trim()) return fail('format', '氣候回應的測站缺少代碼或名稱');
    if (seen.has(id)) return fail('format', `氣候回應測站代碼重複：${id}`);
    seen.add(id);
    const lat = value(st[F.lat], `${id} 緯度`);
    const lon = value(st[F.lon], `${id} 經度`);
    const stats = loc[F.stats] as Record<string, unknown>;
    const temp = isRec(stats[F.temperature]) ? (stats[F.temperature] as Record<string, unknown>)[F.monthly] : undefined;
    const rain = isRec(stats[F.precipitation]) ? (stats[F.precipitation] as Record<string, unknown>)[F.monthly] : undefined;
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
    const months = [];
    let complete = lat !== null && lon !== null;
    for (let month = 1; month <= 12 && complete; month++) {
      const tr = t.get(month);
      const pr = p.get(month);
      const avgTemp = tr ? value(tr[F.mean], `${id} ${month} 月平均氣溫`) : null;
      const avgHigh = tr ? value(tr[F.meanMax], `${id} ${month} 月平均最高`) : null;
      const avgLow = tr ? value(tr[F.meanMin], `${id} ${month} 月平均最低`) : null;
      const precip = pr ? value(pr[F.accumulation], `${id} ${month} 月降水量`) : null;
      if (avgTemp === null || avgHigh === null || avgLow === null || precip === null) complete = false;
      else months.push({ month, avgTemp, avgHigh, avgLow, precip });
    }
    if (!complete) {
      skipped += 1;
      continue;
    }
    stations.push({ id, name, lat: lat as number, lon: lon as number, months });
  }
  if (stations.length === 0) return fail('coverage', `氣候回應沒有任何完整測站（略過 ${skipped} 站）`);
  const file: ClimateNormalsFile = {
    format: CLIMATE_NORMALS_FORMAT,
    generatedAt: now.toISOString(),
    source: { ...CLIMATE_SOURCE },
    period: { startYear, endYear },
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
    const built = convertClimate(raw, now());
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
