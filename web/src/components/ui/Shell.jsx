import {
  ChevronLeft,
  ChevronRight,
  X
} from "lucide-react";

export function AppShell({ children, className = "" }) {
  return (
    <div className={`redesign-shell ${className}`.trim()}>
      {children}
    </div>
  );
}

export function TopCommandBar({ children, className = "" }) {
  return (
    <header className={`top-command-bar ${className}`.trim()}>
      {children}
    </header>
  );
}

export function MapTabs({ children, className = "" }) {
  return (
    <div className={`map-tabs-command ${className}`.trim()}>
      {children}
    </div>
  );
}

export function GraphToolbar({ children, className = "" }) {
  return (
    <div className={`graph-toolbar-modern ${className}`.trim()}>
      {children}
    </div>
  );
}

export function WorkspaceNav({ items, activeId, onSelect }) {
  return (
    <nav className="workspace-nav-rail" aria-label="Workspace navigation">
      {items.map((item) => {
        const Icon = item.icon;
        const isActive = item.id === activeId;

        return (
          <button
            key={item.id}
            type="button"
            className={`workspace-nav-item ${isActive ? "is-active" : ""}`.trim()}
            onClick={() => onSelect(item.id)}
            title={item.label}
            aria-label={item.label}
            aria-current={isActive ? "page" : undefined}
          >
            <Icon size={18} strokeWidth={2} aria-hidden="true" />
            <span>{item.label}</span>
            {item.count ? <strong>{item.count}</strong> : null}
          </button>
        );
      })}
    </nav>
  );
}

export function WorkspaceDrawer({
  title,
  purpose,
  children,
  onClose,
  className = "",
  footer = null
}) {
  return (
    <section className={`workspace-drawer-panel ${className}`.trim()}>
      <div className="workspace-drawer-header">
        <div>
          <p className="panel-title">{title}</p>
          {purpose ? <p>{purpose}</p> : null}
        </div>
        {onClose ? (
          <IconButton label="Close drawer" onClick={onClose}>
            <X size={17} strokeWidth={2.2} />
          </IconButton>
        ) : null}
      </div>
      <div className="workspace-drawer-body">
        {children}
      </div>
      {footer ? <div className="workspace-drawer-footer">{footer}</div> : null}
    </section>
  );
}

export function PanelHeader({ eyebrow, title, description, action = null }) {
  return (
    <div className="panel-header-modern">
      <div>
        {eyebrow ? <p className="panel-title">{eyebrow}</p> : null}
        {title ? <h2>{title}</h2> : null}
        {description ? <p>{description}</p> : null}
      </div>
      {action ? <div className="panel-header-action">{action}</div> : null}
    </div>
  );
}

export function ActionBar({ children, className = "" }) {
  return (
    <div className={`action-bar ${className}`.trim()}>
      {children}
    </div>
  );
}

export function MetricStrip({ items, className = "" }) {
  return (
    <div className={`metric-strip ${className}`.trim()}>
      {items.map((item) => (
        <div key={item.label} className="metric-strip-item">
          <span>{item.label}</span>
          <strong>{item.value}</strong>
        </div>
      ))}
    </div>
  );
}

export function StatusBanner({ children, tone = "default", className = "" }) {
  if (!children) return null;

  return (
    <div className={`status-banner is-${tone} ${className}`.trim()}>
      {children}
    </div>
  );
}

export function EmptyState({ eyebrow, title, description, action = null }) {
  return (
    <div className="empty-state-modern">
      {eyebrow ? <p className="panel-title">{eyebrow}</p> : null}
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {action ? <div>{action}</div> : null}
    </div>
  );
}

export function IconButton({
  label,
  children,
  className = "",
  type = "button",
  ...buttonProps
}) {
  return (
    <button
      type={type}
      className={`icon-button ${className}`.trim()}
      aria-label={label}
      title={label}
      {...buttonProps}
    >
      {children}
    </button>
  );
}

export function SegmentedControl({ options, value, onChange, ariaLabel, className = "" }) {
  return (
    <div className={`segmented-control ${className}`.trim()} role="group" aria-label={ariaLabel}>
      {options.map((option) => {
        const Icon = option.icon;

        return (
          <button
            key={option.value}
            type="button"
            className={value === option.value ? "is-active" : ""}
            onClick={() => onChange(option.value)}
          >
            {Icon ? <Icon size={14} strokeWidth={2.1} aria-hidden="true" /> : null}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function FieldGroup({ label, help, children, className = "" }) {
  return (
    <label className={`field-group ${className}`.trim()}>
      {label ? <span>{label}</span> : null}
      {children}
      {help ? <small>{help}</small> : null}
    </label>
  );
}

export function DrawerOpenButton({ side, label, onClick }) {
  const Icon = side === "left" ? ChevronRight : ChevronLeft;

  return (
    <IconButton className={`drawer-open-${side}`} label={label} onClick={onClick}>
      <Icon size={16} strokeWidth={2.4} />
    </IconButton>
  );
}
