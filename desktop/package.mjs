#!/usr/bin/env node
import { cp, mkdir, readdir, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = Object.fromEntries(process.argv.slice(2).filter((arg) => arg.startsWith('--')).map((arg) => {
  const [key, ...value] = arg.slice(2).split('=');
  return [key, value.join('=')];
}));
const platform = options.platform || process.platform;
const arch = options.arch || process.arch;
const nodeBinary = resolve(options.node || process.execPath);
const output = resolve(options.out || join(projectRoot, 'dist-desktop', platform === 'darwin' ? 'Rotation.app' : 'Rotation'));
if (!['linux', 'win32', 'darwin'].includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported architecture: ${arch}`);
const required = [
  'desktop/launcher.mjs',
  'desktop/runtime.mjs',
  'server/dist/index.js',
  'server/node_modules/fastify/package.json',
  'server/package.json',
  'web/dist/index.html',
];
for (const path of required) {
  const fullPath = join(projectRoot, path);
  if (!(await stat(fullPath).catch(() => null))) throw new Error(`Missing ${path}; build the app and install production server dependencies first.`);
}
if (await stat(join(projectRoot, 'server/node_modules/typescript')).catch(() => null)) {
  throw new Error('server/node_modules still contains development dependencies; run npm --prefix server prune --omit=dev before packaging.');
}
if (!(await stat(nodeBinary).catch(() => null))) throw new Error(`Node binary not found: ${nodeBinary}`);
const nodeVersion = execFileSync(nodeBinary, ['--version'], { encoding: 'utf8' }).trim().replace(/^v/, '');
if (Number(nodeVersion.split('.')[0]) < 24) throw new Error(`Node 24 or later is required; got ${nodeVersion}`);
if (platform === process.platform && arch !== process.arch) throw new Error('The Node binary architecture must match the packaging runner.');

await rm(output, { recursive: true, force: true });
const appRoot = platform === 'darwin' ? join(output, 'Contents', 'Resources', 'Rotation') : output;
await mkdir(join(appRoot, 'runtime'), { recursive: true });
await mkdir(join(appRoot, 'desktop'), { recursive: true });
await mkdir(join(appRoot, 'server'), { recursive: true });
await mkdir(join(appRoot, 'web'), { recursive: true });
await cp(join(projectRoot, 'desktop/launcher.mjs'), join(appRoot, 'desktop/launcher.mjs'));
await cp(join(projectRoot, 'desktop/runtime.mjs'), join(appRoot, 'desktop/runtime.mjs'));
await cp(join(projectRoot, 'server/dist'), join(appRoot, 'server/dist'), { recursive: true });
await cp(join(projectRoot, 'server/package.json'), join(appRoot, 'server/package.json'));
await cp(join(projectRoot, 'server/node_modules'), join(appRoot, 'server/node_modules'), {
  recursive: true,
  filter: (source) => !source.split(sep).includes('.bin'),
});
await cp(join(projectRoot, 'web/dist'), join(appRoot, 'web/dist'), { recursive: true });
const runtimeName = platform === 'win32' ? 'node.exe' : 'node';
await cp(nodeBinary, join(appRoot, 'runtime', runtimeName));
if (platform !== 'win32') await chmod(join(appRoot, 'runtime/node'), 0o755);
const quickStart = `rotation desktop — ${platform} ${arch}\n\nSpotify setup is local. On first launch, enter your Spotify Developer app Client ID and Client Secret in the browser setup page. Register http://127.0.0.1:3000/auth/callback exactly in the Spotify Developer Dashboard. Your credentials and session are saved in your user profile, outside this app folder.\n\nLaunch: ${platform === 'darwin' ? 'open Rotation.app' : platform === 'win32' ? 'double-click Launch Rotation.vbs (or Launch Rotation.cmd)' : './Launch Rotation.sh (or run ./Install Desktop Shortcut.sh once)'}\nQuit: use the Quit rotation button in the browser. You can reopen http://127.0.0.1:3000 while it is running. Closing the browser tab does not stop the local server.\n\nSee https://github.com/aok8/rotation for full documentation.\n`;
if (platform === 'darwin') {
  await mkdir(join(output, 'Contents', 'MacOS'), { recursive: true });
  const macLauncher = `#!/bin/sh\nset -eu\nROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../Resources/Rotation" && pwd)"\nexec "$ROOT/runtime/node" "$ROOT/desktop/launcher.mjs" --app-root "$ROOT" "$@"\n`;
  await writeFile(join(output, 'Contents', 'MacOS', 'Rotation'), macLauncher, { mode: 0o755 });
  await writeFile(join(output, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleName</key><string>rotation</string><key>CFBundleDisplayName</key><string>rotation</string><key>CFBundleIdentifier</key><string>app.rotation.desktop</string><key>CFBundleVersion</key><string>0.1.0</string><key>CFBundleShortVersionString</key><string>0.1.0</string><key>CFBundleExecutable</key><string>Rotation</string><key>CFBundlePackageType</key><string>APPL</string><key>LSMinimumSystemVersion</key><string>12.0</string><key>LSUIElement</key><true/></dict></plist>\n`);
  await writeFile(join(output, 'Contents', 'Resources', 'README.txt'), quickStart);
} else if (platform === 'win32') {
  await writeFile(join(output, 'Launch Rotation.cmd'), '@echo off\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" "%~dp0desktop\\launcher.mjs" %*\r\n');
  await writeFile(join(output, 'Launch Rotation.vbs'), 'Set shell = CreateObject("WScript.Shell")\r\nSet files = CreateObject("Scripting.FileSystemObject")\r\nroot = files.GetParentFolderName(WScript.ScriptFullName)\r\nshell.Run Chr(34) & root & "\\runtime\\node.exe" & Chr(34) & " " & Chr(34) & root & "\\desktop\\launcher.mjs" & Chr(34), 0, False\r\n');
  await writeFile(join(output, 'README.txt'), quickStart);
} else {
  await writeFile(join(output, 'Launch Rotation.sh'), '#!/bin/sh\nset -eu\nROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$ROOT/runtime/node" "$ROOT/desktop/launcher.mjs" --app-root "$ROOT" "$@"\n', { mode: 0o755 });
  await writeFile(join(output, 'Install Desktop Shortcut.sh'), '#!/bin/sh\nset -eu\nROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nTARGET="$HOME/.local/share/applications/rotation.desktop"\nmkdir -p "$(dirname "$TARGET")"\nprintf "[Desktop Entry]\\nType=Application\\nName=rotation\\nComment=Listen and curate your Spotify playlist\\nExec=\\\"%s/Launch Rotation.sh\\\"\\nTerminal=false\\nCategories=Audio;Music;\\n" "$ROOT" > "$TARGET"\nchmod 644 "$TARGET"\nprintf "Installed %s\\n" "$TARGET"\n', { mode: 0o755 });
  await writeFile(join(output, 'README.txt'), quickStart);
}

const forbidden = new Set(['.env', 'session.enc', 'rotation.sqlite', 'rotation.sqlite3', 'config.json', 'settings.json']);
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (forbidden.has(entry.name) || entry.name.endsWith('.log')) throw new Error(`Refusing to package private file: ${entry.name}`);
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing to package symlink: ${path}`);
    if (entry.isDirectory()) await inspect(path);
  }
}
await inspect(output);
const manifest = {
  app: 'rotation', platform, arch, nodeVersion,
  files: ['desktop/launcher.mjs', 'desktop/runtime.mjs', 'server/dist', 'server/node_modules', 'server/package.json', 'web/dist', `runtime/${runtimeName}`],
};
await writeFile(join(appRoot, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Staged ${platform}/${arch} package at ${output}`);
