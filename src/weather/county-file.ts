// 縣市天氣檔格式與解析（任務 1-10；規格 3.4、4.2 WeatherCountyCache／WeatherSnapshot、6.1、6.7「缺值處理」）
//
// 縣市檔由 0-05 的排程工作產生、發布在獨立天氣儲存庫；一個縣市一個檔，內含該縣市全部鄉鎮的公開預報。
// 本 repo 目前沒有 0-05 的欄位對照表定稿，以下格式依規格 3.4 與 4.2 的欄位暫定為 `fucheng-weather/1`：
//
//   {
//     format: 'fucheng-weather/1',
//     countyCode: string,
//     generatedAt: ISO 時間,
//     source: 'cwa',
//     towns: [{ regionId, days: [{ date: 'YYYY-MM-DD', ...每日彙整欄位 }] }]
//   }
//
// 每日彙整欄位（排程端由逐三小時預報彙整；時段定義見 6.1）：
//   必填：tempMinDay、tempMaxDay（全日）、tempMinDaytime、tempMaxDaytime（白天 7–19 時）、weatherText
//   選填（只有 format 為 fucheng-weather/2 時允許）：rowGeneratedAt（該列自己的產生時間；沒有時以檔案 generatedAt 為準，逐列沿用時用）
//   選填（缺值時省略或為 null）：tempMinOuting、tempMaxOuting（外出 7–22 時）、apparentMinDaytime、apparentMaxDaytime、
//     apparentMinOuting、rainProbDaytimeMax、humidityMax、windSpeedMax、uvIndex
//
// 版本：`fucheng-weather/1`（沒有 rowGeneratedAt）與 `fucheng-weather/2`（同欄位，允許 rowGeneratedAt）；App 兩者都接受，解析後保留原版本。
//
// 解析採白名單：不認得的欄位一律拒絕（避免把不明內容存進明文快取）；數值須為有限數字且在合理範圍內。

import { ACCEPTED_COUNTY_FILE_FORMATS, COUNTY_FILE_FORMAT_V2, MAX_COUNTY_FILE_CHARS, type CountyFileFormat } from './config.ts';

export interface DayForecast {
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
  /** 這一列自己的產生時間（選填）：發布端沿用上一版的今天列、或 App 保留舊的今天列時帶上；沒有時以檔案的 generatedAt 為準 */
  rowGeneratedAt?: string;
}

export interface TownForecast {
  regionId: string;
  days: DayForecast[];
}

export interface CountyFile {
  format: CountyFileFormat;
  countyCode: string;
  generatedAt: string;
  source: 'cwa';
  towns: TownForecast[];
}

export class WeatherFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeatherFileError';
  }
}

const fail = (message: string): never => {
  throw new WeatherFileError(`縣市天氣檔格式不符：${message}`);
};

type NumberField = Exclude<keyof DayForecast, 'date' | 'weatherText' | 'rowGeneratedAt'>;

/** [下限, 上限]（含兩端）；超出視為資料錯誤 */
const RANGES: Record<NumberField, readonly [number, number]> = {
  tempMinDay: [-30, 50],
  tempMaxDay: [-30, 50],
  tempMinDaytime: [-30, 50],
  tempMaxDaytime: [-30, 50],
  tempMinOuting: [-30, 50],
  tempMaxOuting: [-30, 50],
  apparentMinDaytime: [-40, 60],
  apparentMaxDaytime: [-40, 60],
  apparentMinOuting: [-40, 60],
  rainProbDaytimeMax: [0, 100],
  humidityMax: [0, 100],
  windSpeedMax: [0, 80],
  uvIndex: [0, 20],
};
const REQUIRED_NUMBERS: readonly NumberField[] = ['tempMinDay', 'tempMaxDay', 'tempMinDaytime', 'tempMaxDaytime'];
const DAY_FIELDS: readonly string[] = ['date', 'weatherText', 'rowGeneratedAt', ...Object.keys(RANGES)];
const TOWN_FIELDS: readonly string[] = ['regionId', 'days'];
const FILE_FIELDS: readonly string[] = ['format', 'countyCode', 'generatedAt', 'source', 'towns'];

const CODE = /^[0-9A-Za-z_-]{1,32}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

