const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const STORE_DIR = path.join(ROOT, "data");
const STORE_FILE = path.join(STORE_DIR, "leaderboard.json");
const PORT = Number(process.env.PORT) || 4173;
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

function boundedInt(value, min, max, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function cleanProgress(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const progress = {};
  for (const key of ["name", "call", "spec", "track", "claimed", "supXpDay", "supDay", "testDay", "labDay", "solDay", "lessonDay", "last"]) {
    if (typeof input[key] === "string") progress[key] = input[key].slice(0, 80);
  }
  if (typeof input.avatarImage === "string" && input.avatarImage.length <= 50000 && /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(input.avatarImage)) {
    progress.avatarImage = input.avatarImage;
  }
  for (const key of ["saved", "consent"]) if (typeof input[key] === "boolean") progress[key] = input[key];
  for (const key of ["av", "patch", "shape", "xp", "streak", "cr"]) {
    if (input[key] !== undefined) progress[key] = boundedInt(input[key], 0, key === "xp" ? 10000000 : 1000000);
  }
  if (Array.isArray(input.done)) progress.done = input.done.filter((item) => typeof item === "string").slice(0, 300).map((item) => item.slice(0, 80));
  if (Array.isArray(input.supXpQuestions)) progress.supXpQuestions = input.supXpQuestions.slice(0, 100).map(Boolean);
  if (input.sk && typeof input.sk === "object" && !Array.isArray(input.sk)) {
    progress.sk = {};
    for (const key of ["nav", "eng", "sci", "surv"]) progress.sk[key] = boundedInt(input.sk[key], 0, 1000000);
  }
  if (input.inventory && typeof input.inventory === "object" && !Array.isArray(input.inventory)) {
    progress.inventory = {};
    for (const key of ["p", "w", "f"]) progress.inventory[key] = boundedInt(input.inventory[key], 0, 100000);
  }
  if (input.econ && typeof input.econ === "object" && !Array.isArray(input.econ)) {
    const econ = input.econ;
    progress.econ = { day: typeof econ.day === "string" ? econ.day.slice(0, 40) : "", k: typeof econ.k === "string" ? econ.k.slice(0, 8) : "", i: boundedInt(econ.i, 0, 100), pick: boundedInt(econ.pick, 0, 20), ok: Boolean(econ.ok) };
  }
  if (input.labDone && typeof input.labDone === "object" && !Array.isArray(input.labDone)) {
    progress.labDone = { d: typeof input.labDone.d === "string" ? input.labDone.d.slice(0, 40) : "" };
    for (const key of ["rover", "orbit", "fix", "dodge", "match"]) if (input.labDone[key]) progress.labDone[key] = true;
  }
  if (input.colony && typeof input.colony === "object" && !Array.isArray(input.colony)) {
    const colony = input.colony;
    if (["mars", "cal", "uran"].includes(colony.pl)) {
      progress.colony = {
        pl: colony.pl, sol: boundedInt(colony.sol, 1, 30, 1), crew: boundedInt(colony.crew, 1, 100, 3),
        p: Math.max(0, Math.min(100, Number(colony.p) || 0)), w: Math.max(0, Math.min(100, Number(colony.w) || 0)), f: Math.max(0, Math.min(100, Number(colony.f) || 0)),
        rp: boundedInt(colony.rp, 0, 100000), msg: typeof colony.msg === "string" ? colony.msg.slice(0, 240) : "",
        over: Boolean(colony.over), win: Boolean(colony.win), u: {}, a: {}
      };
      for (const key of ["react", "recyc", "hydro", "shield"]) if (colony.u && colony.u[key]) progress.colony.u[key] = 1;
      for (const key of ["p", "w", "f"]) progress.colony.a[key] = boundedInt(colony.a && colony.a[key], 0, progress.colony.crew);
      if (typeof colony.why === "string") progress.colony.why = colony.why.slice(0, 100);
    }
  } else if (input.colony === null) progress.colony = null;
  return progress;
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
  const progressRoute = url.pathname === "/api/progress";
  if (!progressRoute && url.pathname !== "/api/leaderboard") return json(res, 404, { error: "Not found" });
  if (req.method === "GET") {
    try {
      await writes;
      const players = await readPlayers();
      if (progressRoute) {
        const id = url.searchParams.get("id") || "";
        if (!/^[\w-]{10,80}$/.test(id)) return json(res, 400, { error: "Invalid profile id" });
        const player = players.find((item) => item.id === id);
        return player ? json(res, 200, { progress: player.progress || {}, updatedAt: player.updatedAt }) : json(res, 404, { error: "Progress not found" });
      }
      players.sort((a, b) => b.xp - a.xp || String(a.callsign).localeCompare(String(b.callsign)));
      return json(res, 200, { entries: players.map(({ id, name, callsign, xp, rank, progress, updatedAt }) => ({ id, name, callsign, xp, rank, av: progress && progress.av, avatarImage: progress && progress.avatarImage, updatedAt })) });
    } catch {
      return json(res, 500, { error: "Could not read leaderboard storage" });
    }
  }
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  try {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 65536) return json(res, 413, { error: "Request too large" });
    }
    const input = JSON.parse(raw);
    const id = typeof input.id === "string" ? input.id : "";
    const xp = Number(input.xp);
    const callsign = typeof input.callsign === "string" ? input.callsign.trim().slice(0, 32) : "";
    const name = typeof input.name === "string" ? input.name.trim().slice(0, 48) : "";
    if (!/^[\w-]{10,80}$/.test(id) || !callsign || !Number.isSafeInteger(xp) || xp < 0 || xp > 10000000) {
      return json(res, 400, { error: "Invalid profile" });
    }
    const progress = cleanProgress(input.progress);
    const player = { id, name: name || callsign, callsign, xp, rank: rankFor(xp), progress, updatedAt: new Date().toISOString() };
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
  if (pathname === "/") pathname = "/index.html";
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
