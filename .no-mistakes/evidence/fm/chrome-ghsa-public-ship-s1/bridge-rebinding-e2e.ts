import { createServer, request } from "node:http";
import { handleBridgeRequest, type BridgeClient } from "../../../../src/bridge.ts";

const calls: string[] = [];
const client: BridgeClient = {
  listTools: async () => ({ tools: [{ name: "take_snapshot" }] }),
  callTool: async ({ name }) => {
    calls.push(name);
    return { content: [{ type: "text", text: "ok" }] };
  },
  close: async () => {},
};

const server = createServer((req, res) => {
  void handleBridgeRequest(client, req, res, "evidence");
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (address === null || typeof address === "string") throw new Error("no port");

async function probe(
  label: string,
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string>,
) {
  const body = method === "POST" ? JSON.stringify({ name: "take_snapshot" }) : "";
  const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        method,
        path,
        headers: { ...headers, "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        let responseBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: responseBody }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
  console.log(`${label}: ${result.status} ${result.body}`);
}

try {
  console.log("DNS rebinding bridge validation through real HTTP requests");
  await probe("forged Host GET /health", "GET", "/health", { host: "evil.attacker.com" });
  await probe("forged Host GET /tools", "GET", "/tools", { host: "evil.attacker.com" });
  await probe("forged Host POST /call", "POST", "/call", { host: "evil.attacker.com" });
  console.log(`CDP calls after forged /call: ${calls.length}`);
  await probe("forged Origin POST /call", "POST", "/call", {
    host: `127.0.0.1:${address.port}`,
    origin: "https://evil.attacker.com",
  });
  console.log(`CDP calls after forged Origin: ${calls.length}`);
  await probe("present empty Origin POST /call", "POST", "/call", {
    host: `127.0.0.1:${address.port}`,
    origin: "",
  });
  console.log(`CDP calls after present empty Origin: ${calls.length}`);
  await probe("CLI-shaped 127.0.0.1 /health", "GET", "/health", {
    host: `127.0.0.1:${address.port}`,
  });
  await probe("localhost + loopback Origin /tools", "GET", "/tools", {
    host: `localhost:${address.port}`,
    origin: `http://localhost:${address.port}`,
  });
  await probe("IPv6 Host, missing Origin POST /call", "POST", "/call", {
    host: `[::1]:${address.port}`,
  });
  console.log(`CDP calls after legitimate /call: ${calls.length}`);
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
