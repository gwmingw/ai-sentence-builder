import json
import os
import random
import re
import time
from typing import Any

from flask import Flask, jsonify, render_template, request

try:
    from dotenv import load_dotenv

    load_dotenv(encoding="utf-8-sig")
except ImportError:
    pass


app = Flask(__name__, static_folder="public/static", static_url_path="/static")

DEFAULT_MODEL = os.getenv("UPSTAGE_MODEL", "solar-mini")
DEFAULT_TEMPERATURE = float(os.getenv("DEFAULT_TEMPERATURE", "0.8"))
MAX_CANDIDATES = int(os.getenv("MAX_CANDIDATES", "6"))
MAX_STEPS = int(os.getenv("MAX_STEPS", "5"))
MAX_PROMPT_CHARS = int(os.getenv("MAX_PROMPT_CHARS", "180"))
CACHE_TTL_SECONDS = int(os.getenv("CACHE_TTL_SECONDS", "90"))

_CACHE: dict[str, tuple[float, list[dict[str, Any]]]] = {}

BLOCKED_WORDS = {
    "죽",
    "살인",
    "자살",
    "폭력",
    "피",
    "귀신",
    "욕",
}

AWKWARD_ENDINGS = (
    "다",
    "했다",
    "한다",
    "이었다",
    "였다",
    "있다",
    "없다",
    "간다",
    "온다",
    "먹는다",
    "본다",
)

FALLBACK_POOLS = [
    ("모험", ["신기한 문을 열었어요", "반짝이는 길을 따라갔어요", "새로운 친구를 만났어요"]),
    ("학교", ["친구와 함께 웃었어요", "재미있는 일이 생겼어요", "선생님께 질문했어요"]),
    ("상상", ["구름 위로 올라갔어요", "작은 별을 발견했어요", "비밀 지도를 펼쳤어요"]),
    ("따뜻함", ["모두 함께 박수를 쳤어요", "마음이 포근해졌어요", "서로 도와주기로 했어요"]),
    ("놀라움", ["갑자기 빛이 반짝였어요", "작은 소리가 들렸어요", "상자 안에서 편지가 나왔어요"]),
    ("유머", ["모두 깜짝 웃었어요", "이상한 춤을 추기 시작했어요", "말도 안 되는 일이 벌어졌어요"]),
    ("궁금함", ["그 이유가 궁금해졌어요", "조심스럽게 다가갔어요", "다음 단서를 찾아봤어요"]),
    ("우정", ["친구가 손을 내밀었어요", "함께 방법을 생각했어요", "서로의 이야기를 들어줬어요"]),
]


@app.get("/")
def index():
    return render_template(
        "index.html",
        max_steps=MAX_STEPS,
        max_candidates=min(MAX_CANDIDATES, 8),
    )


@app.get("/health")
def health():
    return jsonify({"ok": True, "model": DEFAULT_MODEL})


@app.post("/api/candidates")
def candidates():
    payload = request.get_json(silent=True) or {}
    text = normalize_text(str(payload.get("text", "")))
    temperature = clamp_float(payload.get("temperature", DEFAULT_TEMPERATURE), 0.2, 1.4)
    count = clamp_int(payload.get("count", MAX_CANDIDATES), 4, 6)
    step = clamp_int(payload.get("step", 0), 0, MAX_STEPS)

    if len(text) > MAX_PROMPT_CHARS:
        return (
            jsonify(
                {
                    "ok": False,
                    "message": f"문장이 너무 길어요. {MAX_PROMPT_CHARS}자 안에서 이어가 볼까요?",
                    "candidates": build_fallback_candidates(text, count, temperature),
                    "source": "fallback",
                }
            ),
            400,
        )

    if not text:
        text = random.choice(EXAMPLE_STARTERS)

    cache_key = json.dumps(
        {"text": text, "temperature": round(temperature, 2), "count": count, "step": step},
        ensure_ascii=False,
        sort_keys=True,
    )
    cached = _CACHE.get(cache_key)
    if cached and time.time() - cached[0] < CACHE_TTL_SECONDS:
        return jsonify({"ok": True, "candidates": cached[1], "source": "cache"})

    try:
        generated = generate_with_solar(text=text, temperature=temperature, count=count, step=step)
        clean = sanitize_candidates(generated, count=count)
        if not clean:
            raise ValueError("Solar returned no usable candidates")
        if len(clean) < count:
            clean = fill_missing_candidates(clean, text, count, temperature)
        _CACHE[cache_key] = (time.time(), clean)
        return jsonify({"ok": True, "candidates": clean, "source": "solar"})
    except Exception as exc:
        app.logger.warning("candidate generation fell back: %s", exc)
        fallback = build_fallback_candidates(text, count, temperature)
        return jsonify({"ok": True, "candidates": fallback, "source": "fallback"})


EXAMPLE_STARTERS = [
    "오늘 학교에 갔는데",
    "우주선을 타고",
    "내 친구 로봇은",
    "마법의 문을 열자",
    "급식실에서 이상한 일이",
    "운동장 한가운데에",
]