function object(value: unknown, where: string, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${where} 須為物件`);
  const row = value as Record<string, unknown>;
  const extra = Object.keys(row).filter((key) => !fields.includes(key));
  if (extra.length > 0) fail(`${where} 含未定義的欄位 ${extra.join('、')}`);
  return row;
}

function isValidDate(text: string): boolean {
  if (!DATE.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function parseDay(value: unknown, where: string, allowRowTime: boolean): DayForecast {
  const row = object(value, where, DAY_FIELDS);
  if (!allowRowTime && row.rowGeneratedAt !== undefined) fail(`${where} 含未定義的欄位 rowGeneratedAt（版本 1 不含此欄位）`);
  if (typeof row.date !== 'string' || !isValidDate(row.date)) fail(`${where}.date 須為 YYYY-MM-DD`);
  if (typeof row.weatherText !== 'string' || row.weatherText.trim() === '' || row.weatherText.length > 40) {
    fail(`${where}.weatherText 須為 1 至 40 字`);
  }
  const day: Record<string, unknown> = { date: row.date, weatherText: row.weatherText };
  if (row.rowGeneratedAt !== undefined && row.rowGeneratedAt !== null) {
    if (typeof row.rowGeneratedAt !== 'string' || !ISO.test(row.rowGeneratedAt) || Number.isNaN(Date.parse(row.rowGeneratedAt))) {
      fail(`${where}.rowGeneratedAt 須為 ISO 時間`);
    }
    day.rowGeneratedAt = new Date(Date.parse(row.rowGeneratedAt as string)).toISOString();
  }
  for (const field of Object.keys(RANGES) as NumberField[]) {
    const raw = row[field];
    if (raw === undefined || raw === null) {
      if (REQUIRED_NUMBERS.includes(field)) fail(`${where}.${field} 為必填`);
      continue;
    }
    const [min, max] = RANGES[field];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max) {
      fail(`${where}.${field} 須為 ${min} 至 ${max} 的數字`);
    }
    day[field] = raw;
  }
  const out = day as unknown as DayForecast;
  if (out.tempMinDay > out.tempMaxDay) fail(`${where} 全日最低氣溫高於最高氣溫`);
  if (out.tempMinDaytime > out.tempMaxDaytime) fail(`${where} 白天最低氣溫高於最高氣溫`);
  if (out.tempMinOuting !== undefined && out.tempMaxOuting !== undefined && out.tempMinOuting > out.tempMaxOuting) {
    fail(`${where} 外出時段最低氣溫高於最高氣溫`);
  }
  return out;
}

/** 驗證並重建縣市檔（只保留白名單欄位、省略 null）；不符格式時丟出 WeatherFileError */
export function parseCountyFile(value: unknown, expectedCounty?: string): CountyFile {
  const row = object(value, '檔案', FILE_FIELDS);
  if (!ACCEPTED_COUNTY_FILE_FORMATS.includes(row.format as CountyFileFormat)) fail(`format 須為 ${ACCEPTED_COUNTY_FILE_FORMATS.join(' 或 ')}`);
  const format = row.format as CountyFileFormat;
  if (typeof row.countyCode !== 'string' || !CODE.test(row.countyCode)) fail('countyCode 不正確');
  const countyCode = row.countyCode as string;
  if (expectedCounty !== undefined && countyCode !== expectedCounty) fail(`下載的是 ${countyCode}，不是要求的 ${expectedCounty}`);
  if (typeof row.generatedAt !== 'string' || !ISO.test(row.generatedAt) || Number.isNaN(Date.parse(row.generatedAt))) {
    fail('generatedAt 須為 ISO 時間');
  }
  if (row.source !== 'cwa') fail('source 須為 cwa');
  if (!Array.isArray(row.towns) || row.towns.length === 0) fail('towns 須為非空陣列');
  const seen = new Set<string>();
  const towns = (row.towns as unknown[]).map((townValue, ti): TownForecast => {
    const town = object(townValue, `towns[${ti}]`, TOWN_FIELDS);
    if (typeof town.regionId !== 'string' || !CODE.test(town.regionId)) fail(`towns[${ti}].regionId 不正確`);
    const regionId = town.regionId as string;
    if (seen.has(regionId)) fail(`鄉鎮 ${regionId} 重複`);
    seen.add(regionId);
    if (!Array.isArray(town.days)) fail(`towns[${ti}].days 須為陣列`);
    const dates = new Set<string>();
    const days = (town.days as unknown[]).map((dayValue, di) => {
      const day = parseDay(dayValue, `towns[${ti}].days[${di}]`, format === COUNTY_FILE_FORMAT_V2);
      if (dates.has(day.date)) fail(`towns[${ti}] 日期 ${day.date} 重複`);
      dates.add(day.date);
      return day;
    });
    return { regionId, days };
  });
  return {
    format,
    countyCode,
    generatedAt: new Date(Date.parse(row.generatedAt as string)).toISOString(),
    source: 'cwa',
    towns,
  };
}

/** 由回應文字解析縣市檔（含大小上限與 JSON 檢查） */
export function parseCountyFileText(text: string, expectedCounty?: string): CountyFile {
  if (text.length > MAX_COUNTY_FILE_CHARS) fail(`檔案超過 ${MAX_COUNTY_FILE_CHARS} 字元`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail('不是有效的 JSON');
  }
  return parseCountyFile(value, expectedCounty);
}
