// Removes OLD rules marked "belongs in components/shared" from the other CSS files,
// but only the ones the new shared.css now covers. Run from the project root:
//   node strip-shared-overrides.cjs          (dry run: lists what it would remove)
//   node strip-shared-overrides.cjs --write  (applies it; commit or back up first)
const fs = require('fs'), path = require('path');
const root = path.join('src', 'css');
const covered = new Set(`.btn .icon .cbtn .tag .tag.ghost .kstat .note .note.err .note.good .nudge .nudge_button
.nudge_button:hover .nudge_button.on .seg-m .seg-m_button .seg-m_button.on .dp-chips .dp-seg .dp-chips_button
.dp-seg_button .dp-chips_button:hover .dp-seg_button:hover .sw .search .scrim .dialog .dlg-head .err-t .opt
.opt_small .inline .empty .empty_h2 .empty_p .msec .bar .bar_>_i`.split(/\s+/));
const norm = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/\s*>\s*/g, '_>_').replace(/\s+/g, '_');
const write = process.argv.includes('--write');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.css') ? [path.join(d, e.name)] : []);
let total = 0;
for (const f of walk(root)) {
  if (f.endsWith('unused.css') || f.endsWith(path.join('components', 'shared.css'))) continue;
  let css = fs.readFileSync(f, 'utf8'), out = '', i = 0, n = 0;
  const re = /\/\*\s*belongs in components\/shared[^*]*\*\/\s*/g;
  let m;
  while ((m = re.exec(css))) {
    const open = css.indexOf('{', re.lastIndex);
    if (open < 0) break;
    const sels = css.slice(re.lastIndex, open).split(',').map(norm);
    if (!sels.every((s) => covered.has(s))) continue;
    let depth = 1, j = open + 1;
    while (j < css.length && depth) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
    out += css.slice(i, m.index); i = j; re.lastIndex = j; n++;
  }
  out += css.slice(i);
  if (n) { console.log(`${f}: ${n} rule(s)`); total += n; if (write) fs.writeFileSync(f, out.replace(/\n{3,}/g, '\n\n')); }
}
console.log(`${total} rule(s) ${write ? 'removed' : 'would be removed (dry run, add --write to apply)'}`);
