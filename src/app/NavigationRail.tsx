import { Tooltip } from '@fluentui/react-components';
import { ArrowExport24Regular, BookOpen24Regular, Chat24Regular, Home24Regular, PanelLeftContract20Regular, PanelLeftExpand20Regular, People24Regular, Settings24Regular } from '@fluentui/react-icons';
import type { NavigationLayout } from './layout-preferences';

export type PageId = 'today' | 'conversation' | 'customers' | 'knowledge' | 'export' | 'settings';

const items = [
  { id: 'conversation', label: '客户会话', icon: Chat24Regular },
  { id: 'today', label: '工作台', icon: Home24Regular },
  { id: 'customers', label: 'CRM 客户', icon: People24Regular },
  { id: 'knowledge', label: '知识库', icon: BookOpen24Regular },
  { id: 'export', label: '聊天导出', icon: ArrowExport24Regular },
  { id: 'settings', label: '设置', icon: Settings24Regular },
] as const;

export function NavigationRail({ active, layout, orientation = 'vertical', onChange, onLayoutChange }: {
  active: PageId; layout: NavigationLayout; onChange: (page: PageId) => void;
  orientation?: 'vertical' | 'horizontal';
  onLayoutChange: (layout: NavigationLayout) => void;
}) {
  const horizontal = orientation === 'horizontal';
  const compact = !horizontal && layout === 'compact';
  return <nav className={`navigation-rail ${compact ? 'navigation-rail-compact' : ''} ${horizontal ? 'navigation-top' : ''}`} aria-label="主导航">
    <div className="nav-items" id="main-navigation-items">
      {items.map(({ id, label, icon: Icon }) => <Tooltip key={id} content={label} relationship="label" positioning={horizontal ? 'below' : 'after'}>
        <button type="button" className={`nav-item ${active === id ? 'nav-item-active' : ''}`}
          aria-label={label} aria-current={active === id ? 'page' : undefined} onClick={() => onChange(id)}>
          <Icon aria-hidden="true" />{!compact && <span>{label}</span>}
        </button>
      </Tooltip>)}
    </div>
    {!horizontal && <Tooltip content={compact ? '展开导航，显示文字' : '收起导航，仅显示图标'} relationship="label" positioning="after">
      <button type="button" className="nav-collapse" aria-expanded={!compact} aria-controls="main-navigation-items"
        aria-label={compact ? '展开导航' : '收起导航'} onClick={() => onLayoutChange(compact ? 'labelled' : 'compact')}>
        {compact ? <PanelLeftExpand20Regular /> : <PanelLeftContract20Regular />}
        {!compact && <span>收起</span>}
      </button>
    </Tooltip>}
  </nav>;
}
