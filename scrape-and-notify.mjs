import { chromium } from "playwright-core";
import fs from "node:fs/promises";
import path from "node:path";

// ---------- Konfigurace ----------
const URL = process.env.TARGET_URL || "https://rezidencehury.cz/cenik/";
const STATE_FILE = process.env.STATE_FILE || "/data/state.json";
const TO_EMAIL = process.env.TO_EMAIL || "jan.verner@gmail.com";
const RESEND_API_KEY = process.env.RESEND_API_KEY;
// Pokud nemas overenou vlastni domenu na Resend, musi zustat "onboarding@resend.dev"
const FROM_EMAIL = process.env.FROM_EMAIL || "Notifikator bytu <onboarding@resend.dev>";

const MAX_SCROLL_ITERATIONS = 250;
const STABLE_ROUNDS_TO_STOP = 4;
const SCROLL_WAIT_MS = 700;

// ---------- Pomocné funkce ----------

function log(...args) {
  console.log(new Date().toISOString(), "-", ...args);
}

/**
 * Otevre stranku, postupne scrolluje dokud se nenacte cely (infinite-scroll)
 * seznam bytu, a vrati kompletni viditelny text stranky.
 */
async function fetchRenderedText() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    });

    log("Nacitam stranku:", URL);
    await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 });

    // Pokusit se zavrit pripadny cookie banner, aby nezasahoval do scrollovani
    for (const text of ["Souhlasím", "Přijmout", "Rozumím", "Accept"]) {
      const btn = page.getByText(text, { exact: false }).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {});
        break;
      }
    }

    let previousHeight = 0;
    let stableRounds = 0;

    for (let i = 0; i < MAX_SCROLL_ITERATIONS; i++) {
      const currentHeight = await page.evaluate(() => document.body.scrollHeight);

      if (currentHeight === previousHeight) {
        stableRounds++;
        if (stableRounds >= STABLE_ROUNDS_TO_STOP) {
          log(`Vyska stranky stabilni ${stableRounds}x po sobe, koncim scrollovani (iterace ${i}).`);
          break;
        }
      } else {
        stableRounds = 0;
      }

      previousHeight = currentHeight;

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(SCROLL_WAIT_MS);
    }

    const bodyText = await page.evaluate(() => document.body.innerText);
    return bodyText;
  } finally {
    await browser.close();
  }
}

/**
 * Rozparsuje viditelny text stranky na jednotlive byty.
 * Kazdy byt zacina radkem s cislem bytu ve tvaru "A.101".
 * Vraci pole { unitCode, disposition, status }.
 */
function parseListings(fullText) {
  const lines = fullText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const unitCodeRegex = /^[A-ZÁ-Ž]{1,2}\.\d{2,4}$/i;
  const dispositionRegex = /^\d\+?\s*KK$/i;

  const listings = [];
  let current = null;

  for (const line of lines) {
    if (unitCodeRegex.test(line)) {
      if (current) listings.push(current);
      current = { unitCode: line, disposition: null, blockLines: [] };
      continue;
    }

    if (!current) continue;

    current.blockLines.push(line);

    if (dispositionRegex.test(line) && !current.disposition) {
      current.disposition = line.toUpperCase().replace(/\s+/g, "");
    }

    // Jakmile narazime na dalsi radek, ktery uz vypada jako novy blok
    // (napr. dalsi cislo bytu), predchozi radek uz zpracovavame vyse.
  }
  if (current) listings.push(current);

  return listings
    .filter((l) => l.disposition) // zahodit radky, kde se nepodarilo najit dispozici
    .map((l) => {
      const blockText = l.blockLines.join(" ").toUpperCase();
      let status = "VOLNY";
      if (blockText.includes("PRODÁNO") || blockText.includes("PRODANO")) {
        status = "PRODANO";
      } else if (blockText.includes("REZERVOVÁNO") || blockText.includes("REZERVOVANO")) {
        status = "REZERVOVANO";
      }
      return {
        unitCode: l.unitCode,
        disposition: l.disposition,
        status,
      };
    });
}

