// 영어 글쓰기 연습 앱(hdd-bit/eng)용 중간 다리.
// 학생 글과 학년만 받아서, 비밀로 저장된 GEMINI_API_KEY로 Gemini에 검사를 맡기고 결과만 돌려준다.
// 키는 Supabase Edge Function 비밀(GEMINI_API_KEY)에만 있고 브라우저로 나가지 않는다.

const ALLOWED = [/^https:\/\/hdd-bit\.github\.io$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];
const MAX_CHARS = 3000;

const MODELS: { id: string; think: string | null }[] = [
  { id: "gemini-3.5-flash-lite", think: null },
  { id: "gemini-3.6-flash", think: "minimal" },
  { id: "gemini-3.8-flash", think: "low" },
  { id: "gemini-flash-latest", think: "low" },
];

function cors(origin: string | null) {
  const ok = origin && ALLOWED.some((r) => r.test(origin));
  return {
    "Access-Control-Allow-Origin": ok ? origin! : "https://hdd-bit.github.io",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
    "Vary": "Origin",
  };
}

// 학년별 검사 범위
function scope(g: number) {
  if (g <= 2) return "아주 기초만 봐: 문장 첫 글자 대문자, 문장 끝 마침표/물음표, 나를 뜻하는 I는 대문자, 쉬운 단어 철자, 단어 사이 띄어쓰기.";
  if (g <= 4) return "기초 + 초급 문법을 봐: 대문자, 문장부호, 철자, 띄어쓰기, a/an, 복수형 -s, be동사(am/is/are/was/were), 기본 현재/과거 시제.";
  return "기초 + 문법을 봐: 대문자, 문장부호, 철자, 띄어쓰기, 시제(불규칙 과거형 포함), 주어-동사 수 일치, 관사(a/an/the), 전치사, 어순, 빠진 단어, 축약형 아포스트로피.";
}

// 글이 길수록 더 많이 짚도록 상한을 늘린다 (앞부분만 보고 끝나지 않게)
function maxErrors(g: number, words: number) {
  const base = g <= 2 ? 3 : g <= 4 ? 5 : 8;
  return Math.min(20, base + Math.floor(words / 40) * 2);
}

function sysPrompt(g: number, cap: number, skip: string[]) {
  return `너는 한국 초등학교 ${g}학년 학생의 영어 글을 봐 주는 친절한 선생님이야.
학생 글에서 '틀린 것'만 찾아. ${scope(g)}

먼저 글 전체를 첫 문장부터 마지막 문장까지 한 문장씩 빠짐없이 살펴봐. 앞부분에서 멈추지 말 것.
고칠 곳은 최대 ${cap}개. 틀린 곳이 ${cap}개보다 많으면, 글 전체에 고르게 퍼지도록 고르고 같은 종류 실수보다 다른 종류 실수를 먼저 고른다.

규칙:
- 실제로 틀린 것만 고른다. 더 자연스러운 표현 제안, 내용 평가, 문체 바꾸기는 하지 않는다. 사람 이름은 건드리지 않는다.
- wrong: 학생 글에서 '그대로 복사한' 부분. 대소문자·문장부호·띄어쓰기까지 똑같이. 틀린 곳이 들어간 가장 짧은 덩어리(1~4단어).
- correct: wrong을 바르게 고친 것.
- 문장 끝 문장부호가 빠졌으면 wrong은 그 문장의 마지막 단어, correct는 그 단어+문장부호.
- 단어가 빠졌으면 wrong은 빠진 자리 앞뒤 단어, correct는 빠진 단어를 넣은 것.
- hint: 한국어로만, ${g}학년이 알아듣는 쉬운 말, 35자 이내. 스스로 찾을 수 있게 묻는 말로 쓴다.
  힌트 안에 고친 단어, 넣을 단어, 지울 단어를 절대 쓰지 않는다(영어 단어 금지). 무엇을 살펴볼지만 알려준다.
  좋은 예) "문장을 시작할 때 첫 글자는 어떻게 써야 할까요?", "어제 일이에요. 동사 모양을 살펴볼까요?", "도시 이름 앞에 꼭 필요한 말일까요?"
  나쁜 예) "the를 빼야 해요", "went로 바꿔요"
- 같은 실수가 여러 번 나오면 각각 따로 적는다(상한 안에서). 글에 나오는 순서대로 적는다.
- good: 이 글에서 잘한 점 한 가지를 한국어로 칭찬하는 짧은 한 문장.
- 글이 영어가 아니면 notEnglish를 true로 하고 errors는 빈 배열.${skip.length ? `
- 학생이 '맞게 쓴 것'이라고 넘긴 표현들이야. 이 표현과 같은 부분은 다시 지적하지 마: ${skip.map((x) => `"${x}"`).join(", ")}` : ""}`;
}

const SCHEMA = {
  type: "OBJECT",
  properties: {
    notEnglish: { type: "BOOLEAN" },
    good: { type: "STRING" },
    errors: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { wrong: { type: "STRING" }, correct: { type: "STRING" }, hint: { type: "STRING" } },
        required: ["wrong", "correct", "hint"],
      },
    },
  },
  required: ["errors", "good"],
};

function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  const h = cors(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, h);

  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return json({ error: "NOKEY", detail: "GEMINI_API_KEY 비밀이 없음" }, 500, h);

  let text = "", grade = 3, skip: string[] = [];
  try {
    const b = await req.json();
    text = String(b.text ?? "").trim().slice(0, MAX_CHARS);
    grade = Math.min(6, Math.max(1, Number(b.grade) || 3));
    if (Array.isArray(b.skip)) skip = b.skip.slice(0, 30).map((x: unknown) => String(x).replace(/["\n]/g, " ").slice(0, 60)).filter(Boolean);
  } catch {
    return json({ error: "BAD", detail: "잘못된 요청" }, 400, h);
  }
  if (!text) return json({ error: "BAD", detail: "글이 비어 있음" }, 400, h);

  const words = text.split(/\s+/).filter(Boolean).length;
  const cap = maxErrors(grade, words);

  let last = "ERR", detail = "";
  for (const { id, think } of MODELS) {
    const body = {
      systemInstruction: { parts: [{ text: sysPrompt(grade, cap, skip) }] },
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
        responseSchema: SCHEMA,
        ...(think ? { thinkingConfig: { thinkingLevel: think } } : {}),
      },
    };
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${id}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25000),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        detail = `${id} · ${r.status} · ${t.replace(/\s+/g, " ").slice(0, 160)}`;
        if (r.status === 429 || r.status >= 500) { last = "BUSY"; continue; }
        if (r.status === 401 || r.status === 403 || (r.status === 400 && /api.?key/i.test(t))) {
          return json({ error: "KEY", detail }, 502, h);
        }
        last = "HTTP"; continue;
      }
      const j = await r.json();
      const out = (j.candidates?.[0]?.content?.parts || []).filter((p: any) => !p.thought).map((p: any) => p.text || "").join("");
      if (!out) { detail = `${id} · 빈 응답 · ${j.candidates?.[0]?.finishReason || ""}`; continue; }
      const parsed = JSON.parse(out);
      if (Array.isArray(parsed.errors)) parsed.errors = parsed.errors.slice(0, cap);
      return json({ ...parsed, model: id }, 200, h);
    } catch (e) {
      const name = (e as Error).name;
      detail = `${id} · ${name === "TimeoutError" ? "25초 안에 답이 없음" : (e as Error).message}`;
      if (name === "TimeoutError") last = "TIMEOUT";
    }
  }
  return json({ error: last, detail }, 502, h);
});
