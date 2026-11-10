// Usage gate checks (mydocs/08 3.3): the share computation, the injected UI
// hooks, the upstream markup they rely on, and who may see the settings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { APP_ROOT } from '../../config.mjs';
import { createTranscriptReader, evaluateShare, normalizeSettings, parseUsageLine } from '../../usage/usage-gate.mjs';

const INJECT = fs.readFileSync(path.join(APP_ROOT, 'gateway', 'public', 'static', 'inject.js'), 'utf8');
const readUpstream = (file) => fs.readFileSync(path.join(APP_ROOT, file), 'utf8');

const usageLine = ({ id, cwd, model = 'claude-opus-4-6', at = new Date().toISOString(), output = 40_000 }) => JSON.stringify({
  type: 'assistant', cwd, timestamp: at,
  message: { id, model, usage: { input_tokens: 0, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
});

export const usageUnitScenarios = [
  ['USE-01', '用量控制：按模型计价、按消息去重、增量读取、分母取基准与合计的较大值', async () => {
    // 40k output tokens of current Opus = $1; Haiku 4 = $0.2; an unknown model is priced as Opus.
    assert.equal(parseUsageLine(usageLine({ id: 'm', cwd: '/w' })).cost, 1);
    assert.equal(parseUsageLine(usageLine({ id: 'm', cwd: '/w', model: 'claude-haiku-4-5' })).cost, 0.2);
    assert.equal(parseUsageLine(usageLine({ id: 'm', cwd: '/w', model: 'claude-next-9' })).cost, 1);
    assert.equal(parseUsageLine(usageLine({ id: 'm', cwd: '/w', model: '<synthetic>' })), null);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-gate-'));
    try {
      const file = path.join(dir, '-w-a', 's.jsonl');
      fs.mkdirSync(path.dirname(file));
      const old = new Date(Date.now() - 6 * 3_600_000).toISOString();
      fs.writeFileSync(file, `${[
        usageLine({ id: 'a1', cwd: '/w/a/app' }),
        usageLine({ id: 'a1', cwd: '/w/a/app' }), // the same reply on a second line
        usageLine({ id: 'old', cwd: '/w/a', at: old }),
        usageLine({ id: 'b1', cwd: '/w/ab' }),
      ].join('\n')}\n${usageLine({ id: 'partial', cwd: '/w/a' }).slice(0, 30)}`);
      const reader = createTranscriptReader(dir);
      const since = Date.now() - 5 * 3_600_000;
      let entries = await reader.entriesSince(since);
      assert.deepEqual(entries.map((entry) => entry.id).sort(), ['a1', 'b1'], 'deduplicated, windowed, unterminated line skipped');

      fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8').replace(/\{[^\n]*$/, '')}${usageLine({ id: 'a2', cwd: '/w/a' })}\n`);
      entries = await reader.entriesSince(since);
      assert.deepEqual(entries.map((entry) => entry.id).sort(), ['a1', 'a2', 'b1'], 'appended line picked up');

      const settings = normalizeSettings({ limitPercent: 20, baselineUsd: 10 });
      const a = evaluateShare(entries, '/w/a', settings);
      assert.equal(a.used, 2, '/w/ab is not under /w/a');
      assert.equal(a.denominator, 10, 'small totals are measured against the baseline');
      assert.equal(a.blocked, true, '2 / 10 = 20%');
      assert.equal(evaluateShare(entries, '/w/ab', settings).blocked, false, '1 / 10 = 10%');
      assert.equal(evaluateShare(entries, '/w/a', normalizeSettings({ baselineUsd: 0 })).denominator, 3, 'above the baseline the real total is used');
      assert.equal(evaluateShare(entries, '/w/a', normalizeSettings({ baselineUsd: 10, enabled: false })).blocked, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.deepEqual(normalizeSettings({ limitPercent: 500, windowHours: 'x', baselineUsd: -1 }), { enabled: true, limitPercent: 100, windowHours: 5, baselineUsd: 0 });
  }],

  ['USE-02', '用量控制：超限时注入脚本标记页面，只拦会发送的回车（jsdom）', async (ctx) => {
    let JSDOM;
    try {
      ({ JSDOM } = await import('jsdom'));
    } catch {
      ctx.skip('未安装 jsdom（开发依赖）');
    }
    const run = async (role, preferences) => {
      const dom = new JSDOM('<!doctype html><html><head></head><body><form data-slot="prompt-input"><textarea data-slot="prompt-input-textarea"></textarea></form></body></html>', { url: 'http://gateway.test/', runScripts: 'outside-only', pretendToBeVisual: true });
      const requests = [];
      dom.window.fetch = (url) => {
        requests.push(url);
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ blocked: true, message: '已暂停发送' }) });
      };
      // Same account as before, so inject.js keeps the stored preferences.
      dom.window.localStorage.setItem('gw-account', 'projA');
      if (preferences) dom.window.localStorage.setItem('user-preferences', JSON.stringify({ uiPreferences: preferences }));
      dom.window.__GW__ = { account: 'projA', role, token: 't' };
      dom.window.eval(INJECT);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const press = (init) => {
        const event = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
        dom.window.document.querySelector('textarea').dispatchEvent(event);
        return event.defaultPrevented;
      };
      return { dom, requests, press };
    };

    const member = await run('member');
    assert.deepEqual(member.requests, ['/__gw/api/usage-gate']);
    assert.ok(member.dom.window.document.documentElement.classList.contains('gw-usage-blocked'));
    assert.equal(member.press({}), true, 'Enter would send: swallowed');
    assert.equal(member.press({ shiftKey: true }), false, 'Shift+Enter is a newline');
    assert.equal(member.press({ isComposing: true }), false, 'IME confirmation passes');

    const ctrlEnter = await run('member', { sendByCtrlEnter: true });
    assert.equal(ctrlEnter.press({}), false, 'plain Enter is a newline in Ctrl+Enter mode');
    assert.equal(ctrlEnter.press({ ctrlKey: true }), true);

    const admin = await run('admin');
    assert.deepEqual(admin.requests, [], 'admin is never gated');
    assert.equal(admin.press({}), false);
  }],

  ['USE-03', '用量控制依赖的上游界面结构仍然存在（变化时需同步修改 inject.js 第 4 段）', async () => {
    const promptInput = readUpstream('src/modules/chat/composer/PromptInput.tsx');
    assert.match(promptInput, /data-slot="prompt-input"/, 'composer form marker');
    assert.match(promptInput, /type=\{isActive \? 'button' : 'submit'\}/, 'send button is type=submit only while idle (stop stays visible)');
    assert.match(readUpstream('src/modules/chat/composer/ChatComposer.tsx'), /canQueueDraft \? \(\s*<ArrowUpIcon/, 'queue button shows the arrow-up icon');
    assert.match(readUpstream('src/modules/chat/composer/ScheduleMessagePopover.tsx'), /<Clock /, 'schedule button shows the clock icon');
    assert.match(readUpstream('src/shared/userSettings.ts'), /MIRROR_STORAGE_KEY = 'user-preferences'/, 'preference mirror key');
    assert.match(readUpstream('src/shared/uiPreferences.ts'), /readUserPreference<.*>\('uiPreferences'/, 'send-key preference location');
    const composerState = readUpstream('src/modules/chat/hooks/useChatComposerState.ts');
    assert.match(composerState, /\(event\.ctrlKey \|\| event\.metaKey\) && !event\.shiftKey/, 'Enter handling unchanged');
    assert.match(composerState, /!event\.shiftKey && !event\.ctrlKey && !event\.metaKey && !sendByCtrlEnter/, 'Enter handling unchanged');
  }],
];

export const usageHttpScenarios = [
  ['USE-04', '用量控制：普通账号只能读自己的状态，设置只有管理员能看和改', async (ctx) => {
    const status = await ctx.a.get('/__gw/api/usage-gate');
    assert.equal(status.status, 200, status.text);
    assert.equal(typeof status.body.blocked, 'boolean');
    assert.equal(status.body.settings, undefined, 'members do not get the settings');
    assert.equal((await ctx.a.get('/__gw/api/usage-gate/settings')).status, 403);
    assert.equal((await ctx.a.request('PUT', '/__gw/api/usage-gate/settings', { json: { limitPercent: 1 } })).status, 403);

    const saved = await ctx.admin.request('PUT', '/__gw/api/usage-gate/settings', { json: { limitPercent: 35, baselineUsd: 200 } });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.body.settings.limitPercent, 35);
    assert.ok(saved.body.members.some((member) => member.username === 'projA'));
    assert.equal((await ctx.admin.get('/__gw/api/usage-gate')).body.blocked, false, 'admin is never gated');
    const reset = await ctx.admin.request('PUT', '/__gw/api/usage-gate/settings', { json: saved.body.defaults });
    assert.equal(reset.body.settings.limitPercent, saved.body.defaults.limitPercent);
  }],
];
