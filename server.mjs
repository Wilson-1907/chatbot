import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import pdf from "pdf-parse";
import Groq from "groq-sdk";
import * as cheerio from "cheerio";
import puppeteer from "puppeteer";
import playwright from "playwright";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PDF_FILES = ["rules.pdf", "handbook.pdf", "regulations.pdf", "student_portal_guide_september_2021.pdf"];
const UNIVERSITY_URL = "https://karu.ac.ke";
const MODEL = process.env.MODEL || "llama-3.3-70b-versatile";

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

const groq = new Groq({ apiKey: GROQ_API_KEY });

const STOPWORDS = new Set([
  "the", "is", "are", "was", "were", "what", "where", "when", "how",
  "why", "who", "which", "and", "or", "to", "of", "in", "on", "for",
  "with", "about", "can", "could", "should", "would", "a", "an", "be",
  "at", "by", "from", "as", "it", "if", "that", "this", "have", "has",
  "do", "does", "did", "will", "shall", "may", "might", "must", "any",
  "hi", "hello", "hey", "thanks", "thank", "you", "your", "me", "my"
]);

const GREETING_PATTERNS = {
  hello: /^(hello|hi|hey|greetings|good morning|good afternoon|good evening|howdy)$/i,
  thanks: /^(thank you|thanks|thankyou|thx|appreciate|appreciate it)$/i,
  howAreYou: /(how are you|how are you doing|how's it going|what's up|how ya doing)/i
};

let documentChunks = [];
let webContent = null;
let isReady = false;
let loadedPdfs = [];
let lastWebScrapedTime = 0;
let puppeteerBrowser = null;
let playwrightBrowser = null;

// ============================================
// LOAD PDFs
// ============================================
async function loadDocuments() {
  try {
    documentChunks = [];
    loadedPdfs = [];

    for (const pdfFile of PDF_FILES) {
      if (!fs.existsSync(pdfFile)) {
        console.warn(`⚠️ ${pdfFile} not found, skipping...`);
        continue;
      }

      console.log(`📖 Loading ${pdfFile}...`);
      const buffer = fs.readFileSync(pdfFile);
      const data = await pdf(buffer);
      const text = data.text;

      if (!text || text.trim().length === 0) {
        console.warn(`⚠️ ${pdfFile} is empty, skipping...`);
        continue;
      }

      const cleanText = text.replace(/\s+/g, " ").trim();
      const words = cleanText.split(/\s+/).filter(word => word.length > 0);
      const chunkSize = 1000;

      for (let i = 0; i < words.length; i += chunkSize) {
        const chunk = words.slice(i, i + chunkSize).join(" ");
        documentChunks.push({
          content: chunk,
          source: pdfFile,
          wordCount: chunk.split(/\s+/).length
        });
      }

      const pdfInfo = {
        name: pdfFile,
        chunks: documentChunks.filter(c => c.source === pdfFile).length,
        words: words.length
      };
      
      loadedPdfs.push(pdfInfo);
      console.log(`✅ ${pdfFile} loaded: ${pdfInfo.chunks} chunks`);
    }

    isReady = true;
    console.log(`\n✅ Documents loaded!`);
    console.log(`📊 Total chunks: ${documentChunks.length}`);
    console.log(`📚 PDFs: ${loadedPdfs.map(p => p.name).join(", ") || "None"}`);
    console.log(`🤖 Model: ${MODEL}\n`);
    return true;
  } catch (error) {
    console.error("❌ Document loading failed:", error.message);
    isReady = false;
    return false;
  }
}

// ============================================
// METHOD 1: PUPPETEER (HEAVYWEIGHT)
// ============================================
async function scrapeWithPuppeteer(url) {
  try {
    console.log(`   🤖 Method 1: Puppeteer (Full Browser)...`);

    if (!puppeteerBrowser) {
      puppeteerBrowser = await puppeteer.launch({
        headless: "new",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-extensions",
          "--no-first-run",
          "--no-default-browser-check",
          "--ignore-certificate-errors",
          "--disable-web-resources",
          "--disable-plugins",
          "--disable-extensions",
          "--proxy-server=http://127.0.0.1:8080",
        ],
        timeout: 20000
      });
    }

    const page = await puppeteerBrowser.newPage();

    // Set realistic viewport
    await page.setViewport({ width: 1920, height: 1080 });

    // Set extra headers
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache'
    });

    // Block unnecessary resources
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const resourceType = request.resourceType();
      if (['image', 'stylesheet', 'font', 'media', 'manifest'].includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Go to page with multiple waits
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

    // Wait for dynamic content
    await page.waitForTimeout(3000);

    // Scroll to load lazy-loaded content
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight);
    });

    await page.waitForTimeout(2000);

    // Extract content
    const html = await page.content();
    await page.close();

    if (!html || html.length < 500) throw new Error("Insufficient content");

    console.log(`   ✅ Puppeteer OK (${html.length} bytes)`);
    return html;
  } catch (error) {
    console.log(`   ❌ Puppeteer failed: ${error.message}`);
    return null;
  }
}

