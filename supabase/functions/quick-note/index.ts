// クイック入力アプリ用 Edge Function
// Notion の任意のデータベースへの書き込み、画像・音声の添付、OpenAI による文字起こしを行う。
//
// 使う Secrets（日記アプリと同じプロジェクトなので設定済みのものを共用）:
//   NOTION_API_KEY   … Notion インテグレーションのキー（ntn_...）
//   OPENAI_API_KEY   … OpenAI のキー（sk-...）
//   ALLOWED_EMAIL    … このアプリを使えるログイン用メールアドレス
// 任意:
//   TRANSCRIBE_MODEL      … 録音ファイルの文字起こしモデル。既定は gpt-transcribe
//   LIVE_TRANSCRIBE_MODEL … 話しながらの文字起こしモデル。既定は gpt-live-transcribe
//   いまは共通設定（app_settings: quick-note/transcribe_model, live_transcribe_model）が優先。Secrets は読めないときの予備

import { createClient } from "jsr:@supabase/supabase-js@2";

const norm = (k: string) => k.toUpperCase().replace(/[^A-Z0-9]/g, "");
function env(name: string, ...aliases: string[]): string {
  const wanted = new Set([name, ...aliases].map(norm));
  for (const [k, v] of Object.entries(Deno.env.toObject())) {
    if (wanted.has(norm(k))) return v.trim().replace(/^["']|["']$/g, "").trim();
  }
  return "";
}

const NOTION_API_KEY = env("NOTION_API_KEY", "NOTION_KEY", "NOTION_TOKEN");
const OPENAI_API_KEY = env("OPENAI_API_KEY", "OPENAI_KEY");
const ANTHROPIC_API_KEY = env("ANTHROPIC_API_KEY", "CLAUDE_API_KEY");
const ALLOWED_EMAIL = env("ALLOWED_EMAIL").toLowerCase();
const TRANSCRIBE_MODEL = env("TRANSCRIBE_MODEL") || "gpt-transcribe";
const FALLBACK_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
const LIVE_TRANSCRIBE_MODEL = env("LIVE_TRANSCRIBE_MODEL") || "gpt-live-transcribe";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const NOTION_VERSION = "2022-06-28";

// ── 全アプリ共通の設定（Supabase の app_settings テーブル）──
// AIモデルや料金単価はここから読む。1分間は使い回す。読めないときは従来の値（Secret・既定値）を使う
const SETTINGS_TTL = 60_000;
let settingsCache: { at: number; map: Record<string, unknown> } | null = null;
async function appSettings(app: string): Promise<Record<string, unknown>> {
  if (settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL) return settingsCache.map;
  const map: Record<string, unknown> = {};
  try {
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const q = `select=app,key,value&app=in.${encodeURIComponent(`("global","${app}")`)}`;
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/app_settings?${q}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (r.ok) for (const row of await r.json()) map[row.app === "global" ? `global.${row.key}` : row.key] = row.value;
    else console.error("app_settings", r.status, await r.text());
  } catch (e) { console.error("app_settings", e); }
  settingsCache = { at: Date.now(), map };
  return map;
}
async function setting(app: string, key: string, fallback: string): Promise<string> {
  const v = (await appSettings(app))[key];
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ── 共通: リトライ付き fetch（429 と 5xx は待って再試行）──
async function fetchJson(url: string, init: RequestInit, label: string, retries = 4) {
  let lastText = "";
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, init);
    if (res.ok) return res.json();
    lastText = await res.text();
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 2 ** i * 500));
      continue;
    }
    throw new HttpError(502, `${label} エラー (${res.status}): ${lastText.slice(0, 300)}`);
  }
  throw new HttpError(502, `${label} が混み合っています: ${lastText.slice(0, 200)}`);
}

