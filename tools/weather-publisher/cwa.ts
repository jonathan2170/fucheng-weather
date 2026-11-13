// 中央氣象署鄉鎮預報回應 → 每鄉鎮每日彙整（任務 A4；規格 3.4、4.2 WeatherSnapshot、6.1 時段定義）
//
// 只做純資料轉換，不連網、不讀檔。任何不符預期的結構一律丟 PublisherError（fail closed）；
// 只有單一時間點的值是 "-"、空字串或 null 才當作缺值（該欄位省略）。

import { MIN_DAYTIME_POINTS, WINDOWS } from './config.ts';

export type FailureCategory = 'config' | 'network' | 'http' | 'format' | 'mismatch' | 'range' | 'coverage' | 'stale' | 'size' | 'write' | 'internal';

export class PublisherError extends Error {
  readonly category: FailureCategory;
  constructor(category: FailureCategory, message: string) {
    super(message);
    this.name = 'PublisherError';
    this.category = category;
  }
}

export interface CwaElementSpec {
  /** WeatherElement.ElementName */
  name: string;
  /** ElementValue 物件內的鍵 */
  key: string;
}

/** 單一時間點；瞬時值 start === end，區間值 end > start（毫秒時間戳） */
export interface Point {
  start: number;
  end: number;
  raw: string | null;
}

export type ElementPoints = Map<string, Point[]>; // key: 我們自己的要素代號
export type LocationElements = Map<string, ElementPoints>; // key: LocationName

const fail = (category: FailureCategory, message: string): never => {
  throw new PublisherError(category, message);
};

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

const OFFSET_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

function parseTime(value: unknown, where: string): number {
  if (typeof value !== 'string' || !OFFSET_ISO.test(value)) return fail('format', `${where} 時間格式不符`);
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? fail('format', `${where} 時間無法解析`) : ms;
}

function readRaw(entry: Record<string, unknown>, key: string, where: string): string | null {
  const values = entry.ElementValue;
  if (!Array.isArray(values) || values.length === 0 || !isRecord(values[0])) return fail('format', `${where} 缺 ElementValue`);
  const row = values[0] as Record<string, unknown>;
  if (!(key in row)) return fail('format', `${where} 的值缺鍵 ${key}（欄位可能改名）`);
  const raw = row[key];
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string' && typeof raw !== 'number') return fail('format', `${where}.${key} 型別不符`);
  const text = String(raw).trim();
  return text === '' || text === '-' ? null : text;
}

/**
 * 解析一個資料集回應：驗證成功旗標與縣市名稱，取出每個鄉鎮、每個指定要素的時間點。
 * 指定的要素（specs）全部必須出現在每個鄉鎮；整個要素消失視為欄位改名。
 */
export function readDataset(payload: unknown, expectedCountyName: string, specs: Record<string, CwaElementSpec>): LocationElements {
  if (!isRecord(payload)) return fail('format', '回應不是物件');
  if (payload.success !== 'true' && payload.success !== true) return fail('format', '回應的 success 不是 true');
  const records = payload.records;
  if (!isRecord(records) || !Array.isArray(records.Locations) || records.Locations.length !== 1 || !isRecord(records.Locations[0])) {
    return fail('format', '回應缺 records.Locations（應恰好一個縣市）');
  }
  const group = records.Locations[0] as Record<string, unknown>;
  if (group.LocationsName !== expectedCountyName) {
    return fail('mismatch', `回應的縣市名稱 ${String(group.LocationsName)} 不是預期的 ${expectedCountyName}`);
  }
  if (!Array.isArray(group.Location) || group.Location.length === 0) return fail('format', '回應缺 Location 陣列');

  const out: LocationElements = new Map();
  for (const loc of group.Location as unknown[]) {
    if (!isRecord(loc) || typeof loc.LocationName !== 'string' || !Array.isArray(loc.WeatherElement)) {
      return fail('format', 'Location 結構不符');
    }
    const name = loc.LocationName;
    if (out.has(name)) return fail('format', `鄉鎮 ${name} 重複`);
    const byName = new Map<string, Record<string, unknown>>();
    for (const el of loc.WeatherElement as unknown[]) {
      if (isRecord(el) && typeof el.ElementName === 'string') byName.set(el.ElementName, el);
    }
    const elements: ElementPoints = new Map();
    for (const [code, spec] of Object.entries(specs)) {
      const el = byName.get(spec.name);
      if (!el || !Array.isArray(el.Time)) return fail('format', `${name} 缺要素「${spec.name}」（欄位可能改名）`);
      const points = (el.Time as unknown[]).map((entry, i): Point => {
        const where = `${name}/${spec.name}[${i}]`;
        if (!isRecord(entry)) return fail('format', `${where} 不是物件`);
        const raw = readRaw(entry, spec.key, where);
        if (entry.DataTime !== undefined) {
          const t = parseTime(entry.DataTime, `${where}.DataTime`);
          return { start: t, end: t, raw };
        }
        const start = parseTime(entry.StartTime, `${where}.StartTime`);
        const end = parseTime(entry.EndTime, `${where}.EndTime`);
        if (end <= start) return fail('format', `${where} 結束時間不晚於開始時間`);
        return { start, end, raw };
      });
      elements.set(code, points);
    }
    out.set(name, elements);
  }
  return out;
}

