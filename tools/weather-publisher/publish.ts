// 發布流程（任務 A4；規格 3.4、風險 6）：抓取 → 轉換 → 驗證 → 原子寫入；fail closed
//
// 規則：
// - 每個縣市獨立：抓取、轉換、驗證任何一步失敗，該縣市檔案完全不動（保留上一版，其 generatedAt 照舊，App 依規格 3.4 顯示更新較久／過期）。
// - 只有整檔驗證通過才寫入，寫入用「同資料夾暫存檔 + rename」，讀者不會看到半個檔。
// - 每次執行都更新 status.json（檢查時間、每縣市是否成功、目前對外檔案的 generatedAt、失敗類別），讓「保留上一版」看得出來。
// - 授權碼只放 Authorization 標頭；所有輸出文字都先過 redact。

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CountyFileFormat } from '../../src/weather/config.ts';
import { parseCountyFileText, type CountyFile } from '../../src/weather/county-file.ts';
import { buildCountyFile, type CountyJob } from './build.ts';
import { PublisherError, type FailureCategory } from './cwa.ts';
import {
  CWA_API_BASE,
  MAX_ATTEMPTS,
  MAX_GZIP_BYTES,
  MAX_RESPONSE_CHARS,
  OUTPUT_SUBDIR,
  PAUSE_BETWEEN_REQUESTS_MS,
  REQUEST_TIMEOUT_MS,
  RETRY_DELAYS_MS,
  STATUS_FILE,
  STATUS_FORMAT,
} from './config.ts';

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect: 'error' }) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface PublishOptions {
  apiKey: string;
  outDir: string;
  jobs: CountyJob[];
  fetchImpl?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pauseMs?: number;
  maxGzipBytes?: number;
  /** 輸出格式版本，預設 1（見 config.ts ENV_FILE_FORMAT） */
  fileFormat?: CountyFileFormat;
}

export interface CountyResult {
  countyCode: string;
  ok: boolean;
  /** 目前對外檔案的產生時間；失敗且沒有上一版時為 null */
  generatedAt: string | null;
  error?: FailureCategory;
  /** 只含不帶授權碼的簡短說明，寫在標準錯誤輸出，不寫進對外的 status.json */
  detail?: string;
  unknownTowns?: string[];
}

export interface PublishReport {
  ok: boolean;
  checkedAt: string;
  results: CountyResult[];
}

/** 授權碼是否可以安全放進標頭：非空、無空白與控制字元 */
export const isUsableApiKey = (key: string): boolean => /^[\x21-\x7e]{8,200}$/.test(key);

export const redact = (text: string, apiKey: string): string => (apiKey ? text.split(apiKey).join('[REDACTED]') : text);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

export function datasetUrl(datasetId: string): string {
  if (!/^(F-D0047|C-B0027)-\d{3}$/.test(datasetId)) throw new PublisherError('config', `資料集代碼格式不符：${datasetId}`);
  return `${CWA_API_BASE}${datasetId}?format=JSON`;
}

export async function fetchDataset(datasetId: string, o: Required<Pick<PublishOptions, 'apiKey' | 'fetchImpl' | 'sleep'>>): Promise<unknown> {
  const url = datasetUrl(datasetId);
  let last: PublisherError = new PublisherError('network', `${datasetId} 連線失敗`);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let retryable = true;
    try {
      const response = await o.fetchImpl(url, {
        headers: { Authorization: o.apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });
      if (!response.ok) {
        retryable = response.status === 429 || response.status >= 500;
        last = new PublisherError('http', `${datasetId} 回應 HTTP ${response.status}`);
      } else {
        // 內容有問題（過大、不是 JSON）不是暫時性錯誤，重試沒有意義
        retryable = false;
        // 先看 content-length，宣告過大就不讀本文
        const declared = Number(response.headers?.get('content-length') ?? NaN);
        if (Number.isFinite(declared) && declared > MAX_RESPONSE_CHARS * 4) throw new PublisherError('format', `${datasetId} 回應過大`);
        const text = await response.text();
        if (text.length > MAX_RESPONSE_CHARS) throw new PublisherError('format', `${datasetId} 回應過大`);
        try {
          return JSON.parse(text);
        } catch {
          throw new PublisherError('format', `${datasetId} 回應不是有效的 JSON`);
        }
      }
    } catch (error) {
      if (error instanceof PublisherError) throw error;
      last = new PublisherError('network', `${datasetId} 連線失敗（${error instanceof Error ? error.name : 'unknown'}）`);
    }
    if (!retryable) throw last;
    if (attempt < MAX_ATTEMPTS) await o.sleep(RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]);
  }
  throw last;
}

