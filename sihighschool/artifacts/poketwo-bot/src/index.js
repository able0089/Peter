const { Client } = require("discord.js-selfbot-v13");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const POKETWO_CHANNEL_ID = process.env.POKETWO_CHANNEL_ID;
const MESSAGE_CHANNEL_ID = process.env.MESSAGE_CHANNEL_ID;
const NAMING_BOT_ID = process.env.NAMING_BOT_ID;
const CAPTCHA_API_KEY = process.env.CAPTCHA_API_KEY;

const POKETWO_BOT_ID = "716390085896962058";
const WAKE_COMMAND = "quaxly wake";

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

function extractPokemonName(content) {
  const match = content.match(/That['']?s\s+\*{1,2}([^*!\n]+?)\*{0,2}[!.]?/i)
    || content.match(/That's \*\*(.+?)\*\*/i);
  return match ? match[1].trim().toLowerCase() : null;
}

function extractVerifyUrl(content) {
  const match = content.match(/https?:\/\/verify\.poketwo\.net\/[^\s>)]+/i);
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

async function solveCaptchaWithCapsolver(verifyUrl) {
  if (!CAPTCHA_API_KEY) {
    console.log("[CAPTCHA] No CAPTCHA_API_KEY set — skipping auto-solve");
    return false;
  }

  console.log("[CAPTCHA] Fetching verify page to extract hCaptcha site key...");

  let siteKey;
  try {
    const pageRes = await fetch(verifyUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    const html = await pageRes.text();

    const skMatch =
      html.match(/data-sitekey="([^"]+)"/i) ||
      html.match(/"sitekey"\s*:\s*"([^"]+)"/i) ||
      html.match(/sitekey=([a-f0-9-]{36})/i);

    if (!skMatch) {
      console.error("[CAPTCHA] Could not find hCaptcha site key in page");
      return false;
    }
    siteKey = skMatch[1];
    console.log(`[CAPTCHA] Found site key: ${siteKey}`);
  } catch (err) {
    console.error("[CAPTCHA] Failed to fetch verify page:", err.message);
    return false;
  }

  console.log("[CAPTCHA] Submitting task to Capsolver...");
  let taskId;
  try {
    const createRes = await fetch("https://api.capsolver.com/createTask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: CAPTCHA_API_KEY,
        task: {
          type: "HCaptchaTaskProxyLess",
          websiteURL: verifyUrl,
          websiteKey: siteKey,
        },
      }),
    });
    const createData = await createRes.json();
    if (createData.errorId !== 0) {
      console.error("[CAPTCHA] Capsolver createTask error:", createData.errorDescription);
      return false;
    }
    taskId = createData.taskId;
    console.log(`[CAPTCHA] Task created: ${taskId}`);
  } catch (err) {
    console.error("[CAPTCHA] Failed to create Capsolver task:", err.message);
    return false;
  }

  console.log("[CAPTCHA] Polling for solution...");
  let token = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const resultRes = await fetch("https://api.capsolver.com/getTaskResult", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: CAPTCHA_API_KEY,
          taskId,
        }),
      });
      const resultData = await resultRes.json();
      if (resultData.status === "ready") {
        token = resultData.solution?.gRecaptchaResponse || resultData.solution?.token;
        console.log("[CAPTCHA] Got solution token!");
        break;
      } else if (resultData.status === "processing") {
        console.log(`[CAPTCHA] Still processing... (attempt ${attempt + 1}/30)`);
      } else {
        console.error("[CAPTCHA] Unexpected status:", resultData.status);
        return false;
      }
    } catch (err) {
      console.error("[CAPTCHA] Poll error:", err.message);
    }
  }

  if (!token) {
    console.error("[CAPTCHA] Timed out waiting for solution");
    return false;
  }

  console.log("[CAPTCHA] Submitting solution to Poketwo...");
  try {
    const submitRes = await fetch(verifyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      body: new URLSearchParams({ "h-captcha-response": token }).toString(),
    });
    if (submitRes.ok || submitRes.status === 302) {
      console.log("[CAPTCHA] Solution submitted successfully!");
      return true;
    } else {
      console.warn("[CAPTCHA] Submit returned status:", submitRes.status);
      return false;
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
  if (message.author.id === client.user.id) {
    if (message.content.toLowerCase() === WAKE_COMMAND) {
      wakeUp();
    }
    return;
  }

  if (message.author.id === POKETWO_BOT_ID && isCaptchaMessage(message.content)) {
    goToSleep();

    if (!solvingCaptcha && CAPTCHA_API_KEY) {
      solvingCaptcha = true;
      const verifyUrl = extractVerifyUrl(message.content);

      if (verifyUrl) {
        console.log(`[CAPTCHA] Verify URL found: ${verifyUrl}`);
        const solved = await solveCaptchaWithCapsolver(verifyUrl);

        if (solved) {
          console.log("[CAPTCHA] Auto-solve succeeded! Waking bot and sending Quaxly wake triggers...");
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
          console.log(`[CAPTCHA] Auto-solve failed. Manually solve at: ${verifyUrl}`);
          console.log(`[CAPTCHA] Then send "${WAKE_COMMAND}" in any channel to resume.`);
          solvingCaptcha = false;
        }
      } else {
        console.log("[CAPTCHA] No verify URL in message — waiting for manual solve.");
        console.log(`[CAPTCHA] Send "${WAKE_COMMAND}" after completing captcha.`);
        solvingCaptcha = false;
      }
    }

    return;
  }

  if (sleeping) return;

  if (message.channel.id === POKETWO_CHANNEL_ID) {
    console.log(`[DEBUG] Message in pokemon channel | author: ${message.author.id} (${message.author.username}) | content: "${message.content}"`);
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
    if (sleeping) return;
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
