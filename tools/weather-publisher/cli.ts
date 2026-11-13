// 天氣發布排程進入點（任務 A4）。目前沒有任何排程啟用；搬到獨立儲存庫後由該儲存庫的排程呼叫（見 MIGRATION.md）。
//
// 環境變數：CWA_AUTHORIZATION（必填，授權碼）、WEATHER_OUT_DIR（預設 ./out）、WEATHER_REGIONS_FILE（鄉鎮對照表）、WEATHER_FILE_FORMAT（1 或 2，預設 1；2 要等 App 已部署支援版本 2 才可設）
// 結束碼：0 全部縣市成功；1 至少一個縣市保留了上一版（排程平台據此寄失敗通知）；2 設定錯誤（授權碼、鄉鎮對照表），什麼都沒做；執行中的寫入錯誤也回 1。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Region } from '../../src/data/types.ts';
import { buildJobs } from './build.ts';
import { COUNTY_FILE_FORMAT, COUNTY_FILE_FORMAT_V2, type CountyFileFormat } from '../../src/weather/config.ts';
import { ENV_API_KEY, ENV_FILE_FORMAT, ENV_OUT_DIR, ENV_REGIONS_FILE } from './config.ts';
import { isUsableApiKey, redact, runPublish, type FetchLike } from './publish.ts';

export interface CliDeps {
  fetchImpl?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** 資料集對照表（測試用）；預設為 COUNTY_DATASETS */
  countyTable?: Parameters<typeof buildJobs>[1];
}

const DEFAULT_REGIONS = fileURLToPath(new URL('../../src/weather/regions-data.json', import.meta.url));

export async function main(env: Record<string, string | undefined>, deps: CliDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const apiKey = env[ENV_API_KEY] ?? '';
  if (!isUsableApiKey(apiKey)) {
    log(`未設定 ${ENV_API_KEY}（或格式不符），沒有執行任何動作。`);
    return 2;
  }
  const requested = env[ENV_FILE_FORMAT]?.trim();
  const formats: Record<string, CountyFileFormat> = { '1': COUNTY_FILE_FORMAT, '2': COUNTY_FILE_FORMAT_V2 };
  if (requested && !formats[requested]) {
    log(`設定錯誤：${ENV_FILE_FORMAT} 只能是 1 或 2，沒有執行任何動作。`);
    return 2;
  }
  const fileFormat = formats[requested || '1'];
  let jobs: ReturnType<typeof buildJobs>;
  try {
    const regionsFile = env[ENV_REGIONS_FILE] || DEFAULT_REGIONS;
    const regions = (JSON.parse(readFileSync(regionsFile, 'utf8')) as { regions: Region[] }).regions;
    jobs = buildJobs(regions, deps.countyTable);
  } catch (error) {
    log(redact(`設定錯誤：${error instanceof Error ? error.message : String(error)}`, apiKey));
    return 2;
  }
  try {
    const report = await runPublish({
      apiKey,
      outDir: path.resolve(env[ENV_OUT_DIR] || 'out'),
      jobs,
      fetchImpl: deps.fetchImpl,
      now: deps.now,
      sleep: deps.sleep,
      fileFormat,
    });
    for (const r of report.results) {
      log(
        r.ok
          ? `OK   ${r.countyCode} generatedAt=${r.generatedAt}${r.unknownTowns?.length ? ` 對照表沒有的鄉鎮：${r.unknownTowns.join('、')}` : ''}`
          : `FAIL ${r.countyCode} ${r.error}：${r.detail}（保留上一版 generatedAt=${r.generatedAt ?? '無'}）`,
      );
    }
    return report.ok ? 0 : 1;
  } catch (error) {
    // 執行中才出錯（例如寫 status.json 失敗）：縣市檔可能已經更新，不是「什麼都沒做」
    log(redact(`執行中失敗，部分縣市檔可能已更新：${error instanceof Error ? error.message : String(error)}`, apiKey));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env).then((code) => process.exit(code));
}
