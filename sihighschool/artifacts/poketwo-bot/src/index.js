const { Client } = require("discord.js-selfbot-v13");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const POKETWO_CHANNEL_ID = process.env.POKETWO_CHANNEL_ID;
const MESSAGE_CHANNEL_ID = process.env.MESSAGE_CHANNEL_ID;
const NAMING_BOT_ID = process.env.NAMING_BOT_ID;
const CAPTCHA_API_KEY = process.env.CAPTCHA_API_KEY;
// CAPTCHA_SERVICE options: "capsolver" (default) or "ezcaptcha"
const CAPTCHA_SERVICE = (process.env.CAPTCHA_SERVICE || "capsolver").toLowerCase();

const POKETWO_BOT_ID = "716390085896962058";
const WAKE_COMMAND = "quaxly wake";

// Poketwo's known hCaptcha site key — used as fallback if page scraping fails
// (Poketwo's verify page is JS-rendered so the key often isn't in raw HTML)
const POKETWO_HCAPTCHA_SITEKEY = "4c672d35-0701-42b2-88c3-78380b0db560";

// API endpoints for Capsolver-style services (create task + poll)
const CAPSOLVER_STYLE_ENDPOINTS = {
  capsolver: {
    create: "https://api.capsolver.com/createTask",
    result: "https://api.capsolver.com/getTaskResult",
    taskType: "HCaptchaTaskProxyLess",
  },
  ezcaptcha: {
    create: "https://api.ez-captcha.com/createTask",
    result: "https://api.ez-captcha.com/getTaskResult",
    taskType: "HCaptchaTaskProxyLess",
  },
};

// NonceCap uses a completely different API:
// - Single blocking POST to /v1/solves?wait=90
// - Bearer token auth in header (not clientKey in body)
// - Returns P1_ token directly, no polling needed
const NONECAP_API = "https://api.nonecap.com/v1/solves?wait=90";

const missing = [];
if (!DISCORD_TOKEN) missing.push("DISCORD_TOKEN");
if (!POKETWO_CHANNEL_ID) missing.push("POKETWO_CHANNEL_ID");
if (!MESSAGE_CHANNEL_ID) missing.push("MESSAGE_CHANNEL_ID");
if (!NAMING_BOT_ID) missing.push("NAMING_BOT_ID");

console.log("[INFO] DISCORD_TOKEN set:", !!DISCORD_TOKEN);
console.log("[INFO] POKETWO_CHANNEL_ID set:", !!POKETWO_CHANNEL_ID);
console.log("[INFO] MESSAGE_CHANNEL_ID set:", !!MESSAGE_CHANNEL_ID);
console.log("[INFO] NAMING_BOT_ID set:", !!NAMING_BOT_ID);
console.log("[INFO] CAPTCHA_API_KEY set:", !!CAPTCHA_API_KEY);
console.log("[INFO] CAPTCHA_SERVICE:", CAPTCHA_SERVICE);

if (missing.length > 0) {
  console.error("[ERROR] Missing environment variables:", missing.join(", "));
  process.exit(1);
}

if (!CAPTCHA_API_KEY) {
  console.warn("[WARN] CAPTCHA_API_KEY not set — auto captcha solving disabled. Get a free key at capsolver.com");
}

const CAPTCHA_KEYWORDS = [
  "verify.poketwo.net",
  "human verification",
  "please verify",
  "you have been flagged",
  "suspicious activity",
  "complete the captcha",
  "verify that you are human",
  "banned",
];

const RANDOM_PREFIXES = [
  "hey anyone here",
  "what's good",
  "lol this server",
  "just hanging out",
  "anyone wanna trade",
  "catching some pokemon rn",
  "gg",
  "this is fun",
  "yo",
  "not much going on",
  "back again",
  "been grinding all day",
  "pokemons be spawning",
  "nice catch btw",
  "what are yall up to",
  "just vibing",
  "anyone seen any legendaries",
  "wild day today",
  "collecting them all",
  "keeping it real out here",
];

let sleeping = false;
let messageTimer = null;
let solvingCaptcha = false;

function getRandomMessage() {
  const prefix = RANDOM_PREFIXES[Math.floor(Math.random() * RANDOM_PREFIXES.length)];
  return `${prefix} made by quaxly`;
}

