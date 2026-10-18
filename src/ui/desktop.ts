export interface DesktopBridge {
  platform: string;
  windowAction(action: 'minimize' | 'maximize' | 'close'): void;
  copyText(text: string): Promise<void>;
}

declare global {
  interface Window { shellLabDesktop?: DesktopBridge }
}

export async function writeClipboard(text: string): Promise<void> {
  const bridge = window.shellLabDesktop;
  if (bridge) {
    await bridge.copyText(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}

export function bindDesktopControls(): void {
  const bridge = window.shellLabDesktop;
  if (!bridge) return;
  document.documentElement.dataset.desktop = bridge.platform;
  // macOS uses native traffic lights in the title bar.
  const controls = document.querySelector<HTMLElement>('#window-controls')!;
  controls.hidden = bridge.platform === 'darwin';
  controls.querySelectorAll<HTMLButtonElement>('[data-window-action]').forEach((button) => {
    button.addEventListener('click', () => bridge.windowAction(button.dataset.windowAction as Parameters<DesktopBridge['windowAction']>[0]));
  });
  document.querySelector('.titlebar')?.addEventListener('dblclick', (event) => {
    if (!(event.target as HTMLElement).closest('button, a')) bridge.windowAction('maximize');
  });
}
