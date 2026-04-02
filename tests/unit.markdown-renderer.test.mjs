import test from "node:test";
import assert from "node:assert/strict";

import { renderTerminalMarkdown } from "../src/ui/markdown.js";

function stripAnsi(text) {
  return String(text || "").replace(/\x1B\[[0-9;]*m/g, "");
}

test("Unit: markdown renderer styles headings and inline markdown", () => {
  const markdown = "# Heading\nUse **bold** with `inline_code` and a [link](https://example.com).";
  const rendered = renderTerminalMarkdown(markdown);
  const normalized = stripAnsi(rendered);

  assert.match(normalized, /# Heading/);
  assert.match(normalized, /Use bold with\s+inline_code\s+and a link \(https:\/\/example\.com\)\./);
});

test("Unit: markdown renderer converts table blocks to terminal table layout", () => {
  const markdown = [
    "| Key | Value |",
    "| --- | --- |",
    "| run_id | abc123 |",
    "| gate | pass |",
  ].join("\n");
  const rendered = stripAnsi(renderTerminalMarkdown(markdown));

  assert.match(rendered, /┌/);
  assert.match(rendered, /run_id/);
  assert.match(rendered, /abc123/);
  assert.match(rendered, /└/);
});

test("Unit: markdown renderer preserves and highlights fenced code blocks", () => {
  const markdown = ["```js", "const value = 42;", "```"].join("\n");
  const rendered = stripAnsi(renderTerminalMarkdown(markdown));

  assert.match(rendered, /```js/);
  assert.match(rendered, /const value = 42;/);
  assert.match(rendered, /```/);
});

test("Unit: markdown renderer plain mode bypasses markdown styling", () => {
  const markdown = "## Plain heading\n**no styling**";
  const rendered = renderTerminalMarkdown(markdown, { plain: true });
  assert.equal(rendered, markdown);
});
