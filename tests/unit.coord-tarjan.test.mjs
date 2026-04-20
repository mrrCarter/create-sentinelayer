// Unit tests for coord/tarjan.js (#A9 SCC + deadlock detection).

import test from "node:test";
import assert from "node:assert/strict";

import { findCycles, tarjanSCC } from "../src/coord/tarjan.js";

function sortComponent(component) {
  return component.slice().sort();
}

function normalizeSCCs(sccs) {
  return sccs.map(sortComponent).sort((a, b) => {
    const left = a.join(",");
    const right = b.join(",");
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

test("tarjanSCC: empty graph returns no components", () => {
  assert.deepEqual(tarjanSCC({}), []);
});

test("tarjanSCC: singleton node has one size-1 component", () => {
  const result = tarjanSCC({ a: [] });
  assert.deepEqual(result, [["a"]]);
});

test("tarjanSCC: two-node cycle forms a single SCC", () => {
  const result = tarjanSCC({ a: ["b"], b: ["a"] });
  const normalized = normalizeSCCs(result);
  assert.deepEqual(normalized, [["a", "b"]]);
});

test("tarjanSCC: DAG produces singleton components per node", () => {
  const graph = { a: ["b"], b: ["c"], c: [] };
  const normalized = normalizeSCCs(tarjanSCC(graph));
  assert.deepEqual(normalized, [["a"], ["b"], ["c"]]);
});

test("tarjanSCC: triangle cycle detected", () => {
  const graph = { a: ["b"], b: ["c"], c: ["a"] };
  const normalized = normalizeSCCs(tarjanSCC(graph));
  assert.deepEqual(normalized, [["a", "b", "c"]]);
});

test("tarjanSCC: two disjoint cycles", () => {
  const graph = {
    a: ["b"],
    b: ["a"],
    c: ["d"],
    d: ["c"],
  };
  const normalized = normalizeSCCs(tarjanSCC(graph));
  assert.deepEqual(normalized, [["a", "b"], ["c", "d"]]);
});

test("tarjanSCC: self-loop produces size-1 SCC", () => {
  const graph = { a: ["a"] };
  assert.deepEqual(normalizeSCCs(tarjanSCC(graph)), [["a"]]);
});

test("tarjanSCC: picks up nodes referenced only as neighbors", () => {
  // 'b' is never a key, but is a neighbor of 'a'. The algorithm should still
  // discover it as a leaf node.
  const graph = { a: ["b"] };
  const normalized = normalizeSCCs(tarjanSCC(graph));
  assert.deepEqual(normalized, [["a"], ["b"]]);
});

test("findCycles: filters out singleton non-self-loop components", () => {
  const graph = { a: ["b"], b: ["a"], c: [] };
  const cycles = findCycles(graph);
  assert.equal(cycles.length, 1);
  assert.deepEqual(sortComponent(cycles[0]), ["a", "b"]);
});

test("findCycles: keeps self-loops", () => {
  const cycles = findCycles({ solo: ["solo"] });
  assert.deepEqual(cycles, [["solo"]]);
});

test("findCycles: no cycles → empty array", () => {
  assert.deepEqual(findCycles({ a: ["b"], b: ["c"], c: [] }), []);
});

test("tarjanSCC: deep chain uses iterative stack (no RangeError)", () => {
  // 2_000 nodes chained a0 → a1 → ... → a1999 → a0 makes one giant SCC.
  const graph = {};
  const size = 2000;
  for (let i = 0; i < size; i += 1) {
    graph[`a${i}`] = [`a${(i + 1) % size}`];
  }
  const sccs = tarjanSCC(graph);
  assert.equal(sccs.length, 1);
  assert.equal(sccs[0].length, size);
});
