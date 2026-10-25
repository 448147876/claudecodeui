// Injected by the cloudcli-multi gateway into every CloudCLI page
// (mydocs/03-技术方案.md 4.3). Runs before the upstream bundle.
(function () {
  var gw = window.__GW__;
  if (!gw || !window.localStorage) return;

  var storage = window.localStorage;
  var nativeRemoveItem = Storage.prototype.removeItem;
  var nativeClear = Storage.prototype.clear;
  var internal = false;

  // 1. Hand the upstream frontend this account's token. A different account
  //    in this browser means its drafts and history must go first (FR-3.5).
  try {
    internal = true;
    if (storage.getItem('gw-account') !== gw.account) storage.clear();
    storage.setItem('gw-account', gw.account);
    storage.setItem('auth-token', gw.token);
  } catch {
    // Storage unavailable; the upstream app will show its own error.
  } finally {
    internal = false;
  }

  // 2. Upstream signs out by dropping its token; turn that into a gateway logout.
  function leave() {
    location.replace('/__gw/logout');
  }
  Storage.prototype.removeItem = function (key) {
    var result = nativeRemoveItem.apply(this, arguments);
    if (!internal && this === storage && key === 'auth-token') leave();
    return result;
  };
  Storage.prototype.clear = function () {
    var result = nativeClear.apply(this, arguments);
    if (!internal && this === storage) leave();
    return result;
  };

  // 3. A small account menu at the top right, just below the upstream header
  //    (whose tabs reach the right edge).
  function mountMenu() {
    if (document.getElementById('gw-menu')) return;
    var style = document.createElement('style');
    style.textContent = [
      '#gw-menu{position:fixed;top:62px;right:10px;z-index:2147483000;font:12px/1.4 system-ui,-apple-system,"PingFang SC",sans-serif}',
      '#gw-menu>button{border:1px solid rgba(127,127,127,.35);border-radius:999px;padding:2px 10px;background:rgba(127,127,127,.12);color:inherit;cursor:pointer;opacity:.75;backdrop-filter:blur(6px)}',
      '#gw-menu>button:hover{opacity:1}',
      '#gw-menu .gw-panel{display:none;position:absolute;right:0;top:26px;min-width:150px;padding:4px;border:1px solid rgba(127,127,127,.35);border-radius:8px;background:Canvas;color:CanvasText;box-shadow:0 6px 20px rgba(0,0,0,.18)}',
      '#gw-menu.open .gw-panel{display:block}',
      '#gw-menu a{display:block;padding:6px 10px;border-radius:6px;color:inherit;text-decoration:none}',
      '#gw-menu a:hover{background:rgba(127,127,127,.15)}',
    ].join('');
    var menu = document.createElement('div');
    menu.id = 'gw-menu';
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.textContent = gw.account + ' ▾';
    toggle.title = '当前账号';
    var panel = document.createElement('div');
    panel.className = 'gw-panel';
    if (gw.role === 'admin') {
      var admin = document.createElement('a');
      admin.href = '/__gw/admin';
      admin.textContent = '账号管理';
      panel.appendChild(admin);
    }
    var logout = document.createElement('a');
    logout.href = '/__gw/logout';
    logout.textContent = '退出登录';
    panel.appendChild(logout);
    menu.appendChild(toggle);
    menu.appendChild(panel);
    toggle.addEventListener('click', function (event) {
      event.stopPropagation();
      menu.classList.toggle('open');
    });
    document.addEventListener('click', function () {
      menu.classList.remove('open');
    });
    document.head.appendChild(style);
    document.body.appendChild(menu);
  }
  if (document.body) mountMenu();
  else document.addEventListener('DOMContentLoaded', mountMenu);
})();
