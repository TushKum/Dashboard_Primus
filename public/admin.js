// The organiser console: set the timetable, import teams, load and deal the cards, watch submissions come in, read
// any team's work and download everything as one CSV.

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const NAMES = { 1: "Product", 2: "Crisis" };
const fmt = (ms) => new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const hm = (ms) => new Date(ms).toLocaleTimeString([], { timeStyle: "short" });
const localInput = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16);

let state = null;
let built = false;

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "content-type": opts.csv ? "text/csv" : "application/json" }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `Error ${res.status}`), { status: res.status });
  return body;
}

function say(id, msg, ok = true) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `status ${ok ? "good" : "bad"}`;
  el.textContent = msg;
}

async function act(statusId, fn, okMsg) {
  try {
    const r = await fn();
    say(statusId, typeof okMsg === "function" ? okMsg(r) : okMsg);
    await load();
  } catch (e) {
    say(statusId, e.message, false);
  }
}

$("#login").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  try {
    await api("/api/admin/login", { method: "POST", body: JSON.stringify({ password: $("#password").value }) });
    await load();
  } catch (e) {
    $("#login-status").textContent = e.message;
  }
});
$("#logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  location.reload();
});

async function load() {
  try {
    state = await api("/api/admin/state");
  } catch (e) {
    if (e.status === 401 && built) location.reload();
    return;
  }
  $("#logout").hidden = false;
  if (!built) build();
  refresh();
}

function build() {
  built = true;
  const t = state.timetable;
  $("#main").innerHTML = `
  <section class="card">
    <h2>1. Session</h2>
    <p class="small muted">A briefing, then Round 1 (product, up to ${state.limits[1]} words) and Round 2 (crisis, up to ${state.limits[2]} words). Forms lock on the server's clock.</p>
    <div class="row">
      <div class="grow"><label for="starts">Start time (your local time)</label><input id="starts" type="datetime-local" /></div>
      <div><label for="m0">Briefing (min)</label><input id="m0" type="number" min="0" style="width:110px" value="${t.briefingMinutes}" /></div>
      <div><label for="m1">Round 1 (min)</label><input id="m1" type="number" min="1" style="width:110px" value="${t.roundMinutes[1]}" /></div>
      <div><label for="m2">Round 2 (min)</label><input id="m2" type="number" min="1" style="width:110px" value="${t.roundMinutes[2]}" /></div>
    </div>
    <div class="row" style="margin-top:10px"><button id="save-settings">Save</button><button class="ghost" id="clear-start">Clear start time</button></div>
    <p class="status" id="s-settings"></p>
    <div id="timeline" class="small"></div>
  </section>

  <section class="card">
    <h2>2. Teams</h2>
    <p class="small muted">Paste or choose a CSV with columns <code>code,name</code>. Importing again updates names and adds new teams.</p>
    <textarea id="teams-csv" placeholder="code,name&#10;S001,Team Alpha"></textarea>
    <div class="row" style="margin-top:10px">
      <input type="file" id="teams-file" accept=".csv,text/csv" style="width:auto" />
      <button id="import-teams">Import teams</button>
      <a href="/api/admin/logins.csv"><button class="ghost" type="button">Download login sheet</button></a>
    </div>
    <p class="status" id="s-teams"></p>
  </section>

  <section class="card">
    <h2>3. Cards</h2>
    <p class="small" id="cards-summary"></p>
    <div class="row">
      <div class="grow"><label for="card-kind">Replace</label>
        <select id="card-kind"><option value="problem">Problem cards (CSV: number,title,body)</option><option value="crisis">Crisis cards (CSV: number,category,title,body)</option></select></div>
      <div><label for="card-file">File</label><input type="file" id="card-file" accept=".csv,text/csv" style="width:auto" /></div>
    </div>
    <div class="row" style="margin-top:10px"><button id="upload-cards">Upload</button></div>
    <p class="status" id="s-cards"></p>
    <h3>Deal</h3>
    <p class="small muted">Gives every team one problem card and one crisis card, spread evenly and at random. Re-deal is allowed until Round 1 opens.</p>
    <div class="row"><button id="deal">Deal cards</button><span class="small" id="dealt"></span></div>
    <p class="status" id="s-deal"></p>
  </section>

  <section class="card">
    <div class="row"><h2 class="grow">4. Submissions</h2><a href="/api/admin/submissions.csv"><button type="button">Download all (CSV)</button></a></div>
    <p class="small" id="sub-summary"></p>
    <div class="table-wrap"><table id="subs"></table></div>
  </section>

  <section class="card" id="team-detail" hidden></section>`;

  $("#save-settings").onclick = () =>
    act(
      "s-settings",
      () =>
        api("/api/admin/settings", {
          method: "POST",
          body: JSON.stringify({
            startsAt: $("#starts").value ? new Date($("#starts").value).toISOString() : null,
            briefingMinutes: Number($("#m0").value),
            round1Minutes: Number($("#m1").value),
            round2Minutes: Number($("#m2").value),
          }),
        }),
      "Saved.",
    );
  $("#clear-start").onclick = () => act("s-settings", () => api("/api/admin/settings", { method: "POST", body: JSON.stringify({ startsAt: null }) }), "Start time cleared.");
  $("#teams-file").onchange = async (ev) => ($("#teams-csv").value = await ev.target.files[0].text());
  $("#import-teams").onclick = () => act("s-teams", () => api("/api/admin/teams", { method: "POST", csv: true, body: $("#teams-csv").value }), (r) => `${r.teams} teams in all.`);
  $("#upload-cards").onclick = async () => {
    const f = $("#card-file").files[0];
    if (!f) return say("s-cards", "Choose a file first.", false);
    act("s-cards", async () => api(`/api/admin/cards/${$("#card-kind").value}`, { method: "POST", csv: true, body: await f.text() }), "Cards replaced.");
  };
  $("#deal").onclick = () => {
    if (state.dealt && !confirm("Cards are already dealt. Deal again? Every team gets new cards.")) return;
    act("s-deal", () => api("/api/admin/deal", { method: "POST", body: "{}" }), (r) => `Dealt to ${r.teams} teams.`);
  };
  $("#starts").value = state.startsAt ? localInput(state.startsAt) : "";
}

