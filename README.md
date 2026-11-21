# Sokoban Solver

[![LIVE](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/competitions/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Unknown77777777777/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/competitions/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Unknown77777777777/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/competitions/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver, written from scratch (Node 22, `main.ts`).

## How it works

A level is a hallway with independent rooms off it: a box pushed into the
hallway can never come back, so each room is a subproblem of its own. The
solver cuts the hallway's dead squares out of the floor, finds each room,
solves it push-optimally, and joins the rooms with plain walks through the
hallway.

Per room, an A* search over pushes: a state is the sorted box squares plus
the player's reachable region (named by its lowest square). The heuristic
is the minimum-cost assignment of boxes to goals over BFS distances
(admissible: one push moves one box by one square). Deadlock pruning uses
dead squares (pull-back from the goals) and frozen 2x2 blocks. All budgets
are counts of expanded states, never the wall clock, and every tie is broken
by fixed order, so two runs produce byte-identical output.

## Practice score

1,000,000 / 1,000,000 on the practice set: every instance solved in exactly
P* pushes (13 / 16 / 29 / 47 / 60). The house baseline (plain-astar 1.0.0)
scores 200,000 on the same set.

## Run

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads `/input/<id>/level.txt` (or `$MAKEFUN_INPUT_DIR`) and writes
`/output/<id>/solution.txt` (or `$MAKEFUN_OUTPUT_DIR`) for every instance.
