import React, { useState } from 'react';

interface MvuTreeViewProps {
  data: Record<string, unknown>;
}

function TreeNode({ label, value, depth = 0 }: { label: string; value: unknown; depth?: number }) {
  const [collapsed, setCollapsed] = useState(depth >= 2);

  if (label.startsWith('$')) return null;

  const isReadonly = label.startsWith('_');
  const isObj = value !== null && typeof value === 'object' && !Array.isArray(value);
  const isArr = Array.isArray(value);

  if (isObj) {
    const entries = Object.entries(value as Record<string, unknown>).filter(([k]) => !k.startsWith('$'));
    if (entries.length === 0) {
      return (
        <div className="mvu-row" style={{ paddingLeft: depth * 12 }}>
          <span className="mvu-key">{label}</span>
          <span className="muted">（空）</span>
        </div>
      );
    }
    return (
      <div style={{ marginLeft: depth > 0 ? 8 : 0 }}>
        <div
          className="section-header"
          style={{ padding: '4px 8px', fontSize: 12, marginBottom: 3 }}
          onClick={() => setCollapsed((c) => !c)}
        >
          <span>
            {collapsed ? '▸' : '▾'} {label}
          </span>
          <span className="muted">{entries.length}</span>
        </div>
        {!collapsed && (
          <div style={{ borderLeft: '1px solid var(--ink-border)', paddingLeft: 6, marginBottom: 4 }}>
            {entries.map(([k, v]) => (
              <TreeNode key={k} label={k} value={v} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (isArr) {
    const arr = value as unknown[];
    return (
      <div className="mvu-row" style={{ paddingLeft: depth * 8 }}>
        <span className="mvu-key">{label}</span>
        <span className="mvu-val">
          {arr.length === 0 ? '[]' : arr.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join('、')}
        </span>
      </div>
    );
  }

  return (
    <div className="mvu-row" style={{ paddingLeft: depth * 8 }}>
      <span className="mvu-key" style={{ opacity: isReadonly ? 0.65 : 1 }}>
        {label}
        {isReadonly ? ' 🔒' : ''}
      </span>
      <span className="mvu-val">{String(value ?? '')}</span>
    </div>
  );
}

export function MvuTreeView({ data }: MvuTreeViewProps) {
  const entries = Object.entries(data || {}).filter(([k]) => !k.startsWith('$'));
  if (entries.length === 0) {
    return <div className="muted">当前角色卡无 MVU `stat_data` 变量树。</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {entries.map(([k, v]) => (
        <TreeNode key={k} label={k} value={v} depth={0} />
      ))}
    </div>
  );
}
