/** Accessible tab sets; tabs sharing a sync key switch together across the page. */
let mounted = false;

function select(tab: HTMLElement, propagate = true) {
  const set = tab.closest<HTMLElement>('[data-tab-set]')!;
  for (const other of set.querySelectorAll<HTMLElement>(':scope > [role="tablist"] > [role="tab"]')) {
    const active = other === tab;
    other.setAttribute('aria-selected', String(active));
    other.tabIndex = active ? 0 : -1;
    const panel = document.getElementById(other.getAttribute('aria-controls') ?? '');
    if (panel) panel.hidden = !active;
  }
  const sync = tab.dataset.sync;
  if (!propagate || !sync) return;
  for (const other of document.querySelectorAll<HTMLElement>(`[data-tab-set] [role="tab"][data-sync="${CSS.escape(sync)}"]`)) {
    if (other.closest('[data-tab-set]') !== set) select(other, false);
  }
}

export function mountTabs() {
  if (mounted) return;
  mounted = true;
  document.addEventListener('click', event => {
    const tab = (event.target as Element).closest<HTMLElement>('[data-tab-set] > [role="tablist"] > [role="tab"]');
    if (tab) select(tab);
  });
  document.addEventListener('keydown', event => {
    const tab = (event.target as Element).closest<HTMLElement>('[data-tab-set] > [role="tablist"] > [role="tab"]');
    if (!tab) return;
    const tabs = [...tab.parentElement!.querySelectorAll<HTMLElement>(':scope > [role="tab"]')];
    const current = tabs.indexOf(tab);
    const next = event.key === 'ArrowRight' ? (current + 1) % tabs.length : event.key === 'ArrowLeft' ? (current + tabs.length - 1) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    tabs[next]!.focus();
    select(tabs[next]!);
  });
}
