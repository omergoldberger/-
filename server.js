const express = require("express");
const path = require("path");
const fs = require("fs");
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "30mb" }));

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || "claude-sonnet-5-5";
const SMART_MODEL = process.env.SMART_MODEL || "claude-opus-5-5";
const SMART_COST = parseInt(process.env.SMART_COST || "3", 10);
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || "15", 10);
const GLOBAL_DAILY_LIMIT = parseInt(process.env.GLOBAL_DAILY_LIMIT || "500", 10);
const MAX_IMAGES = 5;
const MAX_IMAGE_CHARS = 6 * 1024 * 1024;
const SITE_URL = (process.env.SITE_URL || "").replace(/\/+$/, "");
const GOOGLE_VERIFY = (process.env.GOOGLE_SITE_VERIFICATION || "").replace(/[^A-Za-z0-9_-]/g, "");
let globalUses = { day: "", n: 0 };
const uses = new Map();

function baseUrl(req) {
  return SITE_URL || req.protocol + "://" + req.get("host");
}

app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(self), microphone=()",
  });
  next();
});

app.get("/healthz", (req, res) => res.send("ok"));

app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send("User-agent: *\nAllow: /\nSitemap: " + baseUrl(req) + "/sitemap.xml\n");
});

app.get("/sitemap.xml", (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  res.type("application/xml").send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>' + baseUrl(req) + "/</loc><lastmod>" + today + "</lastmod></url></urlset>");
});

const HTML = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
function page(req, res) {
  const verify = GOOGLE_VERIFY ? '<meta name="google-site-verification" content="' + GOOGLE_VERIFY + '">' : "";
  res.type("html").send(HTML.replace(/\{\{SITE_URL\}\}/g, baseUrl(req)).replace("{{GOOGLE_VERIFY}}", verify));
}
app.get(["/", "/index.html"], page);

function allow(ip, cost) {
  const day = new Date().toISOString().slice(0, 10);
  if (globalUses.day !== day) globalUses = { day, n: 0 };
  if (globalUses.n + cost > GLOBAL_DAILY_LIMIT) return false;
  const k = ip + "|" + day;
  const n = (uses.get(k) || 0) + cost;
  if (n > DAILY_LIMIT) return false;
  uses.set(k, n);
  globalUses.n += cost;
  if (uses.size > 5000) for (const key of uses.keys()) if (!key.endsWith(day)) uses.delete(key);
  return true;
}

function buildPrompt(o) {
  const p = ["התמונות המצורפות הן צילומים של מסמך, שקופית, דף או לוח. הפק מהן טקסט נקי.", "כללים:"];
  if (o.what === "all") p.push("• תמלל את כל הטקסט הקריא בתמונה, כולל כתב יד ושוליים. התעלם רק מסרגלי כלים, שעון ולוגואים. אל תנחש טקסט לא קריא.");
  else if (o.what === "hand") p.push("• תמלל רק את הכתב היד הקריא. התעלם מטקסט מודפס או מוקרן. אל תנחש מילים לא קריאות.");
  else p.push("• תמלל רק את הטקסט הראשי והקריא בבירור (כותרת וגוף הטקסט). התעלם מאנשים וראשים בתמונה, תפריטים וסרגלי כלים, לוגואים, שעון, כתב יד חלקי או מטושטש בשוליים, ושורות מוסתרות או לא קריאות.");
  p.push("• שמור על הניסוח המקורי בדיוק. אל תתקן ואל תוסיף מילים משלך, מלבד תיקון טעויות זיהוי ברורות שנובעות מאיכות הצילום.");
  if (o.fmt === "lines") p.push("• שמור על שבירות השורות כפי שהן במקור.");
  else if (o.fmt === "bullets") p.push("• ארגן את התוכן כרשימת נקודות קצרה, כל נקודה בשורה נפרדת שמתחילה במקף ורווח, עם כותרת בראש אם יש.");
  else if (o.fmt === "sum") p.push("• במקום תמלול מלא, כתוב סיכום קצר וענייני (עד כ-120 מילים).");
  else p.push("• חלק לפסקאות לפי המבנה המקורי: שורה ריקה בין פסקאות, הכותרת בשורה נפרדת בראש. נקודות רשימה כשורות שמתחילות במקף ורווח. אל תשבור פסקה לשורות.");
  if (o.lang === "he") p.push("• כתוב את הפלט בעברית (תרגם אם צריך).");
  else if (o.lang === "en") p.push("• כתוב את הפלט באנגלית (תרגם אם צריך).");
  else p.push("• כתוב באותה שפה שבה הטקסט כתוב.");
  if (o.nik === "strip") p.push("• הסר ניקוד וטעמי מקרא.");
  p.push("• אם יש כמה תמונות, חבר אותן לפי הסדר ברצף אחד בלי לחזור על טקסט כפול.");
  if (o.smart) p.push("• מצב חכם: קרא בקפידה רבה. פענח כתב יד קשה, מילים חתוכות או מטושטשות לפי ההקשר, שמור על סדר קריאה נכון (כולל טבלאות, עמודות והערות בשוליים), ותקן רק טעויות זיהוי ברורות. מילה שאי אפשר לפענח בביטחון סמן כך: [?].");
  if (o.answer) p.push("• אם בתמונה יש שאלה, תרגיל, משימה או שאלון: אחרי התמלול הוסף שורה ריקה, אחריה שורה שכתוב בה רק: תשובה:, ואחריה תשובה מלאה, מדויקת ועניינית בשפת השאלה (בתרגיל חישובי הראה את שלבי הפתרון בקצרה). אם יש כמה שאלות, ענה על כולן לפי הסדר. אם אין שאלה בתמונה, אל תוסיף תשובה.");
  p.push("• פלט: טקסט רגיל בלבד. בלי Markdown, בלי כוכביות, בלי הקדמה ובלי הערות. אם אין טקסט קריא, כתוב רק: לא נמצא טקסט קריא.");
  return p.join("\n");
}

