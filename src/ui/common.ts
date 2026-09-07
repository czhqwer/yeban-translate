/** 获取当前静态页面中已声明的界面元素。 */
export function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error('界面尚未准备好，请重新打开扩展。');
  return node as T;
}

/** 仅以纯文本更新反馈，避免服务信息成为可执行内容。 */
export function feedback(node: HTMLElement, message: string, tone: 'success' | 'error' | 'neutral' = 'neutral'): void {
  if (node.textContent !== message) node.textContent = message;
  node.dataset.tone = tone;
  node.hidden = !message;
}

/** 端点不接受嵌入身份信息、查询参数或片段，具体官方地址仍由后台校验。 */
export function validEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}