// ── 臺灣時間（UTC+8，無日光節約時間） ──

const HOUR = 3_600_000;
const TAIPEI = 8 * HOUR;

export const taipeiDate = (ms: number): string => new Date(ms + TAIPEI).toISOString().slice(0, 10);
const dayStart = (date: string): number => Date.parse(`${date}T00:00:00Z`) - TAIPEI;

type Window = readonly [number, number];
const dayWindow = (date: string): Window => [dayStart(date), dayStart(date) + 24 * HOUR - 1];
const hoursWindow = (date: string, [from, to]: readonly [number, number]): Window => [dayStart(date) + from * HOUR, dayStart(date) + to * HOUR];

/** 瞬時值：落在視窗內（含兩端）；區間值：與視窗嚴格重疊（結束於視窗起點、開始於視窗終點的區間不算） */
function inWindow(point: Point, [from, to]: Window): boolean {
  if (point.end > point.start) return point.start < to && point.end > from;
  return point.start >= from && point.start <= to;
}

const NUMBER = /^-?\d+(\.\d+)?$/;
/**
 * 帶比較符號的界限值，例如風速「>= 11」「≥11」（2026-11-13 首次實測：金門、臺東、澎湖強風時段出現，三縣因此整檔被擋）。
 * 只用在明確允許的要素（風速）；取符號後的數字當作該點的值——對「全日最大」而言是保守的下限，不會把強風報小。
 */
const BOUNDED = /^\s*(>=|≥|＞=|＞|>|<=|≤|<)\s*(-?\d+(?:\.\d+)?)\s*$/;

/** 錯誤訊息裡的原始值：只留數字、符號與空白，最多 12 字（公開的預報值，不含授權碼；方便下次一看就知道是什麼格式） */
const showRaw = (raw: string): string => JSON.stringify(raw.replace(/[^\d.\-+<>=≥≤＞ ]/g, '?').slice(0, 12));

/** 取出視窗內的數值；缺值（"-"）略過，非數字內容視為格式錯誤（allowBound：接受「>= 11」這類界限值） */
function numbers(points: Point[] | undefined, window: Window, where: string, allowBound = false): number[] {
  const out: number[] = [];
  for (const point of points ?? []) {
    if (!inWindow(point, window) || point.raw === null) continue;
    if (NUMBER.test(point.raw)) {
      out.push(Number(point.raw));
      continue;
    }
    const bound = allowBound ? BOUNDED.exec(point.raw) : null;
    if (!bound) return fail('format', `${where} 出現非數字的值 ${showRaw(point.raw)}`);
    out.push(Number(bound[2]));
  }
  return out;
}

const min = (values: number[]): number | undefined => (values.length ? Math.min(...values) : undefined);
const max = (values: number[]): number | undefined => (values.length ? Math.max(...values) : undefined);