app.post("/api/transcribe", async (req, res) => {
  try {
    if (!KEY) return res.status(500).json({ error: "השרת לא הוגדר (חסר מפתח API)." });
    const { images, options = {} } = req.body || {};
    if (!Array.isArray(images) || !images.length || images.length > MAX_IMAGES)
      return res.status(400).json({ error: "יש לשלוח בין תמונה אחת ל-" + MAX_IMAGES + " תמונות." });
    const smart = !!options.smart;
    if (!allow(req.ip, smart ? SMART_COST : 1)) return res.status(429).json({ error: "הגעת למגבלת התמלולים היומית (או שהאתר הגיע לתקרת השימוש להיום). נסו שוב מחר." });
    const content = images.map((d) => {
      const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(d || "");
      if (!m || d.length > MAX_IMAGE_CHARS) throw new Error("bad image");
      return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
    });
    content.push({ type: "text", text: buildPrompt(options) });
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: smart ? SMART_MODEL : MODEL, max_tokens: options.answer || smart ? 6000 : 4000, messages: [{ role: "user", content }] }),
    });
    const j = await r.json();
    if (!r.ok) { console.error(j); return res.status(502).json({ error: "שגיאה בתמלול. נסו שוב." }); }
    const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    res.json({ text });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: "לא הצלחנו לקרוא את התמונה. נסו תמונה אחרת." });
  }
});

app.use(express.static(path.join(__dirname, "public"), { index: false, maxAge: "1h" }));
app.listen(process.env.PORT || 3000, () => console.log("up"));
const express = require("express");
const path = require("path");
const fs = require("fs");
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "30mb" }));

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || "claude-sonnet-5-5";
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || "15", 10);
const GLOBAL_DAILY_LIMIT = parseInt(process.env.GLOBAL_DAILY_LIMIT || "500", 10);
const MAX_IMAGES = 5;
const MAX_IMAGE_CHARS = 6 * 1024 * 1024;
const SITE_URL = (process.env.SITE_URL || "").replace(/\/+$/, "");
const GOOGLE_VERIFY = (process.env.GOOGLE_SITE_VERIFICATION || "").replace(/[^A-Za-z0-9_-]/g, "");
let globalUses = { day: "", n: 0 };
const uses = new Map();

function baseUrl(req) {
  return SITE_URL || req.protocol + "://" + req.get("host");
}

app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(self), microphone=()",
  });
  next();
});

app.get("/healthz", (req, res) => res.send("ok"));

app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send("User-agent: *\nAllow: /\nSitemap: " + baseUrl(req) + "/sitemap.xml\n");
});

app.get("/sitemap.xml", (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  res.type("application/xml").send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>' + baseUrl(req) + "/</loc><lastmod>" + today + "</lastmod></url></urlset>");
});

const HTML = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
function page(req, res) {
  const verify = GOOGLE_VERIFY ? '<meta name="google-site-verification" content="' + GOOGLE_VERIFY + '">' : "";
  res.type("html").send(HTML.replace(/\{\{SITE_URL\}\}/g, baseUrl(req)).replace("{{GOOGLE_VERIFY}}", verify));
}
app.get(["/", "/index.html"], page);

