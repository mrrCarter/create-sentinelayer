import { createHash } from "node:crypto";

import { buildSessionUsageLedger } from "./pricing-ledger.js";

export const SESSION_USAGE_REPORT_SCHEMA = "session_usage_report/v1";
const DEFAULT_RECENT_LIMIT = 10;
const MAX_RECENT_LIMIT = 50;

function normalize(value) {
  return String(value == null ? "" : value).trim();
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nonNegativeNumber(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function nonNegativeInt(value) {
  const parsed = nonNegativeNumber(value);
  return parsed == null ? 0 : Math.floor(parsed);
}

function money(value) {
  const parsed = nonNegativeNumber(value);
  return parsed == null ? null : Math.round(parsed * 1_000_000) / 1_000_000;
}

function clampRecentLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_RECENT_LIMIT;
  return Math.min(MAX_RECENT_LIMIT, Math.floor(parsed));
}

function intCell(value) {
  return Math.max(0, Math.floor(Number(value || 0))).toLocaleString("en-US");
}

function usdCell(value) {
  return `$${Number(value || 0).toFixed(6)}`;
}

function tableText(value, { maxLength = 160 } = {}) {
  const escaped = normalize(value)
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "'");
  if (!maxLength || escaped.length <= maxLength) return escaped;
  const head = Math.max(24, Math.floor((maxLength - 3) * 0.7));
  const tail = Math.max(12, maxLength - 3 - head);
  return `${escaped.slice(0, head)}...${escaped.slice(-tail)}`;
}

function codeCell(value) {
  const text = tableText(value);
  return text ? `\`${text}\`` : "-";
}

function optionalUsdCell(value, hasValue) {
  return hasValue ? usdCell(value) : "-";
}

function timestampOnly(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace("T", " ").replace(/\..+/, " UTC");
}