// ── Notion ──
function notion(path: string, method = "GET", body?: unknown) {
  return fetchJson(
    `https://api.notion.com/v1${path}`,
    {
      method,
      headers: {
        "Authorization": `Bearer ${NOTION_API_KEY}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION,
      },
      body: body ? JSON.stringify(body) : undefined,
    },
    "Notion",
  );
}

// deno-lint-ignore no-explicit-any
const plain = (rt: any[] = []) => rt.map((t) => t.plain_text ?? t.text?.content ?? "").join("");
const cleanId = (id: unknown) => {
  const s = String(id ?? "").replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(s)) throw new HttpError(400, "データベースIDが正しくありません");
  return s;
};

// deno-lint-ignore no-explicit-any
function iconOf(obj: any): string {
  return obj?.icon?.type === "emoji" ? obj.icon.emoji : "";
}

// インテグレーションに共有されているデータベースの一覧
async function listDatabases() {
  // deno-lint-ignore no-explicit-any
  const all: any[] = [];
  let cursor: string | undefined;
  do {
    // deno-lint-ignore no-explicit-any
    const payload: any = {
      filter: { property: "object", value: "database" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: 100,
    };
    if (cursor) payload.start_cursor = cursor;
    const data = await notion("/search", "POST", payload);
    all.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor && all.length < 300);
  return all
    .filter((d) => !d.archived && !d.in_trash)
    .map((d) => ({ id: d.id, title: plain(d.title) || "（無題）", icon: iconOf(d) }));
}

// 入力画面で使うプロパティだけを返す
const SUPPORTED = new Set(["title", "date", "select", "multi_select", "checkbox", "url", "status", "files"]);
async function getSchema(databaseId: string) {
  const db = await notion(`/databases/${cleanId(databaseId)}`);
  // deno-lint-ignore no-explicit-any
  const props = Object.values(db.properties as Record<string, any>)
    .filter((p) => SUPPORTED.has(p.type))
    .map((p) => {
      const base = { id: p.id, name: p.name, type: p.type };
      if (p.type === "select" || p.type === "multi_select" || p.type === "status") {
        // deno-lint-ignore no-explicit-any
        return { ...base, options: (p[p.type].options ?? []).map((o: any) => ({ name: o.name, color: o.color })) };
      }
      return base;
    });
  return { id: db.id, title: plain(db.title) || "（無題）", icon: iconOf(db), url: db.url, properties: props };
}

// ── ファイルを Notion にアップロード（20MB まで。無料プランは 5MB まで）──
function baseMime(m: string) {
  return (m || "").split(";")[0].trim().toLowerCase();
}

async function uploadToNotion(file: File) {
  const contentType = baseMime(file.type) || "application/octet-stream";
  const created = await notion("/file_uploads", "POST", {
    filename: file.name || "file",
    content_type: contentType,
  });
  const form = new FormData();
  form.append("file", new File([await file.arrayBuffer()], file.name || "file", { type: contentType }));
  const sent = await fetchJson(
    `https://api.notion.com/v1/file_uploads/${created.id}/send`,
    {
      method: "POST",
      headers: { "Authorization": `Bearer ${NOTION_API_KEY}`, "Notion-Version": NOTION_VERSION },
      body: form,
    },
    "Notion（ファイル送信）",
    2,
  );
  return { id: sent.id ?? created.id, contentType };
}

// ── OpenAI 文字起こし ──
async function transcribeOnce(file: File, model: string, prompt: string): Promise<Response> {
  const form = new FormData();
  form.append("file", file, file.name || "audio.m4a");
  form.append("model", model);
  form.append("language", "ja");
  form.append("response_format", "json");
  if (prompt) form.append("prompt", prompt);
  return await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });
}

