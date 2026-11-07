// e2e のための next start（#52、#54）。先に next build を済ませておく。実 API に届かないよう、鍵を外して起動する。
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      s.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("port"))));
    });
  });
}

export async function startServer(): Promise<{ base: string; stop: () => void }> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const next = join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
  const server: ChildProcess = spawn(process.execPath, [next, "start", "-H", "127.0.0.1", "-p", String(port)], {
    env: { ...process.env, ANTHROPIC_API_KEY: "" },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/roadmap`)).ok) break;
    } catch {
      // まだ起動していない
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { base, stop: () => server.kill() };
}
