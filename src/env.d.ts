interface ImportMeta { readonly env: { readonly BASE_URL: string }; }
declare module 'virtual:notebook-options' {
  const options: import('./notebooks/types').BrowserOptions;
  export default options;
}

declare module '*.css';
