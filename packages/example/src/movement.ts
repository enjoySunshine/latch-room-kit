/**
 * Client-side movement bookkeeping.
 *
 * Two problems this fixes:
 *
 *  1. Every move packet carries a monotonic `seq`, so the room can drop a
 *     late, lower-seq packet instead of letting it overwrite a newer
 *     position ("序号更小的包晚到，不能覆盖序号更大的落点").
 *
 *  2. The next target is computed from a local accumulator (`x`/`y`), NOT
 *     from the circle's current canvas position. While an echo is in
 *     flight the canvas stays put, so reading the canvas back would send
 *     the same (x, y) three times in a row and — once those packets land —
 *     collapse three key presses into one jump. The accumulator keeps
 *     advancing one step (+5/+5) per tick regardless of echo timing.
 *
 * The canvas itself stays a pure view of room state: it only ever renders
 * coordinates the room wrote, so the two readings (room current position
 * and canvas circle center) are always the same number.
 */

export const MOVE_SPEED = 5;
export const MOVE_INTERVAL_MS = 1000 / 30;

export interface MoveInput {
  x: number;
  y: number;
}

export interface MoveSample extends MoveInput {
  seq: number;
}

export class MovementController {
  /** Last position acknowledged by the room (echo), or the spawn point. */
  private baseX: number;
  private baseY: number;

  /** Local accumulator: target of the last packet we sent. */
  private x: number;
  private y: number;

  /** Monotonic packet sequence, starting at 1 (the 20th press sends seq 20). */
  private seq = 0;

  /** Packets sent but not yet seen echoed back, in send order. */
  private pending = new Map<number, MoveInput>();

  constructor(startX = 0, startY = 0) {
    this.baseX = this.x = startX;
    this.baseY = this.y = startY;
  }

  get currentX(): number {
    return this.x;
  }

  get currentY(): number {
    return this.y;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Produce one sequenced move for this tick. Returns `null` when the
   * pressed keys resolve to no movement, so no packet (and no seq) is
   * consumed for an idle tick.
   */
  sample(dx: number, dy: number): MoveSample | null {
    if (dx === 0 && dy === 0) {
      return null;
    }

    this.x += dx;
    this.y += dy;

    const sample: MoveSample = { seq: ++this.seq, x: this.x, y: this.y };
    this.pending.set(sample.seq, { x: sample.x, y: sample.y });
    return sample;
  }

  /**
   * Reconcile the accumulator with an authoritative position the room
   * wrote to the canvas. Echoes normally match one of our own pending
   * packets: drop everything up to and including it — the room has
   * confirmed that much of our trajectory (105, then 110, then 115).
   *
   * A coordinate that matches no pending packet means the room moved us
   * for another reason (reconnection, cloud save, …): snap the whole
   * accumulator to it instead of fighting the authoritative state.
   */
  reconcile(authoritativeX: number, authoritativeY: number): void {
    let acknowledgedSeq: number | undefined;
    for (const [seq, target] of this.pending) {
      if (target.x === authoritativeX && target.y === authoritativeY) {
        acknowledgedSeq = seq;
        break;
      }
    }

    if (acknowledgedSeq !== undefined) {
      for (const seq of [...this.pending.keys()]) {
        this.pending.delete(seq);
        if (seq === acknowledgedSeq) {
          break;
        }
      }
      this.baseX = authoritativeX;
      this.baseY = authoritativeY;
    } else {
      this.pending.clear();
      this.baseX = this.x = authoritativeX;
      this.baseY = this.y = authoritativeY;
    }
  }

  /** Forget every in-flight packet and restart from an authoritative spot. */
  reset(startX: number, startY: number): void {
    this.pending.clear();
    this.baseX = this.x = startX;
    this.baseY = this.y = startY;
    this.seq = 0;
  }
}
