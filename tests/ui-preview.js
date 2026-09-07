// 仅用于本地界面验收的 Chrome API 模拟，不会打包到扩展中，也不连接翻译服务。
(() => {
  const empty = new URL(location.href).searchParams.has('empty');
  const onlyAliyun = new URL(location.href).searchParams.get('only') === 'aliyun';
  const settings = {
    preferences: { provider: 'bailian', source: 'auto', target: 'zh' },
    services: {
      bailian: { endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus', configured: !empty && !onlyAliyun },
      aliyun: { endpoint: 'https://mt.cn-hangzhou.aliyuncs.com', configured: !empty },
    },
    sites: [], dataNoticeAccepted: !empty, providerPriority: ['bailian', 'aliyun'], selectionEnabled: true,
    allSitesEnabled: false, allSitesGranted: false, blockedSites: [],
  };
  let page = { state: 'idle', completed: 0, failed: 0, pending: 0 };
  // 仅模拟预览跨页面的位置记忆；生产版由后台独立的扩展存储保存。
  const savedPosition = localStorage.getItem('yeban-preview-floating-position');
  let floatingPosition = savedPosition === null ? 0.5 : Number(savedPosition);
  if (!Number.isFinite(floatingPosition) || floatingPosition < 0 || floatingPosition > 1) floatingPosition = 0.5;
  const panelState = { windowId: 1, open: false, ready: true, canOpen: true, canToggle: !new URL(location.href).searchParams.has('legacy'), version: 1 };
  const listeners = [];
  const jobs = new Map();
  const ok = value => ({ ok: true, value });
  const copy = value => JSON.parse(JSON.stringify(value));
  window.chrome = {
    runtime: {
      id: 'yeban-local-preview',
      connect: ({ name }) => {
        if (name !== 'yeban-sidepanel-v1') throw new Error('不支持的测试连接');
        const messages = new Set();
        const disconnected = new Set();
        const owned = new Set();
        let closed = false;
        const port = {
          name,
          onMessage: { addListener: fn => messages.add(fn), removeListener: fn => messages.delete(fn) },
          onDisconnect: { addListener: fn => disconnected.add(fn), removeListener: fn => disconnected.delete(fn) },
          postMessage: envelope => {
            if (closed) throw new Error('测试连接已关闭');
            const message = envelope.message;
            if (message.type === 'TRANSLATE_PANEL') owned.add(message.requestId);
            void window.chrome.runtime.sendMessage(message).then(reply => {
              owned.delete(message.requestId);
              if (!closed) for (const listener of [...messages]) listener({ messageId: envelope.messageId, reply }, port);
            });
          },
          disconnect: () => {
            if (closed) return;
            closed = true;
            for (const requestId of owned) jobs.delete(requestId);
            owned.clear();
            for (const listener of [...disconnected]) listener(port);
          },
        };
        return port;
      },
      onMessage: { addListener: fn => listeners.push(fn) },
      getURL: path => `${location.origin}/${path}`,
      openOptionsPage: async () => { location.href = '/options.html'; },
      sendMessage: async msg => {
        if (msg.type === 'GET_SETTINGS') return ok(copy(settings));
        if (msg.type === 'GET_CONTEXT') return ok({ preferences: copy(settings.preferences), services: copy(settings.services), providerPriority: [...settings.providerPriority], selectionEnabled: settings.selectionEnabled, floatingEnabled: true, floatingPosition, dataNoticeAccepted: true, sidePanel: copy(panelState) });
        if (msg.type === 'SET_FLOATING_POSITION') {
          if (!Number.isFinite(msg.position) || msg.position < 0 || msg.position > 1) return { ok: false, error: { code: 'INVALID_INPUT', message: '位置无效。', retryable: false } };
          floatingPosition = msg.position;
          localStorage.setItem('yeban-preview-floating-position', String(floatingPosition));
          return ok(floatingPosition);
        }
        if (msg.type === 'GET_SIDE_PANEL_STATE') return ok(copy(panelState));
        if (msg.type === 'SET_SIDE_PANEL') {
          if (!msg.open && !panelState.canToggle) return { ok: false, error: { code: 'UNSUPPORTED', message: '当前浏览器不支持程序关闭，请使用侧栏关闭按钮或升级浏览器。', retryable: false } };
          panelState.open = msg.open; panelState.version++;
          for (const listener of listeners) listener({ type: 'SIDE_PANEL_STATE', state: copy(panelState) }, { id: 'yeban-local-preview' }, () => {});
          const note = document.getElementById('preview-events');
          if (note) note.textContent = panelState.open ? '模拟侧栏已打开；没有调用原生浏览器接口。' : '模拟侧栏已关闭；没有调用原生浏览器接口。';
          return ok(copy(panelState));
        }
        if (msg.type === 'SAVE_SETTINGS') {
          if (msg.preferences) settings.preferences = copy(msg.preferences);
          if (msg.dataNoticeAccepted !== undefined) settings.dataNoticeAccepted = msg.dataNoticeAccepted;
          if (msg.providerPriority) settings.providerPriority = [...msg.providerPriority];
          if (msg.selectionEnabled !== undefined) settings.selectionEnabled = msg.selectionEnabled;
          if (msg.provider && msg.config) {
            const { endpoint, model } = msg.config;
            settings.services[msg.provider] = { endpoint, ...(model ? { model } : {}), configured: true };
          }
          return ok(copy(settings));
        }
        if (msg.type === 'DELETE_SERVICE') { settings.services[msg.provider].configured = false; return ok(copy(settings)); }
        if (msg.type === 'TEST_SERVICE') return ok({ translated: '连接测试通过（模拟响应）。' });
        if (msg.type === 'ENABLE_SITE') { settings.sites = [...new Set([...settings.sites, msg.origin])]; settings.blockedSites = settings.blockedSites.filter(s => s !== msg.origin); return ok(copy(settings)); }
        if (msg.type === 'DISABLE_SITE') { settings.sites = settings.sites.filter(site => site !== msg.origin); settings.blockedSites = [...new Set([...settings.blockedSites, msg.origin])]; return ok(copy(settings)); }
        if (msg.type === 'ENABLE_ALL_SITES') { settings.allSitesEnabled = settings.allSitesGranted = true; return ok(copy(settings)); }
        if (msg.type === 'DISABLE_ALL_SITES') { settings.allSitesEnabled = settings.allSitesGranted = false; return ok(copy(settings)); }
        if (msg.type === 'OPEN_SIDE_PANEL') {
          const note = document.getElementById('preview-events');
          if (note) note.textContent = '已收到打开原生侧栏请求（模拟，未调用浏览器侧栏 API）。';
          return ok(null);
        }
        if (msg.type === 'CANCEL_PANEL') { jobs.delete(msg.requestId); return ok(null); }
        if (msg.type === 'TRANSLATE_PANEL') {
          jobs.set(msg.requestId, true);
          await new Promise(resolve => setTimeout(resolve, 700));
          if (!jobs.has(msg.requestId)) return { ok: false, error: { code: 'CANCELED', message: '已停止文本翻译。', retryable: false } };
          return ok({ translated: '这是侧栏的模拟译文。阅读，让语言之间的距离更近。' });
        }
        if (msg.type === 'BEGIN_JOB') { jobs.set(msg.jobId, true); return ok({ revision: 1 }); }
        if (msg.type === 'CANCEL_JOB') { jobs.delete(msg.jobId); return ok(undefined); }
        if (msg.type === 'TRANSLATE') {
          await new Promise(resolve => setTimeout(resolve, 450));
          if (!jobs.get(msg.jobId)) return { ok: false, error: { code: 'CANCELED', message: '请求已取消。', retryable: false } };
          const markers = msg.text.match(/\[\[YEBAN_KEEP_[^\]]+\]\]/g) || [];
          return ok({ translated: `模拟译文：${markers.length ? '保留标识 ' + markers.join('、') + '，并翻译相关说明。' : msg.text.includes('Reading') ? '阅读，让世界在眼前展开。' : '保留原文，对照阅读，理解每一个句子。'}` });
        }
        return ok(undefined);
      },
    },
    tabs: {
      query: async () => [{ id: 1, windowId: 1, url: 'https://example.org/article', active: true }],
      sendMessage: async (_id, msg) => {
        if (msg.type === 'SET_PREFERENCES') page.preferences = copy(msg.preferences);
        if (msg.type === 'SET_SELECTION') page.selection = copy(msg.selection);
        if (msg.type === 'PAGE_START') page = { state: 'waiting', completed: 8, failed: 0, pending: 0, canRestore: true, message: '当前已展开内容已翻译，展开菜单后继续补译。', preferences: copy(msg.preferences), selection: msg.selection && copy(msg.selection) };
        if (msg.type === 'PAGE_STOP') page.state = 'stopped';
        if (msg.type === 'RESTORE') page = { state: 'idle', completed: 0, failed: 0, pending: 0, canRestore: false, preferences: page.preferences, selection: page.selection };
        return ok(copy(page));
      },
    },
    scripting: { executeScript: async () => [] },
    permissions: { request: async () => !new URL(location.href).searchParams.has('deny'), contains: async () => settings.allSitesGranted, remove: async () => true },
  };
  window.addEventListener('DOMContentLoaded', () => {
    const note = document.createElement('div');
    note.id = 'preview-events';
    note.textContent = '本地界面验收 · 模拟响应 · 未调用真实 API';
    note.style.cssText = 'padding:8px 12px;font:12px system-ui;background:#fff2ca;color:#684b12;text-align:center;';
    document.body.prepend(note);
  });
})();
