const config = window.BOOTH_CONFIG || { maxSteps: 5, maxCandidates: 6 };

const starters = [
  "오늘 학교에 갔는데",
  "우주선을 타고",
  "내 친구 로봇은",
  "마법의 문을 열자",
  "급식실에서 이상한 일이",
  "운동장 한가운데에"
];

const state = {
  story: "",
  history: [],
  candidates: [],
  step: 0,
  finished: false,
  loading: false,
  lastActivity: Date.now()
};

const els = {
  starterForm: document.querySelector("#starterForm"),
  starterInput: document.querySelector("#starterInput"),
  starterChips: document.querySelector("#starterChips"),
  storyTitle: document.querySelector("#storyTitle"),
  storyText: document.querySelector("#storyText"),
  candidateZone: document.querySelector(".candidate-zone"),
  candidateGrid: document.querySelector("#candidateGrid"),
  storyStage: document.querySelector(".story-stage"),
  progressFill: document.querySelector("#progressFill"),
  progressLabel: document.querySelector("#progressLabel"),
  temperatureRange: document.querySelector("#temperatureRange"),
  refreshButton: document.querySelector("#refreshButton"),
  undoButton: document.querySelector("#undoButton"),
  autoPickButton: document.querySelector("#autoPickButton"),
  resetButton: document.querySelector("#resetButton"),
  finishResetButton: document.querySelector("#finishResetButton"),
  finishPanel: document.querySelector("#finishPanel"),
  finalStory: document.querySelector("#finalStory"),
  sourceLabel: document.querySelector("#sourceLabel")
};

const cardClasses = ["mint", "sky", "lemon", "lavender", "peach"];

function init() {
  renderStarterChips();
  render();
  bindEvents();
  setInterval(checkIdleReset, 5000);
}

function bindEvents() {
  els.starterForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = els.starterInput.value.trim();
    if (!text) return;
    startStory(text);
  });

  els.refreshButton.addEventListener("click", () => {
    if (state.story && !state.loading) fetchCandidates();
  });

  els.undoButton.addEventListener("click", undo);
  els.autoPickButton.addEventListener("click", autoPick);
  els.resetButton.addEventListener("click", reset);
  els.finishResetButton.addEventListener("click", reset);

  document.addEventListener("click", markActivity);
  document.addEventListener("keydown", markActivity);
}

function renderStarterChips() {
  els.starterChips.innerHTML = "";
  starters.forEach((starter) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip-button";
    button.textContent = starter;
    button.addEventListener("click", () => startStory(starter));
    els.starterChips.appendChild(button);
  });
}

function startStory(text) {
  state.story = text;
  state.history = [text];
  state.step = 0;
  state.candidates = [];
  state.finished = false;
  els.starterInput.value = "";
  els.finishPanel.hidden = true;
  markActivity();
  render();
  fetchCandidates();
}

async function fetchCandidates() {
  if (!state.story) return;
  setLoading(true);
  let shouldScroll = false;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 18000);
  try {
    const response = await fetch("/api/candidates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        text: state.story,
        temperature: Number(els.temperatureRange.value),
        count: config.maxCandidates,
        step: state.step
      })
    });
    const data = await response.json();
    state.candidates = Array.isArray(data.candidates) ? data.candidates : [];
    els.sourceLabel.textContent = sourceText(data.source);
    shouldScroll = true;
  } catch (error) {
    state.candidates = localFallback();
    els.sourceLabel.textContent = "준비된 후보";
    shouldScroll = true;
  } finally {
    window.clearTimeout(timeoutId);
    setLoading(false);
    render();
    if (shouldScroll) scrollCandidatesIntoView();
  }
}

function chooseCandidate(candidate) {
  if (state.loading || !candidate?.text) return;
  const nextStory = joinStory(state.story, candidate.text);
  state.story = nextStory;
  state.step += 1;
  state.history.push(nextStory);
  markActivity();

  if (state.step >= config.maxSteps) {
    state.candidates = [];
    state.finished = true;
    render();
    showFinish();
    return;
  }

  render();
  fetchCandidates();
}

function autoPick() {
  if (!state.candidates.length || state.loading) return;
  const sorted = [...state.candidates].sort((a, b) => Number(b.score) - Number(a.score));
  chooseCandidate(sorted[0]);
}

function undo() {
  if (state.loading || state.history.length <= 1) return;
  state.history.pop();
  state.story = state.history[state.history.length - 1];
  state.step = Math.max(0, state.step - 1);
  state.finished = false;
  els.finishPanel.hidden = true;
  markActivity();
  render();
  fetchCandidates();
}

function reset() {
  state.story = "";
  state.history = [];
  state.candidates = [];
  state.step = 0;
  state.finished = false;
  els.finishPanel.hidden = true;
  els.sourceLabel.textContent = "준비 완료";
  markActivity();
  render();
}

function render() {
  document.body.classList.toggle("has-story", Boolean(state.story));
  document.body.classList.toggle("is-finished", state.finished);
  els.finishPanel.hidden = !state.finished;
  renderStory();
  renderProgress();
  renderCandidates();
  renderButtons();
}

function renderStory() {
  if (!state.story) {
    els.storyTitle.textContent = "시작 문장을 골라볼까요?";
    els.storyText.textContent = "";
    els.storyText.classList.remove("story-text-pop");
    return;
  }
  els.storyTitle.textContent = "지금까지 만든 문장";
  els.storyText.textContent = state.story;
  replayStoryAnimation();
}

