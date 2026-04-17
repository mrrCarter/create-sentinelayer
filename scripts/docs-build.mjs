import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

const REQUIRED_FILES = [
  "README.md",
  "docs/sessions.md",
  "docs/blog/slack-for-ai-coding-agents.md",
  "llms.txt",
  "robots.txt",
];

const LLMS_SCHEMA = {
  headings: [
    "# Sentinelayer CLI (LLM Index)",
    "## Project",
    "## Retrieval Order",
    "## Session Surface",
    "## Guardrails",
    "## Docs",
  ],
  retrievalItemsMin: 5,
};

const SESSIONS_HEADINGS = [
  "# Sentinelayer Sessions",
  "## Core Commands",
  "## Omar Handshake Loop (P0/P1 Gate)",
  "## Human-in-the-Loop (HITL)",
];

const BLOG_HEADINGS = [
  "# Slack for AI Coding Agents: Why Multi-Agent Coordination Changes Everything",
  "## The Problem Nobody Talks About",
  "## What We Built",
  "## Use Cases",
  "## Why This Is a Moat",
  "## What Comes Next",
];

const REQUIRED_README_ANCHOR = "## Multi-Agent Session Workflow";
const REQUIRED_README_LINK = "docs/sessions.md";
const REQUIRED_ROBOTS_LINES = [
  "User-agent: *",
  "Allow: /docs/sessions.md",
  "Allow: /llms.txt",
  "Disallow: /dashboard/",
];

const errors = [];

function readFile(relPath) {
  const absPath = path.join(root, relPath);
  return fs.readFileSync(absPath, "utf8");
}

function checkRequiredFiles() {
  for (const relPath of REQUIRED_FILES) {
    const absPath = path.join(root, relPath);
    if (!fs.existsSync(absPath)) {
      errors.push(`missing required file: ${relPath}`);
    }
  }
}

function checkHeadings(content, headings, fileLabel) {
  for (const heading of headings) {
    if (!content.includes(heading)) {
      errors.push(`${fileLabel} missing heading: ${heading}`);
    }
  }
}

function checkLlmsSchema(content) {
  checkHeadings(content, LLMS_SCHEMA.headings, "llms.txt");
  const retrievalLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s+/.test(line));
  if (retrievalLines.length < LLMS_SCHEMA.retrievalItemsMin) {
    errors.push(
      `llms.txt retrieval order must contain at least ${LLMS_SCHEMA.retrievalItemsMin} numbered entries`,
    );
  }
}

function checkSessionsDoc(content) {
  checkHeadings(content, SESSIONS_HEADINGS, "docs/sessions.md");
}

function checkBlogDoc(content) {
  checkHeadings(content, BLOG_HEADINGS, "docs/blog/slack-for-ai-coding-agents.md");
}

function checkReadme(content) {
  if (!content.includes(REQUIRED_README_ANCHOR)) {
    errors.push(`README.md missing section: ${REQUIRED_README_ANCHOR}`);
  }
  if (!content.includes(REQUIRED_README_LINK)) {
    errors.push(`README.md missing docs link: ${REQUIRED_README_LINK}`);
  }
}

function checkRobots(content) {
  for (const line of REQUIRED_ROBOTS_LINES) {
    if (!content.includes(line)) {
      errors.push(`robots.txt missing line: ${line}`);
    }
  }
  const hasSitemap = /Sitemap:\s+https?:\/\/\S+/i.test(content);
  if (!hasSitemap) {
    errors.push("robots.txt missing valid Sitemap line");
  }
}

function main() {
  checkRequiredFiles();
  if (errors.length > 0) {
    printAndExit();
    return;
  }

  const readme = readFile("README.md");
  const sessions = readFile("docs/sessions.md");
  const llms = readFile("llms.txt");
  const robots = readFile("robots.txt");
  const blog = readFile("docs/blog/slack-for-ai-coding-agents.md");

  checkReadme(readme);
  checkSessionsDoc(sessions);
  checkLlmsSchema(llms);
  checkRobots(robots);
  checkBlogDoc(blog);
  printAndExit();
}

function printAndExit() {
  if (errors.length > 0) {
    console.error("[docs:build] validation failed");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("[docs:build] validation passed");
  console.log(`- files checked: ${REQUIRED_FILES.length}`);
  console.log(`- llms headings checked: ${LLMS_SCHEMA.headings.length}`);
}

main();
