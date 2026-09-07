/** 用固定 SVG 路径绘制控件图标，不依赖网页字体或外部图片。 */
export function createIcon(doc: Document, kind: 'translate' | 'side-panel', size: number): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = doc.createElementNS(namespace, 'path');
  path.setAttribute('d', kind === 'translate'
    ? 'M3 5h12M9 3v2M5 5c1 5 4 8 8 10M13 5c-1 5-4 8-9 11M13 21l4-10 4 10M14.4 17.5h5.2'
    : 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM15 4v16M18 8h1M18 12h1M18 16h1');
  svg.append(path);
  return svg;
}
