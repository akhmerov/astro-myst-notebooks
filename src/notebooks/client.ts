import { renderPlots } from './plots.js';
import { renderDiagrams } from './diagrams.js';

const render = () => { renderPlots(); void renderDiagrams(); };
render();
document.addEventListener('astro:page-load', render);