// ============================================
// METHOD 2: PLAYWRIGHT (VERY HEAVYWEIGHT)
// ============================================
async function scrapeWithPlaywright(url) {
  try {
    console.log(`   🎭 Method 2: Playwright (Advanced Browser)...`);

    if (!playwrightBrowser) {
      playwrightBrowser = await playwright.chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--ignore-certificate-errors',
          '--disable-blink-features=AutomationControlled',
        ],
        timeout: 20000
      });
    }

    const context = await playwrightBrowser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      geolocation: { latitude: -1.2921, longitude: 36.8219 }, // Kenya
      permissions: []
    });

    const page = await context.newPage();

    // Set headers
    await context.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate',
      'Cache-Control': 'no-cache'
    });

    // Navigate
    await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });

    // Wait for dynamic content
    await page.waitForTimeout(3000);

    // Scroll and load lazy content
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight);
    });

    await page.waitForTimeout(2000);

    // Extract HTML
    const html = await page.content();
    await context.close();

    if (!html || html.length < 500) throw new Error("Insufficient content");

    console.log(`   ✅ Playwright OK (${html.length} bytes)`);
    return html;
  } catch (error) {
    console.log(`   ❌ Playwright failed: ${error.message}`);
    return null;
  }
}

// ============================================
// METHOD 3: PUPPETEER WITH STEALTH
// ============================================
async function scrapeWithPuppeteerStealth(url) {
  try {
    console.log(`   🥷 Method 3: Puppeteer (Stealth Mode)...`);

    if (!puppeteerBrowser) {
      puppeteerBrowser = await puppeteer.launch({
        headless: "new",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled",
          "--disable-dev-shm-usage",
        ]
      });
    }

    const page = await puppeteerBrowser.newPage();

    // Stealth mode
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
    });

    await page.setViewport({ width: 1920, height: 1080 });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

    await page.waitForTimeout(3000);

    const html = await page.content();
    await page.close();

    if (!html || html.length < 500) throw new Error("Insufficient content");

    console.log(`   ✅ Stealth OK (${html.length} bytes)`);
    return html;
  } catch (error) {
    console.log(`   ❌ Stealth failed: ${error.message}`);
    return null;
  }
}

// ============================================
// EXTRACT CONTENT
// ============================================
function extractHtmlContent(html) {
  try {
    const $ = cheerio.load(html);

    const content = {
      title: $('title').text() || $('h1').first().text() || "Karatina University",
      headings: [],
      paragraphs: [],
      lists: [],
      tables: [],
      divs: [],
      allText: []
    };

    // Headings
    $('h1, h2, h3, h4, h5, h6').each((i, elem) => {
      const text = $(elem).text().trim();
      if (text.length > 0 && text.length < 500) {
        content.headings.push(text);
      }
    });

    // Paragraphs
    $('p').each((i, elem) => {
      const text = $(elem).text().trim();
      if (text.length > 30 && text.length < 2000) {
        content.paragraphs.push(text);
      }
    });

    // Lists
    $('li').each((i, elem) => {
      const text = $(elem).text().trim();
      if (text.length > 5 && text.length < 500) {
        content.lists.push(text);
      }
    });

    // Tables
    $('table').each((i, elem) => {
      const rows = [];
      $(elem).find('tr').each((j, row) => {
        const cols = [];
        $(row).find('td, th').each((k, col) => {
          cols.push($(col).text().trim());
        });
        if (cols.length > 0) rows.push(cols.join(' | '));
      });
      if (rows.length > 0) content.tables.push(rows.join('\n'));
    });

    // Divs with content
    $('div').each((i, elem) => {
      const text = $(elem).text().trim();
      if (text.length > 50 && text.length < 1500 && !text.includes('script')) {
        content.divs.push(text);
      }
    });

    // All visible text
    $('body *').each((i, elem) => {
      const text = $(elem).contents().filter(function() {
        return this.type === 'text';
      }).text().trim();
      
      if (text.length > 20 && text.length < 500) {
        content.allText.push(text);
      }
    });

    // Combine strategically
    const combined = [
      `KARATINA UNIVERSITY OFFICIAL WEBSITE`,
      `Title: ${content.title}`,
      `---HEADINGS---`,
      content.headings.slice(0, 30).join("\n"),
      `---LISTS---`,
      content.lists.slice(0, 25).join("\n"),
      `---PARAGRAPHS---`,
      content.paragraphs.slice(0, 25).join("\n"),
      `---TABLES---`,
      content.tables.slice(0, 5).join("\n"),
      `---CONTENT---`,
      content.divs.slice(0, 20).join("\n"),
      content.allText.slice(0, 50).join("\n")
    ]
      .filter(text => text && text.length > 0)
      .join("\n\n");

    return combined.length > 500 ? combined : null;
  } catch (error) {
    console.error(`   Error extracting: ${error.message}`);
    return null;
  }
}

