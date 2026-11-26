/**
 * Unit tests for the client-side movement bookkeeping.
 *
 * Reproduces the scenario from the bug report: holding right+down, with no
 * echo written back to the canvas for three consecutive ticks. The old code
 * read the (unchanged) canvas position back and sent (105,105) three times;
 * the accumulator must instead advance one +5/+5 step per tick with its own
 * monotonic seq.
 */
import assert from 'node:assert';
import { describe, it } from 'node:test';

import { MovementController, MOVE_INTERVAL_MS, MOVE_SPEED } from '../src/movement.ts';

describe('MovementController', () => {
  it('uses the 30Hz tick interval and a 5px step', () => {
    assert.equal(MOVE_INTERVAL_MS, 1000 / 30);
    assert.equal(MOVE_SPEED, 5);
  });

  it('starts the accumulator at the spawn point and numbers packets from 1', () => {
    const movement = new MovementController(100, 100);

    const first = movement.sample(5, 5)!;
    assert.deepStrictEqual(first, { seq: 1, x: 105, y: 105 });

    const second = movement.sample(5, 5)!;
    assert.deepStrictEqual(second, { seq: 2, x: 110, y: 110 });
  });

  it('keeps advancing while no echo returns — three ticks, three distinct steps', () => {
    // After 20 acknowledged presses the circle sits at (100,100). The next
    // three ticks happen before any echo comes back.
    const movement = new MovementController(100, 100);

    const s21 = movement.sample(5, 5)!;
    const s22 = movement.sample(5, 5)!;
    const s23 = movement.sample(5, 5)!;

    assert.deepStrictEqual(s21, { seq: 1, x: 105, y: 105 });
    assert.deepStrictEqual(s22, { seq: 2, x: 110, y: 110 });
    assert.deepStrictEqual(s23, { seq: 3, x: 115, y: 115 });
    assert.equal(movement.pendingCount, 3);
  });

  it('does not consume a seq for an idle tick', () => {
    const movement = new MovementController(100, 100);
    assert.equal(movement.sample(0, 0), null);
    assert.equal(movement.pendingCount, 0);

    const next = movement.sample(5, 5)!;
    assert.equal(next.seq, 1);
  });

  it('reconciles echoes in order, dropping every packet up to the acknowledged one', () => {
    const movement = new MovementController(100, 100);
    movement.sample(5, 5); // seq 1 -> (105,105)
    movement.sample(5, 5); // seq 2 -> (110,110)
    movement.sample(5, 5); // seq 3 -> (115,115)

    // Room replays 21, then 22, then 23.
    movement.reconcile(105, 105);
    assert.equal(movement.pendingCount, 2);
    movement.reconcile(110, 110);
    assert.equal(movement.pendingCount, 1);
    movement.reconcile(115, 115);
    assert.equal(movement.pendingCount, 0);

    // The accumulator stays at the authoritative tip; the next press is +5
    // from there, never restarting from a stale canvas position.
    const next = movement.sample(5, 5)!;
    assert.deepStrictEqual(next, { seq: 4, x: 120, y: 120 });
  });

  it('snaps to an authoritative position that matches no pending packet', () => {
    const movement = new MovementController(100, 100);
    movement.sample(5, 5); // (105,105) in flight

    // e.g. a cloud-save restore moved us server-side.
    movement.reconcile(200, 300);
    assert.equal(movement.pendingCount, 0);
    assert.equal(movement.currentX, 200);
    assert.equal(movement.currentY, 300);

    const next = movement.sample(5, 5)!;
    assert.deepStrictEqual(next, { seq: 2, x: 205, y: 305 });
  });

  it('reset() restarts the accumulator and sequence at a new spawn point', () => {
    const movement = new MovementController(100, 100);
    movement.sample(5, 5);
    movement.reset(0, 0);
    assert.equal(movement.pendingCount, 0);
    assert.deepStrictEqual(movement.sample(5, 5)!, { seq: 1, x: 5, y: 5 });
  });
});
