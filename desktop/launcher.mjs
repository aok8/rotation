#!/usr/bin/env node
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  childEnvironment,
  LOOPBACK,
  openBrowser,
  packagedPaths,
  readConfig,
  startSetup,
  userPaths,
  waitForHealth,
} from "./runtime.mjs";

function argumentsForLaunch(args) {
  const options = { open: true, port: 3000 };
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === "--no-open") options.open = false;
    else if (
      ["--port", "--config-dir", "--data-dir", "--app-root"].includes(value) &&
      args[i + 1]
    )
      options[value.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] =
        args[++i];
    else throw new Error(`Unknown launcher option: ${value}`);
  }
  options.port = Number(options.port);
  if (
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65535
  )
    throw new Error("Port must be between 0 and 65535.");
  return options;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function existingDesktop(url) {
  try {
    const response = await fetch(`${url}/api/session`, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok && (await response.json()).desktop === true;
  } catch {
    return false;
  }
}

async function portOccupied(port) {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, LOOPBACK, resolve);
    });
    await new Promise((resolve) => server.close(resolve));
    return false;
  } catch (error) {
    if (error?.code === "EADDRINUSE") return true;
    throw error;
  }
}

async function main() {
  const options = argumentsForLaunch(process.argv.slice(2));
  if (options.port === 0) options.port = await freePort();
  const appRoot = resolve(
    options.appRoot || dirname(dirname(fileURLToPath(import.meta.url))),
  );
  const { server, webDist } = packagedPaths(appRoot);
  const paths = userPaths();
  const configDir = resolve(options.configDir || paths.configDir);
  const dataDir = resolve(options.dataDir || paths.dataDir);
  const url = `http://${LOOPBACK}:${options.port}`;
  if (await portOccupied(options.port)) {
    if (await existingDesktop(url)) {
      if (options.open) openBrowser(url);
      return;
    }
    throw new Error(
      `Port ${options.port} is already in use. Close the other app or register and choose another port.`,
    );
  }
  let config = await readConfig(configDir);
  if (!config) {
    const setup = await startSetup({ port: options.port, configDir });
    if (options.open) openBrowser(setup.url);
    else console.log(`Open ${setup.url} to complete setup.`);
    const cancelSetup = () => setup.cancel();
    process.once("SIGINT", cancelSetup);
    process.once("SIGTERM", cancelSetup);
    config = await setup.completion;
    process.off("SIGINT", cancelSetup);
    process.off("SIGTERM", cancelSetup);
    await new Promise((resolve) => setup.server.close(resolve));
    if (!config) return;
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const child = spawn(
    process.env.ROTATION_NODE_BIN || process.execPath,
    [server],
    {
      cwd: appRoot,
      env: childEnvironment({ config, dataDir, webDist, port: options.port }),
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      windowsHide: true,
    },
  );
  child.on("error", (error) =>
    console.error(`Rotation server could not start: ${error.message}`),
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (!child.pid || child.exitCode !== null || child.signalCode !== null)
      return;
    if (child.connected) child.send({ type: "shutdown" });
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGTERM");
    }, 5000);
    await new Promise((resolve) => child.once("exit", resolve));
    clearTimeout(timeout);
  };
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void stop();
    });
  child.on("message", (message) => {
    if (message?.type === "quit")
      setTimeout(() => {
        void stop();
      }, 100);
  });
  try {
    await waitForHealth(url, child);
    if (options.open) openBrowser(url);
    else
      console.log(
        `Rotation is ready at ${url}. Stop with Ctrl+C or the in-app Quit button.`,
      );
  } catch (error) {
    await stop();
    throw error;
  }
}

main().catch((error) => {
  console.error(`Rotation could not start: ${error.message}`);
  process.exitCode = 1;
});
