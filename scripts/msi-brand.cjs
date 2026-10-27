// Adds (or removes) the MSI picture settings in package.json for ONE build, using full file paths.
// WiX's linker runs from a temporary folder, so relative paths like build/x.bmp are not found.
const fs = require('fs');
const path = require('path');
const on = process.argv[2] === 'on';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.build = pkg.build || {};
pkg.build.msi = pkg.build.msi || {};
if (on) {
  pkg.build.msi.additionalLightArgs = [
    '-dWixUIBannerBmp=' + path.resolve('build', 'msi-banner.bmp'),
    '-dWixUIDialogBmp=' + path.resolve('build', 'msi-dialog.bmp'),
  ];
} else {
  delete pkg.build.msi.additionalLightArgs;
}
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log('MSI branding ' + (on ? 'on' : 'off'));
