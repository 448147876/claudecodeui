import fs from 'node:fs';
import path from 'node:path';

import { dataPaths, writePrivateFile } from '../config.mjs';

// Usage gate (mydocs/08 section 3.3): a member whose workspace used too large
// a share of the recent Claude usage gets the composer's send controls hidden
// (gateway/public/static/inject.js). UI-level only and approximate by design;
// nothing upstream is changed or blocked.
//
// share = workspace cost / max(cost of all directories, baselineUsd), over the
// last `windowHours`. The baseline keeps a lone user from being "100%" of a
// small total; above it the share of the real total applies.

/** Defaults; the admin page overrides them in <dataRoot>/usage-gate.json. */
export const USAGE_GATE_DEFAULTS = Object.freeze({
  enabled: true,
  limitPercent: 20,
  windowHours: 5,
  // Rough 5-hour capacity of a Max 20x plan in API-equivalent dollars
  // (community estimate; Anthropic publishes no numbers). Tune it on the admin page.
  baselineUsd: 140,
});

const SETTING_RANGES = { limitPercent: [1, 100], windowHours: [1, 24], baselineUsd: [0, 100_000] };

// $ per million tokens: [input, output, cacheWrite, cacheRead]; first match wins.
// Same table as the claude-usage plugin (src/pricing.ts, MIT) so its tab shows matching costs.
const PRICES = [
  [/fable|mythos/, [10, 50, 12.5, 1]],
  [/opus-4-[01]\b|3-opus/, [15, 75, 18.75, 1.5]],
  [/opus/, [5, 25, 6.25, 0.5]],
  [/sonnet/, [3, 15, 3.75, 0.3]],
  [/haiku-4/, [1, 5, 1.25, 0.1]],
  [/haiku-3-5|3-5-haiku/, [0.8, 4, 1, 0.08]],
  [/haiku/, [0.25, 1.25, 0.3, 0.03]],
];
// Models missing from the table (usually new ones) are priced as current Opus.
const FALLBACK_PRICE = [5, 25, 6.25, 0.5];

const STATUS_CACHE_MS = 30_000;
// Session files are projects/<dir>/<id>.jsonl; subagent runs sit one or two levels below.
const MAX_SCAN_DEPTH = 4;

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** One transcript line → `{ id, at, cwd, cost }`, or null when it bills nothing. */
export function parseUsageLine(line) {
  if (!line.includes('"usage"')) return null;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  const message = record?.message;
  const usage = message?.usage;
  const at = Date.parse(record?.timestamp);
  if (!message?.id || typeof message.model !== 'string' || message.model === '<synthetic>' || !usage) return null;
  if (!Number.isFinite(at) || typeof record.cwd !== 'string') return null;
  const [input, output, cacheWrite, cacheRead] = PRICES.find(([pattern]) => pattern.test(message.model))?.[1] ?? FALLBACK_PRICE;
  const cost = (num(usage.input_tokens) * input + num(usage.output_tokens) * output
    + num(usage.cache_creation_input_tokens) * cacheWrite + num(usage.cache_read_input_tokens) * cacheRead) / 1_000_000;
  return { id: message.id, at, cwd: record.cwd, cost };
}

/** Coerces stored or submitted settings into range, falling back to the defaults. */
export function normalizeSettings(input) {
  const settings = { ...USAGE_GATE_DEFAULTS };
  if (typeof input?.enabled === 'boolean') settings.enabled = input.enabled;
  for (const [key, [min, max]] of Object.entries(SETTING_RANGES)) {
    const value = Number(input?.[key]);
    if (input?.[key] !== undefined && input[key] !== '' && Number.isFinite(value)) settings[key] = Math.min(Math.max(value, min), max);
  }
  return settings;
}

const isUnder = (root, candidate) => candidate === root || candidate.startsWith(root.endsWith('/') ? root : `${root}/`);

/** Share of one workspace and whether it is over the limit. */
export function evaluateShare(entries, root, settings) {
  let total = 0;
  let used = 0;
  for (const entry of entries) {
    total += entry.cost;
    if (isUnder(root, entry.cwd)) used += entry.cost;
  }
  const denominator = Math.max(total, settings.baselineUsd);
  const percent = denominator > 0 ? (used / denominator) * 100 : 0;
  return { used, total, denominator, percent, blocked: settings.enabled && percent >= settings.limitPercent };
}

async function listRecentFiles(dir, sinceMs, depth = 0, found = []) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_SCAN_DEPTH) await listRecentFiles(full, sinceMs, depth + 1, found);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        const stat = await fs.promises.stat(full);
        if (stat.mtimeMs >= sinceMs) found.push({ file: full, size: stat.size });
      } catch {
        // Removed while scanning.
      }
    }
  }
  return found;
}

