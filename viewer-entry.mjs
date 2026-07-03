// Entry point for the browser bundle: mermaid + ELK layout engine, exposed as
// window.mermaid. Built by index.mjs via esbuild into dist/mermaid-elk.min.js.
import mermaid from 'mermaid';
import elkLayouts from '@mermaid-js/layout-elk';

mermaid.registerLayoutLoaders(elkLayouts);
window.mermaid = mermaid;