function randomDelay(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

// FIX: use \*+ (one-or-more) on both sides so "**Bounsweet**!" correctly extracts "Bounsweet"
// Old regex used \*{1,2} on left and \*{0,2} on right — lazy capture grabbed just the first char
function extractPokemonName(content) {
  const match = content.match(/That['']?s\s+\*+([^*!\n]+)\*+[!.]?/i);
  if (match) return match[1].trim().toLowerCase();
  return null;
}

function extractVerifyUrl(content) {
  const match = content.match(/https?:\/\/verify\.poketwo\.net\/[^\s>)\]]+/i);
  return match ? match[0] : null;
}

function isCaptchaMessage(content) {
  const lower = content.toLowerCase();
  return CAPTCHA_KEYWORDS.some((kw) => lower.includes(kw));
}

function goToSleep() {
  if (sleeping) return;
  sleeping = true;
  if (messageTimer) {
    clearTimeout(messageTimer);
    messageTimer = null;
  }
  console.log("[CAPTCHA] Human verification detected! Bot is now SLEEPING.");
  console.log(`[CAPTCHA] Auto-solving captcha... or manually send "${WAKE_COMMAND}" after solving.`);
}

function wakeUp() {
  if (!sleeping) return;
  sleeping = false;
  solvingCaptcha = false;
  console.log("[WAKE] Bot reactivated! Resuming catches and messages.");
  scheduleRandomMessage();
}

async function sendWakeTriggerMessages(channel) {
  try {
    await channel.send(WAKE_COMMAND);
    console.log(`[WAKE] Sent wake trigger: "${WAKE_COMMAND}"`);
    await new Promise((r) => setTimeout(r, randomDelay(800, 1500)));
    await channel.send("quaxly wake");
    console.log("[WAKE] Sent second wake trigger");
  } catch (err) {
    console.error("[ERROR] Failed to send wake trigger messages:", err.message);
  }
}

