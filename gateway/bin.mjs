#!/usr/bin/env node
// cloudcli-multi: multi-account gateway for CloudCLI UI (see mydocs/).
import fs from 'node:fs';
import path from 'node:path';

import { dataPaths, loadConfig } from './config.mjs';
import { isAlive } from './proc/run-files.mjs';
import { listBackups, restoreBackup } from './store/backup.mjs';

const USAGE = `用法：cloudcli-multi <命令>

  start               启动网关（默认）
  check               运行检查脚本（BDD 自动场景 + 路径参数扫描）
  backups             列出数据备份
  restore <备份名>    用备份覆盖数据目录（网关需已停止）

环境变量见 mydocs/03-技术方案.md 第 9 节。`;

const [command = 'start', ...args] = process.argv.slice(2);
const config = loadConfig();

function gatewayRunning() {
  const lock = dataPaths(config).lock;
  if (!fs.existsSync(lock)) return false;
  return isAlive(Number.parseInt(fs.readFileSync(lock, 'utf8'), 10));
}

switch (command) {
  case 'start': {
    if (!fs.existsSync(path.join(config.appRoot, 'dist', 'index.html')) && config.childMode !== 'dev') {
      console.error('找不到前端构建产物 dist/；请先运行 npm run build:multi');
      process.exit(1);
    }
    const { startGateway } = await import('./server.mjs');
    let gateway;
    try {
      gateway = await startGateway(config);
    } catch (error) {
      console.error(`[gateway] 启动失败：${error.message}`);
      process.exit(1);
    }
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, async () => {
        await gateway.close();
        process.exit(0);
      });
    }
    break;
  }
  case 'check': {
    const { runChecks } = await import('./check/run.mjs');
    process.exitCode = await runChecks(args);
    break;
  }
  case 'backups':
    for (const name of listBackups(config)) console.log(name);
    break;
  case 'restore': {
    if (!args[0]) {
      console.error(USAGE);
      process.exit(1);
    }
    if (gatewayRunning()) {
      console.error('网关正在运行，请先停止');
      process.exit(1);
    }
    restoreBackup(config, args[0]);
    console.log(`已从备份 ${args[0]} 恢复 ${config.dataRoot}`);
    break;
  }
  default:
    console.log(USAGE);
    process.exit(command === 'help' || command === '--help' ? 0 : 1);
}
