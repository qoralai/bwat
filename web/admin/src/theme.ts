/**
 * The board's Appearance choice (web/pages/board/ui/theme.js), read from the same key on
 * this origin: Light or Dark sets the same data-theme the board sets. Device stores
 * nothing, and the stylesheet follows the device's own setting.
 */
export function followBoardTheme() {
  let choice: string | null = null;
  try {
    choice = localStorage.getItem('bwat.theme');
  } catch {
    // Storage blocked: follow the device.
  }
  if (choice === 'light' || choice === 'dark') document.documentElement.dataset.theme = choice;
}
