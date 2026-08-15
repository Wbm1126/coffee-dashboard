import type { BeanBadge } from '../../../domain/status';

export const BEAN_BADGE_LABELS: Record<BeanBadge, string> = {
  followed: '已关注',
  purchased_waiting: '已购买待饮用',
  drank_pending_review: '喝过待补评价',
  review_complete: '已完成评价',
  archived: '已归档',
};

export const GALLERY_STATUS_OPTIONS = (Object.entries(BEAN_BADGE_LABELS) as Array<[BeanBadge, string]>)
  .filter(([value]) => value !== 'archived')
  .map(([value, label]) => ({ value, label }));
