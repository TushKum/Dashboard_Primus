// The team page: sign in, the timetable, and the open round's card and form (saved as you type).

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const NAMES = { 1: "Product", 2: "Crisis" };

let state = null;
let skew = 0; // server clock minus this device's clock
let renderedKey = "";
const drafts = {}; // round → content being edited
const saveTimers = {};

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `Error ${res.status}`), { status: res.status });
  return body;
}

const serverNow = () => Date.now() + skew;

function countWords(t) {
  const s = String(t || "").trim();
  return s ? s.split(/\s+/).length : 0;
}

async function load() {
  try {
    state = await api("/api/team/state");
  } catch (e) {
    if (e.status === 401) return showLogin();
    return;
  }
  skew = state.now - Date.now();
  $("#who").textContent = `${state.team.name} · ${state.team.code}`;
  $("#logout").hidden = false;
  const open = state.stage.stage === "ROUND" ? state.stage.round : 0;
  const key = `${state.stage.stage}:${open}:${!!state.cards.problem}${!!state.cards.crisis}`;
  if (key !== renderedKey) {
    renderedKey = key;
    render();
  }
}

function showLogin() {
  $("#who").textContent = "";
  $("#logout").hidden = true;
  renderedKey = "";
  if (!$("#login")) location.reload();
}

$("#login")?.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  $("#login-status").textContent = "";
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ code: $("#code").value, password: $("#password").value }) });
    await load();
  } catch (e) {
    $("#login-status").textContent = e.message;
  }
});

$("#logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  location.reload();
});

function stepsHtml() {
  if (!state.windows.length) return "";
  const open = state.stage.stage === "ROUND" ? state.stage.round : 0;
  return `<div class="steps">${state.windows
    .map((w) => `<div class="step ${w.round === open ? "now" : ""}"><b>Round ${w.round}: ${NAMES[w.round]}</b>${time(w.opensAt)}–${time(w.closesAt)}</div>`)
    .join("")}</div>`;
}

function statusHtml() {
  const s = state.stage;
  const line = {
    NOT_SCHEDULED: "The organisers have not set the start time yet.",
    BEFORE: `The session starts at ${s.startsAt ? time(s.startsAt) : ""}. The briefing comes first.`,
    BRIEFING: "Briefing. Round 1 opens when the countdown ends.",
    ROUND: `Round ${s.round}: ${NAMES[s.round]} is open. Your work saves as you type; whatever is saved when the clock hits zero is handed in.`,
    ENDED: "The session is over. Thank you: your saved work has been handed in.",
  }[s.stage];
  const target = s.stage === "BEFORE" ? s.startsAt : s.stage === "BRIEFING" ? s.nextOpensAt : s.stage === "ROUND" ? s.closesAt : null;
  return `<div class="card"><div class="row"><div class="grow">${esc(line)}</div>${target ? `<div class="clock" data-until="${target}"></div>` : ""}</div></div>`;
}

function cardHtml(round) {
  const c = state.cards;
  if (round === 1 && c.problem) return `<div class="cardbox"><b>Problem card ${c.problem.number}: ${esc(c.problem.title)}</b>${esc(c.problem.body)}</div>`;
  if (round === 2 && c.crisis) return `<div class="cardbox"><b>Crisis card: ${esc(c.crisis.title)}</b>${esc(c.crisis.body)}</div>`;
  return "";
}

function fieldHtml(round, f, value, locked) {
  const id = `f${round}_${f.key}`;
  const dis = locked ? "disabled" : "";
  const head = `<label for="${id}">${esc(f.label)}<span class="hint">${esc(f.hint)}</span></label>`;
  if (f.kind === "text") return `${head}<textarea id="${id}" data-key="${f.key}" ${dis}>${esc(value)}</textarea>`;
  const extra = f.kind === "rupees" ? 'inputmode="decimal" placeholder="4.50"' : "";
  return `${head}<input id="${id}" data-key="${f.key}" value="${esc(value)}" ${extra} ${dis} />`;
}

