import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import './ui/desktop.css';
import { icon } from './ui/icons.js';
import { shellMarkup } from './ui/shell.js';
import { bindDesktopControls, writeClipboard } from './ui/desktop.js';
import type { Bootstrap, CheckResult, Lesson, RuntimeHealth, SessionInfo, GeneratorInfo, GenerationOptions, Difficulty, ScenarioTopic } from '../shared/types.js';

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const $ = <T extends Element = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
const paletteShortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K';

interface GroupMeta { id: string; name: string }
const groupMeta: GroupMeta[] = [
  { id: 'diagnose', name: '排查与诊断' },
  { id: 'files', name: '文件与数据' },
  { id: 'release', name: '发布与工程' },
  { id: 'remote', name: 'SSH 与远程' },
];

interface PaletteItem { id: string; label: string; hint: string; run: () => void }

let selected: Lesson | null = null;
let health: RuntimeHealth;
let generator: GeneratorInfo;
let generationPreferences: GenerationOptions = { topics: [], difficulty: 'intermediate', source: 'rules' };
let session: SessionInfo | null = null;
let socket: WebSocket | undefined;
let busy = false;
let checking = false;
let connected = false;
let connectionGeneration = 0;
let result: CheckResult | undefined;
let hintVisible = false;
let customFontSize = false;
const UI_SCALE_KEY = 'shell-lab-ui-scale';
const DEFAULT_UI_SCALE = 1.25;
let uiScale = DEFAULT_UI_SCALE;
let completed = new Set<string>();
try { completed = new Set(JSON.parse(localStorage.getItem('shell-lab-progress-v1') ?? '[]')); } catch { /* Private browsing may block storage. */ }

let scenarioFilter = '';
const collapsedGroups = new Set<string>();
let paletteIndex = 0;
let paletteItems: PaletteItem[] = [];
let paletteReturnFocus: HTMLElement | null = null;
let dialogReturnFocus: HTMLElement | null = null;
let drawerOpen = false;
const mobileQuery = window.matchMedia('(max-width: 680px)');

const terminal = new Terminal({
  cursorBlink: true, cursorStyle: 'block', fontSize: 16, lineHeight: 1.6,
  fontFamily: '"SFMono-Regular", "Cascadia Code", "JetBrains Mono", "IBM Plex Mono", "Liberation Mono", Menlo, Consolas, monospace',
  scrollback: 5000, allowProposedApi: false,
  theme: {
    background: '#252626', foreground: '#deded8', cursor: '#e8e5dd', cursorAccent: '#252626', selectionBackground: '#55564e',
    black: '#16202c', red: '#d38b70', green: '#a7bfa0', yellow: '#e7b65a',
    blue: '#8ab4f8', magenta: '#c8a8f0', cyan: '#7ed8d0', white: '#d9e4f0',
    brightBlack: '#4a5e72', brightRed: '#ff9a9a', brightGreen: '#9cffc4', brightYellow: '#f2cc86',
    brightBlue: '#afcbff', brightMagenta: '#dfc7ff', brightCyan: '#a8ede7', brightWhite: '#f2f7fc',
  },
});
const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
terminal.onData((data) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }));
});
terminal.onResize(({ cols, rows }) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols, rows }));
});

function topicMap(): Map<string, ScenarioTopic> {
  return new Map(generator.topics.map((topic) => [topic.id, topic]));
}

function groupOf(topic: ScenarioTopic): string {
  return groupMeta.some((group) => group.id === topic.group) ? topic.group : 'other';
}

function groupLabel(id: string): string {
  return groupMeta.find((group) => group.id === id)?.name ?? '更多场景';
}

function allGroups(): GroupMeta[] {
  return generator.topics.some((topic) => groupOf(topic) === 'other')
    ? [...groupMeta, { id: 'other', name: '更多场景' }]
    : groupMeta;
}

function topicMatches(topic: ScenarioTopic, query: string): boolean {
  const fields = [topic.name, topic.id, topic.description, ...topic.concepts, ...topic.tools, groupLabel(groupOf(topic))];
  return fields.join(' ').toLowerCase().includes(query);
}

function updateTerminalDimensions(): void {
  const dimensions = document.querySelector('#terminal-dimensions');
  if (dimensions) dimensions.textContent = `${terminal.cols} × ${terminal.rows}`;
}

let fitFrame: number | undefined;
function fitTerminal(): void {
  if (fitFrame !== undefined) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = undefined;
    try {
      fitAddon.fit();
      updateTerminalDimensions();
    } catch { /* Terminal is not attached yet. */ }
  });
}

function applyResponsiveTerminalFontSize(): void {
  if (customFontSize) return;
  const size = window.innerWidth >= 3000 ? 22 : window.innerWidth >= 2300 ? 20 : window.innerWidth >= 1800 ? 18 : window.shellLabDesktop ? 16 : 14;
  if (terminal.options.fontSize === size) return;
  terminal.options.fontSize = size;
  fitTerminal();
}

function applyUiScale(scale: number): void {
  const bridge = window.shellLabDesktop;
  if (!bridge) return;
  void bridge.setZoom(scale).then(() => {
    window.setTimeout(fitTerminal, 50);
  }).catch(() => { /* Keep the current scale. */ });
}

