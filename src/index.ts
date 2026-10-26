
import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import cors from "cors";
import { z } from "zod";

const server = new McpServer({
  name: "perplexity-firecrawl-server",
  version: "1.1.0"
});

function getKey(name: string): string {
  const key = process.env[name];
  if (!key) throw new Error(`Missing environment variable: ${name}`);
  return key;
}

async function postApi(
  endpoint: string,
  key: string,
  body: object
): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `API returned HTTP ${response.status}: ${text.slice(0, 800)}`
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The API returned an invalid JSON response.");
  }
}

function toolResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

// Keep the original Echo tool
server.tool(
  "echo",
  { message: z.string() },
  async ({ message }) => ({
    content: [{ type: "text" as const, text: `Tool echo: ${message}` }]
  })
);

// Perplexity web search
server.tool(
  "perplexity_search",
  {
    query: z.string().min(1).max(1000)
  },
  async ({ query }) => {
    const data = await postApi(
      "https://api.perplexity.ai/search",
      getKey("PERPLEXITY_API_KEY"),
      { query, max_results: 5 }
    );

    return toolResult(data);
  }
);

// Firecrawl web search
server.tool(
  "firecrawl_search",
  {
    query: z.string().min(1).max(1000)
  },
  async ({ query }) => {
    const data = await postApi(
      "https://api.firecrawl.dev/v2/search",
      getKey("FIRECRAWL_API_KEY"),
      { query, limit: 5 }
    );

    return toolResult(data);
  }
);

// Firecrawl page scraping
server.tool(
  "firecrawl_scrape",
  {
    url: z.string().url()
  },
  async ({ url }) => {
    const parsed = new URL(url);

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("Only HTTP and HTTPS URLs are supported.");
    }

    const hostname = parsed.hostname.toLowerCase();

    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "169.254.169.254" ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("172.16.")
    ) {
      throw new Error("Private and local URLs are not allowed.");
    }

    const data = await postApi(
      "https://api.firecrawl.dev/v2/scrape",
      getKey("FIRECRAWL_API_KEY"),
      { url, formats: ["markdown"] }
    );

    return toolResult(data);
  }
);

const app = express();
app.use(cors());

const transports: Record<string, SSEServerTransport> = {};

app.get("/", (_: Request, res: Response) => {
  res.status(200).send("Perplexity + Firecrawl MCP server is running");
});

app.get("/sse", async (_: Request, res: Response) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;

  res.on("close", () => {
    delete transports[transport.sessionId];
  });

  await server.connect(transport);
});

app.post("/messages", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports[sessionId];

  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).send("No transport found for sessionId");
  }
});

const port = Number(process.env.PORT || 3001);

app.listen(port, "0.0.0.0", () => {
  console.log(`Perplexity + Firecrawl MCP server listening on ${port}`);
});
