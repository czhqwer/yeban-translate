import type { TranslationMode } from '../shared/types';
import { cancelled } from './errors';

interface Entry<T = unknown> {
  owner: string;
  mode: TranslationMode;
  run: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  controller: AbortController;
  finished: boolean;
}

/** 每家服务共享两个请求槽位；划词优先取得下一个空闲槽。 */
export class RequestPool {
  private readonly waiting: Entry[] = [];
  private readonly active = new Set<Entry>();
  constructor(private readonly capacity = 2) {}

  enqueue<T>(owner: string, mode: TranslationMode, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiting.push({ owner, mode, run, resolve, reject, controller: new AbortController(), finished: false } as Entry);
      this.drain();
    });
  }

  /** 排队项立即移除；已发请求中止，迟到结果不再回成功。 */
  cancel(owner: string, error: unknown = cancelled()): void {
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      if (this.waiting[i].owner !== owner) continue;
      const entry = this.waiting.splice(i, 1)[0];
      entry.finished = true;
      entry.controller.abort();
      entry.reject(error);
    }
    for (const entry of this.active) {
      if (entry.owner !== owner || entry.finished) continue;
      entry.finished = true;
      entry.controller.abort();
      entry.reject(error);
    }
  }

  private drain(): void {
    while (this.active.size < this.capacity && this.waiting.length) {
      const selected = this.waiting.findIndex(entry => entry.mode === 'selection');
      const entry = this.waiting.splice(selected < 0 ? 0 : selected, 1)[0];
      this.active.add(entry);
      Promise.resolve().then(() => entry.run(entry.controller.signal)).then(value => {
        if (!entry.finished && !entry.controller.signal.aborted) { entry.finished = true; entry.resolve(value); }
      }, error => {
        if (!entry.finished) { entry.finished = true; entry.reject(error); }
      }).finally(() => { this.active.delete(entry); this.drain(); });
    }
  }
}