// ============================================
// HEAVY WEB SCRAPING
// ============================================
async function scrapeUniversityWebsite() {
  try {
    const now = Date.now();
    if (webContent && (now - lastWebScrapedTime) < 2 * 60 * 60 * 1000) {
      console.log(`📦 Using cached web content`);
      return webContent;
    }

    console.log(`\n🌐 HEAVY WEB SCRAPING: ${UNIVERSITY_URL}...`);
    console.log(`   Trying multiple heavyweight methods...\n`);

    let html = null;

    // Try Method 1: Puppeteer
    html = await scrapeWithPuppeteer(UNIVERSITY_URL);

    // Try Method 2: Playwright
    if (!html) {
      html = await scrapeWithPlaywright(UNIVERSITY_URL);
    }

    // Try Method 3: Puppeteer Stealth
    if (!html) {
      html = await scrapeWithPuppeteerStealth(UNIVERSITY_URL);
    }

    if (!html) {
      console.log(`\n❌ All heavyweight scraping methods failed`);
      return null;
    }

    const extracted = extractHtmlContent(html);

    if (!extracted) {
      console.log(`❌ Content extraction failed`);
      return null;
    }

    webContent = extracted;
    lastWebScrapedTime = now;

    console.log(`\n✅ Web content retrieved (${extracted.length} characters)\n`);
    return extracted;

  } catch (error) {
    console.error(`❌ Heavy scraping error: ${error.message}`);
    return null;
  }
}

// ============================================
// GREETING
// ============================================
function isGreeting(message) {
  const msg = message.trim().toLowerCase();
  if (GREETING_PATTERNS.hello.test(msg)) return "greeting";
  if (GREETING_PATTERNS.thanks.test(msg)) return "thanks";
  if (GREETING_PATTERNS.howAreYou.test(msg)) return "howAreYou";
  return null;
}

function getGreetingResponse(greetingType) {
  const responses = {
    greeting: [
      "Hello! 👋 Welcome to Karatina University! I'm your AI assistant. How can I help you today?",
      "Hi there! 🎓 I'm the KARU chatbot. Ask me anything about our university!",
      "Greetings! 👨‍🎓 I'm here to answer your questions about Karatina University."
    ],
    thanks: [
      "You're welcome! 😊 Any other questions?",
      "My pleasure! 🎓 Feel free to ask anything else!",
      "Glad I could help! 💪 What else can I assist you with?"
    ],
    howAreYou: [
      "I'm doing great! 😊 Ready to help. What would you like to know?",
      "I'm functioning perfectly! 🤖 How can I assist you?",
      "I'm good! 👍 What can I help you with?"
    ]
  };
  
  const responseList = responses[greetingType] || responses.greeting;
  return responseList[Math.floor(Math.random() * responseList.length)];
}

