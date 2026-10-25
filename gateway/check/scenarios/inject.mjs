import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { APP_ROOT } from '../../config.mjs';

const INJECT = fs.readFileSync(path.join(APP_ROOT, 'gateway', 'public', 'static', 'inject.js'), 'utf8');

/** Runs inject.js in jsdom (a dev dependency) with a pre-filled localStorage. */
async function runInject(ctx, bootstrap, storage) {
  let JSDOM;
  let VirtualConsole;
  try {
    ({ JSDOM, VirtualConsole } = await import('jsdom'));
  } catch {
    ctx.skip('未安装 jsdom（开发依赖）');
  }
  const navigations = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => {
    if (/navigation/i.test(error.message)) navigations.push(error.message);
  });
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://gateway.test/', runScripts: 'outside-only', virtualConsole });
  for (const [key, value] of Object.entries(storage)) dom.window.localStorage.setItem(key, value);
  dom.window.__GW__ = bootstrap;
  dom.window.eval(INJECT);
  return { window: dom.window, navigations };
}

export const injectScenarios = [
  ['AUTH-06', '切换账号时清空本地数据并写入新 token（jsdom）', async (ctx) => {
    const { window, navigations } = await runInject(ctx, { account: 'projB', role: 'member', token: 'token-B' }, { 'gw-account': 'projA', 'auth-token': 'token-A', 'draft-A': 'draft text' });
    assert.equal(window.localStorage.getItem('draft-A'), null, 'drafts of the previous account are gone');
    assert.equal(window.localStorage.getItem('gw-account'), 'projB');
    assert.equal(window.localStorage.getItem('auth-token'), 'token-B');
    assert.deepEqual(navigations, [], 'the internal clear does not log out');
  }],

  ['AUTH-14b', '同一账号重新打开页面只刷新 token，保留草稿（jsdom）', async (ctx) => {
    const { window } = await runInject(ctx, { account: 'projA', role: 'member', token: 'token-new' }, { 'gw-account': 'projA', 'auth-token': 'token-old', 'draft-A': 'keep me' });
    assert.equal(window.localStorage.getItem('draft-A'), 'keep me');
    assert.equal(window.localStorage.getItem('auth-token'), 'token-new');
  }],

  ['AUTH-07b', '上游退出（移除 token）会跳转到网关退出页（jsdom）', async (ctx) => {
    const { window, navigations } = await runInject(ctx, { account: 'projA', role: 'member', token: 't' }, {});
    window.localStorage.removeItem('some-other-key');
    assert.deepEqual(navigations, [], 'other keys do not log out');
    window.localStorage.removeItem('auth-token');
    assert.equal(navigations.length, 1, 'removing auth-token navigates away');
  }],

  ['AUTH-08b', '悬浮菜单：管理员有账号管理入口，普通账号没有（jsdom）', async (ctx) => {
    const admin = await runInject(ctx, { account: 'admin', role: 'admin', token: 't' }, {});
    const adminLinks = [...admin.window.document.querySelectorAll('#gw-menu a')].map((link) => link.getAttribute('href'));
    assert.deepEqual(adminLinks, ['/__gw/admin', '/__gw/logout']);
    const member = await runInject(ctx, { account: 'projA', role: 'member', token: 't' }, {});
    const memberLinks = [...member.window.document.querySelectorAll('#gw-menu a')].map((link) => link.getAttribute('href'));
    assert.deepEqual(memberLinks, ['/__gw/logout']);
  }],
];
