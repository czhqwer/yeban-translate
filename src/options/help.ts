import type { ProviderId } from '../shared/types';
import { element } from '../ui/common';

/** 教程仅使用固定的官方说明，不读取用户填写的配置。 */
const serviceHelp: Record<ProviderId, { title: string; steps: string[]; fields: Array<[string, string]>; links: Array<[string, string]> }> = {
  bailian: {
    title: '百炼大模型 · 配置帮助',
    steps: [
      '打开百炼控制台，先选择要使用的地域，并在该地域的默认业务空间中创建 API Key。',
      '把 API Key 填入对应字段。官方 API 端点必须是 Chat Completions 完整地址，且与 API Key、模型所属地域一致。',
      '选择该地域可用的模型，填写模型名称；确认后点击“保存配置”，再点击“测试连接”。',
    ],
    fields: [
      ['API Key', '填写百炼为所选地域创建的 API Key。'],
      ['官方 API 端点', '填写完整请求地址，不是 Base URL。中国内地（北京）示例：https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'],
      ['模型', '默认 qwen3-vl-plus，文本与图片共用此模型；其他模型需支持图像输入，并在所选地域可用。'],
    ],
    links: [['百炼：获取 API Key 与地域说明', 'https://help.aliyun.com/zh/model-studio/get-api-key']],
  },
  aliyun: {
    title: '阿里云机器翻译 · 配置帮助',
    steps: [
      '在阿里云机器翻译控制台开通机器翻译通用版。',
      '推荐创建 RAM 用户，并授予调用通用版翻译所需的最小权限（alimt:TranslateGeneral）。具体授权方式见官方准备账号指南。',
      '在 RAM 用户的认证管理中创建 AccessKey，获取 AccessKey ID 和 AccessKey Secret；创建后妥善保存。',
      '按下表填写端点与凭据，点击“保存配置”，再点击“测试连接”。',
    ],
    fields: [
      ['AccessKey ID（AK）', '填写 RAM 用户的 AccessKey ID。'],
      ['AccessKey Secret（SK）', '填写与该 AccessKey ID 配对的 AccessKey Secret。'],
      ['官方服务端点', '当前使用杭州端点：https://mt.cn-hangzhou.aliyuncs.com'],
    ],
    links: [
      ['阿里云：开通机器翻译', 'https://help.aliyun.com/zh/machine-translation/getting-started/activate-machine-translation-for-developers'],
      ['阿里云：准备账号与 AccessKey', 'https://help.aliyun.com/zh/machine-translation/getting-started/prepare-accounts-for-developers'],
    ],
  },
};

/** 根据服务建立独立教程，固定链接不拼接表单或凭据信息。 */
function renderServiceHelp(provider: ProviderId): void {
  const help = serviceHelp[provider];
  element('service-help-title').textContent = help.title;
  const content = element('service-help-content');
  content.replaceChildren();
  const steps = document.createElement('ol');
  steps.className = 'service-help-steps';
  for (const text of help.steps) {
    const step = document.createElement('li');
    step.textContent = text;
    steps.append(step);
  }
  const table = document.createElement('table');
  table.className = 'service-help-fields';
  const caption = document.createElement('caption');
  caption.textContent = '设置页字段对应';
  table.append(caption);
  for (const [label, description] of help.fields) {
    const row = document.createElement('tr');
    const heading = document.createElement('th');
    heading.scope = 'row';
    heading.textContent = label;
    const value = document.createElement('td');
    value.textContent = description;
    row.append(heading, value);
    table.append(row);
  }
  const links = document.createElement('div');
  links.className = 'service-help-links';
  for (const [label, url] of help.links) {
    const link = document.createElement('a');
    link.textContent = `${label} ↗`;
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    links.append(link);
  }
  content.append(steps, table, links);
}

/** 使用原生模态对话框处理焦点与 Esc，关闭后回到当前帮助入口。 */
export function initializeServiceHelp(): void {
  const dialog = element<HTMLDialogElement>('service-help-dialog');
  let opener: HTMLButtonElement | undefined;
  document.querySelectorAll<HTMLButtonElement>('[data-service-help]').forEach(button => {
    button.addEventListener('click', () => {
      const provider = button.dataset.serviceHelp;
      if (provider !== 'bailian' && provider !== 'aliyun') return;
      opener = button;
      renderServiceHelp(provider);
      if (!dialog.open) dialog.showModal();
    });
  });
  element('service-help-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { if (opener?.isConnected) opener.focus(); });
}
