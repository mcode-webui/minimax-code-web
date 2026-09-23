// webui/server/lib/ring-buffer.js
// seq 索引重放窗口（环形缓冲区）。
//
// 职责：为事件流下行帧的断线续传保留最近 capacity 条有序条目。
// 写入方为传输层（push），读取方为 resume 路径（replay）。
//
// 设计约束：
//   - 纯内存、零 npm 依赖（packages/webui 保持零依赖包）。
//   - seq 由调用方分配并保证严格递增；本模块只做单调性校验，
//     不生成、不改写 seq。
//   - 容量满时覆盖最旧条目（环形语义），replay 对被覆盖区间返回
//     complete=false，提示调用方降级为全量快照。

/**
 * 创建 seq 索引的环形重放缓冲区。
 *
 * @param {number} capacity 保留条目数上限，必须为 >=1 的整数
 * @returns {{
 *   push: (seq: number, item: unknown) => boolean,
 *   replay: (fromSeq: number) => { items: Array<{seq: number, item: unknown}>, complete: boolean },
 *   latestSeq: () => number | null,
 *   size: () => number,
 *   capacity: number,
 * }}
 */
export function createRingBuffer(capacity) {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(
      `ring-buffer: capacity must be an integer >= 1, got ${capacity}`,
    );
  }
  /** @type {Array<{seq: number, item: unknown}>} 按 seq 升序保存的条目 */
  const entries = [];

  return {
    /**
     * 追加一个条目；seq 必须严格大于当前最新 seq，否则拒绝。
     * 容量满时覆盖最旧条目。
     *
     * @param {number} seq 单调递增序列号
     * @param {unknown} item 被保留的条目（引用保存，不做拷贝）
     * @returns {boolean} 是否接受
     */
    push(seq, item) {
      // 防御性输入校验：非有限数（含 NaN）无法参与单调比较，直接拒绝
      if (!Number.isFinite(seq)) return false;
      const latest = entries.length ? entries[entries.length - 1].seq : null;
      if (latest !== null && seq <= latest) return false;
      entries.push({ seq, item });
      if (entries.length > capacity) entries.shift(); // 覆盖最旧
      return true;
    },

    /**
     * 重放 fromSeq 起（含）的全部保留条目，按 seq 升序返回。
     *
     * complete=false 表示缓冲区无法证明 [fromSeq, latestSeq] 的连续性
     * （请求起点早于最旧保留 seq，或缓冲区从未写入且 fromSeq>1），
     * 调用方应降级为全量快照。
     *
     * @param {number} fromSeq 续传起点（含）
     * @returns {{ items: Array<{seq: number, item: unknown}>, complete: boolean }}
     */
    replay(fromSeq) {
      const items = [];
      for (const e of entries) {
        if (e.seq >= fromSeq) items.push({ seq: e.seq, item: e.item });
      }
      let complete;
      if (entries.length === 0) {
        // 空缓冲（从未写入，latestSeq()===null）：
        //   fromSeq===1 无历史缺口，视为完整；否则无法证明连续性。
        complete = fromSeq === 1;
      } else {
        // 有保留条目：只有请求起点早于最旧保留 seq（已被覆盖）才不完整。
        // fromSeq===latestSeq()+1 是空重放的完整边界情形，自然涵盖。
        complete = fromSeq >= entries[0].seq;
      }
      return { items, complete };
    },

    /**
     * 最新（最大）已写入 seq；从未写入时为 null。
     *
     * @returns {number | null}
     */
    latestSeq() {
      return entries.length ? entries[entries.length - 1].seq : null;
    },

    /**
     * 当前保留条目数（0..capacity）。
     *
     * @returns {number}
     */
    size() {
      return entries.length;
    },

    capacity,
  };
}
