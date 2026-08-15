export function normalizeIdentityText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).normalize('NFKC').replace(/\r\n?/g, '\n').trim();
  return text.length > 0 ? text : null;
}

export function normalizeBeanIdentity(value: unknown): string {
  return (normalizeIdentityText(value) ?? '')
    .toLocaleLowerCase('zh-CN')
    .replace(/[／\\]/g, '/')
    .replace(/[·•・]/g, '')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, '');
}

export function beanIdentityKey(brandName: unknown, beanName: unknown): string {
  return `${normalizeBeanIdentity(brandName)}::${normalizeBeanIdentity(beanName)}`;
}
