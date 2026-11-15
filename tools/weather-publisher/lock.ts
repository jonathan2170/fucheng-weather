// 輸出檔的寫入鎖：讀上一版、判定、抓取、寫入整段在同一把鎖內（CLAUDE.md「多分頁與鎖」第 1 點）。
//
// 協定：**鎖只有持有者自己能移除，沒有「過期接手」。**
// 前幾版靠「判定過期 → 搬走」讓死掉的持有者不會卡住鎖，但「判定」與「搬走」是兩個系統呼叫，
// Node 沒有 flock，兩者之間世代可以換掉（審查連續指出的 HIGH 都是這個根因）。拿掉接手，
// 這一整類競態就不存在：持有期間沒有任何人會搬動、刪除或取代鎖，所以
// 釋放不需要先驗代號、提交不需要防世代被換。
// - 同一程序內的多個實體：依鎖路徑排隊（記憶體佇列），排隊時間與檔案鎖等待共用同一個期限。
// - 取鎖：先在旁邊建好完整的鎖資料夾（內有 owner 診斷檔與本世代專屬的 stage 檔），再 rename 成鎖路徑。
//   目標已存在（非空）就失敗，所以同時只有一個持有者；取鎖成功時資料夾內容一定齊全。
// - 等不到（逾時）→ 丟 write 錯誤，呼叫端保留上一版，不寫檔、不動別人的鎖。
// - 提交：新內容以 writeFile 寫完整進 stage 檔（不靠單次 write），再 rename 到目標（同檔案系統內原子換檔）。
// - 釋放：把鎖資料夾 rename 到唯一的墳場名再刪。釋放失敗不改變 fn 的結果；搬走成功但刪不掉只留下墳場資料夾（鎖已釋放）。
// **已知限制（取捨）**：持有者程序若在持鎖時當掉（kill -9、斷電），鎖會一直留著，後續發布全部逾時回 kept(write)，
// 直到人工刪除鎖資料夾（錯誤訊息會指出路徑）。這是為了「絕不讓兩個寫入者同時進入」所選的 fail closed；
// 氣候統計是每月更新的資料，卡住只會讓資料維持上一版。
// 鎖相關的資料夾名稱以 "." 開頭、不以 ".tmp" 結尾，不會被 sweepTemp 清掉。

import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { PublisherError } from './cwa.ts';

export interface LockOptions {
  /** 最多等多久（預設 20 分鐘，含排隊）；逾時丟 write 錯誤，呼叫端保留上一版 */
  waitMs?: number;
  pollMs?: number;
  /** 測試用：取代最後的刪資料夾動作，用來模擬釋放失敗 */
  removeImpl?: (target: string) => Promise<void>;
  /** 測試用：換掉同程序佇列的鎖，模擬「另一個程序」（不會排在同一個佇列後面） */
  queueKey?: string;
}

export interface HeldLock {
  /** 寫完整內容再 rename 提交；失敗丟 write 錯誤、目標不動。只能呼叫一次。 */
  commit(target: string, body: string): Promise<void>;
}

const OWNER_FILE = 'owner';
const DEFAULTS = { waitMs: 20 * 60_000, pollMs: 250 };
const queues = new Map<string, Promise<void>>();

type Resolved = Required<Omit<LockOptions, 'removeImpl' | 'queueKey'>> & Pick<LockOptions, 'removeImpl'>;

const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
const fail = (error: unknown, what: string) => new PublisherError('write', `${what}（${error instanceof Error ? error.name : 'unknown'}）`);
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rmDir = (target: string) => rm(target, { recursive: true, force: true });
const RACE = new Set(['ENOENT', 'ENOTEMPTY', 'EEXIST']);

interface Acquired {
  stage: FileHandle;
  stageName: string;
}

async function tryCreate(lockPath: string): Promise<Acquired | null> {
  const token = randomUUID();
  const stageName = `stage-${token}`;
  const tmp = `${lockPath}.new-${token}`;
  let stage: FileHandle | undefined;
  try {
    await mkdir(tmp);
    const owner = await open(path.join(tmp, OWNER_FILE), 'w');
    try {
      await owner.writeFile(`${token} pid=${process.pid}`, 'utf8');
    } finally {
      await owner.close();
    }
    stage = await open(path.join(tmp, stageName), 'w');
    await rename(tmp, lockPath);
    return { stage, stageName };
  } catch (e) {
    await stage?.close().catch(() => undefined);
    await rmDir(tmp).catch(() => undefined);
    if (RACE.has(code(e) ?? '')) return null; // 別人已持有
    throw fail(e, '無法建立寫入鎖');
  }
}

async function acquire(lockPath: string, o: Resolved, deadline: number): Promise<Acquired> {
  const timeout = () => new PublisherError('write', `等待寫入鎖逾時（另一個發布程序仍持有鎖；若確定它已不在執行，請人工刪除 ${lockPath}）`);
  for (;;) {
    // 每次嘗試前都檢查期限：醒來時已逾時就不取鎖（就算鎖剛好空了）
    if (Date.now() > deadline) throw timeout();
    const got = await tryCreate(lockPath);
    if (got) return got;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timeout();
    await sleepMs(Math.min(o.pollMs, remaining));
  }
}

export async function withWriteLock<T>(lockPath: string, fn: (lock: HeldLock) => Promise<T>, options: LockOptions = {}): Promise<T> {
  const o: Resolved = { ...DEFAULTS, ...options };
  const deadline = Date.now() + o.waitMs;
  const key = options.queueKey ?? lockPath;
  // 佇列：prev 永遠不會 reject。我們的位置在 prev 之後；就算我們逾時離開，後面的人仍排在 prev 之後。
  const prev = queues.get(key) ?? Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>((r) => (done = r));
  const tail = prev.then(() => mine);
  queues.set(key, tail);
  try {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PublisherError('write', '等待寫入鎖逾時（同程序內仍有發布在進行）')), Math.max(0, deadline - Date.now()));
    });
    try {
      await Promise.race([prev, timedOut]);
    } finally {
      clearTimeout(timer);
    }
    const held = await acquire(lockPath, o, deadline);
    let committed = false;
    const lock: HeldLock = {
      async commit(target, body) {
        if (committed) throw new PublisherError('write', '寫入鎖只能提交一次');
        committed = true;
        try {
          await held.stage.truncate(0);
          await held.stage.writeFile(body, 'utf8'); // 寫完全部位元組（write() 可能短寫）才提交
          await rename(path.join(lockPath, held.stageName), target);
        } catch (e) {
          throw new PublisherError('write', `寫入失敗，放棄寫入（${e instanceof Error ? e.name : 'unknown'}）`);
        }
      },
    };
    try {
      return await fn(lock);
    } finally {
      // 持有期間沒有人會動鎖，釋放不需要驗世代。失敗不蓋掉 fn 的結果。
      await held.stage.close().catch(() => undefined);
      const grave = `${lockPath}.rel-${randomUUID()}`;
      try {
        await rename(lockPath, grave);
        await (o.removeImpl ?? rmDir)(grave);
      } catch {
        /* 搬走失敗：鎖殘留（逾時訊息會指出路徑）；搬走成功但刪不掉：鎖已釋放，只留墳場資料夾 */
      }
    }
  } finally {
    done();
    if (queues.get(key) === tail) queues.delete(key);
  }
}