// ============================================
// SEARCH
// ============================================
function searchRelevantChunks(query, topK = 15) {
  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter(word => word.length > 2 && !STOPWORDS.has(word));

  if (keywords.length === 0 || documentChunks.length === 0) {
    return { chunks: "", confidence: 0, sources: [] };
  }

  const scored = documentChunks.map(chunk => {
    const lowerChunk = chunk.content.toLowerCase();
    let score = 0;
    let matchedKeywords = 0;

    for (const keyword of keywords) {
      const regex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, "gi");
      const matches = (lowerChunk.match(regex) || []).length;
      
      if (matches > 0) {
        score += matches * 3;
        matchedKeywords++;
      }
    }

    if (matchedKeywords > 1) {
      score += matchedKeywords * 5;
    }

    return { ...chunk, score, matchedKeywords };
  });

  const topMatches = scored
    .sort((a, b) => b.score - a.score)
    .filter(item => item.score > 0)
    .slice(0, topK);

  if (topMatches.length === 0) {
    return { chunks: "", confidence: 0, sources: [] };
  }

  const maxScore = topMatches[0].score;
  const confidence = Math.min((maxScore / (keywords.length * 3)), 1);
  
  const combinedContent = topMatches.map(item => item.content).join("\n\n---\n\n");
  const sources = [...new Set(topMatches.map(m => m.source))];

  return {
    chunks: combinedContent,
    confidence: confidence,
    sources: sources,
    matchCount: topMatches.length
  };
}

// ============================================
// HYBRID SEARCH
// ============================================
async function hybridSearch(query) {
  console.log(`\n🔍 Search: "${query}"`);

  const localResult = searchRelevantChunks(query);
  console.log(`📚 KB: ${(localResult.confidence * 100).toFixed(1)}% (${localResult.matchCount} matches)`);
  
  if (localResult.sources.length > 0) {
    console.log(`   From: ${localResult.sources.join(", ")}`);
  }

  if (localResult.confidence > 0.15 && localResult.chunks.length > 100) {
    console.log(`✅ Using knowledge base`);
    return {
      source: "knowledge_base",
      context: localResult.chunks,
      confidence: localResult.confidence,
      sources: localResult.sources
    };
  }

  console.log(`⚠️ KB confidence low, starting heavy web scraping...`);
  const webScrapedContent = await scrapeUniversityWebsite();

  if (webScrapedContent && webScrapedContent.length > 300) {
    console.log(`✅ Using website content`);
    return {
      source: "website",
      context: webScrapedContent,
      confidence: 0.85
    };
  }

  console.log(`⚠️ Web scraping failed, using KB as fallback`);
  return {
    source: "knowledge_base",
    context: localResult.chunks,
    confidence: localResult.confidence,
    sources: localResult.sources
  };
}

// ============================================
// CHAT
// ============================================
app.post("/chat", async (req, res) => {
  try {
    if (!isReady) {
      return res.status(503).json({
        success: false,
        error: "Server initializing",
        reply: "System is loading. Please try again."
      });
    }

    const message = req.body?.message?.trim();

    if (!message) {
      return res.status(400).json({
        success: false,
        error: "Message required",
        reply: "Please ask a question."
      });
    }

    if (message.length > 1000) {
      return res.status(400).json({
        success: false,
        error: "Message too long",
        reply: "Keep it under 1000 characters."
      });
    }

    const greetingType = isGreeting(message);
    if (greetingType) {
      console.log(`👋 Greeting: ${greetingType}`);
      return res.json({
        success: true,
        reply: getGreetingResponse(greetingType),
        type: "greeting",
        university: "Karatina University",
        timestamp: new Date().toISOString()
      });
    }

    const searchResult = await hybridSearch(message);

    if (!searchResult.context || searchResult.context.length < 50) {
      console.log(`📤 Using AI general knowledge...`);

      const chatCompletion = await groq.chat.completions.create({
        messages: [
          {
            role: "system",
            content: `You are an AI assistant for Karatina University. Answer questions helpfully and professionally. If you don't know specific details, suggest visiting https://karu.ac.ke`
          },
          {
            role: "user",
            content: message
          }
        ],
        model: MODEL,
        max_tokens: 1024,
        temperature: 0.8
      });

      const reply = chatCompletion.choices[0]?.message?.content || "Unable to answer.";

      return res.json({
        success: true,
        reply: reply,
        source: "general_knowledge",
        timestamp: new Date().toISOString()
      });
    }

    console.log(`📤 Generating response from ${searchResult.source}...`);

    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: `You are an AI assistant for Karatina University. Answer based on the provided context. Be helpful and professional.`
        },
        {
          role: "user",
          content: `Context:\n${searchResult.context}\n\nQuestion: ${message}`
        }
      ],
      model: MODEL,
      max_tokens: 1024,
      temperature: 0.7
    });

    const reply = chatCompletion.choices[0]?.message?.content || "Unable to generate response.";

    console.log(`✅ Done\n`);

    return res.json({
      success: true,
      reply: reply,
      source: searchResult.source,
      sources: searchResult.sources || [],
      confidence: `${(searchResult.confidence * 100).toFixed(1)}%`,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error("❌ Error:", error.message);
    return res.status(500).json({
      success: false,
      error: "Error processing request",
      reply: "Technical issue. Please try again."
    });
  }
});