/** 視窗內最常出現的文字（同數量取最早出現者） */
function modeText(points: Point[] | undefined, window: Window): string | undefined {
  const counts = new Map<string, number>();
  for (const point of points ?? []) {
    if (!inWindow(point, window) || point.raw === null) continue;
    counts.set(point.raw, (counts.get(point.raw) ?? 0) + 1);
  }
  let best: string | undefined;
  for (const [text, n] of counts) if (best === undefined || n > (counts.get(best) as number)) best = text;
  return best;
}

export interface DayRow {
  date: string;
  tempMinDay: number;
  tempMaxDay: number;
  tempMinDaytime: number;
  tempMaxDaytime: number;
  tempMinOuting?: number;
  tempMaxOuting?: number;
  apparentMinDaytime?: number;
  apparentMaxDaytime?: number;
  apparentMinOuting?: number;
  rainProbDaytimeMax?: number;
  humidityMax?: number;
  windSpeedMax?: number;
  uvIndex?: number;
  weatherText: string;
}

/**
 * 把一個鄉鎮的逐三小時資料（與一週版的紫外線）彙整成每日欄位（時段定義見規格 6.1，臺灣時間）：
 *   全日 0–24 時、白天 7–19 時、外出 7–22 時；濕度、風速取全日最大；降雨機率取白天最大；紫外線取全日最大。
 * 白天溫度時間點少於 MIN_DAYTIME_POINTS 或沒有天氣描述的日期不輸出
 * （必填欄位無法成立、或殘餘時段不足以代表白天高低溫）。其餘部分時段的日期只用有資料的時間點（FIELD-MAP.md 已註明）。
 */
export function aggregateTown(forecast: ElementPoints, week: ElementPoints, label: string): DayRow[] {
  const temps = forecast.get('temperature') ?? [];
  const dates = [...new Set(temps.map((p) => taipeiDate(p.start)))].sort();
  const rows: DayRow[] = [];
  for (const date of dates) {
    const whole = dayWindow(date);
    const daytime = hoursWindow(date, WINDOWS.daytime);
    const outing = hoursWindow(date, WINDOWS.outing);
    const where = `${label}/${date}`;
    const tDay = numbers(temps, whole, `${where} 溫度`);
    const tDaytime = numbers(temps, daytime, `${where} 溫度`);
    const text = modeText(forecast.get('weather'), daytime) ?? modeText(forecast.get('weather'), whole);
    if (tDay.length === 0 || tDaytime.length < MIN_DAYTIME_POINTS || text === undefined) continue;
    const tOuting = numbers(temps, outing, `${where} 溫度`);
    const apparent = forecast.get('apparent');
    const row: DayRow = {
      date,
      tempMinDay: min(tDay) as number,
      tempMaxDay: max(tDay) as number,
      tempMinDaytime: min(tDaytime) as number,
      tempMaxDaytime: max(tDaytime) as number,
      weatherText: text,
    };
    const optional: [keyof DayRow, number | undefined][] = [
      ['tempMinOuting', min(tOuting)],
      ['tempMaxOuting', max(tOuting)],
      ['apparentMinDaytime', min(numbers(apparent, daytime, `${where} 體感溫度`))],
      ['apparentMaxDaytime', max(numbers(apparent, daytime, `${where} 體感溫度`))],
      ['apparentMinOuting', min(numbers(apparent, outing, `${where} 體感溫度`))],
      ['rainProbDaytimeMax', max(numbers(forecast.get('rainProb'), daytime, `${where} 降雨機率`))],
      ['humidityMax', max(numbers(forecast.get('humidity'), whole, `${where} 相對濕度`))],
      ['windSpeedMax', max(numbers(forecast.get('windSpeed'), whole, `${where} 風速`, true))],
      ['uvIndex', max(numbers(week.get('uvIndex'), whole, `${where} 紫外線指數`))],
    ];
    for (const [field, value] of optional) if (value !== undefined) (row as unknown as Record<string, number>)[field] = value;
    rows.push(row);
  }
  return rows;
}