function hashOpaque(value) {
  const text = normalize(value);
  if (!text) return "";
  return `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

function sortRollups(map) {
  return [...map.values()].sort((a, b) => (
    b.providerCostUsd - a.providerCostUsd ||
    b.totalTokens - a.totalTokens ||
    b.entries - a.entries ||
    tableText(a.label).localeCompare(tableText(b.label))
  ));
}

function recentUsageEntries(entries, limit) {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const aSequence = Number.isFinite(a.entry.sequenceId) ? a.entry.sequenceId : null;
      const bSequence = Number.isFinite(b.entry.sequenceId) ? b.entry.sequenceId : null;
      if (aSequence != null && bSequence != null && aSequence !== bSequence) {
        return bSequence - aSequence;
      }
      const aTime = Date.parse(a.entry.timestamp);
      const bTime = Date.parse(b.entry.timestamp);
      if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
        return bTime - aTime;
      }
      return b.index - a.index;
    })
    .slice(0, limit)
    .map(({ entry }) => entry);
}

function rollupToJson(rollup) {
  return {
    label: rollup.label,
    entries: rollup.entries,
    inputTokens: rollup.inputTokens,
    outputTokens: rollup.outputTokens,
    totalTokens: rollup.totalTokens,
    providerCostUsd: rollup.providerCostUsd,
    customerCostUsd: rollup.hasCustomerCost ? rollup.customerCostUsd : null,
    unpriced: rollup.unpriced,
    estimatedEntries: rollup.estimatedEntries || 0,
  };
}

function hostedRollupToJson(rollup, fallbackLabel = "") {
  const bag = object(rollup);
  const hasCustomerCost = Boolean(bag.hasCustomerCost ?? bag.has_customer_cost ?? bag.customerCostUsd != null ?? bag.customer_cost_usd != null);
  return {
    label: normalize(bag.label ?? bag.agentId ?? bag.agent_id ?? bag.action ?? fallbackLabel) || "unknown",
    entries: nonNegativeInt(bag.entries ?? bag.entryCount ?? bag.entry_count ?? bag.count ?? bag.interactions),
    inputTokens: nonNegativeInt(bag.inputTokens ?? bag.input_tokens),
    outputTokens: nonNegativeInt(bag.outputTokens ?? bag.output_tokens),
    totalTokens: nonNegativeInt(bag.totalTokens ?? bag.total_tokens),
    providerCostUsd: money(bag.providerCostUsd ?? bag.provider_cost_usd ?? bag.costUsd ?? bag.cost_usd) ?? 0,
    customerCostUsd: hasCustomerCost
      ? money(bag.customerCostUsd ?? bag.customer_cost_usd ?? bag.billableCostUsd ?? bag.billable_cost_usd) ?? 0
      : null,
    unpriced: nonNegativeInt(bag.unpriced),
    estimatedEntries: nonNegativeInt(bag.estimatedEntries ?? bag.estimated_entries),
  };
}

function entryToJson(entry) {
  return {
    timestamp: normalize(entry.timestamp) || null,
    sequenceId: Number.isFinite(entry.sequenceId) ? entry.sequenceId : null,
    ledgerEntryId: entry.ledgerEntryId,
    idempotencyKeyHash: hashOpaque(entry.idempotencyKey),
    schema: entry.schema,
    agentId: entry.agentId,
    action: entry.action,
    model: entry.model,
    provider: normalize(entry.provider) || null,
    billingTier: entry.billingTier,
    priceBookVersion: entry.priceBookVersion,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    totalTokens: entry.totalTokens,
    providerCostUsd: entry.providerCostUsd,
    customerCostUsd: entry.customerCostUsd,
    unpriced: entry.unpriced,
    estimated: Boolean(entry.estimated),
  };
}

function hostedEntryToJson(entry) {
  const bag = object(entry);
  const idempotencyKey = normalize(bag.idempotencyKey ?? bag.idempotency_key ?? bag.runKey ?? bag.run_key);
  return {
    timestamp: normalize(bag.timestamp ?? bag.createdAt ?? bag.created_at ?? bag.occurredAt ?? bag.occurred_at) || null,
    sequenceId: nonNegativeNumber(bag.sequenceId ?? bag.sequence_id ?? bag.sequence) == null
      ? null
      : nonNegativeInt(bag.sequenceId ?? bag.sequence_id ?? bag.sequence),
    ledgerEntryId: normalize(bag.ledgerEntryId ?? bag.ledger_entry_id ?? bag.billingEventId ?? bag.billing_event_id) || "",
    idempotencyKeyHash: hashOpaque(idempotencyKey),
    schema: normalize(bag.schema) || "billing/v1",
    agentId: normalize(bag.agentId ?? bag.agent_id) || "unknown",
    action: normalize(bag.action ?? bag.operation ?? bag.kind ?? bag.billingAction ?? bag.billing_action) || "agent_message",
    model: normalize(bag.model ?? bag.modelId ?? bag.model_id) || "unknown",
    provider: normalize(bag.provider ?? bag.providerName ?? bag.provider_name) || null,
    billingTier: normalize(bag.billingTier ?? bag.billing_tier ?? bag.tier) || "unknown",
    priceBookVersion: normalize(bag.priceBookVersion ?? bag.price_book_version ?? bag.pricingVersion ?? bag.pricing_version) || "unknown",
    inputTokens: nonNegativeInt(bag.inputTokens ?? bag.input_tokens),
    outputTokens: nonNegativeInt(bag.outputTokens ?? bag.output_tokens),
    totalTokens: nonNegativeInt(bag.totalTokens ?? bag.total_tokens ?? bag.tokens),
    providerCostUsd: money(bag.providerCostUsd ?? bag.provider_cost_usd ?? bag.costUsd ?? bag.cost_usd ?? bag.cost) ?? 0,
    customerCostUsd: money(bag.customerCostUsd ?? bag.customer_cost_usd ?? bag.billableCostUsd ?? bag.billable_cost_usd),
    unpriced: Boolean(bag.unpriced),
    estimated: Boolean(bag.estimated),
  };
}

function sourceArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function recentReportEntries(entries, limit) {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const aSequence = Number.isFinite(a.entry.sequenceId) ? a.entry.sequenceId : null;
      const bSequence = Number.isFinite(b.entry.sequenceId) ? b.entry.sequenceId : null;
      if (aSequence != null && bSequence != null && aSequence !== bSequence) {
        return bSequence - aSequence;
      }
      const aTime = Date.parse(a.entry.timestamp);
      const bTime = Date.parse(b.entry.timestamp);
      if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
        return bTime - aTime;
      }
      return b.index - a.index;
    })
    .slice(0, limit)
    .map(({ entry }) => entry);
}

export function buildSessionUsageReport({
  sessionId = "",
  events = [],
  recentLimit = DEFAULT_RECENT_LIMIT,
  estimateMessageUsage = true,
} = {}) {
  const ledger = buildSessionUsageLedger(events, {
    sessionId: normalize(sessionId),
    includeEstimatedMessages: estimateMessageUsage,
  });
  const limit = clampRecentLimit(recentLimit);
  return {
    schema: SESSION_USAGE_REPORT_SCHEMA,
    sessionId: normalize(sessionId),
    generatedAt: new Date().toISOString(),
    totals: {
      acceptedEntries: ledger.entries.length,
      duplicatesSkipped: ledger.duplicatesSkipped,
      inputTokens: ledger.totals.inputTokens,
      outputTokens: ledger.totals.outputTokens,
      totalTokens: ledger.totals.totalTokens,
      providerCostUsd: ledger.totals.providerCostUsd,
      customerCostUsd: ledger.totals.hasCustomerCost ? ledger.totals.customerCostUsd : null,
      unpriced: ledger.totals.unpriced,
      estimatedEntries: ledger.totals.estimatedEntries || 0,
      priceBookVersions: ledger.priceBookVersions,
    },
    perAgent: sortRollups(ledger.perAgent).map(rollupToJson),
    perAction: sortRollups(ledger.perAction).map(rollupToJson),
    recentEntries: recentUsageEntries(ledger.entries, limit).map(entryToJson),
  };
}

export function buildSessionUsageReportFromLedgerPayload({
  sessionId = "",
  payload = {},
  recentLimit = DEFAULT_RECENT_LIMIT,
} = {}) {
  const root = object(payload);
  const embedded = root.usageLedger || root.usage_ledger || root.ledger;
  const source = embedded && typeof embedded === "object" && !Array.isArray(embedded)
    ? embedded
    : root;
  const entries = sourceArray(source.entries).map(hostedEntryToJson);
  const sourceTotals = object(source.totals);
  const totals = hostedRollupToJson(sourceTotals, "session");
  const priceBookVersions = sourceArray(
    source.priceBooks ||
      source.price_books ||
      source.priceBookVersions ||
      source.price_book_versions ||
      sourceTotals.priceBooks ||
      sourceTotals.price_books ||
      sourceTotals.priceBookVersions ||
      sourceTotals.price_book_versions,
  )
    .map(normalize)
    .filter(Boolean)
    .sort();
  const resolvedPriceBookVersions = priceBookVersions.length
    ? priceBookVersions
    : [...new Set(entries.map((entry) => normalize(entry.priceBookVersion)).filter(Boolean))].sort();
  const limit = clampRecentLimit(recentLimit);
  return {
    schema: SESSION_USAGE_REPORT_SCHEMA,
    sessionId: normalize(root.sessionId ?? root.session_id ?? source.sessionId ?? source.session_id ?? sessionId),
    generatedAt: new Date().toISOString(),
    totals: {
      acceptedEntries: totals.entries || entries.length,
      duplicatesSkipped: nonNegativeInt(source.duplicatesSkipped ?? source.duplicates_skipped),
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      totalTokens: totals.totalTokens,
      providerCostUsd: totals.providerCostUsd,
      customerCostUsd: totals.customerCostUsd,
      unpriced: totals.unpriced,
      estimatedEntries: nonNegativeInt(source.estimatedEntries ?? source.estimated_entries ?? sourceTotals.estimatedEntries ?? sourceTotals.estimated_entries),
      priceBookVersions: resolvedPriceBookVersions,
    },
    perAgent: sourceArray(
      source.agents ||
        source.perAgent ||
        source.per_agent ||
        source.byAgent ||
        source.by_agent ||
        source.agentsById ||
        source.agents_by_id,
    )
      .map((rollup) => hostedRollupToJson(rollup))
      .sort((a, b) => b.providerCostUsd - a.providerCostUsd || b.totalTokens - a.totalTokens || a.label.localeCompare(b.label)),
    perAction: sourceArray(
      source.actions ||
        source.perAction ||
        source.per_action ||
        source.byAction ||
        source.by_action ||
        source.actionsById ||
        source.actions_by_id,
    )
      .map((rollup) => hostedRollupToJson(rollup))
      .sort((a, b) => b.providerCostUsd - a.providerCostUsd || b.totalTokens - a.totalTokens || a.label.localeCompare(b.label)),
    recentEntries: recentReportEntries(entries, limit),
  };
}

function appendRollupTable(lines, { title, labelHeader, rollups }) {
  lines.push(`### ${title}`);
  lines.push("");
  lines.push(`| ${labelHeader} | Entries | Input | Output | Total | Provider cost | Customer cost | Unpriced |`);
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  if (!rollups.length) {
    lines.push(`| - | 0 | 0 | 0 | 0 | ${usdCell(0)} | - | 0 |`);
  } else {
    for (const rollup of rollups) {
      lines.push(
        `| ${codeCell(rollup.label)} | ${intCell(rollup.entries)} | ${intCell(rollup.inputTokens)} | ${intCell(rollup.outputTokens)} | ${intCell(rollup.totalTokens)} | ${usdCell(rollup.providerCostUsd)} | ${optionalUsdCell(rollup.customerCostUsd, rollup.customerCostUsd != null)} | ${intCell(rollup.unpriced)} |`,
      );
    }
  }
  lines.push("");
}