async function api<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(`/api/${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? '请求失败，请重试。');
  return data as T;
}

function layout() {
  $('#app').innerHTML = shellMarkup(generator.topics.length, paletteShortcut);
  bindDesktopControls();
  terminal.open($('#terminal'));
  new ResizeObserver(() => fitTerminal()).observe($('#terminal'));
  $('#menu').addEventListener('click', () => setDrawer(!drawerOpen));
  $('#sidebar-scrim').addEventListener('click', () => setDrawer(false));
  $('#reference').addEventListener('click', showReference);
  $('#practice-nav').addEventListener('click', () => { setDrawer(false); $('#main-content').focus(); });
  $('#history-nav').addEventListener('click', showHistory);
  $('#settings-nav').addEventListener('click', showSettings);
  $('#skip').addEventListener('click', showGenerator);
  $('#fullscreen').addEventListener('click', toggleTerminal);
  $('#sidebar-close').addEventListener('click', () => setDrawer(false));
  $('#guide').addEventListener('click', showGuide);
  document.querySelectorAll('[data-open-generator]').forEach((button) => button.addEventListener('click', showGenerator));
  $('#hint').addEventListener('click', () => {
    if (!selected) return;
    hintVisible = !hintVisible;
    renderHint(hintVisible);
  });
  $('#check').addEventListener('click', () => void check());
  $('#clear').addEventListener('click', () => { terminal.clear(); terminal.focus(); });
  $('#reset').addEventListener('click', requestReset);
  $('#scenarios').addEventListener('click', onScenarioClick);
  $<HTMLInputElement>('#scenario-filter').addEventListener('input', (event) => {
    scenarioFilter = (event.target as HTMLInputElement).value;
    applyScenarioView();
  });
  $('#scenario-clear').addEventListener('click', () => {
    const input = $<HTMLInputElement>('#scenario-filter');
    input.value = ''; scenarioFilter = ''; input.focus(); applyScenarioView();
  });
  $('#palette-trigger').addEventListener('click', openPalette);
  $<HTMLInputElement>('#palette-input').addEventListener('input', () => { paletteIndex = 0; renderPalette(); });
  $<HTMLInputElement>('#palette-input').addEventListener('keydown', onPaletteKeydown);
  $('#palette-list').addEventListener('click', (event) => {
    const option = (event.target as HTMLElement).closest<HTMLElement>('[data-palette-index]');
    if (option) activatePaletteItem(Number(option.dataset.paletteIndex));
  });
  $<HTMLDialogElement>('#dialog').addEventListener('close', restoreDialogFocus);
  $<HTMLDialogElement>('#palette').addEventListener('close', () => {
    paletteReturnFocus?.focus(); paletteReturnFocus = null;
  });
  $('#dialog').addEventListener('click', (event) => { if (event.target === $('#dialog')) closeDialog(); });
  $('#palette').addEventListener('click', (event) => { if (event.target === $('#palette')) closePalette(); });
  document.addEventListener('keydown', onGlobalKeydown);
  mobileQuery.addEventListener('change', syncDrawerMode);
  syncDrawerMode();
  try {
    const saved = localStorage.getItem('shell-lab-font-size');
    const savedSize = Number(saved);
    if (saved !== null && savedSize >= 12 && savedSize <= 22) {
      customFontSize = true;
      terminal.options.fontSize = savedSize;
    }
  } catch { /* Use the responsive default when storage is unavailable. */ }
  applyResponsiveTerminalFontSize();
  window.addEventListener('resize', applyResponsiveTerminalFontSize);
  try {
    const savedScale = localStorage.getItem(UI_SCALE_KEY);
    if (savedScale !== null) {
      const scale = Number(savedScale);
      if (scale >= 0.8 && scale <= 2) uiScale = scale;
    }
  } catch { /* Use the default scale. */ }
  applyUiScale(uiScale);
}

function onScenarioClick(event: Event) {
  const target = event.target as HTMLElement;
  const toggle = target.closest<HTMLElement>('[data-group-toggle]');
  if (toggle) {
    const id = toggle.dataset.groupToggle!;
    if (collapsedGroups.has(id)) collapsedGroups.delete(id); else collapsedGroups.add(id);
    applyScenarioView();
    return;
  }
  const topic = target.closest<HTMLButtonElement>('[data-topic]');
  if (topic && !topic.disabled) selectTopic(topic.dataset.topic!);
}

function selectTopic(id: string) {
  if (busy || checking) return;
  generationPreferences = { ...generationPreferences, topics: [id], difficulty: 'basic' };
  setDrawer(false, false);
  showGenerator();
}

function requestReset() {
  if (busy || checking) return;
  if (!session || !selected) { showGenerator(); return; }
  confirmAction('重新开始这道练习？', '当前练习中的文件、变量和命令历史会被清空，已完成的学习进度会保留。', '重置环境', () => void createSession());
}

function setDrawer(open: boolean, restoreFocus = true) {
  const sidebar = $('#sidebar');
  const menu = $('#menu');
  $('#app').classList.toggle('library-open', open);
  menu.classList.toggle('active', open);
  $('#practice-nav').classList.toggle('active', !open);
  $('#practice-nav').setAttribute('aria-current', !open ? 'page' : 'false');
  drawerOpen = open;
  sidebar.classList.toggle('is-open', open);
  menu.setAttribute('aria-expanded', String(open));
  $('#sidebar-scrim').hidden = !open;
  if (open) {
    sidebar.removeAttribute('inert');
    requestAnimationFrame(() => $<HTMLInputElement>('#scenario-filter').focus());
  } else {
    sidebar.setAttribute('inert', '');
    if (restoreFocus) menu.focus();
  }
}

function syncDrawerMode() {
  setDrawer(drawerOpen, false);
}

function onGlobalKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if ($<HTMLDialogElement>('#palette').open) closePalette();
    else openPalette();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !anyDialogOpen()) {
    event.preventDefault(); void check(); return;
  }
  if (event.key === 'Escape' && $('#app').classList.contains('terminal-expanded') && !anyDialogOpen()) { toggleTerminal(); return; }
  if (event.key === 'Escape' && drawerOpen) { setDrawer(false); return; }
  if (drawerOpen && event.key === 'Tab') {
    const focusable = [...$('#sidebar').querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], select, textarea')]
      .filter((element) => element.getClientRects().length > 0);
    if (focusable.length) {
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    return;
  }
  if (event.key === '/' && !isTypingTarget(event.target) && !anyDialogOpen()) {
    event.preventDefault(); setDrawer(true); return;
  }
  if (event.key === '?' && !isTypingTarget(event.target) && !anyDialogOpen()) showReference();
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

function anyDialogOpen(): boolean {
  return $<HTMLDialogElement>('#dialog').open || $<HTMLDialogElement>('#palette').open;
}

function renderSidebar() {
  $('#active-challenge').innerHTML = selected?.generated ? `<div class="active-challenge"><span>当前实战 · ${selected.generated.source === 'ai' ? 'AI 场景规划' : '本地动态出题'}</span><strong>${escape(selected.title)}</strong><small>${selected.generated.verified ? '已通过真实环境试做验证' : '等待验证'}</small></div>` : '';
  renderScenarioGroups();
  applyScenarioView();
  const challenges = [...completed].filter((id) => id.startsWith('generated-')).length;
  $('#progress-number').textContent = `${challenges} 题`;
  $('#challenge-progress').textContent = challenges ? `实战累计完成 ${challenges} 题，继续挑战。` : '选择场景，开始你的第一道实战。';
}

function renderScenarioGroups() {
  const groups = allGroups();
  $('#scenarios').innerHTML = groups.map((group, index) => {
    const topics = generator.topics.filter((topic) => groupOf(topic) === group.id);
    if (!topics.length) return '';
    const activeGroup = topics.some((topic) => selected?.generated?.topics.includes(topic.id));
    return `<section class="scenario-group" data-group="${group.id}">
      <button class="group-toggle" data-group-toggle="${group.id}" aria-expanded="true" aria-controls="group-${group.id}">
        <span class="group-caret" aria-hidden="true">${icon('chevron')}</span>
        <span class="group-index" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
        <span class="group-name">${escape(group.name)}</span>
        <span class="group-count" aria-hidden="true">${String(topics.length).padStart(2, '0')}</span>
        ${activeGroup ? '<span class="group-active" aria-hidden="true"></span>' : ''}
      </button>
      <div class="group-body" id="group-${group.id}" role="group" aria-label="${escape(group.name)}">
        ${topics.map((topic) => {
          const active = Boolean(selected?.generated?.topics.includes(topic.id));
          const reason = topic.unavailableReason ?? '环境未就绪';
          return `<button class="scenario-link${active ? ' active' : ''}" data-topic="${topic.id}"${active ? ' aria-current="true"' : ''}${topic.available ? ` title="${escape(topic.description)}"` : ` disabled aria-label="${escape(topic.name)} — ${escape(reason)}"`}><span class="scenario-name">${escape(topic.name)}</span></button>`;
        }).join('')}
      </div>
    </section>`;
  }).join('') + '<p id="scenario-empty" hidden>没有匹配的场景。</p>';
}

function applyScenarioView() {
  const query = scenarioFilter.trim().toLowerCase();
  const topics = topicMap();
  let total = 0;
  document.querySelectorAll<HTMLElement>('.scenario-group').forEach((section) => {
    const groupId = section.dataset.group!;
    const body = section.querySelector<HTMLElement>('.group-body')!;
    const toggle = section.querySelector<HTMLElement>('[data-group-toggle]')!;
    const links = [...section.querySelectorAll<HTMLButtonElement>('.scenario-link')];
    let matched = 0;
    for (const link of links) {
      const topic = topics.get(link.dataset.topic!);
      const match = !query || Boolean(topic && topicMatches(topic, query));
      link.hidden = !match;
      if (match) matched++;
    }
    total += matched;
    section.hidden = matched === 0;
    const expanded = query ? true : !collapsedGroups.has(groupId);
    toggle.setAttribute('aria-expanded', String(expanded));
    body.hidden = !expanded;
    const count = section.querySelector<HTMLElement>('.group-count')!;
    count.textContent = query ? `${matched}/${links.length}` : String(links.length).padStart(2, '0');
  });
  $('#scenario-count').textContent = query ? `${total} / ${generator.topics.length}` : String(generator.topics.length);
  $('#scenario-empty').hidden = !(query && total === 0);
  $<HTMLButtonElement>('#scenario-clear').hidden = !query;
}

function renderLesson() {
  updateLessonPane();
  if (!selected) {
    $('#chapter-name').textContent = '选择练习场景';
    $('#lesson-content').innerHTML = `<div class="lesson-empty">
      <div class="lesson-meta"><span>准备开始</span><span class="difficulty-badge">实战</span></div>
      <h2>从一个开发场景开始</h2>
      <p class="lesson-subtitle">选择你想练习的工作任务，让系统生成新题。</p>
      <div class="lesson-divider"></div>
      <p class="lesson-description">日志排查、配置修改、Git、SSH/SCP、HTTP 接口、进程管理……选择一个专项，或组合多个场景挑战自己。</p>
      <ol class="start-steps">
        <li><span class="step-index">01</span><div><strong>选择场景</strong><p>打开场景库，选择一项日常开发任务。</p></div></li>
        <li><span class="step-index">02</span><div><strong>生成并验证</strong><p>选择难度，生成已在真实环境中试做通过的题目。</p></div></li>
        <li><span class="step-index">03</span><div><strong>动手检查</strong><p>在 Bash 终端中操作，检查结果后继续生成新题。</p></div></li>
      </ol>
      <div class="takeaway"><span class="takeaway-label">NOTE</span><p>支持专项和组合实战，随时查看提示和命令速查。</p></div>
    </div>`;
    updateButtons();
    return;
  }
  const lesson = selected;
  $('#chapter-name').textContent = lesson.chapter;
  $('#lesson-content').innerHTML = `
    <div class="lesson-meta"><span>当前练习</span><span class="difficulty-badge">${difficultyLabel(lesson.generated?.difficulty)}</span></div>
    <h2>${escape(lesson.title)}</h2><p class="lesson-subtitle">${escape(lesson.subtitle)}</p>
    <p class="duration">预计 ${lesson.minutes} 分钟 <span>·</span> ${escape(lesson.concepts.slice(0, 2).join('与'))}</p>
    ${lesson.generated ? `<div class="generation-label">${icon('check')}<span>已在真实环境中试做通过</span><button id="change-challenge">换一道题 ${icon('reset')}</button></div>` : ''}
    <div class="lesson-divider"></div>
    <h3 class="objectives-heading">任务目标</h3>
    <details class="lesson-background"><summary>查看任务背景</summary><p class="lesson-description">${escape(lesson.description)}</p></details>
    <ol class="objectives">${lesson.objectives.map((objective) => {
      const state = result?.results.find((item) => item.id === objective.id);
      return `<li class="objective ${state ? state.passed ? 'passed' : 'failed' : ''}"><span class="objective-marker" aria-label="${state?.passed ? '已完成' : '待完成'}">${state?.passed ? icon('check') : ''}</span><span>${escape(objective.text)}${state && !state.passed ? '<small>尚未达到目标，再检查一下。</small>' : ''}</span></li>`;
    }).join('')}</ol>
    <p class="objective-progress">已完成 ${result?.results.filter((item) => item.passed).length ?? 0} / ${lesson.objectives.length}</p>
    <div class="exercise-files">${icon('folder')}<span>练习文件</span><code title="${escape(session?.workspace ?? '')}">${escape(relativeWorkspace())}</code></div>
    <div class="takeaway"><p>${escape(lesson.takeaway)}</p></div>
    <section class="hint-content" id="lesson-hint" aria-label="练习提示" hidden></section>
    ${result ? `<div class="result-message ${result.passed ? 'success' : ''}" role="status">${result.passed ? `${icon('check')}<div><strong>做得好，练习完成！</strong><p>所有目标都已通过检查。</p></div>` : `<div><strong>已经完成 ${result.results.filter((item) => item.passed).length} / ${result.results.length} 个目标</strong><p>查看上面的反馈，调整后可以再次检查。</p></div>`}</div>` : ''}
    ${result?.passed && lesson.generated ? `<button class="next-button" id="another">再生成一道开发实战 ${icon('spark')}</button>` : ''}`;
  $('#terminal-workspace').textContent = relativeWorkspace();
  $('#terminal-workspace').title = session?.workspace ?? '';
  renderHint();
  document.querySelector('#change-challenge')?.addEventListener('click', showGenerator);
  document.querySelector('#another')?.addEventListener('click', showGenerator);
  updateButtons();
}

function renderHint(reveal = false) {
  const hint = document.querySelector<HTMLElement>('#lesson-hint');
  if (!hint || !selected) return;
  if (hintVisible && !hint.firstElementChild) {
    const lesson = selected;
    hint.innerHTML = `<div class="code-heading"><span class="hint-title">$ hint --show</span><button class="icon-button" id="copy-example" aria-label="复制参考命令">${icon('copy')}</button></div><h3>试试这个思路</h3><p>${escape(lesson.hint)}</p><div class="code-heading code-heading-reference"><span>参考写法</span></div><pre><code>${escape(lesson.example)}</code></pre>`;
    $('#copy-example').addEventListener('click', () => void copy(lesson.example));
  }
  hint.hidden = !hintVisible;
  $('#hint').classList.toggle('selected', hintVisible);
  $('#hint').setAttribute('aria-expanded', String(hintVisible));
  $('#hint span').textContent = hintVisible ? '收起提示' : '给我一点提示';
  // Jump to the feedback without queueing scroll animations during repeated clicks.
  if (reveal && hintVisible) hint.scrollIntoView({ block: 'start', behavior: 'instant' });
}

function difficultyLabel(difficulty?: Difficulty): string {
  return difficulty === 'advanced' ? '进阶' : difficulty === 'intermediate' ? '综合' : '基础';
}

function relativeWorkspace(): string {
  return '~/workspace';
}

function toggleTerminal() {
  const expanded = $('#app').classList.toggle('terminal-expanded');
  const button = $('#fullscreen');
  button.setAttribute('aria-pressed', String(expanded));
  button.setAttribute('aria-label', expanded ? '收起终端' : '展开终端');
  button.title = expanded ? '收起终端 · Esc' : '展开终端';
  button.innerHTML = icon(expanded ? 'collapse' : 'expand');
  fitTerminal();
  terminal.focus();
}

interface HistoryEntry { id: string; title: string; chapter: string; completedAt: string }
function readHistory(): HistoryEntry[] {
  try {
    const entries: unknown = JSON.parse(localStorage.getItem('shell-lab-history-v1') ?? '[]');
    return Array.isArray(entries) ? entries.filter((entry): entry is HistoryEntry => entry && typeof entry.id === 'string' && typeof entry.title === 'string' && typeof entry.chapter === 'string' && typeof entry.completedAt === 'string') : [];
  } catch { return []; }
}
function saveHistory(lesson: Lesson) {
  try {
    const entries = readHistory().filter((entry) => entry.id !== lesson.id);
    entries.unshift({ id: lesson.id, title: lesson.title, chapter: lesson.chapter, completedAt: new Date().toISOString() });
    localStorage.setItem('shell-lab-history-v1', JSON.stringify(entries.slice(0, 100)));
  } catch { /* Completing an exercise does not depend on browser storage. */ }
}
function showHistory() {
  setDrawer(false, false);
  const entries = readHistory();
  showDialog(`<div class="dialog-eyebrow">YOUR PRACTICE</div><h2 id="dialog-title">练习历史</h2><p>每一步练习，都在这里留下足迹。记录保存在当前设备。</p><div class="history-list">${entries.length ? entries.map((entry) => `<article>${icon('check')}<div><h3>${escape(entry.title)}</h3><p>${escape(entry.chapter)} · ${escape(new Date(entry.completedAt).toLocaleDateString('zh-CN'))}</p></div><span>已完成</span></article>`).join('') : `<div class="history-empty">${icon('clock')}<h3>下一次进步，从现在开始</h3><p>完成一道练习后，这里会记录你的实战成果。</p></div>`}</div>`, 'history');
}
function showSettings() {
  setDrawer(false, false);
  const sizes = [12, 13, 14, 15, 16, 18, 20, 22];
  const uiScaleRow = window.shellLabDesktop
    ? `<div class="settings-row"><label for="ui-scale">界面缩放<small>调整整个窗口的显示比例，立即生效并保存在当前设备</small></label><select id="ui-scale" aria-label="界面缩放">${[1, 1.1, 1.15, 1.25, 1.5].map((scale) => `<option value="${scale}" ${Math.abs(scale - uiScale) < 0.001 ? 'selected' : ''}>${Math.round(scale * 100)}%</option>`).join('')}</select></div>`
    : '';
  showDialog(`<div class="dialog-eyebrow">MAKE IT YOURS</div><h2 id="dialog-title">练习设置</h2><p>让工作区更适合你的节奏。</p>${uiScaleRow}<div class="settings-row"><label for="terminal-font-size">终端字号<small>调整后立即生效，自动保存在当前设备</small></label><select id="terminal-font-size" aria-label="终端字号"><option value="auto" ${customFontSize ? '' : 'selected'}>自动（跟随窗口）</option>${sizes.map((size) => `<option value="${size}" ${customFontSize && size === terminal.options.fontSize ? 'selected' : ''}>${size} px</option>`).join('')}</select></div><div class="settings-environment">${icon('shield')}<div><h3>${health.mode === 'local' ? '本机开发环境 · 未隔离' : '独立 Linux 练习环境'}</h3><p>${escape(health.message)}</p></div></div><p class="dialog-footnote">ShellLab · 真实命令，真实进步。</p>`, 'settings');
  $('#terminal-font-size').addEventListener('change', (event) => {
    const value = (event.target as HTMLSelectElement).value;
    if (value === 'auto') {
      customFontSize = false;
      try { localStorage.removeItem('shell-lab-font-size'); } catch { /* Use the responsive default. */ }
      applyResponsiveTerminalFontSize();
      fitTerminal();
      return;
    }
    const size = Number(value);
    customFontSize = true;
    terminal.options.fontSize = size;
    try { localStorage.setItem('shell-lab-font-size', String(size)); } catch { /* The current setting still applies. */ }
    fitTerminal();
  });
  $('#ui-scale')?.addEventListener('change', (event) => {
    const scale = Number((event.target as HTMLSelectElement).value);
    if (!Number.isFinite(scale) || scale < 0.8 || scale > 2) return;
    uiScale = scale;
    try { localStorage.setItem(UI_SCALE_KEY, String(scale)); } catch { /* The current scale still applies. */ }
    applyUiScale(scale);
  });
}

function updateLessonPane() {
  const state = $('#lesson-state');
  const meta = $('#lesson-meta');
  if (!selected) {
    meta.textContent = '—';
    state.textContent = 'IDLE';
    state.className = 'pane-state';
    return;
  }
  meta.textContent = `${selected.minutes} min`;
  state.textContent = result?.passed ? 'DONE' : checking ? 'CHECK' : 'ACTIVE';
  state.className = `pane-state ${result?.passed ? 'done' : checking ? 'busy' : ''}`;
}

function updateButtons() {
  const checkButton = $<HTMLButtonElement>('#check');
  checkButton.disabled = busy || checking || !connected || !selected;
  checkButton.innerHTML = checking ? '<span class="spinner"></span> 检查中…' : `检查结果 <span class="check-shortcut">${/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'} ↵</span>`;
  $<HTMLButtonElement>('#reset').disabled = busy || checking || !selected;
  $<HTMLButtonElement>('#skip').disabled = busy || checking || !selected;
  $<HTMLButtonElement>('#hint').disabled = busy || !selected;
  document.querySelectorAll<HTMLButtonElement>('[data-open-generator], [data-topic], #change-challenge, #another').forEach((button) => { button.disabled = busy || checking || Boolean(button.dataset.topic && !generator.topics.find((topic) => topic.id === button.dataset.topic)?.available); });
}

function connectionState(state: 'ready' | 'busy' | 'error', text: string) {
  $('#connection-dot').className = state;
  $('#connection-label').textContent = text;
  $('#header-connection-dot').className = state;
  $('#header-connection-label').textContent = state === 'ready' ? '环境已连接' : text;
  $('#header-connection').title = text;
}

function overlay(title: string, message: string, action: boolean | 'generate' = false) {
  const target = $('#terminal-overlay');
  target.hidden = false;
  target.innerHTML = `<div class="overlay-symbol">${icon(action ? 'terminal' : 'reset', action ? '' : 'spin')}</div><span class="overlay-eyebrow">${action === 'generate' ? 'SESSION' : action ? 'CONNECTION' : 'WORKSPACE'}</span><h3>${escape(title)}</h3><p>${escape(message)}</p>${action === 'generate' ? '<button class="primary-button" id="choose-scenario">选择开发场景</button>' : action ? '<button class="primary-button" id="retry">重新连接</button>' : '<span class="overlay-note">马上就好，请稍候。</span>'}`;
  document.querySelector('#retry')?.addEventListener('click', () => void retry());
  document.querySelector('#choose-scenario')?.addEventListener('click', showGenerator);
}

async function createSession() {
  if (busy || !selected) return;
  busy = true; checking = false; connected = false; result = undefined;
  connectionGeneration++; socket?.close();
  connectionState('busy', '正在准备环境');
  overlay('准备你的工作区', '正在启动 Bash 和初始化练习文件。');
  renderLesson();
  try {
    session = await api<SessionInfo>('session', { lessonId: selected.id });
    connectTerminal();
  } catch (error) {
    session = null;
    connectionState('error', '环境未就绪');
    overlay('无法恢复练习', errorMessage(error), health.ready ? 'generate' : true);
  } finally { busy = false; updateButtons(); }
}

function connectTerminal() {
  const generation = ++connectionGeneration;
  socket?.close();
  terminal.reset();
  const current = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminal`);
  socket = current;
  current.addEventListener('open', () => {
    if (generation !== connectionGeneration) return;
    connected = true; session!.active = true;
    $('#terminal-overlay').hidden = true;
    connectionState('ready', health.mode === 'local' ? '本机 Bash · 未隔离' : 'Linux 环境已连接');
    fitAddon.fit();
    updateTerminalDimensions();
    current.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    updateButtons(); terminal.focus();
  });
  current.addEventListener('message', (event) => {
    if (generation !== connectionGeneration) return;
    const message = JSON.parse(event.data);
    if (message.type === 'output') terminal.write(message.data);
    if (message.type === 'exit') {
      connected = false; session!.active = false;
      connectionState('error', 'Shell 已退出');
      terminal.writeln(`\r\n\x1b[90m[Shell 已退出，退出码 ${message.exitCode}。点击“重置环境”可以重新开始。]\x1b[0m`);
      updateButtons();
    }
  });
  current.addEventListener('close', (event) => {
    if (generation !== connectionGeneration || !session?.active) return;
    if (busy) { connected = false; return; }
    connected = false; connectionState('error', '连接已断开'); updateButtons();
    overlay('终端连接已断开', event.code === 4000 ? '这个练习已在另一个标签页连接。可以重新连接取回当前会话。' : '可以重新连接继续当前会话；如果环境已过期，会创建新的工作区。', true);
  });
}

function showWelcome() {
  connectionState('busy', '尚未开始练习');
  overlay('选择场景，开始练习', '先生成一道开发实战，终端会连接到为这道题准备的真实 Bash 环境。', 'generate');
}

async function retry() {
  try {
    const data = await api<Bootstrap>('bootstrap');
    health = data.health; session = data.session; generator = data.generator;
    selected = session?.lesson ?? null;
    renderEnvironment(); renderSidebar(); renderLesson();
    if (session?.active && selected) connectTerminal();
    else if (session && selected && health.ready && !busy) await createSession();
    else if (health.ready) showWelcome();
    else overlay('还差一个 Linux 环境', health.message, true);
  } catch (error) { overlay('暂时无法连接服务', errorMessage(error), true); }
}

async function check() {
  if (!connected || busy || checking || !selected) return;
  checking = true; updateButtons();
  try {
    result = await api<CheckResult>('check', {});
    if (result.lessonId !== selected?.id) return;
    if (result.passed) {
      completed.add(selected.id);
      try { localStorage.setItem('shell-lab-progress-v1', JSON.stringify([...completed])); } catch { /* Progress still works for this page. */ }
      saveHistory(selected);
      renderSidebar();
    }
    renderLesson();
  } catch (error) { toast(errorMessage(error)); }
  finally { checking = false; updateLessonPane(); updateButtons(); }
}

function renderEnvironment() {
  $('#environment-label').textContent = health.mode === 'local' ? '本机开发环境 · 未隔离' : '独立 Linux 练习环境';
  $('#environment-caption').textContent = health.mode === 'local' ? '命令可访问本机文件，请谨慎操作' : 'Ubuntu 24.04 / Bash / UTF-8';
  $('.environment-card').classList.toggle('local', health.mode === 'local');
}

function showGenerator() {
  if (busy || checking) return;
  setDrawer(false, false);
  if (!generator.aiConfigured && generationPreferences.source === 'ai') generationPreferences.source = 'rules';
  const preferences = generationPreferences;
  const groups = allGroups();
  const topicOption = (topic: ScenarioTopic) => {
    const checked = preferences.topics.includes(topic.id);
    const reason = topic.unavailableReason ?? '环境未就绪';
    return `<label class="topic-option ${topic.available ? '' : 'unavailable'}" data-topic-option="${topic.id}"><input type="checkbox" name="topic" value="${topic.id}" ${checked ? 'checked' : ''} ${topic.available ? '' : 'disabled'}><span><strong>${escape(topic.name)}</strong><small>${escape(topic.available ? topic.description : reason)}</small></span></label>`;
  };
  showDialog(`<div class="dialog-eyebrow">GENERATOR / 出题</div><h2 id="dialog-title">生成你的开发实战</h2><p>选择出题范围与难度。每道新题都会创建数据，并在独立工作区完成参考解和判题验证。</p>
    <form id="generator-form">
      <div class="generator-scroll">
        <section class="generator-section">
          <div class="section-label">01 / 难度与来源</div>
          <div class="generation-fields"><label>练习难度<select name="difficulty"><option value="basic" ${preferences.difficulty === 'basic' ? 'selected' : ''}>基础专项 · 1 个场景</option><option value="intermediate" ${preferences.difficulty === 'intermediate' ? 'selected' : ''}>组合实战 · 最多 2 个场景</option><option value="advanced" ${preferences.difficulty === 'advanced' ? 'selected' : ''}>综合挑战 · 最多 3 个场景</option></select></label>
          <label>出题方式<select name="source" id="generation-source"><option value="rules" ${preferences.source === 'rules' ? 'selected' : ''}>本地动态出题 · 无需模型</option><option value="ai" ${!generator.aiConfigured ? 'disabled' : ''} ${preferences.source === 'ai' && generator.aiConfigured ? 'selected' : ''}>AI 场景规划${generator.aiConfigured ? '' : ' · 尚未配置'}</option></select></label></div>
        </section>
        <section class="generator-section">
          <div class="section-label">02 / 场景范围</div>
          <div class="generation-scope"><strong>想练哪些场景？</strong><span>可多选；不选则随机组合全部可用场景。</span></div>
          <div class="generator-filter-row"><input id="generator-filter" type="search" placeholder="筛选可选场景" aria-label="筛选可选场景" autocomplete="off" spellcheck="false"><span id="generator-selected" aria-live="polite">已选 0</span></div>
          ${groups.map((group) => {
            const topics = generator.topics.filter((topic) => groupOf(topic) === group.id);
            if (!topics.length) return '';
            return `<fieldset class="topic-group" data-group="${group.id}"><legend>${escape(group.name)}<span class="topic-group-count">${topics.length}</span></legend><div class="topic-grid">${topics.map(topicOption).join('')}</div></fieldset>`;
          }).join('')}
        </section>
        <section class="generator-section">
          <div class="section-label">03 / 情境偏好</div>
          <label class="generation-focus" id="generation-focus" ${preferences.source !== 'ai' ? 'hidden' : ''}>希望练习的工作情境<textarea name="focus" maxlength="500" placeholder="例如：上线后接口变慢，想练日志排查和配置回滚。">${escape(preferences.focus ?? '')}</textarea><small>偏好影响场景选择与背景，具体目标由已验证的生成器给出。</small></label>
          ${!generator.aiConfigured ? '<p class="generation-note">本地模式会随机生成数据、筛选条件和任务组合。接入模型后可启用 AI 场景规划，配置方法见 README。</p>' : ''}
          <p class="generation-note">生成成功后会替换当前环境；生成失败保留当前练习。重置恢复同一道题，“换一道题”才会重新出题。</p>
        </section>
      </div>
      <div class="dialog-actions"><button type="button" class="secondary-button" id="cancel-generation">返回练习</button><button type="submit" class="primary-button" ${generator.topics.some((topic) => topic.available) ? '' : 'disabled'}>${icon('spark')} 生成并开始</button></div>
    </form>`, 'generator');
  const form = $<HTMLFormElement>('#generator-form');
  const updateSelected = () => {
    const count = form.querySelectorAll<HTMLInputElement>('input[name="topic"]:checked').length;
    $('#generator-selected').textContent = `已选 ${count}`;
  };
  updateSelected();
  form.addEventListener('change', updateSelected);
  $<HTMLInputElement>('#generator-filter').addEventListener('input', (event) => {
    const query = (event.target as HTMLInputElement).value.trim().toLowerCase();
    const topics = topicMap();
    form.querySelectorAll<HTMLElement>('.topic-option').forEach((option) => {
      const topic = topics.get(option.dataset.topicOption!);
      option.hidden = Boolean(query) && !(topic && topicMatches(topic, query));
    });
    form.querySelectorAll<HTMLElement>('.topic-group').forEach((fieldset) => {
      fieldset.hidden = [...fieldset.querySelectorAll<HTMLElement>('.topic-option')].every((option) => option.hidden);
    });
  });
  $('#generator-filter').addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') event.preventDefault();
  });
  $('#cancel-generation').addEventListener('click', closeDialog);
  $('#generation-source').addEventListener('change', () => { $('#generation-focus').hidden = $<HTMLSelectElement>('#generation-source').value !== 'ai'; });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    generationPreferences = { topics: data.getAll('topic') as string[], difficulty: data.get('difficulty') as Difficulty, source: data.get('source') as GenerationOptions['source'], focus: data.get('focus') as string };
    closeDialog();
    void generateSession(generationPreferences);
  });
}

async function generateSession(options: GenerationOptions) {
  if (busy || checking) return;
  busy = true; updateButtons();
  setDrawer(false, false);
  overlay('正在生成并试做新题', options.source === 'ai' ? 'AI 正在规划场景，随后会创建数据并验证参考解与判题。' : '正在组合开发场景、生成初始数据，并在独立工作区验证可解性。');
  try {
    const next = await api<SessionInfo>('generate', options);
    session = next; selected = next.lesson!; result = undefined; hintVisible = false;
    renderSidebar(); renderLesson(); connectTerminal();
  } catch (error) {
    toast(errorMessage(error));
    $('#terminal-overlay').hidden = true;
    if (socket?.readyState !== WebSocket.OPEN) await retry();
  } finally { busy = false; updateButtons(); }
}

function openPalette() {
  if (anyDialogOpen()) return;
  paletteReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  setDrawer(false, false);
  const palette = $<HTMLDialogElement>('#palette');
  const input = $<HTMLInputElement>('#palette-input');
  input.value = ''; paletteIndex = 0;
  if (!palette.open) palette.showModal();
  renderPalette();
  input.focus();
}

function closePalette() {
  const palette = $<HTMLDialogElement>('#palette');
  if (palette.open) palette.close();
}

function paletteActions(): PaletteItem[] {
  const actions: PaletteItem[] = [
    { id: 'generate', label: '生成开发实战', hint: 'command', run: () => { closePalette(); showGenerator(); } },
    { id: 'reference', label: '命令速查', hint: 'command', run: () => { closePalette(); showReference(); } },
    { id: 'guide', label: '练习指南', hint: 'command', run: () => { closePalette(); showGuide(); } },
  ];
  if (selected) actions.push({ id: 'reset', label: '重置环境', hint: 'command', run: () => { closePalette(); requestReset(); } });
  return actions;
}

function renderPalette() {
  const input = $<HTMLInputElement>('#palette-input');
  const query = input.value.trim().toLowerCase();
  const actions = paletteActions().filter((item) => !query || item.label.toLowerCase().includes(query));
  const topics = generator.topics.filter((topic) => topic.available && (!query || topicMatches(topic, query))).map((topic) => ({
    id: `topic-${topic.id}`, label: topic.name, hint: groupLabel(groupOf(topic)),
    run: () => { closePalette(); selectTopic(topic.id); },
  }));
  paletteItems = [...actions, ...topics];
  if (paletteIndex >= paletteItems.length) paletteIndex = Math.max(0, paletteItems.length - 1);
  $('#palette-list').innerHTML = paletteItems.length
    ? paletteItems.map((item, index) => `<li class="palette-item" id="palette-option-${index}" role="option" aria-selected="${index === paletteIndex}" data-palette-index="${index}"><span class="palette-item-label">${escape(item.label)}</span><span class="palette-item-hint">${escape(item.hint)}</span></li>`).join('')
    : '<li class="palette-empty">没有匹配的命令或场景。</li>';
  input.setAttribute('aria-activedescendant', paletteItems.length ? `palette-option-${paletteIndex}` : '');
  document.querySelector(`#palette-option-${paletteIndex}`)?.scrollIntoView({ block: 'nearest' });
}

function onPaletteKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!paletteItems.length) return;
    paletteIndex = (paletteIndex + (event.key === 'ArrowDown' ? 1 : -1) + paletteItems.length) % paletteItems.length;
    renderPalette();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    activatePaletteItem(paletteIndex);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closePalette();
  }
}