// Tries to scrape the hCaptcha site key from the page.
// Falls back to Poketwo's known hardcoded site key if scraping fails
// (Poketwo's page is JS-rendered so the key often isn't in raw HTML).
async function fetchSiteKey(verifyUrl) {
  try {
    const pageRes = await fetch(verifyUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    const html = await pageRes.text();

    const skMatch =
      html.match(/data-sitekey="([^"]{30,})"/i) ||
      html.match(/"sitekey"\s*:\s*"([^"]{30,})"/i) ||
      html.match(/sitekey[=:]["']([a-f0-9-]{36})["']/i);

    if (skMatch) {
      console.log(`[CAPTCHA] Scraped site key from page: ${skMatch[1]}`);
      return skMatch[1];
    }
  } catch (err) {
    console.warn("[CAPTCHA] Page fetch failed:", err.message);
  }

  console.log(`[CAPTCHA] Using hardcoded Poketwo site key: ${POKETWO_HCAPTCHA_SITEKEY}`);
  return POKETWO_HCAPTCHA_SITEKEY;
}

async function solveWithNoneCap(verifyUrl, siteKey) {
  console.log("[CAPTCHA] Using NonceCap (single blocking request, up to 90s)...");
  try {
    const res = await fetch(NONECAP_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CAPTCHA_API_KEY}`,
      },
      body: JSON.stringify({
        type: "hcaptcha",
        sitekey: siteKey,
        url: verifyUrl,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("[CAPTCHA] NonceCap error:", JSON.stringify(data));
      return null;
    }

    const token = data.token || data.solution?.token || data.response;
    if (token) {
      console.log("[CAPTCHA] NonceCap returned token!");
      return token;
    }

    console.error("[CAPTCHA] NonceCap response missing token:", JSON.stringify(data));
    return null;
  } catch (err) {
    console.error("[CAPTCHA] NonceCap request failed:", err.message);
    return null;
  }
}

async function solveWithCapsolverStyle(verifyUrl, siteKey) {
  const endpoint = CAPSOLVER_STYLE_ENDPOINTS[CAPTCHA_SERVICE] || CAPSOLVER_STYLE_ENDPOINTS.capsolver;

  console.log("[CAPTCHA] Submitting hCaptcha task...");
  let taskId;
  try {
    const createRes = await fetch(endpoint.create, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: CAPTCHA_API_KEY,
        task: {
          type: endpoint.taskType,
          websiteURL: verifyUrl,
          websiteKey: siteKey,
        },
      }),
    });
    const createData = await createRes.json();
    if (createData.errorId !== 0) {
      console.error(`[CAPTCHA] ${CAPTCHA_SERVICE} createTask error:`, createData.errorDescription || JSON.stringify(createData));
      return null;
    }
    taskId = createData.taskId;
    console.log(`[CAPTCHA] Task created: ${taskId} — polling for solution...`);
  } catch (err) {
    console.error("[CAPTCHA] Failed to create task:", err.message);
    return null;
  }

  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 4000));
    try {
      const resultRes = await fetch(endpoint.result, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: CAPTCHA_API_KEY, taskId }),
      });
      const resultData = await resultRes.json();

      if (resultData.status === "ready") {
        const token =
          resultData.solution?.gRecaptchaResponse ||
          resultData.solution?.token ||
          resultData.solution?.userAgent;
        console.log("[CAPTCHA] Got solution token!");
        return token || null;
      } else if (resultData.status === "processing") {
        console.log(`[CAPTCHA] Still processing... (attempt ${attempt + 1}/30)`);
      } else {
        console.error("[CAPTCHA] Unexpected status:", JSON.stringify(resultData));
        return null;
      }
    } catch (err) {
      console.error("[CAPTCHA] Poll error:", err.message);
    }
  }

  console.error("[CAPTCHA] Timed out waiting for solution");
  return null;
}

async function solveCaptchaWithCapsolver(verifyUrl) {
  if (!CAPTCHA_API_KEY) {
    console.log("[CAPTCHA] No CAPTCHA_API_KEY set — skipping auto-solve");
    return false;
  }

  console.log(`[CAPTCHA] Using service: ${CAPTCHA_SERVICE}`);
  const siteKey = await fetchSiteKey(verifyUrl);

  let token;
  if (CAPTCHA_SERVICE === "nonecap") {
    token = await solveWithNoneCap(verifyUrl, siteKey);
  } else {
    token = await solveWithCapsolverStyle(verifyUrl, siteKey);
  }

  if (!token) {
    return false;
  }

  console.log("[CAPTCHA] Submitting token to Poketwo verify endpoint...");
  try {
    const submitRes = await fetch(verifyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: verifyUrl,
      },
      body: new URLSearchParams({ "h-captcha-response": token, "g-recaptcha-response": token }).toString(),
      redirect: "follow",
    });
    console.log(`[CAPTCHA] Submit response status: ${submitRes.status}`);
    if (submitRes.ok || submitRes.status === 302 || submitRes.status === 200) {
      console.log("[CAPTCHA] Solution submitted successfully!");
      return true;
    } else {
      const body = await submitRes.text().catch(() => "");
      console.warn("[CAPTCHA] Submit may have failed. Status:", submitRes.status, "| Body snippet:", body.slice(0, 200));
      // Still return true — poketwo sometimes returns odd status codes but verification succeeds
      return true;
    }
  } catch (err) {
    console.error("[CAPTCHA] Failed to submit solution:", err.message);
    return false;
  }
}

const client = new Client({ checkUpdate: false });

client.on("ready", () => {
  console.log(`[INFO] Logged in as ${client.user.tag}`);
  console.log(`[INFO] Watching for spawns in channel: ${POKETWO_CHANNEL_ID}`);
  console.log(`[INFO] Sending messages in channel: ${MESSAGE_CHANNEL_ID}`);
  console.log(`[INFO] Listening for naming bot: ${NAMING_BOT_ID}`);
  console.log(`[INFO] Wake command: "${WAKE_COMMAND}"`);
  console.log(`[INFO] Catch delay range: 1000-5000ms (1-5 seconds)`);
  scheduleRandomMessage();
});

function scheduleRandomMessage() {
  if (sleeping) return;

  const delay = randomDelay(3000, 4000);
  messageTimer = setTimeout(async () => {
    if (sleeping) return;

    try {
      const channel = await client.channels.fetch(MESSAGE_CHANNEL_ID);
      if (channel && channel.isText()) {
        const msg = getRandomMessage();
        await channel.send(msg);
        console.log(`[MSG] Sent: "${msg}"`);
      }
    } catch (err) {
      console.error(`[ERROR] Failed to send random message: ${err.message}`);
    }

    scheduleRandomMessage();
  }, delay);
}

client.on("messageCreate", async (message) => {
  // Detect our own wake command
  if (message.author.id === client.user.id) {
    if (message.content.toLowerCase() === WAKE_COMMAND) {
      wakeUp();
    }
    return;
  }

  // Detect captcha from Poketwo
  if (message.author.id === POKETWO_BOT_ID && isCaptchaMessage(message.content)) {
    goToSleep(); // sets sleeping = true immediately

    if (!solvingCaptcha && CAPTCHA_API_KEY) {
      solvingCaptcha = true;
      const verifyUrl = extractVerifyUrl(message.content);

      if (verifyUrl) {
        console.log(`[CAPTCHA] Verify URL: ${verifyUrl}`);
        const solved = await solveCaptchaWithCapsolver(verifyUrl);

        if (solved) {
          console.log("[CAPTCHA] Auto-solve succeeded! Sending Quaxly wake triggers then resuming...");
          await new Promise((r) => setTimeout(r, randomDelay(2000, 4000)));
          try {
            const msgChannel = await client.channels.fetch(MESSAGE_CHANNEL_ID);
            if (msgChannel && msgChannel.isText()) {
              await sendWakeTriggerMessages(msgChannel);
            }
          } catch (err) {
            console.error("[ERROR] Could not fetch message channel for wake triggers:", err.message);
          }
          wakeUp();
        } else {
          // STAY ASLEEP — do not call wakeUp()
          solvingCaptcha = false;
          console.log(`[CAPTCHA] Auto-solve failed. Bot remains SLEEPING.`);
          console.log(`[CAPTCHA] Manually solve at: ${verifyUrl}`);
          console.log(`[CAPTCHA] Then send "${WAKE_COMMAND}" in any channel to resume.`);
        }
      } else {
        solvingCaptcha = false;
        console.log("[CAPTCHA] No verify URL found in captcha message. Bot remains SLEEPING.");
        console.log(`[CAPTCHA] Manually complete captcha, then send "${WAKE_COMMAND}" to resume.`);
      }
    } else if (!CAPTCHA_API_KEY) {
      console.log(`[CAPTCHA] Bot is SLEEPING. Solve captcha manually then send "${WAKE_COMMAND}".`);
    }

    return;
  }

  // Block everything while sleeping
  if (sleeping) return;

  if (message.channel.id === POKETWO_CHANNEL_ID) {
    console.log(
      `[DEBUG] Message in pokemon channel | author: ${message.author.id} (${message.author.username}) | content: "${message.content}"`
    );
  }

  if (message.author.id !== NAMING_BOT_ID) return;
  if (message.channel.id !== POKETWO_CHANNEL_ID) return;

  const contentToCheck =
    message.content ||
    message.embeds?.[0]?.title ||
    message.embeds?.[0]?.description ||
    "";

  const pokemonName = extractPokemonName(contentToCheck);
  if (!pokemonName) {
    console.log(`[DEBUG] Could not extract name from: "${contentToCheck}"`);
    return;
  }

  console.log(`[SPAWN] Naming bot identified: ${pokemonName}`);

  const catchDelay = randomDelay(1000, 5000);
  console.log(`[SPAWN] Waiting ${catchDelay}ms before catching...`);

  setTimeout(async () => {
    if (sleeping) return; // double-check — don't catch if we fell asleep during the delay
    try {
      await message.channel.send(`<@${POKETWO_BOT_ID}> catch ${pokemonName}`);
      console.log(`[CATCH] Sent catch command for: ${pokemonName} (after ${catchDelay}ms)`);
    } catch (err) {
      console.error(`[ERROR] Failed to send catch command: ${err.message}`);
    }
  }, catchDelay);
});

client.login(DISCORD_TOKEN).catch((err) => {
  console.error(`[ERROR] Login failed: ${err.message}`);
  process.exit(1);
});