/**
 * Reads usage from the shared ~/.claude/projects transcripts (the data the
 * claude-usage plugin charts). Transcripts are append-only, so a grown file is
 * read from where the previous read stopped.
 */
export function createTranscriptReader(projectsDir) {
  const files = new Map(); // file → { offset, entries }

  async function readFile(file, size) {
    let cached = files.get(file);
    if (!cached || size < cached.offset) {
      cached = { offset: 0, entries: [] };
      files.set(file, cached);
    }
    if (size === cached.offset) return cached.entries;
    let pending = Buffer.alloc(0);
    for await (const chunk of fs.createReadStream(file, { start: cached.offset, end: size - 1 })) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      const lastNewline = pending.lastIndexOf(0x0a);
      if (lastNewline === -1) continue;
      for (const line of pending.subarray(0, lastNewline).toString('utf8').split('\n')) {
        const entry = parseUsageLine(line);
        if (entry) cached.entries.push(entry);
      }
      cached.offset += lastNewline + 1;
      pending = pending.subarray(lastNewline + 1);
    }
    // An unterminated last line is still being written; it is read next time.
    return cached.entries;
  }

  return {
    /** Entries since `sinceMs`, deduplicated by message id (one reply spans several lines). */
    async entriesSince(sinceMs) {
      const seenFiles = new Set();
      const seenIds = new Set();
      const result = [];
      for (const { file, size } of await listRecentFiles(projectsDir, sinceMs)) {
        seenFiles.add(file);
        let entries;
        try {
          entries = await readFile(file, size);
        } catch {
          files.delete(file);
          continue;
        }
        for (const entry of entries) {
          if (entry.at < sinceMs || seenIds.has(entry.id)) continue;
          seenIds.add(entry.id);
          result.push(entry);
        }
      }
      for (const file of files.keys()) if (!seenFiles.has(file)) files.delete(file);
      return result;
    },
  };
}

/** The gate used by gateway/usage/routes.mjs. Every failure is reported as "not blocked". */
export function createUsageGate({ config, store, log }) {
  const settingsFile = dataPaths(config).usageGate;
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(config.childHome, '.claude');
  const reader = createTranscriptReader(path.join(claudeDir, 'projects'));
  let cached = null; // { at, windowHours, entries }
  let inflight = null;

  function readSettings() {
    try {
      return normalizeSettings(JSON.parse(fs.readFileSync(settingsFile, 'utf8')));
    } catch {
      return normalizeSettings({});
    }
  }

  async function recentEntries(windowHours) {
    if (cached && cached.windowHours === windowHours && Date.now() - cached.at < STATUS_CACHE_MS) return cached.entries;
    // Concurrent callers share one scan.
    inflight ??= reader.entriesSince(Date.now() - windowHours * 3_600_000)
      .then((entries) => {
        cached = { at: Date.now(), windowHours, entries };
        return entries;
      })
      .finally(() => { inflight = null; });
    return inflight;
  }

  return {
    readSettings,

    saveSettings(input) {
      const settings = normalizeSettings({ ...readSettings(), ...input });
      writePrivateFile(`${settingsFile}.tmp`, JSON.stringify(settings, null, 2));
      fs.renameSync(`${settingsFile}.tmp`, settingsFile);
      cached = null;
      return settings;
    },

    /** What a member's page needs: blocked or not, plus the banner text. */
    async statusFor(account) {
      if (account.role !== 'member') return { blocked: false };
      const settings = readSettings();
      if (!settings.enabled) return { blocked: false };
      try {
        const share = evaluateShare(await recentEntries(settings.windowHours), account.workspace_root, settings);
        const percent = Math.round(share.percent);
        return {
          blocked: share.blocked,
          percent,
          message: share.blocked
            ? `本目录近 ${settings.windowHours} 小时的 Claude 用量约占 ${percent}%，已达到上限 ${settings.limitPercent}%，暂停发送；用量随时间回落后自动恢复。`
            : '',
        };
      } catch (error) {
        log(`usage gate failed for ${account.username}: ${error.message}`);
        return { blocked: false };
      }
    },

    /** Settings plus every member's current share, for the admin page. */
    async overview() {
      const settings = readSettings();
      const entries = await recentEntries(settings.windowHours);
      const members = store.list().filter((account) => account.role === 'member').map((account) => {
        const share = evaluateShare(entries, account.workspace_root, settings);
        return { username: account.username, workspaceRoot: account.workspace_root, usedUsd: share.used, percent: share.percent, blocked: share.blocked };
      });
      const totalUsd = entries.reduce((sum, entry) => sum + entry.cost, 0);
      return { settings, defaults: USAGE_GATE_DEFAULTS, totalUsd, denominatorUsd: Math.max(totalUsd, settings.baselineUsd), members };
    },
  };
}