function cell(r, limit) {
  if (!r) return '<span class="muted">–</span>';
  return `${r.words}/${limit} ${r.complete ? '<span class="pill">Complete</span>' : '<span class="pill warn">Partial</span>'} <span class="muted small">${hm(r.savedAt)}</span>`;
}

function refresh() {
  $("#clock").textContent = new Date(state.now).toLocaleTimeString();
  $("#timeline").innerHTML = state.windows.length
    ? state.windows.map((w) => esc(`Round ${w.round} (${NAMES[w.round]}): ${fmt(w.opensAt)} → ${hm(w.closesAt)}`)).join("<br>")
    : "No start time set.";
  $("#cards-summary").textContent = `${state.cards.problem} problem cards and ${state.cards.crisis} crisis cards loaded.`;
  $("#dealt").textContent = state.dealt ? `Dealt to ${state.dealt} of ${state.teams.length} teams.` : `${state.teams.length} teams, not dealt yet.`;
  const count = (r) => state.teams.filter((t) => t.rounds[r]).length;
  const complete = (r) => state.teams.filter((t) => t.rounds[r]?.complete).length;
  $("#sub-summary").textContent = `Round 1: ${count(1)} saved, ${complete(1)} complete. Round 2: ${count(2)} saved, ${complete(2)} complete. ${state.teams.length} teams.`;
  $("#subs").innerHTML =
    `<thead><tr><th>Team</th><th>Problem card</th><th>Round 1: Product</th><th>Crisis card</th><th>Round 2: Crisis</th></tr></thead><tbody>` +
    state.teams
      .map(
        (t) => `<tr><td><a href="#" data-team="${esc(t.code)}">${esc(t.code)}</a> ${esc(t.name)}</td><td class="small">${esc(t.problem ?? "–")}</td>
        <td>${cell(t.rounds[1], state.limits[1])}</td><td class="small">${esc(t.crisis ?? "–")}</td><td>${cell(t.rounds[2], state.limits[2])}</td></tr>`,
      )
      .join("") +
    "</tbody>";
  for (const a of document.querySelectorAll("[data-team]"))
    a.onclick = (ev) => {
      ev.preventDefault();
      showTeam(a.dataset.team);
    };
}

async function showTeam(code) {
  const d = await api(`/api/admin/team/${encodeURIComponent(code)}`);
  const box = $("#team-detail");
  box.hidden = false;
  const rounds = d.rounds
    .map(({ round, submission: s }) => {
      const card = round === 1 ? d.problem : d.crisis;
      const body = s
        ? d.forms[round].fields.map((f) => `<h3>${esc(f.label)}</h3><p class="small" style="white-space:pre-wrap">${esc(s.content[f.key] || "—")}</p>`).join("")
        : "<p class='muted'>Nothing saved.</p>";
      return `<h2 style="margin-top:20px">Round ${round}: ${NAMES[round]}${s ? ` <span class="muted small">${s.words} words · saved ${fmt(s.saved_at)}</span>` : ""}</h2>
        ${card ? `<div class="cardbox"><b>${esc(card.title)}</b>${esc(card.body)}</div>` : ""}${body}`;
    })
    .join("");
  box.innerHTML = `<div class="row"><h2 class="grow">${esc(d.team.code)} · ${esc(d.team.name)}</h2><button class="ghost" id="close-team">Close</button></div>${rounds}`;
  $("#close-team").onclick = () => (box.hidden = true);
  box.scrollIntoView({ behavior: "smooth" });
}

setInterval(() => built && load(), 5000);
load();
