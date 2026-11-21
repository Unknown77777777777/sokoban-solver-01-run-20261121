// Sokoban solver for sokoban-solver-01-run-20261121.
// Written from scratch. Strategy: the level is a hallway with independent
// rooms off it (a box pushed into the hallway can never come back), so each
// room is solved push-optimally on its own with A* over pushes, and the
// rooms are joined by plain walks through the hallway.
//
// Per room: state = sorted box squares + the player's reachable region
// (named by its lowest square). Heuristic = minimum-cost assignment of
// boxes to goals over BFS distances (admissible: one push moves one box by
// one square). Deadlock pruning: dead squares (pull-back from the goals)
// and frozen 2x2 blocks. All budgets are counts of work, never the clock,
// and every tie is broken by fixed order, so runs are byte-identical.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budgets (counts of expanded states, never wall time).
const MAX_EXPAND = 1_000_000;

type Dir = [number, number, string, string];
const DIRS: Dir[] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

// Squares from which a lone box can be pushed onto some goal, found by
// pulling boxes back from the goals over open floor. A box off a live
// square is dead: no push sequence can ever save it.
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

// BFS distances from every floor square to each goal (walls only, boxes
// ignored): dist[goalIdx][square]. -1 means unreachable.
function goalDistances(level: Level): Int32Array[] {
  const { w, wall, goals } = level;
  const out: Int32Array[] = [];
  for (const g of goals) {
    const dist = new Int32Array(wall.length).fill(-1);
    const queue = [g];
    dist[g] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi]!;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (!wall[q] && dist[q] < 0) {
          dist[q] = dist[p]! + 1;
          queue.push(q);
        }
      }
    }
    out.push(dist);
  }
  return out;
}

// Minimum-cost assignment of boxes to goals over the distance table.
// n <= 4 here, so plain permutation search is exact and cheap. Returns
// Infinity when some box cannot reach any goal.
function assignmentCost(boxes: number[], dists: Int32Array[]): number {
  const n = boxes.length;
  const m = dists.length;
  if (n === 0) return 0;
  if (n > m) return Infinity;
  // Cost matrix, then brute-force permutations of goals.
  const cost: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < m; j++) row.push(dists[j]![boxes[i]!]!);
    cost.push(row);
  }
  let best = Infinity;
  const used = new Array<boolean>(m).fill(false);
  const rec = (i: number, acc: number): void => {
    if (acc >= best) return;
    if (i === n) {
      best = acc;
      return;
    }
    for (let j = 0; j < m; j++) {
      if (used[j]) continue;
      const c = cost[i]![j]!;
      if (c < 0) continue;
      used[j] = true;
      rec(i + 1, acc + c);
      used[j] = false;
    }
  };
  rec(0, 0);
  return best;
}