export async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw new PublisherError('write', `寫入 ${path.basename(file)} 失敗（${error instanceof Error ? error.name : 'unknown'}）`);
  }
}

/** 讀目前對外的縣市檔；不存在或無法解析時為 null（不影響本次結果） */
async function readPublished(file: string, countyCode: string): Promise<CountyFile | null> {
  try {
    return parseCountyFileText(await readFile(file, 'utf8'), countyCode);
  } catch {
    return null;
  }
}

export async function runPublish(options: PublishOptions): Promise<PublishReport> {
  const { apiKey, outDir, jobs } = options;
  if (!isUsableApiKey(apiKey)) throw new PublisherError('config', '授權碼未設定或格式不符');
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const pauseMs = options.pauseMs ?? PAUSE_BETWEEN_REQUESTS_MS;
  const dir = path.join(outDir, OUTPUT_SUBDIR);
  await mkdir(dir, { recursive: true });

  const results: CountyResult[] = [];
  const checkedAt = now().toISOString();
  for (const [index, job] of jobs.entries()) {
    const file = path.join(dir, `${job.countyCode}.json`);
    try {
      if (index > 0) await sleep(pauseMs);
      const forecast = await fetchDataset(job.forecast3h, { apiKey, fetchImpl, sleep });
      await sleep(pauseMs);
      const week = await fetchDataset(job.week, { apiKey, fetchImpl, sleep });
      // 目前對外的上一版（只用來逐列沿用今天的列）；單一寫入者前提見 sweepTemp
      const built = buildCountyFile(job, forecast, week, now(), options.maxGzipBytes ?? MAX_GZIP_BYTES, (await readPublished(file, job.countyCode)) ?? undefined, options.fileFormat);
      await atomicWrite(file, built.text);
      results.push({ countyCode: job.countyCode, ok: true, generatedAt: built.file.generatedAt, unknownTowns: built.unknownTowns });
    } catch (error) {
      const known = error instanceof PublisherError;
      results.push({
        countyCode: job.countyCode,
        ok: false,
        generatedAt: (await readPublished(file, job.countyCode))?.generatedAt ?? null,
        error: known ? error.category : 'internal',
        detail: redact(known ? error.message : `未預期的錯誤（${error instanceof Error ? error.name : 'unknown'}）`, apiKey),
      });
    }
  }

  const ok = results.every((r) => r.ok);
  const status = {
    format: STATUS_FORMAT,
    checkedAt,
    ok,
    counties: results.map((r) => ({
      countyCode: r.countyCode,
      ok: r.ok,
      generatedAt: r.generatedAt,
      ...(r.error ? { error: r.error } : {}),
    })),
  };
  await atomicWrite(path.join(dir, STATUS_FILE), `${JSON.stringify(status)}\n`);
  await sweepTemp(dir);
  return { ok, checkedAt, results };
}

/** 清掉先前被中斷的暫存檔（只清本程式命名規則的 .*.tmp）。前提：同一輸出資料夾同時只有一個寫入者（排程 concurrency 群組，見 MIGRATION.md） */
async function sweepTemp(dir: string): Promise<void> {
  for (const name of await readdir(dir)) if (/^\..+\.tmp$/.test(name)) await rm(path.join(dir, name), { force: true });
}