function roundHtml(round, locked) {
  const form = state.forms[round];
  const saved = state.submissions[round]?.content ?? {};
  const content = (drafts[round] ??= { ...saved });
  return `<section class="card" data-round="${round}">
    <div class="row"><h2 class="grow">Round ${round}: ${NAMES[round]}</h2>${locked ? '<span class="pill warn">Locked</span>' : '<span class="pill">Open</span>'}</div>
    ${cardHtml(round)}
    ${round === 2 && state.submissions[1]?.content.cost ? `<p class="small muted">Your Round 1 cost per pack was ₹${esc(state.submissions[1].content.cost)}.</p>` : ""}
    ${form.fields.map((f) => fieldHtml(round, f, content[f.key] ?? "", locked)).join("")}
    <div class="row" style="margin-top:14px">
      <span class="small muted grow" data-words>0 / ${form.wordLimit} words</span>
      ${locked ? "" : `<button data-save>Save now</button>`}
    </div>
    <p class="status" data-status>${state.submissions[round] ? `Saved at ${time(state.submissions[round].saved_at)}` : locked ? "Nothing was saved for this round." : ""}</p>
  </section>`;
}

function render() {
  const s = state.stage;
  const open = s.stage === "ROUND" ? s.round : 0;
  const past = [1, 2].filter((r) => (s.stage === "ENDED" ? true : open ? r < open : false)).reverse();
  $("#main").innerHTML =
    stepsHtml() + statusHtml() + (open ? roundHtml(open, false) : "") + past.map((r) => roundHtml(r, true)).join("");
  for (const sec of document.querySelectorAll("section[data-round]")) wire(sec);
  tick();
}

function collect(sec) {
  const round = Number(sec.dataset.round);
  const c = drafts[round];
  for (const el of sec.querySelectorAll("[data-key]")) c[el.dataset.key] = el.value;
  return round;
}

function updateWords(sec) {
  const round = Number(sec.dataset.round);
  const form = state.forms[round];
  const n = form.fields.filter((f) => f.counted).reduce((a, f) => a + countWords(drafts[round][f.key]), 0);
  const el = sec.querySelector("[data-words]");
  el.textContent = `${n} / ${form.wordLimit} words`;
  el.style.color = n > form.wordLimit ? "var(--bad)" : "";
}

async function save(sec) {
  const round = collect(sec);
  const status = sec.querySelector("[data-status]");
  const content = drafts[round];
  try {
    const r = await api(`/api/team/round/${round}`, { method: "PUT", body: JSON.stringify({ content }) });
    status.className = "status good";
    status.textContent = `Saved at ${time(r.savedAt)}.` + (r.complete ? " Everything is filled in." : ` Still empty: ${r.missing.join(", ")}.`);
  } catch (e) {
    status.className = "status bad";
    status.textContent = e.message;
    if (e.status === 409) load();
  }
}

function wire(sec) {
  if (sec.querySelector("[data-save]") === null) {
    updateWords(sec);
    return;
  }
  const round = Number(sec.dataset.round);
  const schedule = () => {
    collect(sec);
    updateWords(sec);
    clearTimeout(saveTimers[round]);
    saveTimers[round] = setTimeout(() => save(sec), 2500);
  };
  sec.addEventListener("input", schedule);
  sec.addEventListener("change", schedule);
  sec.querySelector("[data-save]").addEventListener("click", () => {
    clearTimeout(saveTimers[round]);
    save(sec);
  });
  updateWords(sec);
}

function tick() {
  for (const el of document.querySelectorAll("[data-until]")) {
    const left = Math.max(0, Number(el.dataset.until) - serverNow());
    const m = Math.floor(left / 60000);
    const sec = Math.floor((left % 60000) / 1000);
    el.textContent = `${m}:${String(sec).padStart(2, "0")}`;
    el.style.color = left < 5 * 60000 ? "var(--warn)" : "";
    if (left === 0) setTimeout(load, 1500);
  }
}

setInterval(tick, 1000);
setInterval(load, 15000);
load();
