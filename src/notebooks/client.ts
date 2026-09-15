import { renderPlots } from './plots.js';

renderPlots();
document.addEventListener('astro:page-load', () => renderPlots());
