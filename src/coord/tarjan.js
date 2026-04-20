// Iterative Tarjan strongly-connected components (#A9, spec §5.6).
//
// We use an explicit work stack instead of recursion because the wait graph
// can, in theory, chain across all 13 personas and Node's default stack size
// is fine but iterative keeps us honest for future growth (scaffold-before-
// code may run many transient locks in flight).
//
// Input:  adjacency as { node: [neighbors...] } — missing keys are treated
//         as leaves. Nodes referenced only as neighbors are picked up.
// Output: list of SCCs, each an array of node ids. Size-1 SCCs without a
//         self-loop are still returned so callers can filter.

export function tarjanSCC(graph) {
  const adjacency = normalizeGraph(graph);
  const nodes = Array.from(adjacency.keys());

  const index = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const sccStack = [];
  const result = [];

  let counter = 0;

  for (const root of nodes) {
    if (index.has(root)) {
      continue;
    }

    // Iterative DFS. Each frame tracks the node plus the index of the next
    // neighbor to visit so we can resume after recursive descent.
    const workStack = [{ node: root, neighborIdx: 0 }];
    index.set(root, counter);
    lowlink.set(root, counter);
    counter += 1;
    sccStack.push(root);
    onStack.add(root);

    while (workStack.length > 0) {
      const frame = workStack[workStack.length - 1];
      const neighbors = adjacency.get(frame.node) || [];

      if (frame.neighborIdx < neighbors.length) {
        const next = neighbors[frame.neighborIdx];
        frame.neighborIdx += 1;

        if (!index.has(next)) {
          index.set(next, counter);
          lowlink.set(next, counter);
          counter += 1;
          sccStack.push(next);
          onStack.add(next);
          workStack.push({ node: next, neighborIdx: 0 });
        } else if (onStack.has(next)) {
          lowlink.set(
            frame.node,
            Math.min(lowlink.get(frame.node), index.get(next))
          );
        }
        continue;
      }

      // Exhausted neighbors — close the frame. If we're an SCC root, pop the
      // component off the stack.
      if (lowlink.get(frame.node) === index.get(frame.node)) {
        const component = [];
        while (sccStack.length > 0) {
          const popped = sccStack.pop();
          onStack.delete(popped);
          component.push(popped);
          if (popped === frame.node) {
            break;
          }
        }
        result.push(component);
      }

      workStack.pop();
      if (workStack.length > 0) {
        const parent = workStack[workStack.length - 1];
        lowlink.set(
          parent.node,
          Math.min(lowlink.get(parent.node), lowlink.get(frame.node))
        );
      }
    }
  }

  return result;
}

// Convenience: return only SCCs that represent actual cycles (size > 1, or
// self-loops of size 1). Useful for the deadlock-detection branch which
// should ignore every isolated node.
export function findCycles(graph) {
  const sccs = tarjanSCC(graph);
  const source =
    graph && typeof graph === "object" && !Array.isArray(graph) ? graph : {};
  const cycles = [];
  for (const component of sccs) {
    if (component.length > 1) {
      cycles.push(component);
      continue;
    }
    const [only] = component;
    const rawNeighbors = Array.isArray(source[only]) ? source[only] : [];
    const normalizedNeighbors = rawNeighbors.map((value) =>
      String(value || "").trim()
    );
    if (normalizedNeighbors.includes(only)) {
      cycles.push(component);
    }
  }
  return cycles;
}

function normalizeGraph(graph) {
  const adjacency = new Map();
  const source =
    graph && typeof graph === "object" && !Array.isArray(graph) ? graph : {};

  for (const [rawKey, rawValue] of Object.entries(source)) {
    const node = String(rawKey || "").trim();
    if (!node) {
      continue;
    }
    const list = Array.isArray(rawValue) ? rawValue : [];
    const normalized = [];
    for (const candidate of list) {
      const neighbor = String(candidate || "").trim();
      if (!neighbor) {
        continue;
      }
      if (!normalized.includes(neighbor)) {
        normalized.push(neighbor);
      }
    }
    const existing = adjacency.get(node) || [];
    for (const neighbor of normalized) {
      if (!existing.includes(neighbor)) {
        existing.push(neighbor);
      }
    }
    adjacency.set(node, existing);
  }

  // Any node referenced as a neighbor but not as a key is a leaf — add it so
  // the DFS visits it.
  for (const neighbors of [...adjacency.values()]) {
    for (const neighbor of neighbors) {
      if (!adjacency.has(neighbor)) {
        adjacency.set(neighbor, []);
      }
    }
  }
  return adjacency;
}