function activatePaletteItem(index: number) {
  paletteItems[index]?.run();
}

function showDialog(content: string, variant = 'default') {
  dialogReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dialog = $<HTMLDialogElement>('#dialog');
  dialog.dataset.variant = variant;
  $('#dialog-content').innerHTML = `<button class="icon-button dialog-close" id="dialog-close" aria-label="关闭弹窗">${icon('close')}</button>${content}`;
  if (!dialog.open) dialog.showModal();
  $('#dialog-close').addEventListener('click', closeDialog);
}

function closeDialog() { $<HTMLDialogElement>('#dialog').close(); }

function restoreDialogFocus() {
  if (dialogReturnFocus?.isConnected) dialogReturnFocus.focus();
  dialogReturnFocus = null;
}

function confirmAction(title: string, description: string, label: string, action: () => void) {
  showDialog(`<div class="dialog-eyebrow">WORKSPACE / 工作区</div><h2 id="dialog-title">${escape(title)}</h2><p>${escape(description)}</p><div class="dialog-actions"><button class="secondary-button" id="cancel">继续当前练习</button><button class="primary-button" id="confirm">${escape(label)}</button></div>`, 'confirm');
  $('#cancel').addEventListener('click', closeDialog);
  $('#confirm').addEventListener('click', () => { closeDialog(); action(); });
}

