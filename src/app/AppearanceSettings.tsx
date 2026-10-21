import type { CSSProperties } from 'react';
import type { NavigationLayout, WorkspaceDesign } from './layout-preferences';
import { accents, skins, type Appearance } from './appearance';

export function AppearanceSettings({ design, onDesignChange, appearance, onAppearanceChange, layout, onLayoutChange }: {
  design: WorkspaceDesign; onDesignChange: (design: WorkspaceDesign) => void;
  appearance: Appearance; onAppearanceChange: (appearance: Appearance) => void;
  layout: NavigationLayout; onLayoutChange: (layout: NavigationLayout) => void;
}) {
  const selectedSkin = skins.find((skin) => skin.id === appearance.skin) || skins[0];
  return <div className="fv-sheet appearance-settings"><section className="fv-section"><h2>界面布局</h2>
    <p className="fv-muted">布局决定怎么排版，皮肤和主题色决定颜色。三项独立保存，切换不改变客户数据和正在编辑的回复。</p>
    <fieldset className="fv-layout-options workspace-design-options"><legend>选择 A / B / C 方案</legend>
      {([
        { id: 'A', title: 'A · 黑金会客台', detail: '侧边导航，聊天与回复参谋并排。', blocks: 4 },
        { id: 'B', title: 'B · 专注台', detail: '聊天在上、回复在下，CRM 履历独立在右侧。', blocks: 5 },
        { id: 'C', title: 'C · 客户案卷台', detail: '顶部导航，中间聊天与草稿，右侧客户案卷和建议。', blocks: 5 },
      ] as const).map((option) => <label key={option.id}><input type="radio" name="workspace-design" aria-label={option.title} checked={design === option.id} onChange={() => onDesignChange(option.id)} />
        <span><strong>{option.title}</strong><small>{option.detail}</small><span className={`layout-preview layout-preview-${option.id.toLowerCase()}`} aria-hidden="true">{Array.from({ length: option.blocks }, (_, index) => <i key={index} />)}</span></span>
      </label>)}
    </fieldset>
  </section><section className="fv-section"><h2>皮肤</h2><p className="fv-muted">浅色适合白天阅读，深色适合较暗环境。所有布局都能使用任意皮肤。</p>
    <fieldset className="skin-options"><legend>选择界面皮肤</legend>{skins.map((skin) => <label key={skin.id} className="skin-choice">
      <input type="radio" name="workspace-skin" aria-label={skin.label} checked={appearance.skin === skin.id} onChange={() => onAppearanceChange({ ...appearance, skin: skin.id })} />
      <span><span className="skin-preview" aria-hidden="true" style={{ '--sample-canvas': skin.canvas, '--sample-surface': skin.surface, '--sample-line': skin.line, '--sample-text': skin.quiet } as CSSProperties}><i /><i /><i /><i /></span>
        <strong>{skin.label}</strong><small>{skin.mode === 'dark' ? '深色皮肤' : '浅色皮肤'}</small></span>
    </label>)}</fieldset>
  </section><section className="fv-section"><h2>主题色</h2><p className="fv-muted">用于按钮、选中状态和主要图表；领序原版标志保持不变。</p>
    <fieldset className="accent-options"><legend>选择强调色</legend>{accents.map((accent) => <label key={accent.id} className="accent-choice">
      <input type="radio" name="workspace-accent" aria-label={accent.label} checked={appearance.accent === accent.id} onChange={() => onAppearanceChange({ ...appearance, accent: accent.id })} />
      <span className="accent-swatch" aria-hidden="true" style={{ backgroundColor: selectedSkin.mode === 'dark' ? accent.dark : accent.light }} /><span>{accent.label}</span>
    </label>)}</fieldset><p className="appearance-saved-note">选择后立即生效，并记住下次启动时的选择。</p>
  </section><section className="fv-section"><h2>导航宽度</h2><p className="fv-muted">A / B 使用侧边导航；C 使用顶部导航，不占侧栏宽度。</p>
    <fieldset className="fv-layout-options" disabled={design === 'C'}><legend>侧边导航显示方式</legend>
      <label><input type="radio" name="navigation-layout" checked={layout === 'labelled'} onChange={() => onLayoutChange('labelled')} /><span><strong>图标＋文字</strong><small>76 px 窄导航，功能名称直接可见。</small></span></label>
      <label><input type="radio" name="navigation-layout" checked={layout === 'compact'} onChange={() => onLayoutChange('compact')} /><span><strong>仅图标</strong><small>56 px 紧凑导航，悬停或聚焦可查看名称。</small></span></label>
    </fieldset>
  </section></div>;
}
