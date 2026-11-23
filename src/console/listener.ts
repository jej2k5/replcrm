import { createServer } from "node:http";
import type { createConsoleHandler } from "./handler.js";

export type ConsoleListener = (
  host: "127.0.0.1", port: number, handler: ReturnType<typeof createConsoleHandler>,
) => Promise<{ close(): Promise<void> }>;

export const listenForConsole: ConsoleListener = async (_host, port, handler) => {
  const server = createServer(async (request, response) => {
    try {
      const hosts = request.headersDistinct.host;
      const headers = hosts && hosts.length > 1 ? { ...request.headers, host: hosts.join(",") } : request.headers;
      const result = await handler(request.method ?? "", request.url ?? "", headers, async () => {
        let body = "";
        request.setEncoding("utf8");
        // Leave the stream open for the error response if the payload is too large.
        for await (const chunk of request.iterator({ destroyOnReturn: false })) {
          body += chunk;
          if (body.length > 32768) throw new Error("Request body too large");
        }
        return body;
      });
      request.resume();
      response.writeHead(result.status, result.headers).end(result.bytes ?? result.body);
    } catch {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("Unable to serve console");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
};
