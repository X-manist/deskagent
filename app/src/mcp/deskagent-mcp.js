'use strict';
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const baseUrl = process.argv[2];
const token = process.argv[3];
if (!baseUrl || !token) {
  console.error('Usage: deskagent-mcp.js <bridge-url> <token>');
  process.exit(1);
}

async function call(method, pathname, body) {
  const res = await fetch(baseUrl.replace(/\/$/, '') + pathname, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `bridge request failed: ${res.status}`);
  return data;
}

const tools = [
  {
    name: 'deskagent_notify',
    description: '桌面通知用户',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'string' } },
      required: ['title'],
    },
    run: (args) => call('POST', '/notify', args),
  },
  {
    name: 'deskagent_open_url',
    description: '在默认浏览器打开 URL',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    run: (args) => call('POST', '/open-url', args),
  },
  {
    name: 'deskagent_open_app',
    description: '打开本机应用',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    run: (args) => call('POST', '/open-app', args),
  },
  {
    name: 'deskagent_desktop_action',
    description: '执行桌面动作：probe / activate-app / type-text / shortcut / click / double-click / move-mouse / scroll / screenshot / open-app / open-url。底层优先使用 Rust 原生 OS 工具；需要系统权限时桌面端会弹窗引导用户授权。dryRun=true 可做无副作用验证。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        app: { type: 'string' },
        text: { type: 'string' },
        shortcut: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string' },
        amount: { type: 'number' },
        dryRun: { type: 'boolean' },
      },
      required: ['action'],
    },
    run: (args) => call('POST', '/desktop/action', args),
  },
  {
    name: 'deskagent_take_screenshot',
    description: '截取当前电脑屏幕并保存到工作目录 screenshots/ 下，返回截图路径',
    inputSchema: {
      type: 'object',
      properties: {
        outputPath: { type: 'string' },
      },
    },
    run: (args) => call('POST', '/desktop/screenshot', args),
  },
  {
    name: 'deskagent_send_email',
    description: '通过 SMTP 发邮件。正式版由会员账号自动配置；开发版可用 SMTP_* 环境变量配置。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        subject: { type: 'string' },
        text: { type: 'string' },
        html: { type: 'string' },
        cc: { type: 'string' },
        bcc: { type: 'string' },
      },
      required: ['to', 'text'],
    },
    run: (args) => call('POST', '/email/send', args),
  },
  {
    name: 'deskagent_read_email',
    description: '读取邮箱标题、发件人、日期，可按未读或关键词筛选；includeBody=true 时返回正文预览。正式版由会员账号自动配置；开发版可用 IMAP_* 环境变量配置。',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string' },
        limit: { type: 'number' },
        unseenOnly: { type: 'boolean' },
        query: { type: 'string' },
        includeBody: { type: 'boolean' },
      },
    },
    run: (args) => call('POST', '/email/read', args),
  },
  {
    name: 'deskagent_send_wechat_message',
    description: '发送微信消息；优先走 WECHAT_BRIDGE_URL，自定义 bridge 未配置时 macOS 可走本地 UI 自动化兜底。需要系统辅助功能权限时桌面端会弹窗引导授权。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['to', 'text'],
    },
    run: (args) => call('POST', '/wechat/send', args),
  },
  {
    name: 'deskagent_read_wechat_messages',
    description: '读取微信消息；优先走 WECHAT_BRIDGE_URL，未配置时 macOS 可尝试从当前 WeChat 窗口复制可见内容。需要系统辅助功能权限时桌面端会弹窗引导授权。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    run: (args) => call('POST', '/wechat/read', args),
  },
  {
    name: 'deskagent_create_schedule',
    description: '创建定时任务，后台自动唤醒助手执行 prompt',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        cron: { type: 'string' },
        prompt: { type: 'string' },
        timezone: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      required: ['name', 'cron', 'prompt'],
    },
    run: (args) => call('POST', '/schedule', args),
  },
  {
    name: 'deskagent_list_schedules',
    description: '查看当前定时任务列表',
    inputSchema: { type: 'object', properties: {} },
    run: () => call('GET', '/schedule'),
  },
  {
    name: 'deskagent_delete_schedule',
    description: '删除定时任务',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    run: (args) => call('DELETE', `/schedule/${encodeURIComponent(args.id)}`),
  },
];

async function main() {
  const server = new Server(
    { name: 'deskagent-bridge', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((x) => x.name === request.params.name);
    if (!tool) throw new Error(`Unknown tool: ${request.params.name}`);
    const result = await tool.run(request.params.arguments || {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  });

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