function replayStoryAnimation() {
  els.storyText.classList.remove("story-text-pop");
  void els.storyText.offsetWidth;
  els.storyText.classList.add("story-text-pop");
}

function renderProgress() {
  const percent = Math.min(100, (state.step / config.maxSteps) * 100);
  els.progressFill.style.width = `${percent}%`;
  els.progressLabel.textContent = `${state.step} / ${config.maxSteps}`;
}

function renderCandidates() {
  els.candidateGrid.innerHTML = "";

  if (!state.story) {
    els.candidateGrid.appendChild(emptyMessage("시작 문장을 고르면 AI가 다음 말을 보여줘요."));
    return;
  }

  if (state.loading) {
    const loadingMessage = document.createElement("div");
    loadingMessage.className = "candidate-loading";
    loadingMessage.setAttribute("role", "status");
    loadingMessage.setAttribute("aria-live", "polite");
    loadingMessage.innerHTML = `
      <span class="dot-row" aria-hidden="true"><i></i><i></i><i></i></span>
      <strong>AI가 다음 말을 생각하고 있어요</strong>
    `;
    els.candidateGrid.appendChild(loadingMessage);
    for (let index = 0; index < 6; index += 1) {
      const skeleton = document.createElement("div");
      skeleton.className = "candidate-card skeleton";
      els.candidateGrid.appendChild(skeleton);
    }
    return;
  }

  if (!state.candidates.length) {
    els.candidateGrid.appendChild(emptyMessage("다시 추천을 눌러 후보를 불러와요."));
    return;
  }

  state.candidates.forEach((candidate, index) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `candidate-card ${cardClasses[index % cardClasses.length]}`;
    card.addEventListener("click", () => chooseCandidate(candidate));

    const score = Math.max(55, Math.min(98, Number(candidate.score) || 70));
    card.innerHTML = `
      <span class="candidate-tone">${escapeHtml(candidate.tone || "상상")}</span>
      <strong>${escapeHtml(candidate.text)}</strong>
      <span class="candidate-why">${escapeHtml(candidate.why || "자연스럽게 이어져요")}</span>
      <span class="score-row">
        <span>AI 예상 ${score}</span>
        <span class="score-track"><span style="width:${score}%; --score:${score}%"></span></span>
      </span>
    `;
    els.candidateGrid.appendChild(card);
  });
}

function renderButtons() {
  const hasStory = Boolean(state.story);
  els.refreshButton.disabled = !hasStory || state.loading;
  els.undoButton.disabled = state.history.length <= 1 || state.loading;
  els.autoPickButton.disabled = !state.candidates.length || state.loading;
}

function showFinish() {
  renderFinalStory();
  els.finishPanel.hidden = false;
  els.sourceLabel.textContent = "이야기 완성";
  requestAnimationFrame(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

function renderFinalStory() {
  const segments = buildStorySegments();
  els.finalStory.innerHTML = "";
  segments.forEach((segment, index) => {
    const line = document.createElement("p");
    line.className = "final-story-line";
    line.style.setProperty("--delay", `${index * 110}ms`);
    line.textContent = segment;
    els.finalStory.appendChild(line);
  });
}

function buildStorySegments() {
  if (!state.history.length) return state.story ? [state.story] : [];
  const segments = [];
  state.history.forEach((entry, index) => {
    if (index === 0) {
      segments.push(entry);
      return;
    }
    const previous = state.history[index - 1];
    const addition = entry.startsWith(previous)
      ? entry.slice(previous.length).trim()
      : entry.trim();
    if (addition) segments.push(addition);
  });
  return segments;
}

function scrollCandidatesIntoView() {
  requestAnimationFrame(() => {
    const targetTop = window.innerWidth <= 640
      ? els.storyStage.getBoundingClientRect().top + window.scrollY - 8
      : els.storyStage.getBoundingClientRect().top + window.scrollY - 12;
    window.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
  });
}

function setLoading(value) {
  state.loading = value;
  renderButtons();
  renderCandidates();
}

function checkIdleReset() {
  if (!state.story) return;
  const elapsed = Date.now() - state.lastActivity;
  if (elapsed > 60000) reset();
}

function markActivity() {
  state.lastActivity = Date.now();
}

function joinStory(base, addition) {
  const cleanBase = base.trim();
  const cleanAddition = addition.trim();
  if (!cleanBase) return cleanAddition;
  if (/[\s([{'"“‘]$/.test(cleanBase)) return `${cleanBase}${cleanAddition}`;
  return `${cleanBase} ${cleanAddition}`;
}

function sourceText(source) {
  if (source === "solar") return "Solar 연결";
  if (source === "cache") return "빠른 추천";
  if (source === "fallback") return "준비된 후보";
  return "추천 완료";
}

function emptyMessage(text) {
  const div = document.createElement("div");
  div.className = "empty-message";
  div.textContent = text;
  return div;
}

function localFallback() {
  return [
    { text: "신기한 문을 열었어요", score: 91, tone: "상상", why: "이야기가 열려요" },
    { text: "친구와 함께 걸었어요", score: 84, tone: "우정", why: "따뜻하게 이어져요" },
    { text: "반짝이는 것을 발견했어요", score: 78, tone: "놀라움", why: "궁금해져요" },
    { text: "새로운 방법을 떠올렸어요", score: 72, tone: "궁금함", why: "다음이 기대돼요" },
    { text: "모두 함께 웃었어요", score: 68, tone: "따뜻함", why: "분위기가 좋아져요" },
    { text: "작은 단서를 찾았어요", score: 63, tone: "모험", why: "다음이 궁금해져요" }
  ];
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

init();