def generate_with_solar(text: str, temperature: float, count: int, step: int) -> list[dict[str, Any]]:
    api_key = os.getenv("UPSTAGE_API_KEY")
    if not api_key:
        raise RuntimeError("UPSTAGE_API_KEY is not configured")

    from openai import OpenAI

    client = OpenAI(api_key=api_key, base_url="https://api.upstage.ai/v1")
    system_prompt = (
        "당신은 초등학생을 위한 AI 문장 이어가기 부스의 후보 생성기입니다. "
        "현재 문장 뒤에 띄어쓰기 하나만 넣고 바로 붙였을 때 자연스러운 짧고 안전한 한국어 표현을 만듭니다. "
        "문체는 초등학생에게 친근한 존댓말 동화체로 통일합니다. "
        "후보 text는 반드시 '-어요', '-아요', '-했어요', '-였어요', '-됐어요'처럼 부드러운 문장형으로 끝내세요. "
        "딱딱한 설명체, 뉴스체, '-다'로 끝나는 문어체, 명사만 있는 조각 표현은 쓰지 마세요. "
        "현재 문장을 반복하거나 현재 문장을 다시 말하지 마세요. "
        "후보는 서로 달라야 하고, 무섭거나 폭력적이거나 부적절한 내용은 피합니다. "
        "실제 확률이 아니라 어린이가 이해하기 쉬운 상대 점수 score를 55부터 98 사이 정수로 줍니다. "
        "반드시 JSON만 출력하세요."
    )
    user_prompt = {
        "current_sentence": text,
        "candidate_count": count,
        "student_level": "elementary school",
        "step": step,
        "style_rules": [
            "현재 문장 뒤에 바로 이어 붙여도 어색하지 않아야 함",
            "존댓말 동화체 사용",
            "text는 2~5어절",
            "text는 '-어요' 또는 '-아요' 계열로 끝남",
            "현재 문장과 같은 말을 반복하지 않음",
            "예: 현재 문장이 '오늘 학교에 갔는데'라면 '친구들이 활짝 웃고 있었어요'처럼 이어짐",
            "나쁜 예: '하늘이 맑다', '학교 생활', '오늘 학교에 갔는데 친구를 만났어요'",
        ],
        "output_schema": {
            "candidates": [
                {
                    "text": "현재 문장 뒤에 바로 붙일 2~5어절 존댓말 동화체 표현",
                    "score": "55~98 사이 정수",
                    "tone": "모험/학교/상상/따뜻함/놀라움/유머/궁금함/우정 중 하나",
                    "why": "15자 안팎의 쉬운 이유",
                }
            ]
        },
    }

    response = client.chat.completions.create(
        model=DEFAULT_MODEL,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(user_prompt, ensure_ascii=False)},
        ],
        temperature=temperature,
        max_tokens=650,
        stream=False,
    )
    content = response.choices[0].message.content or ""
    parsed = extract_json(content)
    return parsed.get("candidates", [])


def extract_json(content: str) -> dict[str, Any]:
    content = content.strip()
    if content.startswith("```"):
        content = re.sub(r"^```(?:json)?", "", content).strip()
        content = re.sub(r"```$", "", content).strip()
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", content, re.DOTALL)
        if not match:
            raise
        return json.loads(match.group(0))


def sanitize_candidates(raw_candidates: list[dict[str, Any]], count: int) -> list[dict[str, Any]]:
    cleaned: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw_candidates:
        text = normalize_text(str(item.get("text", "")))
        text = trim_candidate_text(text)
        if not text or text in seen or is_blocked(text) or is_awkward_candidate(text):
            continue
        score = clamp_int(item.get("score", 70), 55, 98)
        tone = normalize_text(str(item.get("tone", "상상")))[:8] or "상상"
        why = normalize_text(str(item.get("why", "자연스럽게 이어져요")))[:24]
        cleaned.append({"text": text, "score": score, "tone": tone, "why": why})
        seen.add(text)
        if len(cleaned) >= count:
            break
    return cleaned


def build_fallback_candidates(text: str, count: int, temperature: float) -> list[dict[str, Any]]:
    rng = random.Random(f"{text}|{round(temperature, 2)}|{time.time() // 30}")
    pool = FALLBACK_POOLS[:]
    rng.shuffle(pool)
    candidates: list[dict[str, Any]] = []
    base_score = 92
    for tone, phrases in pool:
        choices = phrases[:]
        rng.shuffle(choices)
        for phrase in choices:
            if len(candidates) >= count:
                return candidates
            score = max(55, base_score - len(candidates) * rng.randint(3, 7))
            candidates.append(
                {
                    "text": phrase,
                    "score": score,
                    "tone": tone,
                    "why": "쉽게 이어져요",
                }
            )
    return candidates[:count]


def fill_missing_candidates(
    candidates: list[dict[str, Any]], text: str, count: int, temperature: float
) -> list[dict[str, Any]]:
    seen = {item["text"] for item in candidates}
    for item in build_fallback_candidates(text, count, temperature):
        if item["text"] in seen:
            continue
        candidates.append(item)
        seen.add(item["text"])
        if len(candidates) >= count:
            break
    return candidates[:count]


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def trim_candidate_text(value: str) -> str:
    value = value.strip(" .,!?;:。！？")
    words = value.split()
    if len(words) > 5:
        value = " ".join(words[:5])
    return value[:40]


def is_awkward_candidate(value: str) -> bool:
    compact = value.strip()
    if any(compact.endswith(ending) for ending in AWKWARD_ENDINGS):
        return True
    if len(compact.split()) < 2:
        return True
    return False


def is_blocked(value: str) -> bool:
    lowered = value.lower()
    return any(word in lowered for word in BLOCKED_WORDS)


def clamp_int(value: Any, low: int, high: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = low
    return max(low, min(high, parsed))


def clamp_float(value: Any, low: float, high: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = low
    return max(low, min(high, parsed))


if __name__ == "__main__":
    app.run(debug=True, port=int(os.getenv("PORT", "5000")))
