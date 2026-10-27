// Writes installer/BuildInfo.cs for the dark installer window (version, download address, sizes for the progress bar).
const fs = require('fs');
const path = require('path');
const [version, repo] = [process.env.VERSION, process.env.REPO];
if (!version || !repo) { console.error('VERSION and REPO are needed'); process.exit(1); }
const dirSize = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? dirSize(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
const setup = fs.statSync(path.join('release', `Cinema-Setup-${version}.exe`)).size;
const unpacked = dirSize(path.join('release', 'win-unpacked'));
const base = `https://github.com/${repo}/releases`;
fs.writeFileSync(path.join('installer', 'BuildInfo.cs'), `static class BuildInfo
{
    public const string Version = "${version}";
    public const string Url = "${base}/download/v${version}/Cinema-Setup-${version}.exe";
    public const string Page = "${base}/tag/v${version}";
    public const long InstallerBytes = ${setup}L;
    public const long UnpackedBytes = ${unpacked}L;
}
`);
console.log('BuildInfo written', { version, setup, unpacked });
