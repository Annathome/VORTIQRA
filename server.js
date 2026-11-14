const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const STORE_DIR = path.join(ROOT, "data");
const STORE_FILE = path.join(STORE_DIR, "leaderboard.json");
const PORT = Number(process.env.PORT) || 4173;
const INDEX_FILE = "Orbit Academy_ Astronaut Training.html";
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const RANKS = [["Cadet", 0], ["Pilot", 100], ["Specialist", 250], ["Commander", 500], ["Mission Director", 900]];
let writes = Promise.resolve();

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

async function readPlayers() {
  try {
    const data = JSON.parse(await fs.promises.readFile(STORE_FILE, "utf8"));
    return Array.isArray(data.players) ? data.players : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function rankFor(xp) {
  let result = RANKS[0][0];
  for (const [rank, threshold] of RANKS) if (xp >= threshold) result = rank;
  return result;
}

async function savePlayer(player) {
  const operation = writes.then(async () => {
    const players = await readPlayers();
    const index = players.findIndex((item) => item.id === player.id);
    if (index < 0) players.push(player);
    else players[index] = player;
    await fs.promises.mkdir(STORE_DIR, { recursive: true });
    const temp = STORE_FILE + ".tmp";
    await fs.promises.writeFile(temp, JSON.stringify({ players }, null, 2), "utf8");
    await fs.promises.rename(temp, STORE_FILE);
  });
  writes = operation.catch(() => {});
  await operation;
}

async function handleApi(req, res, url) {
  if (url.pathname !== "/api/leaderboard") return json(res, 404, { error: "Not found" });
  if (req.method === "GET") {
    try {
      await writes;
      const players = await readPlayers();
      players.sort((a, b) => b.xp - a.xp || a.callsign.localeCompare(b.callsign));
      return json(res, 200, { entries: players });
    } catch {
      return json(res, 500, { error: "Could not read leaderboard storage" });
    }
  }
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  try {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 8192) return json(res, 413, { error: "Request too large" });
    }
    const input = JSON.parse(raw);
    const id = typeof input.id === "string" ? input.id : "";
    const xp = Number(input.xp);
    const callsign = typeof input.callsign === "string" ? input.callsign.trim().slice(0, 32) : "";
    const name = typeof input.name === "string" ? input.name.trim().slice(0, 48) : "";
    if (!/^[\w-]{10,80}$/.test(id) || !callsign || !Number.isSafeInteger(xp) || xp < 0 || xp > 10000000) {
      return json(res, 400, { error: "Invalid profile" });
    }
    const player = { id, name: name || callsign, callsign, xp, rank: rankFor(xp), updatedAt: new Date().toISOString() };
    await savePlayer(player);
    return json(res, 200, { player });
  } catch {
    return json(res, 400, { error: "Invalid leaderboard request" });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Method not allowed" });

  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { res.writeHead(400); return res.end("Bad request"); }
  if (pathname === "/") pathname = "/" + INDEX_FILE;
  const file = path.resolve(ROOT, "." + pathname);
  if (!file.startsWith(ROOT + path.sep) || file.startsWith(STORE_DIR + path.sep)) {
    res.writeHead(403); return res.end("Forbidden");
  }
  const type = MIME[path.extname(file).toLowerCase()];
  if (!type) { res.writeHead(404); return res.end("Not found"); }
  try {
    const body = await fs.promises.readFile(file);
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
    return res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404); return res.end("Not found");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Orbit Academy is available at http://localhost:${PORT}`);
});
