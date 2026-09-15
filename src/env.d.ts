/// <reference types="astro/client" />
declare module 'virtual:notebook-options' {
  const options: import('./notebooks/types').BrowserOptions;
  export default options;
}
