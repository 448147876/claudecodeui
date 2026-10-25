// Plan B (mydocs/01 section 7): member accounts may not use upstream features
// that write configuration shared by every account. Admin is unaffected.
// Terminal and Claude's own tools can still reach these files; that is the
// accepted limit of application-level isolation.

const PROVIDER = '[^/]+';

/** Unconditionally blocked for members: [method, path pattern, what it changes]. */
const BLOCKED = [
  ['POST', `^/api/providers/${PROVIDER}/skills$`, '用户级 Skills（~/.claude/skills）'],
  ['DELETE', `^/api/providers/${PROVIDER}/skills/[^/]+$`, '用户级 Skills（~/.claude/skills）'],
  ['POST', '^/api/plugins/install$', '插件（~/.claude-code-ui）'],
  ['PUT', '^/api/plugins/[^/]+/enable$', '插件（~/.claude-code-ui）'],
  ['POST', '^/api/plugins/[^/]+/update$', '插件（~/.claude-code-ui）'],
  ['DELETE', '^/api/plugins/[^/]+$', '插件（~/.claude-code-ui）'],
  ['POST', '^/api/system/update$', '系统更新（共用的安装目录）'],
  ['PUT', '^/api/browser-use/settings$', 'browser-use 设置（~/.cloudcli/browser-use）'],
  ['POST', '^/api/browser-use/runtime/install$', 'browser-use 运行时（~/.cloudcli/browser-use）'],
  ['POST', '^/api/user/git-config$', '全局 git 配置（~/.gitconfig）'],
].map(([method, pattern, what]) => ({ method, pattern: new RegExp(pattern), what }));

const MCP_WHAT = '用户级 MCP（~/.claude.json）';
// MCP writes are global only with scope=user; the default is project.
const MCP_QUERY_SCOPE = [['DELETE', new RegExp(`^/api/providers/${PROVIDER}/mcp/servers/[^/]+$`)]];
const MCP_BODY_SCOPE = [
  ['POST', new RegExp(`^/api/providers/${PROVIDER}/mcp/servers$`)],
  ['POST', /^\/api\/providers\/mcp\/servers\/global$/],
];

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Normalizes a request path the way upstream's Express router matches it:
 * case-insensitive, duplicate and trailing slashes ignored, percent-decoded.
 */
export function normalizePath(url) {
  let pathname = String(url).split('?')[0].split('#')[0];
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Malformed escapes; match on the raw path.
  }
  pathname = pathname.replace(/\/{2,}/g, '/').toLowerCase();
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

export function forbiddenResponse(what) {
  return {
    status: 403,
    body: {
      success: false,
      error: { code: 'GATEWAY_MEMBER_FORBIDDEN', message: `普通账号不能修改全局配置：${what}。请使用管理员账号操作。` },
    },
  };
}

/** Whether the request needs its JSON body inspected before a decision. */
export function needsBody(req) {
  const pathname = normalizePath(req.url);
  return MCP_BODY_SCOPE.some(([method, pattern]) => req.method === method && pattern.test(pathname));
}

/** Reads the request body (up to 1 MB) so it can be inspected and then forwarded. */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Returns a 403 response description when a member may not make this request,
 * otherwise null. `body` is the buffered request body when needsBody() said so.
 */
export function checkMemberRequest(req, body = null) {
  const pathname = normalizePath(req.url);
  const blocked = BLOCKED.find((rule) => rule.method === req.method && rule.pattern.test(pathname));
  if (blocked) return forbiddenResponse(blocked.what);

  if (MCP_QUERY_SCOPE.some(([method, pattern]) => req.method === method && pattern.test(pathname))) {
    // Repeated parameters arrive upstream as an array; refuse if any of them says user.
    const scopes = new URL(req.url, 'http://gateway.local').searchParams.getAll('scope');
    if (scopes.some((scope) => scope.trim().toLowerCase() === 'user')) return forbiddenResponse(MCP_WHAT);
  }

  if (body && MCP_BODY_SCOPE.some(([method, pattern]) => req.method === method && pattern.test(pathname))) {
    let scope;
    try {
      scope = JSON.parse(body.toString('utf8'))?.scope;
    } catch {
      return null; // Upstream rejects malformed JSON itself.
    }
    if (String(scope ?? '').trim().toLowerCase() === 'user') return forbiddenResponse(MCP_WHAT);
  }
  return null;
}