function showReference() {
  const commands = [
    ['pwd / ls -la', '查看当前位置 / 查看文件（包括隐藏文件）'], ['cd 路径 / cd ..', '进入目录 / 返回上级目录'],
    ['mkdir -p a/b', '创建多层目录'], ['cp 源 目标 / mv 源 目标', '复制 / 移动或重命名'], ['rm 文件', '删除文件'],
    ['cat 文件', '显示文件内容'], ["grep '模式' 文件", '筛选匹配的行'], ['命令1 | 命令2', '将前一个命令的输出交给后一个命令'],
    ['命令 > 文件 / 命令 >> 文件', '覆盖写入 / 追加写入'], ['bash script.sh 参数', '运行脚本并传入参数'],
    ['ssh -p 端口 -i 私钥 用户@主机', '使用指定端口和密钥登录'],
    ['ssh -F ssh_config 主机别名 命令', '通过独立配置执行远端命令'],
    ['scp -P 端口 本地文件 用户@主机:路径', '上传文件；端口选项为大写 -P'],
    ['scp -F client.conf 主机别名:文件 本地路径', '下载文件，使用配置中的端口和密钥'],
    ['scp -rp 目录 主机别名:目标目录', '递归复制并保留权限、修改时间'],
    ['chmod 600 client_key', '收紧 SSH 私钥权限'],
    ['ss -ltnp', '查看 TCP 监听端口及所属进程'],
    ['curl --resolve 主机:端口:IP -D headers.txt URL', '指定地址映射并保存响应头'],
    ['du -sk 目录 / find 目录 -type f -size +128k', '统计实际磁盘占用 / 找大文件'],
    ['timeout 5 命令 参数', '限制命令执行时间，超时通常返回 124'],
    ["trap '清理命令' EXIT", '脚本退出时执行清理'],
    ['flock -n -E 75 9', '获取文件描述符 9 的锁，冲突立即返回 75'],
    ['chmod +x script.sh', '给脚本添加执行权限'], ['printf \'%s\\n\' "$name"', '保留变量内容并输出一行'],
  ];
  showDialog(`<div class="dialog-eyebrow">REFERENCE / 速查</div><h2 id="dialog-title">手边的命令速查</h2><p>记不住很正常。查一查，再动手试一试。</p><div class="reference-list">${commands.map(([command, text]) => `<div><code>${escape(command)}</code><span>${escape(text)}</span></div>`).join('')}</div><p class="dialog-footnote">快捷键：Tab 补全 · ↑ / ↓ 历史命令 · Ctrl+C 中断 · Ctrl+D 结束输入</p>`, 'reference');
}

