import fs from 'node:fs';
import path from 'node:path';

import express from 'express';

import { wrap } from '../http-utils.mjs';
import { dataPaths } from '../config.mjs';
import { currentAccount } from '../auth/session.mjs';
import { removeRunFile } from '../proc/run-files.mjs';
import { MIN_PASSWORD_LENGTH, USERNAME_PATTERN } from '../store/accounts.mjs';
import { WorkspaceRuleError, prepareWorkspaceRoot } from './workspace-rules.mjs';

const PUBLIC_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public');

export function createAdminRouter(ctx) {
  const router = express.Router();
  const paths = dataPaths(ctx.config);

  const requireAdmin = (req, res, next) => {
    const account = currentAccount(req, ctx);
    if (!account) {
      if (req.method === 'GET' && !req.path.startsWith('/api/')) return res.redirect(302, '/__gw/login');
      return res.status(401).json({ error: '未登录' });
    }
    if (account.role !== 'admin') return res.status(403).json({ error: '只有管理员可以管理账号' });
    req.account = account;
    next();
  };

  const findMember = (req, res) => {
    const member = ctx.store.getByUsername(req.params.username);
    if (!member) {
      res.status(404).json({ error: '账号不存在' });
      return null;
    }
    return member;
  };

  router.get('/admin', requireAdmin, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(fs.readFileSync(path.join(PUBLIC_DIR, 'admin.html'), 'utf8'));
  });

  router.get('/api/accounts', requireAdmin, (req, res) => {
    res.json({
      workspacesRoot: ctx.config.workspacesRoot,
      accounts: ctx.store.list().map((account) => ({
        username: account.username,
        role: account.role,
        workspaceRoot: account.workspace_root,
        note: account.note,
        createdAt: account.created_at,
        process: ctx.manager.status(account.username),
      })),
    });
  });

  router.post('/api/accounts', requireAdmin, wrap(async (req, res) => {
    const { username, password, workspaceRoot, note } = req.body ?? {};
    if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
      return res.status(400).json({ error: '用户名需为 3–32 位字母、数字、- 或 _' });
    }
    if (ctx.store.getByUsername(username)) return res.status(409).json({ error: '用户名已存在' });
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `密码至少 ${MIN_PASSWORD_LENGTH} 位` });
    }
    const requestedRoot = typeof workspaceRoot === 'string' && workspaceRoot.trim()
      ? workspaceRoot.trim()
      : path.join(ctx.config.workspacesRoot, username);
    try {
      const others = ctx.store.list().filter((account) => account.role === 'member');
      const { root, warnings } = await prepareWorkspaceRoot(requestedRoot, {
        appRoot: ctx.config.appRoot,
        dataRoot: ctx.config.dataRoot,
        home: fs.realpathSync(ctx.config.childHome),
        others,
      });
      const account = await ctx.store.create({ username, password, role: 'member', workspaceRoot: root, note: typeof note === 'string' ? note.trim().slice(0, 200) : null });
      ctx.log(`account ${username} created (${root})`);
      res.status(201).json({ ok: true, username: account.username, workspaceRoot: root, warnings });
    } catch (error) {
      if (error instanceof WorkspaceRuleError) return res.status(400).json({ error: error.message });
      throw error;
    }
  }));

  router.post('/api/accounts/:username/password', requireAdmin, wrap(async (req, res) => {
    const member = findMember(req, res);
    if (!member) return;
    const { password } = req.body ?? {};
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `密码至少 ${MIN_PASSWORD_LENGTH} 位` });
    }
    await ctx.store.setPassword(member.username, password);
    ctx.log(`password reset for ${member.username}`);
    res.json({ ok: true });
  }));

  router.delete('/api/accounts/:username', requireAdmin, wrap(async (req, res) => {
    const member = findMember(req, res);
    if (!member) return;
    if (member.role === 'admin') return res.status(400).json({ error: '不能删除管理员' });
    await ctx.manager.stop(member.username);
    ctx.manager.forget(member.username);
    removeRunFile(ctx.config, member.username);
    fs.rmSync(paths.accountDir(member.username), { recursive: true, force: true });
    ctx.store.remove(member.username);
    ctx.log(`account ${member.username} deleted (workspace ${member.workspace_root} kept)`);
    res.json({ ok: true });
  }));

  /** Rebuilds a child's index when its internal user no longer matches (mydocs/03 4.2). */
  router.post('/api/accounts/:username/reindex', requireAdmin, wrap(async (req, res) => {
    const member = findMember(req, res);
    if (!member) return;
    await ctx.manager.stop(member.username);
    ctx.manager.forget(member.username);
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${paths.accountDb(member.username)}${suffix}`, { force: true });
    ctx.log(`index rebuilt for ${member.username}`);
    res.json({ ok: true });
  }));

  // The workspace is fixed once created (ACC-06).
  router.all(['/api/accounts/:username', '/api/accounts/:username/workspace'], requireAdmin, (req, res) => {
    res.status(405).json({ error: '工作目录创建后不可修改；如需更换请删除后重建' });
  });

  return router;
}
