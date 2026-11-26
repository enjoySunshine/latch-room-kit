/**
 * Server-side ordering tests for the "move" message.
 *
 * Drives the real MyRoom over a real WebSocket so the exact bug-report
 * scenario is covered end-to-end:
 *
 *   - holding right+down, 20 in-order presses of (+5,+5) leave the circle
 *     framed at (100,100), each step numbered with its own monotonic seq
 *   - the next three packets (21 -> 105,105 / 22 -> 110,110 / 23 -> 115,115)
 *     arrive at the room in the order 22, 23, 21
 *   - the room buffers the gap and, once 21 lands, replays every buffered
 *     seq in order so the circle walks 105 -> 110 -> 115 with no skipped cell
 *   - a late, lower-seq packet must never pull the circle backwards
 *   - other players' circles and this player's score stay untouched
 *
 * Each scenario joins its own room so the seq/position baseline is always
 * exact and tests never share drifting state. The canvas on the page is a
 * pure view of `room.state.players`, so these state assertions are the same
 * numbers the circle center (radius 12) would render.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'move-order-secret';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'move-order-session';
process.env.NODE_ENV = 'test';

import assert from 'node:assert';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate the sqlite file so the test never touches a dev colyseus.db.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'move-order-'));
process.env.DATABASE_URL = path.join(tmpDir, 'test.db');
process.chdir(tmpDir);

const { defineServer, defineRoom } = await import('@colyseus/core');
const { listen } = await import('@colyseus/tools');
const { Client } = await import('@colyseus/sdk');
const { DatabaseDriver } = await import('@colyseus/database');
const { MyRoom } = await import('../src/MyRoom.ts');
const { database } = await import('../src/db/database.ts');

/** Reserve a free TCP port, then release it for the server to bind. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

const server = defineServer({
  // MyRoom's analytics / cloud-save / leaderboard plugins need a booted
  // database; it uses the isolated DATABASE_URL set above.
  database,
  driver: new DatabaseDriver({ database }),
  rooms: {
    my_room: defineRoom(MyRoom),
  },
});

let client: InstanceType<typeof Client>;
let port: number;
type JoinedRoom = Awaited<ReturnType<InstanceType<typeof Client>['joinOrCreate']>>;
const rooms: JoinedRoom[] = [];

/** Wait until `predicate` holds against the room's replicated state. */
async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) { return; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

/** The initial ROOM_STATE lands a round-trip after join resolves. */
async function waitForInitialState(joinedRoom: JoinedRoom): Promise<void> {
  await waitFor(() => joinedRoom.state?.players?.size > 0);
}

/** Join a fresh room pinned at (x,y); every scenario gets an isolated one. */
async function joinRoom(x: number, y: number): Promise<JoinedRoom> {
  const joined = await client.joinOrCreate('my_room', { x, y });
  await waitForInitialState(joined);
  rooms.push(joined);
  return joined;
}

const me = (joined: JoinedRoom) => joined.state.players.get(joined.sessionId);

/**
 * Drive the 20 in-order presses that frame the report's starting point.
 * They keep the circle on (100,100) while advancing the room's
 * lastAppliedSeq to 20, so the next frontier packet is seq 21 exactly as in
 * the scenario.
 */
async function establishBaseline(joined: JoinedRoom): Promise<void> {
  for (let seq = 1; seq <= 20; seq++) {
    joined.send('move', { seq, x: 100, y: 100 });
  }
  // The room patches at 20fps; wait long enough for all 20 to be confirmed.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(me(joined).x, 100);
  assert.equal(me(joined).y, 100);
}

before(async () => {
  port = await getFreePort();
  await database.boot();
  await listen(server, port);
  client = new Client(`ws://127.0.0.1:${port}`);
});

after(async () => {
  for (const joined of rooms) {
    try { await joined.leave(true); } catch { /* already gone */ }
  }
  await server.gracefullyShutdown(false);
  await database.shutdown?.().catch(() => { /* nothing to close */ });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('move ordering', () => {
  it('pins the spawn at (100,100): the position after 20 acknowledged presses', async () => {
    const joined = await joinRoom(100, 100);
    assert.equal(me(joined).x, 100);
    assert.equal(me(joined).y, 100);
  });

  it('20 in-order (+5,+5) presses each land one cell apart and keep their own seq', async () => {
    const joined = await joinRoom(0, 0);
    let seq = 0;
    let x = 0;
    let y = 0;
    for (let i = 0; i < 20; i++) {
      x += 5;
      y += 5;
      joined.send('move', { seq: ++seq, x, y });
      const tx = x;
      const ty = y;
      await waitFor(() => me(joined).x === tx && me(joined).y === ty);
    }
    assert.equal(seq, 20);
    assert.equal(me(joined).x, 100);
    assert.equal(me(joined).y, 100);
  });

  it('arrival 22 -> 23 -> 21: buffers the gap, then replays 105 -> 110 -> 115', async () => {
    const joined = await joinRoom(100, 100);
    await establishBaseline(joined); // lastAppliedSeq = 20 at (100,100)

    // Arrival order at the room: 22, then 23, then 21.
    joined.send('move', { seq: 22, x: 110, y: 110 });
    joined.send('move', { seq: 23, x: 115, y: 115 });

    // While 21 is missing, the circle must not jump (no skipped 105 cell).
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(me(joined).x, 100, '22/23 must stay buffered while 21 is missing');
    assert.equal(me(joined).y, 100);

    // 21 lands last; the room now replays the whole batch in seq order.
    joined.send('move', { seq: 21, x: 105, y: 105 });
    await waitFor(() => me(joined).x === 115 && me(joined).y === 115);

    // Final landing: walked 105 -> 110 -> 115, radius unchanged, no rollback.
    assert.equal(me(joined).x, 115);
    assert.equal(me(joined).y, 115);
  });

  it('after all three settle, a re-sent 21 cannot pull the circle back to 105', async () => {
    const joined = await joinRoom(100, 100);
    await establishBaseline(joined);
    joined.send('move', { seq: 21, x: 105, y: 105 });
    joined.send('move', { seq: 22, x: 110, y: 110 });
    joined.send('move', { seq: 23, x: 115, y: 115 });
    await waitFor(() => me(joined).x === 115 && me(joined).y === 115);

    // The report's late 21, re-delivered after 23 is applied.
    joined.send('move', { seq: 21, x: 105, y: 105 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(me(joined).x, 115, 'late seq 21 must not overwrite the 115 landing');
    assert.equal(me(joined).y, 115);
  });

  it('duplicate packets are ignored and keep the circle put', async () => {
    const joined = await joinRoom(100, 100);
    await establishBaseline(joined);
    joined.send('move', { seq: 21, x: 105, y: 105 });
    await waitFor(() => me(joined).x === 105);
    joined.send('move', { seq: 21, x: 105, y: 105 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(me(joined).x, 105);
    assert.equal(me(joined).y, 105);
  });

  it('the next frontier after a closed gap applies immediately', async () => {
    const joined = await joinRoom(100, 100);
    await establishBaseline(joined);
    joined.send('move', { seq: 22, x: 110, y: 110 }); // buffered (21 missing)
    joined.send('move', { seq: 21, x: 105, y: 105 }); // closes the gap
    await waitFor(() => me(joined).x === 110);
    joined.send('move', { seq: 23, x: 115, y: 115 });
    await waitFor(() => me(joined).x === 115 && me(joined).y === 115);
  });

  it('movement never changes the score', async () => {
    const joined = await joinRoom(100, 100);
    await establishBaseline(joined);
    const scoreBefore = me(joined).score;
    joined.send('move', { seq: 21, x: 105, y: 105 });
    await waitFor(() => me(joined).x === 105);
    assert.equal(me(joined).score, scoreBefore);
  });

  it('other players keep their own coordinates while one player moves', async () => {
    const mover = await joinRoom(100, 100);
    await establishBaseline(mover);
    const other = await joinRoom(300, 300);
    const otherBefore = { x: me(other).x, y: me(other).y };

    mover.send('move', { seq: 21, x: 105, y: 105 });
    await waitFor(() => me(mover).x === 105);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(me(other).x, otherBefore.x);
    assert.equal(me(other).y, otherBefore.y);
  });
});
