// Jupyter tracebacks carry SGR colour codes. Render them as classed spans, and
// drop any other escape sequence rather than leaking control characters.
const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
const pattern = /\x1b\[([\d;]*)m|\x1b\[[\d;?]*[A-Za-z]|\x1b[()][A-Za-z0-9]/g;

function apply(style, codes) {
  const next = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 0) return {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 22) { delete next.bold; delete next.dim; }
    else if (code === 23) delete next.italic;
    else if (code === 24) delete next.underline;
    else if (code >= 30 && code <= 37) next.fg = names[code - 30];
    else if (code >= 90 && code <= 97) next.fg = `bright-${names[code - 90]}`;
    else if (code >= 40 && code <= 47) next.bg = names[code - 40];
    else if (code >= 100 && code <= 107) next.bg = `bright-${names[code - 100]}`;
    else if (code === 39) delete next.fg;
    else if (code === 49) delete next.bg;
    else if (code === 38 || code === 48) {
      const key = code === 38 ? 'fg' : 'bg';
      if (codes[i + 1] === 5 && codes[i + 2] !== undefined) { next[key] = palette(codes[i + 2]); i += 2; }
      else if (codes[i + 1] === 2 && codes[i + 4] !== undefined) { next[key] = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; }
      else break; // Malformed extended colour: ignore the remainder of this sequence.
    }
  }
  return next;
}

/** xterm 256-colour index to a CSS colour, so tracebacks look the same everywhere. */
function palette(index) {
  if (index < 8) return names[index];
  if (index < 16) return `bright-${names[index - 8]}`;
  if (index < 232) {
    const level = value => value ? 55 + value * 40 : 0;
    const cube = index - 16;
    return `rgb(${level(Math.floor(cube / 36))},${level(Math.floor(cube / 6) % 6)},${level(cube % 6)})`;
  }
  const grey = 8 + (index - 232) * 10;
  return `rgb(${grey},${grey},${grey})`;
}

/** @returns {import('hast').ElementContent[]} */
export function ansiToHast(text) {
  const children = [];
  let style = {};
  let last = 0;
  const push = (value) => {
    if (!value) return;
    const classes = [];
    const styles = [];
    for (const flag of ['bold', 'dim', 'italic', 'underline']) if (style[flag]) classes.push(`ansi-${flag}`);
    for (const layer of ['fg', 'bg']) {
      if (!style[layer]) continue;
      if (style[layer].startsWith('rgb(')) styles.push(`${layer === 'fg' ? 'color' : 'background-color'}:${style[layer]}`);
      else classes.push(`ansi-${style[layer]}-${layer}`);
    }
    const node = { type: 'text', value };
    if (!classes.length && !styles.length) children.push(node);
    else children.push({ type: 'element', tagName: 'span', properties: {
      className: classes.length ? classes : undefined, style: styles.length ? styles.join(';') : undefined,
    }, children: [node] });
  };
  for (const match of text.matchAll(pattern)) {
    push(text.slice(last, match.index));
    last = match.index + match[0].length;
    if (match[1] !== undefined) style = apply(style, match[1] ? match[1].split(';').map(Number) : [0]);
  }
  push(text.slice(last));
  return children;
}
