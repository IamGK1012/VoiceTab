const root = document.documentElement;
const toggle = document.getElementById('theme-toggle');
const saved = localStorage.getItem('voicetab-theme');
if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;

function isDark() {
  return root.dataset.theme === 'dark';
}

function syncThemeButton() {
  toggle?.setAttribute('aria-pressed', String(isDark()));
}

toggle?.addEventListener('click', () => {
  root.dataset.theme = isDark() ? 'light' : 'dark';
  localStorage.setItem('voicetab-theme', root.dataset.theme);
  syncThemeButton();
});
syncThemeButton();
