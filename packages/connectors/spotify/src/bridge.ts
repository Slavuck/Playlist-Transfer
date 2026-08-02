import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SENTINEL = "PLAYLIST_TRANSFER_SPOTAPI=";
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export type SpotApiCredentials = {
  identifier: string;
  cookies: Record<string, string>;
  connectedAtMs: number;
};

export type SpotApiCommand = Record<string, unknown> & {
  operation: string;
  credentials?: SpotApiCredentials;
};

export type SpotApiDiagnostic = {
  installed: boolean;
  package?: string;
  version?: string;
  python?: string;
  errorCode?: string;
};

type BridgeEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; mutationMayHaveStarted?: boolean };

export type SpotApiBridge = {
  run<T>(command: SpotApiCommand): Promise<T>;
};

export class SpotApiBridgeError extends Error {
  providerMutationMayHaveStarted: boolean;

  constructor(code: string, mutationMayHaveStarted = false) {
    super(code);
    this.name = "SpotApiBridgeError";
    this.providerMutationMayHaveStarted = mutationMayHaveStarted;
  }
}

function installedWindowsPythonCandidates(): string[] {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return [];
  const root = join(localAppData, "Programs", "Python");
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^Python\d+$/u.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name))
      .map((entry) => join(root, entry.name, "python.exe"))
      .filter(existsSync);
  } catch {
    return [];
  }
}

export function resolveSpotApiPython(): { command: string; args: string[] } {
  const configured = process.env.PLAYLIST_TRANSFER_SPOTAPI_PYTHON?.trim();
  if (configured) {
    if (!existsSync(configured)) throw new SpotApiBridgeError("SPOTAPI_PYTHON_NOT_FOUND");
    return { command: configured, args: [] };
  }
  const windowsPython = installedWindowsPythonCandidates()[0];
  if (windowsPython) return { command: windowsPython, args: [] };
  return { command: process.platform === "win32" ? "python.exe" : "python3", args: [] };
}

export class PythonSpotApiBridge implements SpotApiBridge {
  async run<T>(command: SpotApiCommand): Promise<T> {
    if (typeof window !== "undefined") throw new SpotApiBridgeError("SPOTAPI_BRIDGE_SERVER_ONLY");
    const python = resolveSpotApiPython();
    const script = join(process.cwd(), "packages", "connectors", "spotify", "spotapi_bridge.py");
    if (!existsSync(script)) throw new SpotApiBridgeError("SPOTAPI_BRIDGE_SCRIPT_NOT_FOUND");
    return new Promise<T>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(python.command, [...python.args, script], {
          cwd: process.cwd(),
          env: { ...process.env, PYTHONIOENCODING: "utf-8" },
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        reject(new SpotApiBridgeError(
          code === "ENOENT" ? "SPOTAPI_PYTHON_NOT_FOUND"
            : code === "EPERM" ? "SPOTAPI_PROCESS_PERMISSION_DENIED"
              : "SPOTAPI_BRIDGE_FAILED",
          false,
        ));
        return;
      }
      let stdout = "";
      let stderr = "";
      let settled = false;
      const mutationMayHaveStarted = command.operation === "append_track" || command.operation === "create_playlist";
      const finishWithError = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof SpotApiBridgeError
          ? error
          : new SpotApiBridgeError("SPOTAPI_BRIDGE_FAILED", mutationMayHaveStarted));
      };
      const timer = setTimeout(() => {
        child.kill();
        finishWithError(new SpotApiBridgeError("SPOTAPI_BRIDGE_TIMEOUT", mutationMayHaveStarted));
      }, 90_000);
      child.on("error", (error) => {
        const reason = (error as NodeJS.ErrnoException).code;
        const code = reason === "ENOENT" ? "SPOTAPI_PYTHON_NOT_FOUND"
          : reason === "EPERM" ? "SPOTAPI_PROCESS_PERMISSION_DENIED"
            : "SPOTAPI_BRIDGE_FAILED";
        finishWithError(new SpotApiBridgeError(code, false));
      });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
          child.kill();
          finishWithError(new SpotApiBridgeError("SPOTAPI_RESPONSE_TOO_LARGE", mutationMayHaveStarted));
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-8_192);
      });
      child.on("close", (code) => {
        if (settled) return;
        clearTimeout(timer);
        const line = stdout.split(/\r?\n/u).findLast((entry) => entry.startsWith(SENTINEL));
        if (!line) {
          void stderr;
          finishWithError(new SpotApiBridgeError(code === 0 ? "SPOTAPI_INVALID_RESPONSE" : "SPOTAPI_BRIDGE_FAILED", mutationMayHaveStarted));
          return;
        }
        try {
          const envelope = JSON.parse(line.slice(SENTINEL.length)) as BridgeEnvelope<T>;
          if (!envelope.ok) {
            finishWithError(new SpotApiBridgeError(envelope.error, envelope.mutationMayHaveStarted === true));
            return;
          }
          settled = true;
          resolve(envelope.data);
        } catch {
          finishWithError(new SpotApiBridgeError("SPOTAPI_INVALID_RESPONSE", mutationMayHaveStarted));
        }
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(JSON.stringify(command), "utf8");
    });
  }
}

export const defaultSpotApiBridge = new PythonSpotApiBridge();

export async function getSpotApiDiagnostic(bridge: SpotApiBridge = defaultSpotApiBridge): Promise<SpotApiDiagnostic> {
  try {
    return await bridge.run<SpotApiDiagnostic>({ operation: "status" });
  } catch (error) {
    return {
      installed: false,
      errorCode: error instanceof Error ? error.message : "SPOTAPI_DIAGNOSTIC_FAILED",
    };
  }
}
