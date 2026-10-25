// Optional real-browser checks (`cloudcli-multi check --browser`), run in
// headless Chromium through a playwright-core installed outside this package,
// so no dependency is added:
//   CLOUDCLI_MULTI_PLAYWRIGHT_CORE=<directory of the playwright-core package>
//   CLOUDCLI_MULTI_CHROMIUM=<chromium or chrome-headless-shell executable>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Client, GatewayProcess, createFixture, waitFor, writeTranscript } from './harness.mjs';

export async function runBrowserChecks({ shots, childMode }) {
  const corePath = process.env.CLOUDCLI_MULTI_PLAYWRIGHT_CORE;
  const executablePath = process.env.CLOUDCLI_MULTI_CHROMIUM;
  if (!corePath || !executablePath) {
    console.log('  - BR 真实浏览器检查（跳过：未设置 CLOUDCLI_MULTI_PLAYWRIGHT_CORE / CLOUDCLI_MULTI_CHROMIUM）');
    return [{ id: 'BR', title: '真实浏览器检查', status: 'skip', reason: '未设置 Playwright 路径' }];
  }
  const { chromium } = await import(pathToFileURL(path.join(corePath, 'index.mjs')).href);
  fs.rmSync(shots, { recursive: true, force: true });
  fs.mkdirSync(shots, { recursive: true });

  const results = [];
  let currentPage = null;
  const consoleErrors = [];
  const badResponses = [];

  async function step(id, title, fn) {
    const started = Date.now();
    try {
      const note = await fn();
      results.push({ id, title, status: 'pass', ms: Date.now() - started, selected: true });
      console.log(`  ✔ ${id} ${title}${note ? `（${note}）` : ''}`);
    } catch (error) {
      await currentPage?.screenshot({ path: path.join(shots, `${id}-FAILED.png`) }).catch(() => {});
      results.push({ id, title, status: 'fail', error, selected: true });
      console.log(`  ✘ ${id} ${title}\n      ${String(error.message ?? error).slice(0, 400)}`);
    }
  }

  function watch(page, label) {
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`[${label}] ${msg.text().slice(0, 200)}`);
    });
    page.on('pageerror', (error) => consoleErrors.push(`[${label}] pageerror ${error.message.slice(0, 200)}`));
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (response.status() >= 500 || (response.status() >= 400 && !url.pathname.startsWith('/__gw/'))) badResponses.push(`[${label}] ${response.status()} ${response.request().method()} ${url.pathname}`);
    });
  }


  async function login(page, username, password) {
    // Open the login page directly: an already signed-in browser is not redirected there.
    await page.goto(`${gw.base}/__gw/login`);
    await page.fill('#username', username);
    await page.fill('#password', password);
    await page.click('button[type=submit]');
    await page.waitForURL((url) => !url.pathname.startsWith('/__gw/'), { timeout: 60_000 });
    // The gateway shows a refreshing "starting" page until the child is up.
    await waitFor(async () => !(await page.content()).includes('正在启动'), { timeoutMs: 60_000, message: 'child start' });
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
  }


  const bodyText = (page) => page.evaluate(() => document.body.innerText);

  const fixture = createFixture();
  const ids = { a: 'aaaaaaaa-1111-4000-8000-000000000001', b: 'bbbbbbbb-2222-4000-8000-000000000002' };
  writeTranscript(fixture, path.join(fixture.projA, 'alpha-app'), ids.a, 'SECRET-ALPHA');
  writeTranscript(fixture, path.join(fixture.projB, 'beta-app'), ids.b, 'SECRET-BETA');
  const gw = new GatewayProcess(fixture, { childMode });
  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });

  try {
    await gw.start();
    const admin = new Client(gw);
    await admin.post('/__gw/api/setup', { username: 'admin', password: 'admin123' });
    await admin.post('/__gw/api/accounts', { username: 'projA', password: 'passA1', workspaceRoot: fixture.projA });
    await admin.post('/__gw/api/accounts', { username: 'projB', password: 'passB1', workspaceRoot: fixture.projB });

    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-CN' });
    const page = await context.newPage();
    watch(page, 'main');
    currentPage = page;


    await step('BR-01', '未登录访问首页跳转到网关登录页', async () => {
      await page.goto(`${gw.base}/`);
      await page.waitForURL(/\/__gw\/login/);
      await page.screenshot({ path: path.join(shots, '01-login.png') });
    });

    await step('BR-02', 'projA 登录后直接进入主界面（没有上游登录页），能看到自己的项目', async () => {
      await login(page, 'projA', 'passA1');
      await waitFor(async () => (await bodyText(page)).includes('alpha-app'), { timeoutMs: 30_000, message: 'alpha-app in sidebar' });
      const text = await bodyText(page);
      if (await page.locator('input[type=password]').count()) throw new Error('upstream login form is visible');
      if (text.includes('beta-app')) throw new Error('projB project visible to projA');
      await page.screenshot({ path: path.join(shots, '02-projA-main.png') });
      const storage = await page.evaluate(() => ({ account: localStorage.getItem('gw-account'), token: Boolean(localStorage.getItem('auth-token')) }));
      if (storage.account !== 'projA' || !storage.token) throw new Error(`localStorage ${JSON.stringify(storage)}`);
      return 'localStorage 已写入 projA 的 token';
    });

    await step('BR-03', 'projA 打开自己的会话能看到消息内容', async () => {
      await page.goto(`${gw.base}/session/${ids.a}`);
      await waitFor(async () => (await bodyText(page)).includes('SECRET-ALPHA'), { timeoutMs: 30_000, message: 'own session content' });
      await page.screenshot({ path: path.join(shots, '03-projA-session.png') });
    });

    await step('BR-04', 'projA 直接输入 projB 会话的地址，看不到内容', async () => {
      await page.goto(`${gw.base}/session/${ids.b}`);
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const text = await bodyText(page);
      await page.screenshot({ path: path.join(shots, '04-projA-opens-projB-session.png') });
      if (text.includes('SECRET-BETA') || text.includes('beta-app')) throw new Error('projB content rendered');
    });

    await step('BR-05', '右上角菜单：普通账号只有「退出登录」', async () => {
      await page.goto(`${gw.base}/`);
      await page.waitForSelector('#gw-menu button', { timeout: 30_000 });
      await page.click('#gw-menu button');
      const links = await page.$$eval('#gw-menu a', (as) => as.map((a) => a.textContent));
      await page.screenshot({ path: path.join(shots, '05-projA-menu.png') });
      if (JSON.stringify(links) !== JSON.stringify(['退出登录'])) throw new Error(`menu ${JSON.stringify(links)}`);
    });

    await step('BR-05b', '账号菜单不遮挡上游界面上的任何可点击元素', async () => {
      for (const url of [`${gw.base}/`, `${gw.base}/session/${ids.a}`]) {
        await page.goto(url);
        await page.waitForSelector('#gw-menu button', { timeout: 30_000 });
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
        const overlaps = await page.evaluate(() => {
          const menu = document.querySelector('#gw-menu > button').getBoundingClientRect();
          const hits = [];
          for (const el of document.querySelectorAll('button, a, input, textarea, [role=tab], [role=button]')) {
            if (el.closest('#gw-menu')) continue;
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            if (r.left < menu.right && r.right > menu.left && r.top < menu.bottom && r.bottom > menu.top) hits.push((el.innerText || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 30));
          }
          return hits;
        });
        if (overlaps.length) throw new Error(`${url} 遮挡：${overlaps.join(', ')}`);
      }
      await page.screenshot({ path: path.join(shots, '05b-menu-position.png') });
    });

    await step('BR-06', '同一浏览器不退出直接登录 projB：草稿被清空，只看到 projB 的项目', async () => {
      await page.evaluate(() => localStorage.setItem('draft-from-projA', 'my secret draft'));
      await login(page, 'projB', 'passB1');
      await waitFor(async () => (await bodyText(page)).includes('beta-app'), { timeoutMs: 30_000, message: 'beta-app in sidebar' });
      const text = await bodyText(page);
      if (text.includes('alpha-app')) throw new Error('projA project visible to projB');
      const storage = await page.evaluate(() => ({ account: localStorage.getItem('gw-account'), draft: localStorage.getItem('draft-from-projA') }));
      await page.screenshot({ path: path.join(shots, '06-projB-main.png') });
      if (storage.account !== 'projB' || storage.draft !== null) throw new Error(`localStorage ${JSON.stringify(storage)}`);
    });

    await step('BR-07', '通过右上角菜单退出：回到登录页，本地数据清空，再访问被拦回登录页', async () => {
      await page.click('#gw-menu button');
      await page.click('#gw-menu a[href="/__gw/logout"]');
      await page.waitForURL(/\/__gw\/login/);
      const keys = await page.evaluate(() => Object.keys(localStorage));
      if (keys.length) throw new Error(`localStorage not empty: ${keys.join(',')}`);
      await page.goto(`${gw.base}/session/${ids.b}`);
      await page.waitForURL(/\/__gw\/login/);
    });

    await step('BR-08', '管理员：菜单有「账号管理」，管理页列出全部账号', async () => {
      await login(page, 'admin', 'admin123');
      await page.waitForSelector('#gw-menu button', { timeout: 30_000 });
      await page.click('#gw-menu button');
      await page.click('#gw-menu a[href="/__gw/admin"]');
      await page.waitForURL(/\/__gw\/admin/);
      await waitFor(async () => (await bodyText(page)).includes('projB'), { timeoutMs: 15_000, message: 'accounts table' });
      const text = await bodyText(page);
      await page.screenshot({ path: path.join(shots, '08-admin-accounts.png'), fullPage: true });
      for (const name of ['admin', 'projA', 'projB']) if (!text.includes(name)) throw new Error(`${name} missing`);
    });

    await step('BR-09', '管理员在管理页新增账号 projC', async () => {
      await page.fill('#username', 'projC');
      await page.fill('#password', 'passC1');
      await page.click('#create button[type=submit]');
      await waitFor(async () => (await bodyText(page)).includes('已创建'), { timeoutMs: 15_000, message: 'created notice' });
      await page.screenshot({ path: path.join(shots, '09-admin-created.png'), fullPage: true });
    });

    await step('BR-10', '管理员首次进入：在浏览器里完成上游引导（保存全局 git 配置）', async () => {
      await page.goto(`${gw.base}/`);
      await page.getByText('Git Configuration').first().waitFor({ timeoutMs: 30_000 });
      await page.screenshot({ path: path.join(shots, '10a-admin-onboarding.png') });
      await page.getByRole('button', { name: /Next/ }).click();
      const finish = page.getByRole('button', { name: /Finish|Complete|Get started|Done|完成|开始/i });
      await finish.first().waitFor({ timeoutMs: 15_000 });
      await finish.first().click();
      await waitFor(async () => !(await bodyText(page)).includes('Git Configuration'), { timeoutMs: 15_000, message: 'onboarding closed' });
    });

    await step('BR-10b', '管理员主界面能看到所有账号的项目', async () => {
      await page.goto(`${gw.base}/`);
      await waitFor(async () => {
        const text = await bodyText(page);
        return text.includes('alpha-app') && text.includes('beta-app');
      }, { timeout: 30_000, message: 'admin sees both projects' });
      await page.screenshot({ path: path.join(shots, '10-admin-main.png') });
    });

    await step('BR-11', '页面加载过程中没有 5xx，也没有非预期的 4xx', async () => {
      // Expected: the gateway's "starting" page answers 503 while it refreshes, and
      // BR-04 deliberately asks for projB's session (404).
      const unexpected = badResponses.filter((line) => !line.includes(`/api/providers/sessions/${ids.b}`) && !/ 503 GET \/$/.test(line));
      if (unexpected.length) throw new Error(unexpected.slice(0, 10).join('\n'));
      return `浏览器控制台错误 ${consoleErrors.length} 条`;
    });

  } catch (error) {
    results.push({ id: 'BR-HARNESS', title: '浏览器检查环境', status: 'fail', error, selected: true });
    console.log(`  ✘ 浏览器检查环境出错：${error.stack ?? error}`);
  } finally {
    await browser.close();
    await gw.stop();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
  if (consoleErrors.length) console.log(`  浏览器控制台错误 ${consoleErrors.length} 条（含预期的启动页 503）`);
  console.log(`  截图：${shots}`);
  return results;
}
