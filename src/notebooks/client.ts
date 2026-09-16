import { renderPlots } from './plots.js';
import { renderDiagrams } from './diagrams.js';
import { mountTabs } from './tabs.js';

const render = () => { renderPlots(); void renderDiagrams(); };
mountTabs();
render();
document.addEventListener('astro:page-load', render);