export function renderSessionUsageMarkdown(report = {}) {
  const totals = report.totals || {};
  const lines = [];
  lines.push(`# Session Usage ${normalize(report.sessionId) || "unknown"}`);
  lines.push("");
  lines.push(`Generated: ${normalize(report.generatedAt) || new Date().toISOString()}`);
  lines.push("");
  lines.push("## Totals");
  lines.push("");
  lines.push(`Accepted entries: ${intCell(totals.acceptedEntries)}`);
  lines.push(
    `Tokens: ${intCell(totals.totalTokens)} (input ${intCell(totals.inputTokens)} / output ${intCell(totals.outputTokens)})`,
  );
  lines.push(
    `Provider cost: ${usdCell(totals.providerCostUsd)} - Customer cost: ${optionalUsdCell(totals.customerCostUsd, totals.customerCostUsd != null)}`,
  );
  lines.push(`Price books: ${(totals.priceBookVersions || []).map(tableText).filter(Boolean).join(", ") || "-"}`);
  lines.push(
    `Duplicates skipped: ${intCell(totals.duplicatesSkipped)} - Unpriced entries: ${intCell(totals.unpriced)} - Estimated entries: ${intCell(totals.estimatedEntries)}`,
  );
  if (totals.estimatedEntries > 0) {
    lines.push("_Estimated entries are output-text estimates from non-human session messages, not billing-grade provider usage._");
  }
  lines.push("");

  appendRollupTable(lines, {
    title: "Per Agent",
    labelHeader: "Agent",
    rollups: Array.isArray(report.perAgent) ? report.perAgent : [],
  });
  appendRollupTable(lines, {
    title: "Per Action",
    labelHeader: "Action",
    rollups: Array.isArray(report.perAction) ? report.perAction : [],
  });

  lines.push("### Recent Entries");
  lines.push("");
  lines.push("| Time | Agent | Action | Model | Tokens | Provider cost | Customer cost | Ledger | Idempotency hash |");
  lines.push("|---|---|---|---|---:|---:|---:|---|---|");
  const entries = Array.isArray(report.recentEntries) ? report.recentEntries : [];
  if (!entries.length) {
    lines.push(`| - | - | - | - | 0 | ${usdCell(0)} | - | - | - |`);
  } else {
    for (const entry of entries) {
      const action = entry.estimated ? `${entry.action} (estimated)` : entry.action;
      lines.push(
        `| ${tableText(timestampOnly(entry.timestamp)) || "-"} | ${codeCell(entry.agentId)} | ${codeCell(action)} | ${codeCell(entry.model)} | ${intCell(entry.totalTokens)} | ${usdCell(entry.providerCostUsd)} | ${optionalUsdCell(entry.customerCostUsd, entry.customerCostUsd != null)} | ${codeCell(entry.ledgerEntryId)} | ${codeCell(entry.idempotencyKeyHash)} |`,
      );
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function renderSessionUsageSummary(report = {}) {
  const totals = report.totals || {};
  const lines = [];
  lines.push(`Session usage ${normalize(report.sessionId) || "unknown"}`);
  lines.push(
    `${intCell(totals.acceptedEntries)} entries - ${intCell(totals.totalTokens)} tokens (${intCell(totals.inputTokens)} in / ${intCell(totals.outputTokens)} out) - provider ${usdCell(totals.providerCostUsd)}${
      totals.customerCostUsd == null ? "" : ` - customer ${usdCell(totals.customerCostUsd)}`
    }`,
  );
  lines.push(
    `priceBooks=${(totals.priceBookVersions || []).map(tableText).filter(Boolean).join(",") || "-"} duplicatesSkipped=${intCell(totals.duplicatesSkipped)} unpriced=${intCell(totals.unpriced)}`,
  );
  if (totals.estimatedEntries > 0) {
    lines.push(`estimatedEntries=${intCell(totals.estimatedEntries)} (output-text estimates; not billing-grade)`);
  }
  const agents = Array.isArray(report.perAgent) ? report.perAgent.slice(0, 8) : [];
  if (agents.length) {
    lines.push("");
    lines.push("Per agent:");
    for (const agent of agents) {
      lines.push(
        `- ${agent.label}: ${intCell(agent.totalTokens)} tokens, ${intCell(agent.entries)} entries, provider ${usdCell(agent.providerCostUsd)}`,
      );
    }
  }
  const entries = Array.isArray(report.recentEntries) ? report.recentEntries.slice(0, 5) : [];
  if (entries.length) {
    lines.push("");
    lines.push("Recent:");
    for (const entry of entries) {
      lines.push(
        `- ${timestampOnly(entry.timestamp) || "-"} ${entry.agentId} ${entry.action}${entry.estimated ? " (estimated)" : ""} ${intCell(entry.totalTokens)} tokens ${usdCell(entry.providerCostUsd)} ledger=${entry.ledgerEntryId}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
