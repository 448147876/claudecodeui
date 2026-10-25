// `cloudcli-multi check` (B-5): runs the [自动] BDD scenarios of
// mydocs/06 against a throwaway fixture, scans upstream for new path
// parameters, and optionally runs the upstream test suite.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { APP_ROOT, loadConfig } from '../config.mjs';
import { runBrowserChecks } from './browser.mjs';
import { Client, GatewayProcess, createFixture, writeTranscript } from './harness.mjs';
import { findUnaudited, scanUpstream, unexpectedReadOnlyCallers } from './scan-path-params.mjs';
import { authScenarios, passwordScenarios, setupScenarios } from './scenarios/acc-auth.mjs';
import { crossScenarios, e2eSetupScenarios, featureScenarios, globalProbeScenarios } from './scenarios/e2e.mjs';
import { dataScenarios, snapshotDir, staticScenarios, worktreeScenarios } from './scenarios/extra.mjs';
import { hardeningScenarios } from './scenarios/hardening.mjs';
import { policyScenarios } from './scenarios/policy.mjs';
import { injectScenarios } from './scenarios/inject.mjs';
import { apiScenarios, sessionScenarios, workspaceScenarios } from './scenarios/isolation.mjs';
import { claudeScenarios, idleScenarios, lifecycleScenarios, processScenarios } from './scenarios/proc-upg.mjs';

class SkipError extends Error {}

const USAGE = `用法：cloudcli-multi check [--dev] [--keep] [--only=ACC,API] [--upstream-tests] [--browser] [--scan-only]
  --dev             子进程用 tsx 运行源码（不需要构建 dist-server）
  --keep            保留临时目录，便于排查
  --only=前缀,...   只跑编号以这些前缀开头的场景（依赖的前置场景仍会运行）
  --upstream-tests  额外运行上游测试（npm test，不设隔离开关）
  --browser         额外在真实浏览器中检查（需 CLOUDCLI_MULTI_PLAYWRIGHT_CORE、CLOUDCLI_MULTI_CHROMIUM）
  --scan-only       只做路径参数静态扫描`;

