import type { GalleryFilters, GallerySort } from './gallery-model';
import { GALLERY_STATUS_OPTIONS } from './gallery-options';

interface FilterOptions { brands: string[]; roasts: string[]; flavors: string[]; processes: string[]; scenes: string[]; grades: string[] }
interface Props { filters: GalleryFilters; sort: GallerySort; options: FilterOptions; resultCount: number; onFiltersChange: (filters: GalleryFilters) => void; onSortChange: (sort: GallerySort) => void; onClear: () => void }

export function FilterBar({ filters, sort, options, resultCount, onFiltersChange, onSortChange, onClear }: Props) {
  const update = <K extends keyof GalleryFilters>(key: K, value: GalleryFilters[K]) => onFiltersChange({ ...filters, [key]: value });
  return <div className="gallery-filter" aria-label="筛选咖啡豆">
    <label className="gallery-search">搜索陈列馆<input value={filters.query} onChange={(event) => update('query', event.target.value)} placeholder="豆名、品牌、风味、产地…" /></label>
    <div className="gallery-filter__fields">
      <Select label="品牌" value={filters.brand} values={options.brands} onChange={(value) => update('brand', value)} />
      <Select label="烘焙度" value={filters.roast} values={options.roasts} onChange={(value) => update('roast', value)} />
      <label>价格<select value={filters.price} onChange={(event) => update('price', event.target.value as GalleryFilters['price'])}><option value="">全部价格</option><option value="under_100">100 元以下</option><option value="100_199">100–199 元</option><option value="200_plus">200 元及以上</option><option value="unknown">未知</option></select></label>
      <Select label="风味" value={filters.flavor} values={options.flavors} onChange={(value) => update('flavor', value)} />
      <Select label="处理法" value={filters.process} values={options.processes} onChange={(value) => update('process', value)} />
      <Select label="适用场景" value={filters.scene} values={options.scenes} onChange={(value) => update('scene', value)} />
      <label>状态<select value={filters.status} onChange={(event) => update('status', event.target.value as GalleryFilters['status'])}><option value="">全部状态</option>{GALLERY_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}<option value="unknown">未归类</option></select></label>
      <Select label="个人等级" value={filters.grade} values={options.grades} onChange={(value) => update('grade', value)} />
    </div>
    <div className="gallery-filter__sort">
      <span role="status" aria-live="polite">找到 {resultCount} 支豆</span>
      <label>排序<select value={sort.field} onChange={(event) => onSortChange({ ...sort, field: event.target.value as GallerySort['field'] })}><option value="name">豆名</option><option value="brand">品牌</option><option value="price">价格</option><option value="roast">烘焙度</option><option value="grade">个人等级</option></select></label>
      <button type="button" className="filter-direction" onClick={() => onSortChange({ ...sort, direction: sort.direction === 'asc' ? 'desc' : 'asc' })} aria-label={`当前${sort.direction === 'asc' ? '升序' : '降序'}，点击切换`}>{sort.direction === 'asc' ? '升序 ↑' : '降序 ↓'}</button>
      <button type="button" className="text-button" onClick={onClear}>清除筛选</button>
    </div>
  </div>;
}

function Select({ label, value, values, onChange }: { label: string; value: string; values: string[]; onChange: (value: string) => void }) {
  return <label>{label}<select value={value} onChange={(event) => onChange(event.target.value)}><option value="">全部{label}</option>{values.map((option) => <option key={option}>{option}</option>)}<option value="unknown">未知</option></select></label>;
}