function showGuide() {
  showDialog(`<div class="dialog-eyebrow">GUIDE / 指南</div><h2 id="dialog-title">从第一条命令开始</h2><ol class="guide-steps"><li><span class="step-index">01</span><div><strong>选择开发场景</strong><p>点击“生成开发实战”，选择场景与难度。新题验证通过后，右侧终端会连接真实 Bash。</p></div></li><li><span class="step-index">02</span><div><strong>输入，再按 Enter</strong><p>文件、当前目录和变量会在会话中保留。终端报错也是真实的 Linux 反馈。</p></div></li><li><span class="step-index">03</span><div><strong>检查实际结果</strong><p>点击“检查结果”查看每个目标的状态。没有唯一写法，结果正确就能通过。脚本题会运行你的脚本来检查行为。</p></div></li><li><span class="step-index">04</span><div><strong>卡住时，试试提示</strong><p>提示里有思路和可复制的参考写法。“重置环境”可以恢复初始文件，“换一道题”会生成新的任务和环境。</p></div></li></ol><p class="dialog-footnote">连续 30 分钟没有操作，环境会被回收。完成进度仅保存在当前浏览器。</p>`, 'guide');
}

let toastTimer: ReturnType<typeof setTimeout>;
function toast(message: string) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4000);
}
async function copy(text: string) {
  try { await writeClipboard(text); toast('已复制，可以粘贴到终端中运行。'); }
  catch { toast('当前环境无法访问剪贴板，请选中文本手动复制。'); }
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : '连接失败，请重试。'; }

async function init() {
  try {
    const data = await api<Bootstrap>('bootstrap');
    health = data.health; session = data.session; generator = data.generator;
    selected = session?.lesson ?? null;
    if (selected?.generated) generationPreferences = { topics: selected.generated.topics, difficulty: selected.generated.difficulty, source: selected.generated.source };
    layout(); renderSidebar(); renderLesson(); renderEnvironment();
    if (session?.active) connectTerminal();
    else if (session && selected && health.ready) await createSession();
    else if (health.ready) showWelcome();
    else { connectionState('error', '环境未就绪'); overlay('还差一个 Linux 环境', health.message, true); }
  } catch {
    $('#app').innerHTML = `<main class="startup-error"><span class="brand-prompt">❯_</span><h1>ShellLab 服务尚未启动</h1><p>请在项目目录运行 <code>npm run dev</code>，然后重新加载页面。</p><button class="primary-button" id="reload">重新加载</button></main>`;
    $('#reload').addEventListener('click', () => location.reload());
  }
}
void init();