// ============================================
// SCRAPE NOW
// ============================================
app.post("/scrape-now", async (req, res) => {
  try {
    console.log(`\n🔄 Manual heavy scrape...`);
    webContent = null;
    lastWebScrapedTime = 0;
    const freshContent = await scrapeUniversityWebsite();
    
    res.json({
      success: true,
      message: "Heavy scraping completed",
      contentLength: freshContent ? freshContent.length : 0,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// KB STATUS
// ============================================
app.get("/kb-status", (req, res) => {
  res.json({
    status: isReady ? "loaded" : "loading",
    totalChunks: documentChunks.length,
    totalWords: documentChunks.reduce((sum, c) => sum + (c.wordCount || 0), 0),
    pdfsLoaded: loadedPdfs,
    webContentLength: webContent ? webContent.length : 0,
    lastWebScrape: lastWebScrapedTime ? new Date(lastWebScrapedTime).toISOString() : "Never",
    scrapingMethods: ["Puppeteer", "Playwright", "Puppeteer Stealth"]
  });
});

// ============================================
// HEALTH
// ============================================
app.get("/health", (req, res) => {
  res.json({
    status: isReady ? "healthy" : "initializing",
    ready: isReady,
    chunks: documentChunks.length,
    words: documentChunks.reduce((sum, c) => sum + (c.wordCount || 0), 0),
    pdfs: loadedPdfs.length,
    model: MODEL,
    university: "Karatina University",
    scrapingCapability: "HEAVY (Puppeteer + Playwright)"
  });
});

// ============================================
// INFO
// ============================================
app.get("/info", (req, res) => {
  res.json({
    name: "Karatina University Chatbot (KARU)",
    version: "8.0.0",
    description: "AI chatbot with HEAVY web scraping (Puppeteer + Playwright)",
    model: MODEL,
    features: [
      "Multiple PDF knowledge base",
      "Advanced semantic search",
      "HEAVY web scraping capability",
      "Puppeteer for full browser automation",
      "Playwright for advanced browser control",
      "Stealth mode for protected sites",
      "Dynamic content loading",
      "Lazy loading support",
      "AI-powered responses",
      "Greeting detection"
    ],
    heavyScrapingMethods: [
      "Method 1: Puppeteer (Full Browser Automation)",
      "Method 2: Playwright (Advanced Browser Control)",
      "Method 3: Puppeteer Stealth (Anti-Detection)"
    ],
    capabilities: [
      "JavaScript-rendered content",
      "Protected websites",
      "AJAX/Dynamic content",
      "Lazy-loaded content",
      "Anti-bot detection bypass",
      "Cookie handling",
      "Authentication flows"
    ],
    endpoints: [
      "/chat - Ask questions",
      "/health - Server status",
      "/kb-status - Knowledge base status",
      "/scrape-now - Manual heavy scrape",
      "/info - API information"
    ],
    status: isReady ? "ready" : "initializing"
  });
});

// ============================================
// 404
// ============================================
app.use((req, res) => {
  res.status(404).json({ success: false, error: "Not found" });
});

// ============================================
// CLEANUP
// ============================================
async function cleanup() {
  if (puppeteerBrowser) await puppeteerBrowser.close();
  if (playwrightBrowser) await playwrightBrowser.close();
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// ============================================
// STARTUP
// ============================================
async function startServer() {
  try {
    if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY not set");

    console.log("\n");
    console.log("╔════════════════════════════════════════════╗");
    console.log("║  Karatina University Chatbot Backend       ║");
    console.log("║    Version 8.0.0 (HEAVY WEB SCRAPING)      ║");
    console.log("╚════════════════════════════════════════════╝\n");

    console.log("🔧 Initializing...\n");
    console.log("⚠️  WARNING: Using HEAVY web scraping!");
    console.log("📦 Puppeteer + Playwright enabled\n");

    await loadDocuments();
    
    app.listen(PORT, () => {
      console.log(`\n✅ Server running on http://localhost:${PORT}\n`);
      console.log("🎓 Ready with HEAVY scraping capability!\n");
    });
  } catch (error) {
    console.error("\n❌ Startup failed:", error.message);
    process.exit(1);
  }
}

startServer();