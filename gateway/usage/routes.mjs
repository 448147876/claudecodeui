import express from 'express';

import { currentAccount } from '../auth/session.mjs';
import { wrap } from '../http-utils.mjs';

/** Usage gate endpoints: members read their own status, only admin sees and edits settings. */
export function createUsageRouter(ctx) {
  const router = express.Router();

  const requireAccount = (req, res, next) => {
    const account = currentAccount(req, ctx);
    if (!account) return res.status(401).json({ error: '未登录' });
    req.account = account;
    next();
  };
  const requireAdmin = (req, res, next) => {
    if (req.account.role !== 'admin') return res.status(403).json({ error: '只有管理员可以查看用量控制设置' });
    next();
  };

  router.get('/api/usage-gate', requireAccount, wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await ctx.usageGate.statusFor(req.account));
  }));

  router.get('/api/usage-gate/settings', requireAccount, requireAdmin, wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await ctx.usageGate.overview());
  }));

  router.put('/api/usage-gate/settings', requireAccount, requireAdmin, wrap(async (req, res) => {
    const settings = ctx.usageGate.saveSettings(req.body ?? {});
    ctx.log(`usage gate settings changed by ${req.account.username}: ${JSON.stringify(settings)}`);
    res.json(await ctx.usageGate.overview());
  }));

  return router;
}