// The player's reachable region from `from` with `occupied` in the way:
// marks `seen` with `stamp` and returns the region's lowest square.
function reach(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

// Whether the box just pushed to `t` sits in a frozen 2x2 block of walls
// and boxes holding a box off its goal.
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

// Shortest walk from `from` to `to` around walls and boxes, lower LURD
// letters, first direction first on ties (deterministic).
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

// Push-optimal solution of `level` (boxes onto goals) with A* over pushes,
// or null when the state budget runs out. `useHeuristic` false degrades to
// uniform-cost search (the fallback when the heuristic run gives up).
function solvePushOptimal(level: Level, useHeuristic: boolean, maxExpand = MAX_EXPAND): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;
  const dists = goalDistances(level);
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);

  const keyOf = (boxes: number[], low: number): number => {
    let k = low;
    for (const b of boxes) k = k * 1024 + b;
    return k;
  };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // States: boxes, player square, parent, push (from -> to).
  const stBoxes: number[][] = [level.boxes];
  const stPlayer: number[] = [level.player];
  const stParent: number[] = [-1];
  const stFrom: number[] = [-1];
  const stTo: number[] = [-1];
  const stG: number[] = [0];
  const best = new Map<number, number>();
  for (const b of level.boxes) occupied[b] = 1;
  best.set(keyOf(level.boxes, reach(level, occupied, level.player, seen, ++stamp, stack)), 0);
  for (const b of level.boxes) occupied[b] = 0;

  // Binary heap on (f, h, insertion order): deterministic ties.
  interface HeapEntry { f: number; h: number; ord: number; s: number }
  const heap: HeapEntry[] = [];
  const h0 = useHeuristic ? assignmentCost(level.boxes, dists) : 0;
  if (h0 === Infinity) return null;
  let ord = 0;
  const heapLess = (a: HeapEntry, b: HeapEntry): boolean =>
    a.f < b.f || (a.f === b.f && (a.h < b.h || (a.h === b.h && a.ord < b.ord)));
  const heapPush = (e: HeapEntry): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      const tmp = heap[i]!; heap[i] = heap[p]!; heap[p] = tmp;
      i = p;
    }
  };
  const heapPop = (): HeapEntry => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        const tmp = heap[i]!; heap[i] = heap[c]!; heap[c] = tmp;
        i = c;
      }
    }
    return top;
  };
  heapPush({ f: h0, h: h0, ord: ord++, s: 0 });

  let found = solved(level.boxes) ? 0 : -1;
  let expanded = 0;
  while (heap.length > 0 && found < 0) {
    const cur = heapPop();
    const s = cur.s;
    const boxes = stBoxes[s]!;
    if (best.get(keyOf(boxes, reach(level, (() => { for (const b of boxes) occupied[b] = 1; return occupied; })(), stPlayer[s]!, seen, ++stamp, stack))) !== s) {
      for (const b of boxes) occupied[b] = 0;
      continue;
    }
    // Recompute the region stamp properly for expansion: the check above
    // already marked the region with a fresh stamp; reuse it.
    const here = stamp;
    for (const b of boxes) occupied[b] = 0;
    expanded++;
    if (expanded > maxExpand) return null;
    for (const b of boxes) occupied[b] = 1;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key = -1;
        let next: number[] | null = null;
        let h = 0;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, b2) => a - b2);
          key = keyOf(next, reach(level, occupied, b, mark, ++stamp, stack));
          h = useHeuristic ? assignmentCost(next, dists) : 0;
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || next === null || h === Infinity) continue;
        const g = stG[s]! + 1;
        const prevBest = best.get(key);
        if (prevBest !== undefined && stG[prevBest]! <= g) continue;
        const ns = stBoxes.length;
        best.set(key, ns);
        stBoxes.push(next);
        stPlayer.push(b);
        stParent.push(s);
        stFrom.push(b);
        stTo.push(t);
        stG.push(g);
        heapPush({ f: g + h, h, ord: ord++, s: ns });
        if (solved(next)) {
          found = ns;
          break;
        }
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  const path: number[] = [];
  for (let s = found; s > 0; s = stParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const nextBoxes = stBoxes[s]!;
    const from = stFrom[s]!;
    const to = stTo[s]!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

// The level's rooms: cut the dead squares of the player's row (the
// hallway: a box there reaches no goal) out of the floor; each remaining
// part holding boxes is a room. Null when the level is no set of rooms.
function roomsOf(level: Level): { squares: number[]; boxes: number[]; goals: number[] }[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: { squares: number[]; boxes: number[]; goals: number[] }[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

// BFS walking distance from `from` to the nearest square of `targets`
// (walls and `occupied` boxes in the way); Infinity when unreachable.
function walkDist(level: Level, occupied: Uint8Array, from: number, targets: Set<number>): number {
  const { w, wall } = level;
  const dist = new Int32Array(wall.length).fill(-1);
  const queue = [from];
  dist[from] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (targets.has(p)) return dist[p]!;
    for (const [dx, dy] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || dist[q] >= 0) continue;
      dist[q] = dist[p]! + 1;
      queue.push(q);
    }
  }
  return Infinity;
}

function solveLevel(level: Level): string {
  const rooms = roomsOf(level);
  if (rooms === null) {
    const whole = solvePushOptimal(level, true) ?? solvePushOptimal(level, false);
    return whole === null ? '' : whole.moves;
  }
  // Order rooms greedily by walking distance from where the player stands;
  // walking costs no pushes, so any feasible order scores the same.
  const remaining = rooms.slice();
  const done: { squares: number[]; boxes: number[]; goals: number[] }[] = [];
  let player = level.player;
  let moves = '';
  const occupied = new Uint8Array(level.wall.length);
  while (remaining.length > 0) {
    for (const b of level.boxes) occupied[b] = 0;
    for (const r of done) for (const g of r.goals) occupied[g] = 1;
    for (const r of remaining) for (const b of r.boxes) occupied[b] = 1;
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = walkDist(level, occupied, player, new Set(remaining[i]!.squares));
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const room = remaining.splice(bestIdx, 1)[0]!;
    // Sub-level: other rooms' boxes (on their goals once done) are walls.
    const wall = level.wall.slice();
    for (const r of done) for (const g of r.goals) wall[g] = 1;
    for (const r of remaining) for (const b of r.boxes) wall[b] = 1;
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushOptimal(sub, true) ?? solvePushOptimal(sub, false);
    if (solved === null) return '';
    moves += solved.moves;
    // Advance the player and the room's boxes to their new squares.
    let p = player;
    const boxes = room.boxes.slice();
    for (const ch of solved.moves) {
      const d = ch === 'u' || ch === 'U' ? -level.w : ch === 'd' || ch === 'D' ? level.w : ch === 'l' || ch === 'L' ? -1 : 1;
      const q = p + d;
      const at = boxes.indexOf(q);
      if (at >= 0) boxes[at] = q + d;
      p = q;
    }
    player = p;
    room.boxes = boxes;
    done.push(room);
  }
  return moves;
}

// Replay check: the moves must be legal and end with every box on a goal.
function replayValid(level: Level, moves: string): boolean {
  const { w, wall, goals } = level;
  const goal = new Set(goals);
  const boxes = new Set(level.boxes);
  let p = level.player;
  for (const ch of moves) {
    const d = ch === 'u' || ch === 'U' ? -w : ch === 'd' || ch === 'D' ? w : ch === 'l' || ch === 'L' ? -1 : 1;
    const q = p + d;
    if (wall[q]) return false;
    if (boxes.has(q)) {
      const t = q + d;
      if (wall[t] || boxes.has(t)) return false;
      boxes.delete(q);
      boxes.add(t);
    }
    p = q;
  }
  for (const b of boxes) if (!goal.has(b)) return false;
  return true;
}

function solve(text: string): string {
  const level = parseLevel(text);
  const moves = solveLevel(level);
  if (moves === '') return '';
  if (!replayValid(level, moves)) return '';
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
