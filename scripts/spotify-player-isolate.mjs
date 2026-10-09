#!/usr/bin/env node
// One explicit Player call per run. No transfers, retries or polls are added.
import { createDecipheriv, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readConfig, userPaths } from '../desktop/runtime.mjs';

const trackUri = /^spotify:track:[A-Za-z0-9]+$/;
const commands = ['devices', 'state', 'play-one', 'play-window', 'transfer-paused', 'transfer-play', 'shuffle-off', 'repeat-off', 'next'];

export function decryptProfile(ciphertext, secret) {
  const buffer = Buffer.from(ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), buffer.subarray(0, 12));
  decipher.setAuthTag(buffer.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString());
}

export function prepareCall(command, device, rotation) {
  if (!commands.includes(command)) throw new Error('Choose one command from --help.');
  if (device !== undefined && (typeof device !== 'string' || !device || device === 'active' || device.length > 256 || /[\u0000-\u001f\u007f]/.test(device)))
    throw new Error('Choose a concrete device ID from the devices result.');
  if (command === 'devices') return { method: 'GET', path: '/me/player/devices' };
  if (command === 'state') return { method: 'GET', path: '/me/player' };
  if (!device) throw new Error('Specify --device-id from the devices result.');
  const query = `device_id=${encodeURIComponent(device)}`;
  if (command.startsWith('play-')) {
    const byKey = new Map((rotation?.items || []).map(item => [item.key, item]));
    const uris = rotation?.order?.slice(rotation.currentIndex, rotation.currentIndex + (command === 'play-one' ? 1 : 20)).map(key => byKey.get(key)?.uri);
    if (!uris?.length || uris.some(uri => typeof uri !== 'string' || !trackUri.test(uri)))
      throw new Error('Start a Rotation session and quit the app before this test.');
    return { method: 'PUT', path: `/me/player/play?${query}`, body: { uris } };
  }
  if (command.startsWith('transfer-')) return { method: 'PUT', path: '/me/player', body: { device_ids: [device], play: command === 'transfer-play' } };
  if (command === 'next') return { method: 'POST', path: `/me/player/next?${query}` };
  if (command === 'shuffle-off') return { method: 'PUT', path: `/me/player/shuffle?state=false&${query}` };
  return { method: 'PUT', path: `/me/player/repeat?state=off&${query}` };
}

