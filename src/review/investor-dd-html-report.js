/**
 * HTML report generator for investor-DD (#investor-dd-18b).
 *
 * Builds a self-contained HTML report from the artifact bundle produced
 * by runInvestorDd(). The output is a single file with inlined CSS —
 * no external dependencies, no network calls when viewed — so it can
 * be emailed as an attachment or hosted directly.
 *
 * PDF generation is delegated to the caller (headless-chrome / wkhtmltopdf
 * / puppeteer); this module stays pure HTML so it works offline.
 */

const CSS = `
  :root {
    --bg: #0b0f14;
    --card: #131925;
    --border: #2b3344;
    --muted: #94a3b8;
    --text: #e2e8f0;
    --accent: #38bdf8;
    --p0: #dc2626;
    --p1: #ea580c;
    --p2: #d97706;
    --p3: #65a30d;
    --confirmed: #dc2626;
    --fp: #64748b;
    --contra: #a855f7;
    --unver: #475569;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    line-height: 1.5;
  }
  h1, h2, h3 { color: var(--text); margin-top: 1.5em; }
  h1 { border-bottom: 2px solid var(--accent); padding-bottom: 0.5em; }
  .meta { color: var(--muted); font-size: 0.9em; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 16px 0; }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px;
  }
  .card h3 { margin: 0 0 8px 0; font-size: 0.9em; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .card .value { font-size: 1.8em; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; }
  th, td {
    text-align: left;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    font-size: 0.9em;
  }
  th { color: var(--muted); font-weight: 600; text-transform: uppercase; font-size: 0.75em; letter-spacing: 0.05em; }
  tr:hover { background: rgba(255,255,255,0.02); }
  .sev { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.8em; font-weight: 600; }
  .sev-P0 { background: var(--p0); color: white; }
  .sev-P1 { background: var(--p1); color: white; }
  .sev-P2 { background: var(--p2); color: white; }
  .sev-P3 { background: var(--p3); color: white; }
  .verdict { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75em; font-weight: 600; }
  .verdict-CONFIRMED { background: var(--confirmed); color: white; }
  .verdict-FALSE_POSITIVE { background: var(--fp); color: white; }
  .verdict-CONTRADICTORY { background: var(--contra); color: white; }
  .verdict-UNVERIFIABLE { background: var(--unver); color: white; }
  pre {
    background: #0a0e14;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px;
    overflow-x: auto;
    font-family: "SFMono-Regular", "Consolas", monospace;
    font-size: 0.85em;
  }
  .finding {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    margin: 12px 0;
  }
  .finding-hdr { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
  .finding-file { color: var(--accent); font-family: "SFMono-Regular", monospace; font-size: 0.85em; }
  .finding-title { font-weight: 600; flex: 1; }
  .footer { color: var(--muted); font-size: 0.8em; margin-top: 48px; border-top: 1px solid var(--border); padding-top: 16px; }
`;

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSummaryCards(summary = {}) {
  const cards = [
    { label: "Findings", value: summary.totalFindings ?? 0 },
    { label: "Files scanned", value: summary.totalFiles ?? 0 },
    {
      label: "Duration",
      value: typeof summary.durationSeconds === "number"
        ? `${summary.durationSeconds.toFixed(1)}s`
        : "?",
    },
    { label: "Status", value: summary.terminationReason || "ok" },
  ];
  return `<div class="grid">${cards
    .map(
      (c) =>
        `<div class="card"><h3>${esc(c.label)}</h3><div class="value">${esc(c.value)}</div></div>`,
    )
    .join("")}</div>`;
}

function renderCoverageTable(routing = {}, byPersona = {}) {
  const personas = Object.keys(byPersona).length > 0 ? Object.keys(byPersona) : Object.keys(routing);
  const rows = personas.map((id) => {
    const record = byPersona[id] || {};
    const routed = (routing[id] || []).length;
    const visited = Array.isArray(record.visited) ? record.visited.length : 0;
    const findings = Array.isArray(record.findings) ? record.findings.length : 0;
    return `<tr><td>${esc(id)}</td><td>${routed}</td><td>${visited}</td><td>${findings}</td></tr>`;
  });
  return `<table>
  <thead><tr><th>Persona</th><th>Routed</th><th>Visited</th><th>Findings</th></tr></thead>
  <tbody>${rows.join("")}</tbody>
  </table>`;
}

