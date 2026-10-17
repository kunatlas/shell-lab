import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import type { Bootstrap, CheckResult, Lesson, RuntimeHealth, SessionInfo, GeneratorInfo, GenerationOptions, Difficulty } from '../shared/types.js';

const paths: Record<string, string> = {
  terminal: '<path d="m5 6 6 6-6 6m9 0h5"/>',
  book: '<path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H4zm16 0h-4a3 3 0 0 0-3 3v14a4 4 0 0 1 4-3h3z"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  reset: '<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/>',
  bulb: '<path d="M9 18h6m-5 3h4M8.5 15.5a6 6 0 1 1 7 0L15 18H9z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 20"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>',
};
const icon = (name: string, className = '') => `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.terminal}</svg>`;
const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const $ = <T extends Element = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;

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
let completed = new Set<string>();
try { completed = new Set(JSON.parse(localStorage.getItem('shell-lab-progress-v1') ?? '[]')); } catch { /* Private browsing may block storage. */ }

const terminal = new Terminal({
  cursorBlink: true, cursorStyle: 'bar', fontSize: 14, lineHeight: 1.45,
  fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
  scrollback: 5000, allowProposedApi: false,
  theme: {
    background: '#0b1015', foreground: '#d2dce5', cursor: '#b4f272', selectionBackground: '#30452c',
    black: '#26313c', red: '#f08080', green: '#b4f272', yellow: '#e8c47d',
    blue: '#8bbcf2', magenta: '#c9a4ef', cyan: '#7dcfc9', white: '#d2dce5',
    brightBlack: '#738497', brightRed: '#f8a3a3', brightGreen: '#c6ff8e',
    brightYellow: '#f3d592', brightBlue: '#b1d2ff', brightMagenta: '#ddc2ff',
    brightCyan: '#a6e9e3', brightWhite: '#f1f5f9',
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

async function api<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(`/api/${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? '请求失败，请重试。');
  return data as T;
}

function layout() {
  $('#app').innerHTML = `
    <header class="topbar">
      <button class="icon-button mobile-menu" id="menu" aria-label="打开练习列表">${icon('menu')}</button>
      <a class="brand" href="/" aria-label="ShellLab 首页"><span class="brand-symbol">${icon('terminal')}</span><span>shell<span class="brand-light">lab</span><span class="brand-dot">.</span></span></a>
      <span class="topbar-divider"></span><span class="topbar-caption">Shell 练习室</span>
      <div class="topbar-right"><span class="version">V 0.1</span><button class="text-button" id="reference">${icon('book')}<span>命令速查</span><kbd>?</kbd></button></div>
    </header>
    <div class="app-layout">
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-heading"><span>开发实战</span><span class="tiny-label">LEARN BY DOING</span></div>
        <button class="generate-entry" data-open-generator>${icon('spark')}<span><strong>生成开发实战</strong><small>按场景与难度，自动出新题</small></span>${icon('arrow')}</button>
        <div id="active-challenge"></div>
        <div class="curriculum-label">开发场景</div>
        <nav id="scenarios" aria-label="开发场景"></nav>
        <div class="sidebar-bottom">
          <div class="progress-label"><span>已完成实战</span><strong id="progress-number">0 题</strong></div>
          <p class="progress-caption" id="challenge-progress">每一条命令，都是一次进步。</p>
          <div class="environment-card"><div class="environment-icon">${icon('shield')}</div><div><strong id="environment-label">独立练习环境</strong><p id="environment-caption">真实 Shell，即时反馈</p></div></div>
          <button class="guide-link" id="guide">第一次使用？查看练习指南 ${icon('arrow')}</button>
        </div>
      </aside>
      <main class="main">
        <div class="breadcrumb">开发实战 ${icon('chevron')} <span id="chapter-name"></span></div>
        <div class="workspace-heading"><div><div class="eyebrow">A LITTLE PRACTICE, EVERY DAY</div><h1>把命令，变成直觉<span>。</span></h1><p>从日志排障到应用发布，练习后端开发的日常。</p></div><div class="workspace-badge">${icon('terminal')}<span>交互式实验室</span></div></div>
        <div class="exercise-layout">
          <section class="lesson-panel" aria-label="练习说明"><div id="lesson-content"></div><div class="lesson-actions"><button class="hint-button" id="hint">${icon('bulb')}<span>给我一点提示</span></button><button class="primary-button" id="check">检查结果 ${icon('arrow')}</button></div></section>
          <section class="terminal-panel" aria-label="Linux 交互式终端">
            <div class="terminal-header"><div class="terminal-tab">${icon('terminal')}<span>bash</span><span class="terminal-tab-dot"></span></div><div class="terminal-tools"><button class="icon-button" id="clear" title="清空终端显示（保留文件和会话）" aria-label="清空终端显示">${icon('spark')}</button><span class="tool-divider"></span><button class="reset-button" id="reset">${icon('reset')} 重置环境</button></div></div>
            <div class="terminal-welcome"><span class="terminal-welcome-title">WELCOME TO SHELLLAB</span><span>真实环境，自由探索。</span></div>
            <div class="terminal-area"><div id="terminal"></div><div class="terminal-overlay" id="terminal-overlay" hidden></div></div>
            <div class="terminal-footer"><span class="connection"><i id="connection-dot"></i><span id="connection-label">准备连接</span></span><span id="terminal-dimensions"></span><span class="terminal-key-hint"><kbd>Tab</kbd> 补全 <span>·</span> <kbd>↑</kbd> 历史 <span>·</span> <kbd>Ctrl C</kbd> 中断</span></div>
          </section>
        </div>
        <div class="workspace-footer"><span>${icon('code')} 从输入到结果，每一步都真实发生。</span><span>小步练习，持续积累 <span class="footer-star">✳</span></span></div>
      </main>
    </div>
    <dialog id="dialog" aria-labelledby="dialog-title"><div id="dialog-content"></div></dialog>
    <div class="toast" id="toast" role="status" hidden></div>`;
  terminal.open($('#terminal'));
  new ResizeObserver(() => {
    fitAddon.fit();
    $('#terminal-dimensions').textContent = `${terminal.cols} × ${terminal.rows}`;
  }).observe($('#terminal'));
  $('#menu').addEventListener('click', () => $('#sidebar').classList.toggle('is-open'));
  $('#reference').addEventListener('click', showReference);
  $('#guide').addEventListener('click', showGuide);
  document.querySelectorAll('[data-open-generator]').forEach((button) => button.addEventListener('click', showGenerator));
  $('#hint').addEventListener('click', () => { hintVisible = !hintVisible; renderLesson(); });
  $('#check').addEventListener('click', () => void check());
  $('#clear').addEventListener('click', () => { terminal.clear(); terminal.focus(); });
  $('#reset').addEventListener('click', () => {
    if (busy || checking) return;
    if (!session || !selected) { showGenerator(); return; }
    confirmAction('重新开始这道练习？', '当前练习中的文件、变量和命令历史会被清空，已完成的学习进度会保留。', '重置环境', () => void createSession());
  });
  $('#dialog').addEventListener('click', (event) => { if (event.target === $('#dialog')) closeDialog(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === '?' && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement) && !$('#dialog').hasAttribute('open')) showReference();
  });
}

function renderSidebar() {
  $('#active-challenge').innerHTML = selected?.generated ? `<div class="active-challenge"><span>当前实战 · ${selected.generated.source === 'ai' ? 'AI 场景规划' : '本地动态出题'}</span><strong>${escape(selected.title)}</strong><small>${selected.generated.verified ? '已通过真实环境试做验证' : '等待验证'}</small></div>` : '';
  $('#scenarios').innerHTML = generator.topics.map((topic) => `<button class="scenario-link ${selected?.generated?.topics.includes(topic.id) ? 'active' : ''}" data-topic="${topic.id}" title="${escape(topic.available ? topic.description : topic.unavailableReason ?? '环境未就绪')}" ${topic.available ? '' : 'disabled'}>${icon('chevron')}<span>${escape(topic.name)}</span></button>`).join('');
  document.querySelectorAll<HTMLButtonElement>('[data-topic]').forEach((button) => button.addEventListener('click', () => {
    if (busy || checking) return;
    generationPreferences = { ...generationPreferences, topics: [button.dataset.topic!], difficulty: 'basic' };
    showGenerator();
  }));
  const challenges = [...completed].filter((id) => id.startsWith('generated-')).length;
  $('#progress-number').textContent = `${challenges} 题`;
  $('#challenge-progress').textContent = challenges ? `实战累计完成 ${challenges} 题，继续挑战。` : '选择场景，开始你的第一道实战。';
}

function renderLesson() {
  if (!selected) {
    $('#chapter-name').textContent = '选择练习场景';
    $('#lesson-content').innerHTML = `<div class="lesson-meta"><span class="lesson-label">动态开发实战</span></div><h2>从一个开发场景开始</h2><p class="lesson-subtitle">选择你想练习的工作任务，让系统生成新题。</p><div class="lesson-divider"></div><h3>按你的需要练习</h3><p class="lesson-description">日志排查、配置修改、Git、SSH/SCP、HTTP 接口、进程管理……选择一个专项，或组合多个场景挑战自己。</p><ol class="objectives"><li class="objective"><span class="objective-marker">1</span><span>点击左侧“生成开发实战”，或选择一个具体场景。</span></li><li class="objective"><span class="objective-marker">2</span><span>选择难度，生成已在真实环境中验证过的题目。</span></li><li class="objective"><span class="objective-marker">3</span><span>在 Bash 终端中操作，检查结果后继续生成新题。</span></li></ol><div class="takeaway">${icon('bulb')}<p>支持专项和组合实战，随时查看提示和命令速查。</p></div>`;
    updateButtons();
    return;
  }
  const lesson = selected;
  $('#chapter-name').textContent = lesson.chapter;
  $('#lesson-content').innerHTML = `
    <div class="lesson-meta"><span class="lesson-label">动态实战</span><span class="duration">${icon('clock')} 约 ${lesson.minutes} 分钟</span></div>
    <h2>${escape(lesson.title)}</h2><p class="lesson-subtitle">${escape(lesson.subtitle)}</p>
    <div class="concepts">${lesson.concepts.map((concept) => `<code>${escape(concept)}</code>`).join('')}</div>
    ${lesson.generated ? `<div class="generation-label">${icon('check')} 已在真实环境中试做通过 <button id="change-challenge">换一道题 ${icon('reset')}</button></div>` : ''}
    <div class="lesson-divider"></div>
    <h3>这次的任务</h3><p class="lesson-description">${escape(lesson.description)}</p>
    <ol class="objectives">${lesson.objectives.map((objective, i) => {
      const state = result?.results.find((item) => item.id === objective.id);
      return `<li class="objective ${state ? state.passed ? 'passed' : 'failed' : ''}"><span class="objective-marker">${state?.passed ? icon('check') : i + 1}</span><span>${escape(objective.text)}${state && !state.passed ? '<small>尚未达到目标，再检查一下。</small>' : ''}</span></li>`;
    }).join('')}</ol>
    <div class="takeaway">${icon('bulb')}<p>${escape(lesson.takeaway)}</p></div>
    ${hintVisible ? `<div class="hint-content"><h3>试试这个思路</h3><p>${escape(lesson.hint)}</p><div class="code-heading"><span>参考写法</span><button class="icon-button" id="copy-example" aria-label="复制参考命令">${icon('copy')}</button></div><pre><code>${escape(lesson.example)}</code></pre></div>` : ''}
    ${result ? `<div class="result-message ${result.passed ? 'success' : ''}" role="status">${result.passed ? `${icon('check')}<div><strong>做得好，练习完成！</strong><p>所有目标都已通过检查。</p></div>` : `<div><strong>已经完成 ${result.results.filter((item) => item.passed).length} / ${result.results.length} 个目标</strong><p>查看上面的反馈，调整后可以再次检查。</p></div>`}</div>` : ''}
    ${result?.passed && lesson.generated ? `<button class="next-button" id="another">再生成一道开发实战 ${icon('spark')}</button>` : ''}
    `;
  $('#hint').classList.toggle('selected', hintVisible);
  $('#hint span').textContent = hintVisible ? '收起提示' : '给我一点提示';
  document.querySelector('#copy-example')?.addEventListener('click', () => void copy(lesson.example));
  document.querySelector('#change-challenge')?.addEventListener('click', showGenerator);
  document.querySelector('#another')?.addEventListener('click', showGenerator);
  updateButtons();
}

function updateButtons() {
  const checkButton = $<HTMLButtonElement>('#check');
  checkButton.disabled = busy || checking || !connected || !selected;
  checkButton.innerHTML = checking ? '<span class="spinner"></span> 检查中…' : `检查结果 ${icon('arrow')}`;
  $<HTMLButtonElement>('#reset').disabled = busy || checking || !selected;
  $<HTMLButtonElement>('#hint').disabled = busy || !selected;
  document.querySelectorAll<HTMLButtonElement>('[data-open-generator], [data-topic], #change-challenge, #another').forEach((button) => { button.disabled = busy || checking || Boolean(button.dataset.topic && !generator.topics.find((topic) => topic.id === button.dataset.topic)?.available); });
}

function connectionState(state: 'ready' | 'busy' | 'error', text: string) {
  $('#connection-dot').className = state;
  $('#connection-label').textContent = text;
}

function overlay(title: string, message: string, action: boolean | 'generate' = false) {
  const target = $('#terminal-overlay');
  target.hidden = false;
  target.innerHTML = `<div class="overlay-symbol">${icon(action ? 'terminal' : 'reset', action ? '' : 'spin')}</div><h3>${escape(title)}</h3><p>${escape(message)}</p>${action === 'generate' ? '<button class="primary-button" id="choose-scenario">选择开发场景</button>' : action ? '<button class="primary-button" id="retry">重新连接</button>' : '<span class="overlay-note">马上就好，请稍候。</span>'}`;
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
      renderSidebar();
    }
    renderLesson();
  } catch (error) { toast(errorMessage(error)); }
  finally { checking = false; updateButtons(); }
}

function renderEnvironment() {
  $('#environment-label').textContent = health.mode === 'local' ? '本机开发环境 · 未隔离' : '独立 Linux 练习环境';
  $('#environment-caption').textContent = health.mode === 'local' ? '命令可访问本机文件，请谨慎操作' : 'Ubuntu 24.04 / Bash / UTF-8';
  $('.environment-card').classList.toggle('local', health.mode === 'local');
}

function showGenerator() {
  if (busy || checking) return;
  if (!generator.aiConfigured && generationPreferences.source === 'ai') generationPreferences.source = 'rules';
  const preferences = generationPreferences;
  showDialog(`<div class="dialog-eyebrow">BACKEND DEVELOPMENT LAB</div><h2 id="dialog-title">生成你的开发实战</h2><p>选择出题范围与难度。每道新题都会创建数据，并在独立工作区完成参考解和判题验证。</p>
    <form id="generator-form">
      <div class="generation-fields"><label>练习难度<select name="difficulty"><option value="basic" ${preferences.difficulty === 'basic' ? 'selected' : ''}>基础专项 · 1 个场景</option><option value="intermediate" ${preferences.difficulty === 'intermediate' ? 'selected' : ''}>组合实战 · 最多 2 个场景</option><option value="advanced" ${preferences.difficulty === 'advanced' ? 'selected' : ''}>综合挑战 · 最多 3 个场景</option></select></label>
      <label>出题方式<select name="source" id="generation-source"><option value="rules" ${preferences.source === 'rules' ? 'selected' : ''}>本地动态出题 · 无需模型</option><option value="ai" ${!generator.aiConfigured ? 'disabled' : ''} ${preferences.source === 'ai' && generator.aiConfigured ? 'selected' : ''}>AI 场景规划${generator.aiConfigured ? '' : ' · 尚未配置'}</option></select></label></div>
      <div class="generation-scope"><strong>想练哪些场景？</strong><span>可多选；不选则随机组合全部可用场景。</span></div>
      <div class="topic-grid">${generator.topics.map((topic) => `<label class="topic-option ${topic.available ? '' : 'unavailable'}"><input type="checkbox" name="topic" value="${topic.id}" ${preferences.topics.includes(topic.id) ? 'checked' : ''} ${topic.available ? '' : 'disabled'}><span><strong>${escape(topic.name)}</strong><small>${escape(topic.available ? topic.description : topic.unavailableReason ?? '环境尚未就绪')}</small></span></label>`).join('')}</div>
      <label class="generation-focus" id="generation-focus" ${preferences.source !== 'ai' ? 'hidden' : ''}>希望练习的工作情境<textarea name="focus" maxlength="500" placeholder="例如：上线后接口变慢，想练日志排查和配置回滚。">${escape(preferences.focus ?? '')}</textarea><small>偏好影响场景选择与背景，具体目标由已验证的生成器给出。</small></label>
      ${!generator.aiConfigured ? '<p class="generation-note">本地模式会随机生成数据、筛选条件和任务组合。接入模型后可启用 AI 场景规划，配置方法见 README。</p>' : ''}
      <p class="generation-note">生成成功后会替换当前环境；生成失败保留当前练习。重置恢复同一道题，“换一道题”才会重新出题。</p>
      <div class="dialog-actions"><button type="button" class="secondary-button" id="cancel-generation">返回练习</button><button type="submit" class="primary-button" ${generator.topics.some((topic) => topic.available) ? '' : 'disabled'}>${icon('spark')} 生成并开始</button></div>
    </form>`);
  $('#cancel-generation').addEventListener('click', closeDialog);
  $('#generation-source').addEventListener('change', () => { $('#generation-focus').hidden = $<HTMLSelectElement>('#generation-source').value !== 'ai'; });
  $('#generator-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData($<HTMLFormElement>('#generator-form'));
    generationPreferences = { topics: form.getAll('topic') as string[], difficulty: form.get('difficulty') as Difficulty, source: form.get('source') as GenerationOptions['source'], focus: form.get('focus') as string };
    closeDialog();
    void generateSession(generationPreferences);
  });
}

async function generateSession(options: GenerationOptions) {
  if (busy || checking) return;
  busy = true; updateButtons();
  $('#sidebar').classList.remove('is-open');
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

function showDialog(content: string) {
  $('#dialog-content').innerHTML = `<button class="icon-button dialog-close" id="dialog-close" aria-label="关闭弹窗">${icon('close')}</button>${content}`;
  if (!$<HTMLDialogElement>('#dialog').open) $<HTMLDialogElement>('#dialog').showModal();
  $('#dialog-close').addEventListener('click', closeDialog);
}
function closeDialog() { $<HTMLDialogElement>('#dialog').close(); }
function confirmAction(title: string, description: string, label: string, action: () => void) {
  showDialog(`<div class="dialog-eyebrow">工作区</div><h2 id="dialog-title">${escape(title)}</h2><p>${escape(description)}</p><div class="dialog-actions"><button class="secondary-button" id="cancel">继续当前练习</button><button class="primary-button" id="confirm">${escape(label)}</button></div>`);
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
  showDialog(`<div class="dialog-eyebrow">QUICK REFERENCE</div><h2 id="dialog-title">手边的命令速查</h2><p>记不住很正常。查一查，再动手试一试。</p><div class="reference-list">${commands.map(([command, text]) => `<div><code>${escape(command)}</code><span>${escape(text)}</span></div>`).join('')}</div><p class="dialog-footnote">快捷键：Tab 补全 · ↑ / ↓ 历史命令 · Ctrl+C 中断 · Ctrl+D 结束输入</p>`);
}
function showGuide() {
  showDialog(`<div class="dialog-eyebrow">GETTING STARTED</div><h2 id="dialog-title">从第一条命令开始</h2><ol class="guide-steps"><li><strong>选择开发场景</strong><p>点击“生成开发实战”，选择场景与难度。新题验证通过后，右侧终端会连接真实 Bash。</p></li><li><strong>输入，再按 Enter</strong><p>文件、当前目录和变量会在会话中保留。终端报错也是真实的 Linux 反馈。</p></li><li><strong>检查实际结果</strong><p>点击“检查结果”查看每个目标的状态。没有唯一写法，结果正确就能通过。脚本题会运行你的脚本来检查行为。</p></li><li><strong>卡住时，试试提示</strong><p>提示里有思路和可复制的参考写法。“重置环境”可以恢复初始文件，“换一道题”会生成新的任务和环境。</p></li></ol><p class="dialog-footnote">连续 30 分钟没有操作，环境会被回收。完成进度仅保存在当前浏览器。</p>`);
}
let toastTimer: ReturnType<typeof setTimeout>;
function toast(message: string) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4000);
}
async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); toast('已复制，可以粘贴到终端中运行。'); }
  catch { toast('浏览器无法访问剪贴板，请选中文本手动复制。'); }
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
    $('#app').innerHTML = `<main class="startup-error"><span class="brand-symbol">${icon('terminal')}</span><h1>ShellLab 服务尚未启动</h1><p>请在项目目录运行 <code>npm run dev</code>，然后重新加载页面。</p><button class="primary-button" id="reload">重新加载</button></main>`;
    $('#reload').addEventListener('click', () => location.reload());
  }
}
void init();
