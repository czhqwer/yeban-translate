import { invalid, TranslationError } from './errors';

const POSITION_ENTRY = 'yebanFloatingPosition';

/** 单独保存浮球的纵向比例，避免与服务配置混用存储项。 */
export class FloatingPositionStore {
  private current = 0.5;
  private revision = 0;
  private loading?: Promise<void>;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly local: chrome.storage.StorageArea) {}

  /** 调用方完成 TRUSTED_CONTEXTS 设置后才能加载；读取失败沿用默认位置。 */
  initialize(): Promise<void> {
    if (this.loading) return this.loading;
    const revision = this.revision;
    this.loading = (async () => {
      try {
        const stored = (await this.local.get(POSITION_ENTRY))[POSITION_ENTRY];
        // 慢读取不能覆盖已经成功保存的新位置。
        if (revision === this.revision && this.valid(stored)) this.current = stored;
      } catch { /* 位置恢复失败不阻断翻译和页面初始化。 */ }
    })();
    return this.loading;
  }

  /** 只公开最后确认保存成功的位置。 */
  value(): number { return this.current; }

  /** 串行落盘，写入失败不改变已确认的位置，也不阻断下一次保存。 */
  set(position: unknown): Promise<number> {
    if (!this.valid(position)) invalid('浮球位置必须是 0 至 1 之间的数值。');
    const operation = this.saving.then(async () => {
      try { await this.local.set({ [POSITION_ENTRY]: position }); }
      catch { throw new TranslationError('FLOATING_POSITION_SAVE', '浮球位置未能保存，刷新后可能恢复之前的位置。', true); }
      this.current = position;
      this.revision++;
      return position;
    });
    this.saving = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private valid(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1; }
}
