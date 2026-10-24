import { icon } from './icons.js';

/** Stable shell elements live here; exercise/session state stays in main.ts. */
export function shellMarkup(topicCount: number, shortcut: string): string {
  return `
    <a class="skip-link" href="#main-content">跳到主要内容</a>
    <header class="titlebar">
      <a class="brand" href="/" aria-label="ShellLab 首页"><span class="brand-mark">${icon('terminal')}</span><span>shelllab</span></a>
      <span class="titlebar-caption">你的 Shell 练习室</span>
      <div class="window-controls" id="window-controls" hidden>
        <button data-window-action="minimize" aria-label="最小化窗口"><svg viewBox="0 0 16 16"><path d="M3 8h10"/></svg></button>
        <button data-window-action="maximize" aria-label="最大化或还原窗口"><svg viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="9" rx="1"/></svg></button>
        <button data-window-action="close" aria-label="关闭窗口"><svg viewBox="0 0 16 16"><path d="m3.5 3.5 9 9m0-9-9 9"/></svg></button>
      </div>
    </header>
    <nav class="activity-rail" aria-label="主导航">
      <span class="rail-logo brand-mark" aria-hidden="true">${icon('terminal')}</span>
      <button class="rail-item active" id="practice-nav" aria-label="练习" aria-current="page">${icon('file')}<span>练习</span></button>
      <button class="rail-item" id="menu" aria-label="打开练习列表" aria-expanded="false" aria-controls="sidebar">${icon('book')}<span>场景库</span></button>
      <button class="rail-item" id="history-nav" aria-label="练习历史">${icon('clock')}<span>历史</span></button>
      <div class="rail-bottom"><button class="rail-item" id="settings-nav" aria-label="设置">${icon('settings')}<span>设置</span></button><span class="avatar" title="DeepSeek 鲸鱼娘 · 本地练习者" aria-label="DeepSeek 鲸鱼娘，本地练习者"><img src="/avatar-whale-girl.png" alt="" draggable="false"></span></div>
    </nav>
    <aside class="sidebar" id="sidebar" aria-label="场景库" inert>
      <div class="sidebar-top">
        <div class="sidebar-heading"><h2>场景库</h2><button class="icon-button" id="sidebar-close" aria-label="关闭场景库">${icon('close')}</button></div>
        <p class="sidebar-caption">从日常工作中，练好每一条命令。</p>
        <button class="generate-entry" data-open-generator>${icon('spark')}<span><strong>生成开发实战</strong><small>自由组合场景与难度</small></span>${icon('arrow')}</button>
        <div id="active-challenge"></div>
        <div class="scenario-filter-row">${icon('search')}<input id="scenario-filter" type="search" placeholder="筛选场景" aria-label="筛选场景" autocomplete="off" spellcheck="false"><button class="filter-clear icon-button" id="scenario-clear" aria-label="清空筛选" hidden>${icon('close')}</button><span class="scenario-count" id="scenario-count" aria-live="polite">${topicCount}</span></div>
      </div>
      <div class="sidebar-scroll"><nav id="scenarios" aria-label="开发场景"></nav></div>
      <div class="sidebar-bottom"><div class="progress-label"><span>已完成实战</span><strong id="progress-number">0 题</strong></div><p class="progress-caption" id="challenge-progress"></p><div class="environment-card"><div class="environment-icon">${icon('shield')}</div><div><strong id="environment-label"></strong><p id="environment-caption"></p></div></div><button class="guide-link" id="guide">查看练习指南 ${icon('arrow')}</button></div>
    </aside>
    <div class="sidebar-scrim" id="sidebar-scrim" hidden></div>
    <main class="main" id="main-content" tabindex="-1">
      <header class="workspace-toolbar"><div class="breadcrumb"><span>开发实战</span><span class="breadcrumb-separator">/</span><strong id="chapter-name">选择练习场景</strong></div><div class="workspace-toolbar-right"><span class="header-connection" id="header-connection" role="status"><i id="header-connection-dot"></i><span id="header-connection-label">准备连接</span></span><span class="toolbar-divider"></span><button class="text-button" id="reference" aria-label="命令速查">命令速查</button><button class="palette-trigger" id="palette-trigger" aria-label="搜索场景或命令" aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K"><kbd>${shortcut}</kbd></button></div></header>
      <div class="exercise-layout">
        <section class="lesson-panel" aria-label="练习说明">
          <div class="visually-hidden"><span id="lesson-state">IDLE</span><span id="lesson-meta">—</span></div>
          <div id="lesson-content"></div>
          <div class="lesson-actions"><button class="hint-button" id="hint" aria-expanded="false" aria-controls="lesson-hint">${icon('bulb')}<span>给我一点提示</span></button><div class="action-row"><button class="primary-button" id="check">检查结果</button><button class="secondary-button" id="skip" aria-label="跳过当前练习">跳过</button></div><p class="action-caption">可随时重置练习环境</p></div>
        </section>
        <section class="terminal-panel" aria-label="Linux 交互式终端">
          <header class="terminal-header"><div class="terminal-tab"><span class="terminal-tab-icon">${icon('terminal')}</span><strong>bash</strong><span id="terminal-workspace">~/workspace</span></div><div class="terminal-tools"><button class="icon-button" id="clear" title="清空终端显示" aria-label="清空终端显示">${icon('spark')}</button><button class="reset-button" id="reset" aria-label="重置环境">重置</button><button class="icon-button" id="fullscreen" aria-label="展开终端" aria-pressed="false" title="展开终端">${icon('expand')}</button></div></header>
          <div class="terminal-area"><div id="terminal"></div><div class="terminal-overlay" id="terminal-overlay" role="status" hidden></div></div>
          <footer class="terminal-footer"><span class="connection" aria-live="polite"><i id="connection-dot"></i><span>Bash</span><span class="connection-detail" id="connection-label">准备连接</span></span><span id="terminal-dimensions"></span><span class="terminal-encoding">UTF-8</span></footer>
        </section>
      </div>
    </main>
    <dialog id="dialog" aria-labelledby="dialog-title"><div id="dialog-content"></div></dialog>
    <dialog id="palette" class="palette" aria-labelledby="palette-title"><h2 id="palette-title" class="visually-hidden">命令面板</h2><div class="palette-input-row"><span class="palette-prompt" aria-hidden="true">❯</span><input id="palette-input" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list" aria-activedescendant="" autocomplete="off" spellcheck="false" placeholder="输入场景或命令…" aria-label="搜索场景或命令"><kbd>ESC</kbd></div><ul id="palette-list" role="listbox" aria-label="命令与场景"></ul><div class="palette-footer"><kbd>↑</kbd><kbd>↓</kbd> 选择 <span>·</span><kbd>↵</kbd> 确认 <span>·</span><kbd>ESC</kbd> 关闭</div></dialog>
    <div class="toast" id="toast" role="status" hidden></div>`;
}
