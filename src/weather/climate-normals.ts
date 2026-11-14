// 氣候統計（月平均）檔的解析與「鄉鎮 → 最近測站」換算（任務 A6／0-09；規格 3.4「氣候統計」）
//
// 資料檔 climate-normals.json 由天氣發布端產生，與天氣檔同網域（weather.fuchengone.com/v1/），
// 只含測站的月平均氣溫與降水量，不含任何個人資料。本檔只做解析與檢查，不發請求。任何一項不合格整份丟錯（fail closed）。
// 鄉鎮 → 測站的對照由離線腳本（scripts/build-climate-stations.mjs）產生並隨 App 靜態提供；測站代碼對不上時不猜。

import type { ClimateMonthly } from '../data/types.ts';

export const CLIMATE_NORMALS_FORMAT = 'fucheng-climate-normals/1';
export const MAX_CLIMATE_NORMALS_CHARS = 400_000;

export interface ClimateNormalsMonth {
  month: number;
  avgTemp: number;
  avgHigh: number;
  avgLow: number;
  /** 月降水量（毫米） */
  precip: number;
}
export interface ClimateNormalsStation {
  id: string;
  name: string;
  lat: number;
  lon: number;
  months: ClimateNormalsMonth[];
}
export interface ClimateNormalsFile {
  format: typeof CLIMATE_NORMALS_FORMAT;
  generatedAt: string;
  source: { provider: string; dataset: string; datasetPage: string; license: string; licenseUrl: string; attribution: string };
  period: { startYear: number; endYear: number };
  stations: ClimateNormalsStation[];
}

export class ClimateNormalsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClimateNormalsError';
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const num = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const bad = (m: string): never => {
  throw new ClimateNormalsError(m);
};

export function parseClimateNormals(raw: unknown): ClimateNormalsFile {
  if (!isObj(raw) || raw.format !== CLIMATE_NORMALS_FORMAT) return bad('氣候統計檔格式不符');
  if (!text(raw.generatedAt) || Number.isNaN(Date.parse(raw.generatedAt))) return bad('氣候統計檔缺少產生時間');
  const s = raw.source;
  if (!isObj(s) || !text(s.provider) || !text(s.dataset) || !text(s.datasetPage) || !text(s.license) || !text(s.licenseUrl) || !text(s.attribution)) {
    return bad('氣候統計檔缺少來源標示');
  }
  const p = raw.period;
  if (!isObj(p) || !Number.isInteger(p.startYear) || !Number.isInteger(p.endYear) || (p.startYear as number) > (p.endYear as number) || (p.startYear as number) < 1800 || (p.endYear as number) > 2200) {
    return bad('氣候統計檔缺少資料期間');
  }
  if (!Array.isArray(raw.stations) || raw.stations.length === 0) return bad('氣候統計檔沒有測站');
  const ids = new Set<string>();
  const stations: ClimateNormalsStation[] = [];
  for (const st of raw.stations as unknown[]) {
    if (!isObj(st) || !text(st.id) || !text(st.name)) return bad('測站缺少代碼或名稱');
    if (ids.has(st.id)) return bad(`測站代碼重複：${st.id}`);
    ids.add(st.id);
    if (!num(st.lat, 21.5, 26.5) || !num(st.lon, 118, 122.5)) return bad(`測站座標不合法：${st.id}`);
    if (!Array.isArray(st.months) || st.months.length !== 12) return bad(`測站月資料不是十二個月：${st.id}`);
    const months: ClimateNormalsMonth[] = [];
    st.months.forEach((m: unknown, i: number) => {
      if (!isObj(m) || m.month !== i + 1) return bad(`測站月份順序不符：${String(st.id)}`);
      if (!num(m.avgTemp, -30, 50) || !num(m.avgHigh, -30, 50) || !num(m.avgLow, -30, 50) || !num(m.precip, 0, 5000)) {
        return bad(`測站月數值不合法：${String(st.id)} ${i + 1} 月`);
      }
      if (m.avgHigh < m.avgLow) return bad(`測站平均最高低於平均最低：${String(st.id)} ${i + 1} 月`);
      if (m.avgTemp < m.avgLow || m.avgTemp > m.avgHigh) return bad(`測站平均氣溫不在平均最低與最高之間：${String(st.id)} ${i + 1} 月`);
      months.push({ month: i + 1, avgTemp: m.avgTemp, avgHigh: m.avgHigh, avgLow: m.avgLow, precip: m.precip });
    });
    stations.push({ id: st.id, name: st.name, lat: st.lat as number, lon: st.lon as number, months });
  }
  return {
    format: CLIMATE_NORMALS_FORMAT,
    generatedAt: raw.generatedAt,
    source: { provider: s.provider, dataset: s.dataset, datasetPage: s.datasetPage, license: s.license, licenseUrl: s.licenseUrl, attribution: s.attribution },
    period: { startYear: p.startYear as number, endYear: p.endYear as number },
    stations,
  };
}

export function parseClimateNormalsText(textBody: string): ClimateNormalsFile {
  if (textBody.length > MAX_CLIMATE_NORMALS_CHARS) return bad('氣候統計檔過大');
  let raw: unknown;
  try {
    raw = JSON.parse(textBody);
  } catch {
    return bad('氣候統計檔不是有效的 JSON');
  }
  return parseClimateNormals(raw);
}

/** 鄉鎮 → 測站代碼對照檔（離線腳本產生，隨 App 靜態提供） */
export interface RegionStationMap {
  /** regionId → stationId */
  stations: Record<string, string>;
}

export function parseRegionStationMap(raw: unknown): RegionStationMap {
  if (!isObj(raw) || !isObj(raw.stations)) return bad('鄉鎮測站對照表格式不符');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.stations)) {
    if (!text(v)) return bad(`鄉鎮測站對照表的值不合法：${k}`);
    out[k] = v;
  }
  if (Object.keys(out).length === 0) return bad('鄉鎮測站對照表是空的');
  return { stations: out };
}

/**
 * 以測站月平均換成 ClimateMonthly（缺件的季節判斷用）。
 * 月平均資料沒有「降雨日數」，rainDays 一律 0：雨天相關建議維持關閉（保守預設），不用降水量去猜天數。
 * 測站不在檔內（對照表與資料檔不同步）回空陣列，不猜、不退到別的測站。
 */
export function monthlyFromNormals(file: ClimateNormalsFile, stationId: string, countyCode: string): ClimateMonthly[] {
  const st = file.stations.find((x) => x.id === stationId);
  if (!st) return [];
  return st.months.map((m) => ({ countyCode, month: m.month, avgHigh: m.avgHigh, avgLow: m.avgLow, rainDays: 0 }));
}
