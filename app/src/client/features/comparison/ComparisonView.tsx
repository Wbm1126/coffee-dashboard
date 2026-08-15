import type { GalleryItem } from '../gallery/gallery-model';

interface Props { items: GalleryItem[]; onRemove: (beanId: string) => void; onOpen: (item: GalleryItem, trigger: HTMLButtonElement) => void; onFollow: (beanId: string) => void; onPurchase: (beanId: string) => void; busyBeanId: string | null }
export function ComparisonView({ items, onRemove, onOpen, onFollow, onPurchase, busyBeanId }: Props) {
  if (!items.length) return null;
  return <section className="comparison-view" aria-labelledby="comparison-title"><div className="comparison-heading"><div><p className="section-kicker">SIDE BY SIDE</p><h3 id="comparison-title">比较台 · {items.length}/3</h3></div><p>只比较本地已有字段；缺失事实明确显示“未知”。</p></div>
    <div className="comparison-scroll"><table><thead><tr><th scope="col">比较维度</th>{items.map((item) => <th scope="col" key={item.bean.id}>{item.bean.name}<button type="button" className="text-button" onClick={() => onRemove(item.bean.id)} aria-label={`从比较移除 ${item.bean.name}`}>移除</button></th>)}</tr></thead><tbody>
      <Row label="参考价格" items={items} value={(item) => item.price === null ? null : `¥${item.price}`} />
      <Row label="烘焙度" items={items} value={(item) => item.roast} />
      <Row label="处理法" items={items} value={(item) => item.bean.process} />
      <Row label="产地 / 品种" items={items} value={(item) => item.bean.importedFacts?.originOrVariety} />
      <Row label="风味标签" items={items} value={(item) => item.bean.flavorNotes.length ? item.bean.flavorNotes.join('、') : null} />
      <Row label="甜感" items={items} value={() => null} />
      <Row label="酸感" items={items} value={() => null} />
      <Row label="风味强度" items={items} value={() => null} />
      <Row label="美式适配" items={items} value={(item) => reviewSuitability(item, 'americano')} />
      <Row label="奶咖适配" items={items} value={(item) => reviewSuitability(item, 'milk')} />
      <tr><th scope="row">行动</th>{items.map((item) => <td key={item.bean.id}><div className="comparison-actions"><button type="button" onClick={(event) => onOpen(item, event.currentTarget)}>看详情</button>{!item.badges.includes('followed') && <button type="button" disabled={busyBeanId === item.bean.id} onClick={() => onFollow(item.bean.id)}>加入关注</button>}<button type="button" onClick={() => onPurchase(item.bean.id)}>创建购买</button></div></td>)}</tr>
    </tbody></table></div>
  </section>;
}
function Row({ label, items, value }: { label: string; items: GalleryItem[]; value: (item: GalleryItem) => string | null | undefined }) { return <tr><th scope="row">{label}</th>{items.map((item) => <td key={item.bean.id}>{value(item) || <span className="unknown-value">未知</span>}</td>)}</tr>; }
function reviewSuitability(item: GalleryItem, mode: 'americano' | 'milk') {
  const score = mode === 'americano' ? item.americanoScore : item.milkScore;
  if (score !== null) return `${score}/5（个人评价均值）`;
  const performance = mode === 'americano' ? item.bean.importedFacts?.americanoPerformance : item.bean.importedFacts?.milkPerformance;
  return performance ?? null;
}