export function safeResponse(body, command, device) {
  if (body?.error) {
    const error = typeof body.error === 'object' ? body.error : {};
    const reasons = ['NO_ACTIVE_DEVICE', 'DEVICE_NOT_FOUND', 'PLAYER_COMMAND_FAILED', 'RESTRICTED_DEVICE', 'PREMIUM_REQUIRED', 'UNKNOWN'];
    const descriptions = [
      [/no active device/i, 'No active device'],
      [/device.*not found/i, 'Device not found'],
      [/player command failed/i, 'Player command failed'],
      [/premium/i, 'Premium required'],
      [/rate limit/i, 'Rate limited'],
      [/permission|scope/i, 'Permission missing'],
    ];
    return { error: {
      ...(Number.isInteger(error.status) ? { status: error.status } : {}),
      ...(reasons.includes(error.reason) ? { reason: error.reason } : {}),
      message: descriptions.find(([pattern]) => pattern.test(String(error.message || '')))?.[1] || 'Spotify rejected this request; full response omitted',
    } };
  }
  if (command === 'devices') return { devices: (body?.devices || []).map(entry => ({
    id: typeof entry.id === 'string' ? entry.id : null,
    name: String(entry.name || 'Spotify device'), type: String(entry.type || 'Unknown'),
    isActive: entry.is_active === true, isRestricted: entry.is_restricted === true,
  })), note: 'Device names and IDs are for local selection. Share only sanitized command results.' };
  if (command === 'state') return body ? {
    hasPlayback: true, isPlaying: body.is_playing === true,
    selectedDeviceActive: device ? body.device?.id === device && body.device?.is_active === true : null,
    shuffleOn: typeof body.shuffle_state === 'boolean' ? body.shuffle_state : null,
    repeatOn: typeof body.repeat_state === 'string' ? body.repeat_state !== 'off' : null,
    itemPlayable: typeof body.item?.is_playable === 'boolean' ? body.item.is_playable : null,
    itemRestricted: Boolean(body.item?.restrictions),
  } : { hasPlayback: false };
  return { accepted: true, confirmed: false };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || !args.length) {
    console.log(`One-call Spotify Player isolation. Rotation must be stopped. Uses saved desktop credentials; never prints tokens.
Usage: node scripts/spotify-player-isolate.mjs --command COMMAND [--device-id ID] [--port 3000]
Commands: ${commands.join(', ')}
play-one/play-window use the current saved Rotation track/order. Each run sends exactly one Spotify Player call.
First run devices, then test one mutation at a time. Observe Spotify and the official Web Player manually. Stop after a failure; wait or restart Spotify before another call.
An expired connection requires reopening Rotation, refreshing devices, then Quit. No token refresh or automatic retry is performed here.`);
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--command', '--device-id', '--port', '--config-dir', '--data-dir'].includes(args[i]) || !args[i + 1]) throw new Error('Invalid option. Use --help.');
    options[args[i].slice(2)] = args[i + 1];
  }
  const port = Number(options.port || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose a valid local port.');
  let running = false;
  try { await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) }); running = true; } catch {}
  if (running) throw new Error('Quit Rotation before isolating a call, so its polling and commands cannot interfere.');
  const paths = userPaths();
  const config = await readConfig(resolve(options['config-dir'] || paths.configDir));
  if (!config) throw new Error('Launch the desktop app and connect Spotify first.');
  let profile;
  try { profile = decryptProfile(await readFile(resolve(options['data-dir'] || paths.dataDir, 'session.enc'), 'utf8'), config.sessionSecret); }
  catch { throw new Error('Could not read the saved Spotify connection. Open Rotation and reconnect locally.'); }
  const session = profile.session;
  if (!session?.tokens?.access || session.tokens.expiresAt < Date.now() + 10000) throw new Error('Saved access token expired. Open Rotation, refresh devices, then Quit and run this again.');
  const call = prepareCall(options.command, options['device-id'], session.rotation);
  const required = call.method === 'GET' ? 'user-read-playback-state' : 'user-modify-playback-state';
  if (!session.grantedScopes?.includes(required)) throw new Error('Reconnect Spotify in Rotation to grant playback permissions.');
  let buildId = null;
  try { buildId = JSON.parse(await readFile(resolve(dirname(fileURLToPath(import.meta.url)), '../build-manifest.json'), 'utf8')).buildId || null; } catch {}
  const started = Date.now();
  try {
    const response = await fetch(`https://api.spotify.com/v1${call.path}`, {
      method: call.method, headers: { Authorization: `Bearer ${session.tokens.access}`, 'Content-Type': 'application/json' },
      ...(call.body ? { body: JSON.stringify(call.body) } : {}), signal: AbortSignal.timeout(10000),
    });
    const body = response.status === 204 ? null : await response.json().catch(() => null);
    const output = { at: new Date(started).toISOString(), buildId, command: options.command, method: call.method, endpoint: call.path.split('?')[0], status: response.status,
      elapsedMs: Date.now() - started, retryAfterSeconds: Number(response.headers.get('retry-after')) || null,
      response: safeResponse(!response.ok && !body?.error ? {error: {status: response.status}} : body, options.command, options['device-id']) };
    console.log(JSON.stringify(output, null, 2));
    if (!response.ok) process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ at: new Date(started).toISOString(), buildId, command: options.command, method: call.method, endpoint: call.path.split('?')[0], status: null, elapsedMs: Date.now() - started, error: 'Network request failed or reached the 10 second deadline. Spotify may still process an accepted command; inspect the player before retrying.' }, null, 2));
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
