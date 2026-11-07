// e2e のための next start（#52、#54、#64）。先に next build を済ませておく。実 API に届かないよう、鍵を外すか偽物にして起動する。
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

// connected: 会話の画面を「接続あり」で出す（送信を押せる）。鍵は偽物で、送り先もこの端末の閉じたポートにするので、
// 実 API には届かない。検査では /api/chat への送信をブラウザの中で差し替える。
export async function startServer(
  options: { connected?: boolean } = {},
): Promise<{ base: string; stop: () => void }> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const next = join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
  const server: ChildProcess = spawn(process.execPath, [next, "start", "-H", "127.0.0.1", "-p", String(port)], {
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: options.connected ? "e2e-dummy-not-a-key" : "",
      ANTHROPIC_API_KEY_FILE: "",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9/v1",
    },
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