function parseArgs(args) {
  const options = { dev: false, keep: false, only: null, upstreamTests: false, scanOnly: false, browser: false };
  for (const arg of args) {
    if (arg === '--dev') options.dev = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--upstream-tests') options.upstreamTests = true;
    else if (arg === '--scan-only') options.scanOnly = true;
    else if (arg === '--browser') options.browser = true;
    else if (arg.startsWith('--only=')) options.only = arg.slice(7).split(',').filter(Boolean);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

const scanScenarios = [
  ['UPG-10', '静态扫描：没有未审核的路径参数，且能发现新增参数', async () => {
    const unaudited = findUnaudited();
    assert.deepEqual(unaudited.map((entry) => `${entry.file}:${entry.line} ${entry.expression}`), [], '发现未审核的路径参数，请按 mydocs/04 第 3 节处理');
    assert.deepEqual(unexpectedReadOnlyCallers(), [], 'resolveReadOnlyRootPath 出现了新的调用方');
    const probe = path.join(APP_ROOT, 'server', 'modules', '__isolation_scan_probe.ts');
    fs.writeFileSync(probe, 'export const probe = (req: any) => req.body.targetPath;\n');
    try {
      const found = [...scanUpstream().keys()].some((key) => key === `${path.relative(APP_ROOT, probe)} | body.targetPath`);
      assert.ok(found, 'the scanner detects a newly added path parameter');
      assert.ok(findUnaudited().some((entry) => entry.expression === 'body.targetPath'));
    } finally {
      fs.rmSync(probe, { force: true });
    }
  }],
];

const UPSTREAM_TESTS = ['UPG-04', '关闭开关时上游测试全部通过', async () => {
  const env = { ...process.env };
  delete env.CLOUDCLI_ISOLATION_ROOT;
  const runOnce = () => {
    const result = spawnSync('npm', ['test'], { cwd: APP_ROOT, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const output = `${result.stdout}${result.stderr}`;
    return { status: result.status, failed: output.split('\n').filter((line) => line.startsWith('not ok')) };
  };
  let result = runOnce();
  if (result.status !== 0) {
    // Upstream's agent.routes test intermittently crashes the test runner
    // ("Unable to deserialize cloned data"), also on an unpatched checkout.
    console.log(`      第一次失败：${result.failed.join('；')}；重跑一次`);
    result = runOnce();
  }
  assert.equal(result.status, 0, `npm test failed: ${result.failed.join('; ')}`);
}];

export async function runChecks(args = []) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const results = [];
  const runList = async (list, ctx) => {
    for (const [id, title, fn] of list) {
      const selected = !options.only || options.only.some((prefix) => id.startsWith(prefix));
      const started = Date.now();
      try {
        await fn(ctx);
        results.push({ id, title, status: 'pass', ms: Date.now() - started, selected });
        if (selected) console.log(`  ✔ ${id} ${title} (${Date.now() - started} ms)`);
      } catch (error) {
        if (error instanceof SkipError) {
          results.push({ id, title, status: 'skip', reason: error.message, selected });
          console.log(`  - ${id} ${title}（跳过：${error.message}）`);
          continue;
        }
        results.push({ id, title, status: 'fail', error, selected });
        console.log(`  ✘ ${id} ${title}\n      ${String(error.stack ?? error).split('\n').slice(0, 4).join('\n      ')}`);
      }
    }
  };

  if (options.scanOnly) {
    await runList(scanScenarios, {});
    return summarize(results);
  }

  // UPG-09: the real data root must come out of the run untouched.
  const realDataRoot = loadConfig().dataRoot;
  const realBefore = snapshotDir(realDataRoot);

  const childMode = options.dev || !fs.existsSync(path.join(APP_ROOT, 'dist-server', 'server', 'index.js')) ? 'dev' : 'dist';
  const fixture = createFixture();
  console.log(`检查目录：${fixture.root}（子进程模式：${childMode}）`);

  const ids = {
    sA: 'aaaaaaaa-0000-4000-8000-000000000001',
    sB: 'bbbbbbbb-0000-4000-8000-000000000002',
    sT: 'cccccccc-0000-4000-8000-000000000003',
    sH: 'eeeeeeee-0000-4000-8000-000000000005',
  };
  const transcripts = {
    sA: writeTranscript(fixture, path.join(fixture.projA, 'app1'), ids.sA, 'ZEBRA-A'),
    sB: writeTranscript(fixture, path.join(fixture.projB, 'app2'), ids.sB, 'ZEBRA-B'),
    sT: writeTranscript(fixture, fixture.projAtmp, ids.sT, 'ZEBRA-T'),
    sH: writeTranscript(fixture, path.join(fixture.home, 'other'), ids.sH, 'ZEBRA-H'),
  };
  fs.writeFileSync(path.join(fixture.projB, 'app2', 'CLAUDE.md'), 'SECRET-B');
  fs.mkdirSync(path.join(fixture.projB, 'app2', '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(fixture.projB, 'app2', '.claude', 'commands', 'secret.md'), 'secret command');

  // Values that must never reach a child (PROC-01).
  const gw = new GatewayProcess(fixture, { childMode, env: { JWT_SECRET: 'leak', API_KEY: 'leak', VITE_IS_PLATFORM: 'true' } });
  const ctx = {
    fixture, ids, transcripts, gw, childMode, state: {}, findings: [],
    skip: (reason) => { throw new SkipError(reason); },
  };

  try {
    await gw.start();
    ctx.admin = new Client(gw);
    ctx.a = new Client(gw);
    ctx.b = new Client(gw);

    console.log('\nFeature 1/2：账号管理、登录与入口');
    await runList(setupScenarios, ctx);
    await runList(authScenarios, ctx);
    await runList(passwordScenarios, ctx);
    console.log('\nFeature 3/4/5：工作目录、项目与会话、API 越权');
    await runList(workspaceScenarios, ctx);
    await runList(sessionScenarios, ctx);
    await runList(apiScenarios, ctx);
    await runList(worktreeScenarios, ctx);
    console.log('\n端到端：三个普通账号交叉隔离、功能可用性、全局配置探测');
    await runList(e2eSetupScenarios, ctx);
    await runList(crossScenarios, ctx);
    await runList(featureScenarios, ctx);
    console.log('\n方案 B：普通账号不能修改全局配置');
    await runList(policyScenarios, ctx);
    console.log('\n加固：.git 内部、Taskmaster 文档名、克隆来源、/tmp、MCP 默认目录');
    await runList(hardeningScenarios, ctx);
    await runList(globalProbeScenarios, ctx);
    console.log('\nFeature 6/7：子进程、共用 Claude 登录');
    await runList(processScenarios, ctx);
    await runList(claudeScenarios, ctx);

    console.log('\nFeature 6：空闲回收（短阈值网关）');
    await gw.stop();
    await gw.start({ CLOUDCLI_MULTI_IDLE_SECONDS: '4', CLOUDCLI_MULTI_IDLE_CHECK_SECONDS: '1' });
    await ctx.a.openApp();
    await ctx.b.openApp();
    ctx.admin = new Client(gw);
    await ctx.admin.login('admin', '123456');
    await runList(idleScenarios, ctx);
    await gw.stop();
    await gw.start();
    ctx.admin = new Client(gw);
    await ctx.admin.login('admin', '123456');
    await ctx.a.openApp();
    await ctx.b.openApp();

    console.log('\nFeature 6/8/1：生命周期、升级、删除账号');
    await runList(lifecycleScenarios, ctx);
    await runList(dataScenarios, ctx);
  } catch (error) {
    results.push({ id: 'HARNESS', title: '检查环境', status: 'fail', error, selected: true });
    console.log(`  ✘ 检查环境出错：${error.stack ?? error}\n${gw.output.split('\n').slice(-20).join('\n')}`);
  } finally {
    await gw.stop();
    if (!options.keep) fs.rmSync(fixture.root, { recursive: true, force: true });
    else console.log(`\n保留检查目录：${fixture.root}`);
  }

  console.log('\nAUTH：注入脚本（jsdom）');
  await runList(injectScenarios, ctx);
  console.log('\nUPG：静态检查与单元测试');
  await runList(scanScenarios, ctx);
  await runList(staticScenarios, ctx);
  await runList([['UPG-09', '检查不触碰真实数据，临时目录已删除', async () => {
    assert.equal(snapshotDir(realDataRoot), realBefore, `${realDataRoot} 在检查期间被修改`);
    if (!options.keep) assert.ok(!fs.existsSync(fixture.root), '临时目录未删除');
  }]], ctx);
  if (options.browser) {
    console.log('\nBR：真实浏览器（headless Chromium）');
    results.push(...await runBrowserChecks({ shots: path.join(APP_ROOT, 'gateway', '.check-shots'), childMode }));
  }
  if (options.upstreamTests) {
    console.log('\nUPG：上游测试');
    await runList([UPSTREAM_TESTS], ctx);
  }
  if (ctx.findings?.length) {
    console.log('\n普通账号对工作目录以外的改动能力（探测结果，不计入通过/失败）：');
    for (const [id, target, result, note] of ctx.findings) console.log(`  ${id}  ${target}：${result}；${note}`);
  }
  if (ctx.state?.chatFrameTypes) console.log(`\n聊天 WebSocket 收到的消息类型：${ctx.state.chatFrameTypes}`);
  return summarize(results);
}

function summarize(results) {
  const failed = results.filter((result) => result.status === 'fail');
  const passed = results.filter((result) => result.status === 'pass').length;
  const skipped = results.filter((result) => result.status === 'skip').length;
  console.log(`\n结果：通过 ${passed}，失败 ${failed.length}，跳过 ${skipped}`);
  for (const result of failed) console.log(`  ✘ ${result.id} ${result.title}`);
  return failed.length ? 1 : 0;
}