/**
 * Agreguje seznam bytu na pocty podle dispozice.
 * Vraci napr. { "1KK": {total, available, sold, reserved}, "2KK": {...}, ... }
 */
function aggregate(listings) {
  const result = {};
  for (const item of listings) {
    if (!result[item.disposition]) {
      result[item.disposition] = { total: 0, available: 0, sold: 0, reserved: 0 };
    }
    const bucket = result[item.disposition];
    bucket.total++;
    if (item.status === "VOLNY") bucket.available++;
    if (item.status === "PRODANO") bucket.sold++;
    if (item.status === "REZERVOVANO") bucket.reserved++;
  }
  return result;
}

function sortDispositionKeys(keys) {
  return keys.sort((a, b) => {
    const na = parseInt(a, 10);
    const nb = parseInt(b, 10);
    if (na !== nb) return na - nb;
    return a.localeCompare(b);
  });
}

async function loadPreviousState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function saveState(state) {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function buildChangeDescriptions(previous, current) {
  const changes = [];
  const keys = sortDispositionKeys(Object.keys(current));

  for (const key of keys) {
    const prev = previous?.[key] || { total: 0, available: 0, sold: 0, reserved: 0 };
    const now = current[key];

    if (now.sold > prev.sold) {
      changes.push(`prodáno ${key}`);
    }
    if (now.reserved > prev.reserved) {
      changes.push(`rezervováno ${key}`);
    }
    if (now.available > prev.available && now.total <= prev.total) {
      changes.push(`uvolněno ${key}`);
    }
    if (now.total > prev.total) {
      changes.push(`přidáno do nabídky ${key}`);
    }
  }
  return changes;
}

function buildEmailBody(current) {
  const keys = sortDispositionKeys(Object.keys(current));
  const lines = keys.map((key) => {
    const { available, total } = current[key];
    return `Počet volných ${key} ${available}/${total}`;
  });
  return lines.join("\n");
}

async function sendEmail(subjectSuffix, current) {
  if (!RESEND_API_KEY) {
    throw new Error("Chybí RESEND_API_KEY v environment variables - email nelze odeslat.");
  }

  const subject = `Změna v nabídce bytu - ${subjectSuffix}`;
  const body = `${subject}\n${buildEmailBody(current)}`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [TO_EMAIL],
      subject,
      text: body,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Resend API vratilo chybu ${response.status}: ${errText}`);
  }

  log("Email odeslan na", TO_EMAIL, "predmet:", subject);
}

// ---------- Hlavni beh ----------

async function main() {
  const fullText = await fetchRenderedText();
  const listings = parseListings(fullText);

  log(`Nalezeno ${listings.length} bytovych radku po naparsovani.`);

  if (listings.length < 10) {
    // Bezpecnostni pojistka - pokud se nepodarilo nacist rozumny pocet bytu,
    // radeji nic neporovnavat a nic neposilat, jen zalogovat problem.
    throw new Error(
      `Naparsovano jen ${listings.length} bytu - pravdepodobne se stranka nenactla spravne. Koncim bez odeslani emailu.`
    );
  }

  const current = aggregate(listings);
  const previous = await loadPreviousState();

  if (!previous) {
    log("Zadny predchozi stav nenalezen (prvni beh). Ukladam aktualni stav bez odeslani emailu.");
    await saveState(current);
    return;
  }

  const changes = buildChangeDescriptions(previous, current);

  if (changes.length === 0) {
    log("Zadna zmena oproti minulemu behu. Email se neodesila.");
    await saveState(current);
    return;
  }

  const subjectSuffix = changes.join(", ");
  await sendEmail(subjectSuffix, current);
  await saveState(current);
}

main()
  .then(() => {
    log("Hotovo.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("CHYBA:", err);
    process.exit(1);
  });