async function transcribe(file: File, hint = "") {
  let prompt = hint.slice(0, 1600);   // 漢方薬の名前などの用語集を含むので長め
  if (file.size > 25 * 1024 * 1024) throw new HttpError(400, "録音が長すぎます（25MBまで）");
  let model = await setting("quick-note", "transcribe_model", TRANSCRIBE_MODEL);
  for (let i = 0; i < 4; i++) {
    const res = await transcribeOnce(file, model, prompt);
    if (res.ok) {
      const data = await res.json();
      return { text: String(data.text ?? "").trim(), model };
    }
    const text = await res.text();
    // ヒントが長すぎる・受け付けられないときは、短くして→それでもだめならヒントなしでやり直す
    if (res.status === 400 && prompt && /prompt/i.test(text)) {
      prompt = prompt.length > 500 ? prompt.slice(0, 500) : "";
      continue;
    }
    // モデル名が使えないときは、安いモデルに切り替えて1回だけやり直す
    if ((res.status === 400 || res.status === 404) && /model/i.test(text) && model !== FALLBACK_TRANSCRIBE_MODEL) {
      model = FALLBACK_TRANSCRIBE_MODEL;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 2 ** i * 700));
      continue;
    }
    throw new HttpError(502, `文字起こしエラー (${res.status}): ${text.slice(0, 300)}`);
  }
  throw new HttpError(502, "文字起こしが混み合っています。少し待ってもう一度お試しください");
}