function allow(ip) {
  const day = new Date().toISOString().slice(0, 10);
  if (globalUses.day !== day) globalUses = { day, n: 0 };
  if (globalUses.n >= GLOBAL_DAILY_LIMIT) return false;
  const k = ip + "|" + day;
  const n = (uses.get(k) || 0) + 1;
  if (n > DAILY_LIMIT) return false;
  uses.set(k, n);
  globalUses.n++;
  if (uses.size > 5000) for (const key of uses.keys()) if (!key.endsWith(day)) uses.delete(key);
  return true;
}

function buildPrompt(o) {
  const p = ["התמונות המצורפות הן צילומים של מסמך, שקופית, דף או לוח. הפק מהן טקסט נקי.", "כללים:"];
  if (o.what === "all") p.push("• תמלל את כל הטקסט הקריא בתמונה, כולל כתב יד ושוליים. התעלם רק מסרגלי כלים, שעון ולוגואים. אל תנחש טקסט לא קריא.");
  else if (o.what === "hand") p.push("• תמלל רק את הכתב היד הקריא. התעלם מטקסט מודפס או מוקרן. אל תנחש מילים לא קריאות.");
  else p.push("• תמלל רק את הטקסט הראשי והקריא בבירור (כותרת וגוף הטקסט). התעלם מאנשים וראשים בתמונה, תפריטים וסרגלי כלים, לוגואים, שעון, כתב יד חלקי או מטושטש בשוליים, ושורות מוסתרות או לא קריאות.");
  p.push("• שמור על הניסוח המקורי בדיוק. אל תתקן ואל תוסיף מילים משלך, מלבד תיקון טעויות זיהוי ברורות שנובעות מאיכות הצילום.");
  if (o.fmt === "lines") p.push("• שמור על שבירות השורות כפי שהן במקור.");
  else if (o.fmt === "bullets") p.push("• ארגן את התוכן כרשימת נקודות קצרה, כל נקודה בשורה נפרדת שמתחילה במקף ורווח, עם כותרת בראש אם יש.");
  else if (o.fmt === "sum") p.push("• במקום תמלול מלא, כתוב סיכום קצר וענייני (עד כ-120 מילים).");
  else p.push("• חלק לפסקאות לפי המבנה המקורי: שורה ריקה בין פסקאות, הכותרת בשורה נפרדת בראש. נקודות רשימה כשורות שמתחילות במקף ורווח. אל תשבור פסקה לשורות.");
  if (o.lang === "he") p.push("• כתוב את הפלט בעברית (תרגם אם צריך).");
  else if (o.lang === "en") p.push("• כתוב את הפלט באנגלית (תרגם אם צריך).");
  else p.push("• כתוב באותה שפה שבה הטקסט כתוב.");
  if (o.nik === "strip") p.push("• הסר ניקוד וטעמי מקרא.");
  p.push("• אם יש כמה תמונות, חבר אותן לפי הסדר ברצף אחד בלי לחזור על טקסט כפול.");
  p.push("• פלט: טקסט רגיל בלבד. בלי Markdown, בלי כוכביות, בלי הקדמה ובלי הערות. אם אין טקסט קריא, כתוב רק: לא נמצא טקסט קריא.");
  return p.join("\n");
}

app.post("/api/transcribe", async (req, res) => {
  try {
    if (!KEY) return res.status(500).json({ error: "השרת לא הוגדר (חסר מפתח API)." });
    const { images, options = {} } = req.body || {};
    if (!Array.isArray(images) || !images.length || images.length > MAX_IMAGES)
      return res.status(400).json({ error: "יש לשלוח בין תמונה אחת ל-" + MAX_IMAGES + " תמונות." });
    if (!allow(req.ip)) return res.status(429).json({ error: "הגעת למגבלת התמלולים היומית (או שהאתר הגיע לתקרת השימוש להיום). נסו שוב מחר." });
    const content = images.map((d) => {
      const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(d || "");
      if (!m || d.length > MAX_IMAGE_CHARS) throw new Error("bad image");
      return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
    });
    content.push({ type: "text", text: buildPrompt(options) });
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 4000, messages: [{ role: "user", content }] }),
    });
    const j = await r.json();
    if (!r.ok) { console.error(j); return res.status(502).json({ error: "שגיאה בתמלול. נסו שוב." }); }
    const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    res.json({ text });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: "לא הצלחנו לקרוא את התמונה. נסו תמונה אחרת." });
  }
});

app.use(express.static(path.join(__dirname, "public"), { index: false, maxAge: "1h" }));
app.listen(process.env.PORT || 3000, () => console.log("up"));