function renderFindings(findings = [], max = 50) {
  if (!findings.length) return `<p class="meta">No findings captured.</p>`;
  const html = findings.slice(0, max).map((f) => {
    const sev = f.severity ? `<span class="sev sev-${esc(f.severity)}">${esc(f.severity)}</span>` : "";
    const verdict = f.reconciliation
      ? `<span class="verdict verdict-${esc(f.reconciliation.verdict)}">${esc(f.reconciliation.verdict)}</span>`
      : "";
    const persona = f.personaId ? `<span class="meta">${esc(f.personaId)}</span>` : "";
    const tool = f.tool ? `<span class="meta">· ${esc(f.tool)}</span>` : "";
    const file = f.file ? `<div class="finding-file">${esc(f.file)}${f.line ? `:${f.line}` : ""}</div>` : "";
    const evidence = f.evidence
      ? `<pre>${esc(typeof f.evidence === "string" ? f.evidence : JSON.stringify(f.evidence, null, 2))}</pre>`
      : "";
    const fix = f.recommendedFix
      ? `<p><strong>Recommended:</strong> ${esc(f.recommendedFix)}</p>`
      : "";
    const replay = f.reproducibility?.replayCommand
      ? `<p class="meta">Replay: <code>${esc(f.reproducibility.replayCommand)}</code></p>`
      : "";
    return `<div class="finding">
      <div class="finding-hdr">${sev}${verdict}<span class="finding-title">${esc(f.kind || f.title || "(untitled)")}</span>${persona}${tool}</div>
      ${file}
      ${evidence}
      ${fix}
      ${replay}
    </div>`;
  });
  const footer = findings.length > max
    ? `<p class="meta">Showing top ${max} of ${findings.length}. See findings.json for the full list.</p>`
    : "";
  return html.join("") + footer;
}

function renderCompliance(packs = {}) {
  if (!packs || Object.keys(packs).length === 0) return "";
  const sections = Object.entries(packs).map(([packId, record]) => {
    const rows = (record.items || []).map(
      (i) =>
        `<tr>
      <td>${esc(i.controlId)}</td>
      <td>${esc(i.title)}</td>
      <td>${i.status === "covered" ? "✓" : "✗"}</td>
      <td>${esc(i.evidenceFile || "")}</td>
      </tr>`,
    );
    return `<h3>${esc(packId.toUpperCase())} — ${record.covered || 0} covered / ${record.gaps || 0} gaps</h3>
    <table><thead><tr><th>Control</th><th>Title</th><th>Status</th><th>Evidence</th></tr></thead>
    <tbody>${rows.join("")}</tbody></table>`;
  });
  return `<h2>Compliance Pack</h2>${sections.join("")}`;
}

/**
 * Build the investor-DD HTML report.
 *
 * @param {object} params
 * @param {string} params.runId
 * @param {object} params.summary
 * @param {Record<string,string[]>} [params.routing]
 * @param {Record<string,object>} [params.byPersona]
 * @param {Array<object>} [params.findings]
 * @param {Record<string,object>} [params.compliance]  - From runFullCompliancePack().packs.
 * @returns {string}
 */
export function renderInvestorDdHtml({
  runId,
  summary = {},
  routing = {},
  byPersona = {},
  findings = [],
  compliance = null,
} = {}) {
  const title = `Investor-DD Report — ${esc(runId || "unknown-run")}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title}</title>
<style>${CSS}</style>
</head>
<body>
<h1>${title}</h1>
<p class="meta">Generated ${esc(summary.startedAt || new Date().toISOString())}</p>

${renderSummaryCards(summary)}

<h2>Coverage</h2>
${renderCoverageTable(routing, byPersona)}

<h2>Findings</h2>
${renderFindings(findings)}

${renderCompliance(compliance)}

<div class="footer">SentinelLayer investor-DD · ${esc(runId)}</div>
</body>
</html>`;
}