// ── 話しながらの文字起こし用の一時キー（ブラウザが OpenAI に直接つなぐため。本物のキーは渡さない）──
async function liveToken(hint: string, keywords: string[]) {
  // キーワードは1行・< > を含まないものだけ（含むと OpenAI に拒否される）
  const kw = keywords.map((k) => String(k).trim()).filter((k) => k && k.length <= 40 && !/[<>\r\n]/.test(k)).slice(0, 50);
  const liveModel = await setting("quick-note", "live_transcribe_model", LIVE_TRANSCRIBE_MODEL);
  const transcription: Record<string, unknown> = {
    model: liveModel,
    languages: ["ja"],
    delay: "low",
  };
  if (hint) transcription.prompt = hint.replace(/[\r\n]+/g, " ").slice(0, 1600);
  if (kw.length) transcription.keywords = kw;
  const session = { type: "transcription", audio: { input: { transcription, turn_detection: null } } };

  // 一時キーは10分有効にしておく（アプリが先に取っておき、録音ボタンを押したらすぐつなげるように）
  const call = (s: unknown, withExpiry: boolean) => fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(withExpiry ? { session: s, expires_after: { anchor: "created_at", seconds: 600 } } : { session: s }),
  });
  let res = await call(session, true);
  if (!res.ok && res.status === 400) res = await call(session, false);
  if (!res.ok && res.status === 400 && typeof transcription.prompt === "string" && transcription.prompt.length > 400) {
    // ヒントが長すぎて断られたら、短くしてやり直す
    transcription.prompt = transcription.prompt.slice(0, 400);
    res = await call(session, false);
  }
  if (!res.ok && res.status === 400) {
    // ヒントやキーワードが原因で断られたら、ヒントなしでやり直す
    delete transcription.prompt; delete transcription.keywords;
    res = await call(session, false);
  }
  const text = await res.text();
  if (!res.ok) throw new HttpError(502, `リアルタイム文字起こしを開始できません (${res.status}): ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  return { value: data.value ?? data.client_secret?.value, model: liveModel };
}

// ── 取り込んだ録音のまとめ（議事録アプリの「医師面談」と同じ考え方）──
const VISIT_PROMPT = `以下は製薬会社のMRが医師と面談したとき（または面談の前後に自分で吹き込んだメモ）の文字起こしです。MRがあとで見返し、Veeva（CRM）のコール記録や次回の訪問準備に使えるノートを日本語で作ってください。
文字起こしには聞き間違いが含まれることがあります。漢方薬の名前・薬剤名・疾患名は文脈から正しい表記に直してください。話されていないことは推測で足さないでください。
患者の氏名など、個人が特定できる情報は書かないでください（「70代男性」のような書き方にとどめる）。
副作用・有害事象の可能性がある発言（薬を使った患者に起きた好ましくない症状や検査値の変化など）は、小さなことでも必ず ae に抜き出してください。
施設名は、下の「施設名の候補」に当てはまるものがあればその表記で書いてください。分からなければ空にしてください。
結果は必ず save_note ツールを使って返してください（文章では答えない）。項目は次の通りです:
{
  "facility": "施設名（クリニック名・病院名だけ。分からなければ空）",
  "doctor": "診療科・先生名（分かる範囲。不明なら空）",
  "summary": "2〜4文の要約",
  "topics": [{"heading": "話題", "points": ["内容"]}],
  "reaction": ["先生の反応・関心・印象に残った発言"],
  "usage": ["処方の状況・使用経験・対象としている患者像"],
  "requests": ["先生からの依頼・質問・宿題"],
  "next": ["次回の提案・アクション"],
  "ae": ["副作用・有害事象の可能性がある発言（なければ空の配列）"],
  "veeva": "Veevaのコール記録にそのまま貼れる簡潔な記録文（200〜400字、体言止め・箇条書き可）"
}`;

// まとめの形（ツールの入力として受け取ると、必ず正しいJSONで返ってくる）
const strArr = { type: "array", items: { type: "string" } };
const NOTE_TOOL = {
  name: "save_note",
  description: "面談ノートを保存する",
  input_schema: {
    type: "object",
    properties: {
      facility: { type: "string" }, doctor: { type: "string" }, summary: { type: "string" },
      topics: { type: "array", items: { type: "object", properties: { heading: { type: "string" }, points: strArr }, required: ["heading", "points"] } },
      reaction: strArr, usage: strArr, requests: strArr, next: strArr, ae: strArr, veeva: { type: "string" },
    },
    required: ["facility", "doctor", "summary", "topics", "reaction", "usage", "requests", "next", "ae", "veeva"],
  },
};

async function summarize(transcript: string, names: string[], terms: string) {
  if (!transcript.trim()) throw new HttpError(400, "文字起こしが空です");
  const model = await setting("quick-note", "summary_model", "claude-sonnet-5-5");
  const user = `${VISIT_PROMPT}
${names.length ? `\n施設名の候補: ${names.slice(0, 80).join("、")}` : ""}${terms ? `\nよく出る言葉: ${terms.slice(0, 1500)}` : ""}

--- 文字起こし ---
${transcript.slice(0, 60000)}`;
  // ツール（save_note）で返してもらう。ツールを使わず文章で返ってきたら、JSONを探して読む。だめなら1回やり直す
  const ask = () => fetchJson("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 6000, messages: [{ role: "user", content: user }], tools: [NOTE_TOOL] }),
  }, "まとめ（Claude）", 3);
  // deno-lint-ignore no-explicit-any
  let d: any = null, result: any = null;
  for (let i = 0; i < 2 && !result; i++) {
    d = await ask();
    // deno-lint-ignore no-explicit-any
    result = (d.content ?? []).find((c: any) => c.type === "tool_use")?.input ?? null;
    if (!result) {
      // deno-lint-ignore no-explicit-any
      const raw = (d.content ?? []).map((c: any) => c.text ?? "").join("");
      const m = raw.match(/\{[\s\S]*\}/);
      try { result = m ? JSON.parse(m[0]) : null; } catch { result = null; }
    }
  }
  if (!result) throw new HttpError(502, "まとめの形式で返ってきませんでした。もう一度お試しください");
  // 料金の目安（共通設定の料金表から）
  // deno-lint-ignore no-explicit-any
  const price = ((await appSettings("quick-note"))["global.prices"] as any)?.[model];
  const usd = price ? ((d.usage?.input_tokens ?? 0) * price.in + (d.usage?.output_tokens ?? 0) * price.out) / 1e6 : null;
  return { result, usd, model };
}

// ── 保存 ──
function richText(text: string, size = 1900) {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks.map((c) => ({ type: "text", text: { content: c } }));
}
const paragraph = (t: string) => ({ object: "block", type: "paragraph", paragraph: { rich_text: richText(t) } });
// 「## 見出し」「- 箇条書き」「[ ] やること」の行は、Notionの見出し・箇条書き・ToDoにする
function textBlocks(para: string): unknown[] {
  const out: unknown[] = [];
  let buf: string[] = [];
  const flush = () => { if (buf.join("").trim()) out.push(paragraph(buf.join("\n"))); buf = []; };
  for (const line of para.split("\n")) {
    let m;
    if ((m = /^##\s+(.+)/.exec(line))) { flush(); out.push({ object: "block", type: "heading_3", heading_3: { rich_text: richText(m[1].slice(0, 1900)) } }); }
    else if ((m = /^\[ \]\s+(.+)/.exec(line))) { flush(); out.push({ object: "block", type: "to_do", to_do: { rich_text: richText(m[1]), checked: false } }); }
    else if ((m = /^[-・]\s+(.+)/.exec(line))) { flush(); out.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: richText(m[1]) } }); }
    else buf.push(line);
  }
  flush();
  return out;
}

type Attachment = { id: string; kind: "image" | "audio" | "file"; name?: string };

function attachmentBlock(a: Attachment) {
  const kind = a.kind === "image" || a.kind === "audio" ? a.kind : "file";
  return { object: "block", type: kind, [kind]: { type: "file_upload", file_upload: { id: a.id } } };
}

// deno-lint-ignore no-explicit-any
async function save(input: any) {
  const schema = await getSchema(input.databaseId);
  const text = String(input.text ?? "").replace(/\r\n/g, "\n");
  const values = (input.props ?? {}) as Record<string, unknown>;
  const attachments = (Array.isArray(input.attachments) ? input.attachments : []) as Attachment[];

  // 1行目をタイトル、2行目以降を本文にする（1行目が長いときは本文にも全文を残す）
  const lines = text.split("\n");
  const first = (lines[0] ?? "").trim();
  const TITLE_MAX = 100;
  const title = first.length > TITLE_MAX ? first.slice(0, TITLE_MAX) + "…" : first;
  const bodyLines = first.length > TITLE_MAX ? lines : lines.slice(1);
  const bodyText = bodyLines.join("\n").replace(/^\n+|\n+$/g, "");

  // deno-lint-ignore no-explicit-any
  const properties: Record<string, any> = {};
  for (const p of schema.properties) {
    const v = values[p.name];
    switch (p.type) {
      case "title":
        properties[p.name] = { title: title ? richText(title) : [] };
        break;
      case "date":
        if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) properties[p.name] = { date: { start: v } };
        break;
      case "multi_select":
        if (Array.isArray(v) && v.length) properties[p.name] = { multi_select: v.map((name) => ({ name: String(name) })) };
        break;
      case "select":
        if (typeof v === "string" && v) properties[p.name] = { select: { name: v } };
        break;
      case "status":
        if (typeof v === "string" && v) properties[p.name] = { status: { name: v } };
        break;
      case "checkbox":
        if (typeof v === "boolean") properties[p.name] = { checkbox: v };
        break;
      case "url":
        if (typeof v === "string" && v.trim()) properties[p.name] = { url: v.trim() };
        break;
    }
  }

  // 写真と録音は、DBにファイルのプロパティ（「ファイル&メディア」など）があればそこに入れる（なければ本文に貼る）
  // 「音声」「録音」という名前のファイルのプロパティがあれば、録音はそちらに分けて入れる
  const filesProps = schema.properties.filter((p) => p.type === "files");
  const audioProp = filesProps.find((p) => /音声|録音|audio|voice/i.test(p.name)) ?? filesProps[0];
  const imageProp = filesProps.find((p) => p !== audioProp && !/音声|録音|audio|voice/i.test(p.name)) ?? filesProps[0];
  const valid = attachments.filter((a) => a && typeof a.id === "string");
  const propOf = (a: Attachment) => a.kind === "image" ? imageProp : a.kind === "audio" ? audioProp : undefined;
  const inProp = new Map<string, Attachment[]>();
  for (const a of valid) {
    const p = propOf(a);
    if (p) inProp.set(p.name, [...(inProp.get(p.name) ?? []), a]);
  }
  for (const [name, list] of inProp) {
    properties[name] = {
      files: list.map((a, i) => ({
        type: "file_upload",
        file_upload: { id: a.id },
        name: (a.name || (a.kind === "image" ? `photo-${i + 1}.jpg` : `voice-${i + 1}.m4a`)).slice(0, 100),
      })),
    };
  }

  const children: unknown[] = [];
  // 段落ごとに分けて本文に入れる（空行は区切りとして扱う）
  for (const para of bodyText ? bodyText.split(/\n{2,}/) : []) {
    if (para.trim()) children.push(...textBlocks(para));
  }
  for (const a of valid) {
    if (propOf(a)) continue;   // プロパティに入れた写真・録音は本文には貼らない
    children.push(attachmentBlock(a));
  }

  const page = await notion("/pages", "POST", {
    parent: { database_id: cleanId(input.databaseId) },
    properties,
    children: children.slice(0, 100),
  });
  return { ok: true, url: page.url, id: page.id };
}

// 過去のタイトル（施設名）の一覧。よく使う順（同数なら新しい順）
async function titles(databaseId: string) {
  const count = new Map<string, number>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    // deno-lint-ignore no-explicit-any
    const payload: any = { sorts: [{ timestamp: "created_time", direction: "descending" }], page_size: 100 };
    if (cursor) payload.start_cursor = cursor;
    const data = await notion(`/databases/${cleanId(databaseId)}/query?filter_properties=title`, "POST", payload);
    for (const p of data.results) {
      // deno-lint-ignore no-explicit-any
      const tp = Object.values(p.properties as Record<string, any>).find((x) => x.type === "title");
      const t = plain(tp?.title).trim();
      if (t && t.length <= 40) count.set(t, (count.get(t) ?? 0) + 1);
    }
    pages += data.results.length;
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor && pages < 1000);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
}

// 最近作ったページ
async function recent(databaseId: string) {
  const data = await notion(`/databases/${cleanId(databaseId)}/query`, "POST", {
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: 20,
  });
  // deno-lint-ignore no-explicit-any
  return data.results.map((p: any) => {
    // deno-lint-ignore no-explicit-any
    const titleProp = Object.values(p.properties as Record<string, any>).find((x) => x.type === "title");
    return { id: p.id, url: p.url, title: plain(titleProp?.title) || "（無題）", created: p.created_time };
  });
}

// ── ログイン確認 ──
async function requireUser(req: Request) {
  if (!ALLOWED_EMAIL) throw new HttpError(500, "ALLOWED_EMAIL が設定されていません");
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "ログインしてください");
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, "ログインの期限が切れました。もう一度ログインしてください");
  if ((data.user.email ?? "").toLowerCase() !== ALLOWED_EMAIL) throw new HttpError(403, "このアカウントでは使えません");
}

function need(...keys: [string, string][]) {
  const missing = keys.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new HttpError(500, `Secrets が未設定です: ${missing.join(", ")}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    await requireUser(req);
    const ct = req.headers.get("content-type") ?? "";

    // ファイルを伴う処理（multipart/form-data）
    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const action = String(form.get("action") ?? "");
      const file = form.get("file");
      if (!(file instanceof File)) throw new HttpError(400, "ファイルがありません");
      if (action === "transcribe") {
        need(["OPENAI_API_KEY", OPENAI_API_KEY]);
        return json(await transcribe(file, String(form.get("prompt") ?? "")));
      }
      if (action === "upload") {
        need(["NOTION_API_KEY", NOTION_API_KEY]);
        return json(await uploadToNotion(file));
      }
      throw new HttpError(400, "unknown action");
    }

    const body = await req.json().catch(() => ({}));
    need(["NOTION_API_KEY", NOTION_API_KEY]);
    switch (body.action) {
      case "databases":
        return json({ databases: await listDatabases() });
      case "schema":
        return json(await getSchema(body.databaseId));
      case "save":
        return json(await save(body));
      case "summarize":
        need(["ANTHROPIC_API_KEY", ANTHROPIC_API_KEY]);
        return json(await summarize(String(body.transcript ?? ""), Array.isArray(body.names) ? body.names.map(String) : [], String(body.terms ?? "")));
      case "live_token":
        need(["OPENAI_API_KEY", OPENAI_API_KEY]);
        return json(await liveToken(String(body.prompt ?? ""), Array.isArray(body.keywords) ? body.keywords : []));
      case "titles":
        return json({ titles: await titles(body.databaseId) });
      case "recent":
        return json({ pages: await recent(body.databaseId) });
      default:
        return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
});
