// The organiser console: set the start time, import teams, load and deal the cards, judge each round, check a team,
// publish the results and download the list of qualifying teams.

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const NAMES = { 1: "Idea", 2: "Crisis", 3: "Pricing" };
const fmt = (ms) => new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const localInput = (ms) => {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
};

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
  $("#main").innerHTML = `
  <section class="card">
    <h2>1. Session</h2>
    <p class="small muted">Briefing 15 minutes, then three rounds of 40 minutes each (2 h 15 min in all). Forms lock on the server's clock.</p>
    <div class="row">
      <div class="grow"><label for="starts">Start time (your local time)</label><input id="starts" type="datetime-local" /></div>
      <div><label for="qualify">Teams that qualify</label><input id="qualify" type="number" min="1" style="width:120px" /></div>
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
        <select id="card-kind"><option value="problem">Problem cards (CSV: number,title,body)</option><option value="crisis">Crisis cards (CSV: number,category,title,body)</option><option value="price">Price cards (JSON)</option></select></div>
      <div><label for="card-file">File</label><input type="file" id="card-file" style="width:auto" /></div>
    </div>
    <div class="row" style="margin-top:10px"><button id="upload-cards">Upload</button></div>
    <p class="status" id="s-cards"></p>
    <h3>Deal</h3>
    <p class="small muted">Gives every team one problem card and one crisis card, spread evenly and at random. Re-deal is allowed until Round 1 opens.</p>
    <div class="row"><button id="deal">Deal cards</button><span class="small" id="dealt"></span></div>
    <p class="status" id="s-deal"></p>
  </section>

  <section class="card">
    <h2>4. Judging</h2>
    <p class="small muted">Judge a round once it has closed. Each submission is read 3 times (5 if the runs disagree) without team names; the median counts. Failed ones can be judged again.</p>
    <div class="table-wrap"><table id="rounds"></table></div>
    <p class="status" id="s-judge"></p>
  </section>

  <section class="card">
    <h2>5. Results</h2>
    <div class="row">
      <label class="row" style="margin:0;font-weight:500"><input type="checkbox" id="published" style="width:auto" /> Show results to teams</label>
      <span class="grow"></span>
      <a href="/api/admin/results.csv"><button class="ghost" type="button">Results CSV</button></a>
      <a href="/api/admin/qualified.csv"><button type="button">Qualified teams CSV</button></a>
    </div>
    <p class="status" id="s-results"></p>
    <div class="table-wrap"><table id="results"></table></div>
  </section>

  <section class="card" id="team-detail" hidden></section>`;

  $("#save-settings").onclick = () =>
    act("s-settings", () => api("/api/admin/settings", { method: "POST", body: JSON.stringify({ startsAt: $("#starts").value ? new Date($("#starts").value).toISOString() : null, qualifyCount: Number($("#qualify").value) }) }), "Saved.");
  $("#clear-start").onclick = () => act("s-settings", () => api("/api/admin/settings", { method: "POST", body: JSON.stringify({ startsAt: null }) }), "Start time cleared.");
  $("#teams-file").onchange = async (ev) => ($("#teams-csv").value = await ev.target.files[0].text());
  $("#import-teams").onclick = () => act("s-teams", () => api("/api/admin/teams", { method: "POST", csv: true, body: $("#teams-csv").value }), (r) => `${r.teams} teams in all.`);
  $("#upload-cards").onclick = async () => {
    const f = $("#card-file").files[0];
    if (!f) return say("s-cards", "Choose a file first.", false);
    const kind = $("#card-kind").value;
    act("s-cards", async () => api(`/api/admin/cards/${kind}`, { method: "POST", csv: true, body: await f.text() }), "Cards replaced.");
  };
  $("#deal").onclick = () => {
    if (state.dealt && !confirm("Cards are already dealt. Deal again? Every team gets new cards.")) return;
    act("s-deal", () => api("/api/admin/deal", { method: "POST", body: "{}" }), (r) => `Dealt to ${r.teams} teams.`);
  };
  $("#published").onchange = (ev) => act("s-results", () => api("/api/admin/publish", { method: "POST", body: JSON.stringify({ published: ev.target.checked }) }), ev.target.checked ? "Teams can now see their results." : "Results hidden from teams.");
  $("#starts").value = state.startsAt ? localInput(state.startsAt) : "";
  $("#qualify").value = state.qualifyCount;
}

function refresh() {
  $("#clock").textContent = new Date(state.now).toLocaleTimeString();
  const w = state.startsAt
    ? [0, 1, 2].map((i) => {
        const open = state.startsAt + (15 + i * 40) * 60000;
        return `Round ${i + 1} (${NAMES[i + 1]}): ${fmt(open)} → ${new Date(open + 40 * 60000).toLocaleTimeString([], { timeStyle: "short" })}`;
      })
    : ["No start time set."];
  $("#timeline").innerHTML = w.map(esc).join("<br>");
  $("#cards-summary").textContent = `${state.cards.problem} problem cards, ${state.cards.crisis} crisis cards, ${state.cards.price.length} price cards (${state.cards.price.join("; ")}).`;
  $("#dealt").textContent = state.dealt ? `Dealt to ${state.dealt} of ${state.teams} teams.` : `${state.teams} teams, not dealt yet.`;
  $("#published").checked = state.published;

  $("#rounds").innerHTML =
    `<thead><tr><th>Round</th><th class="num">Saved</th><th class="num">Complete</th><th class="num">Judged</th><th class="num">Failed</th><th class="num">Flagged</th><th></th></tr></thead><tbody>` +
    state.rounds
      .map((r) => {
        const p = r.progress;
        const running = p?.running ? `<span class="pill">Judging ${p.done + p.failed}/${p.total}</span>` : "";
        return `<tr><td>${r.round}. ${NAMES[r.round]} <span class="muted">(out of ${r.max})</span></td><td class="num">${r.saved}</td><td class="num">${r.complete}</td><td class="num">${r.judged}</td>
        <td class="num">${r.failed}</td><td class="num">${r.flagged}</td>
        <td>${running || `<button data-judge="${r.round}">Judge</button> <button class="ghost" data-rejudge="${r.round}">Re-judge all</button>`}</td></tr>`;
      })
      .join("") +
    "</tbody>";
  for (const b of document.querySelectorAll("[data-judge]")) b.onclick = () => act("s-judge", () => api(`/api/admin/judge/${b.dataset.judge}`, { method: "POST", body: "{}" }), "Judging started.");
  for (const b of document.querySelectorAll("[data-rejudge]"))
    b.onclick = () => confirm(`Judge every Round ${b.dataset.rejudge} submission again? Existing scores are replaced.`) && act("s-judge", () => api(`/api/admin/judge/${b.dataset.rejudge}`, { method: "POST", body: JSON.stringify({ rejudge: true }) }), "Re-judging started.");
  const errs = state.rounds.flatMap((r) => r.progress?.errors ?? []);
  if (errs.length) say("s-judge", `Errors: ${errs.join(" | ")}`, false);

  $("#results").innerHTML =
    `<thead><tr><th class="num">Rank</th><th>Team</th><th class="num">Idea</th><th class="num">Crisis</th><th class="num">Price: judge</th><th class="num">Price: market</th><th class="num">Penalty</th><th class="num">Total</th><th></th></tr></thead><tbody>` +
    state.results
      .map(
        (r) => `<tr><td class="num">${r.rank ?? "–"}</td><td><a href="#" data-team="${esc(r.code)}">${esc(r.code)}</a> ${esc(r.name)}</td>
        <td class="num">${r.r1}</td><td class="num">${r.r2}</td><td class="num">${r.r3Judge}</td><td class="num">${r.r3Market}</td><td class="num">${r.penalty || ""}</td><td class="num"><b>${r.total}</b></td>
        <td>${r.disqualified ? '<span class="pill bad">DQ</span>' : r.qualified ? '<span class="pill">Qualifies</span>' : ""}</td></tr>`,
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
    .map((r) => {
      const s = r.submission;
      const j = r.judgement;
      const fields = s ? Object.entries(s.content).filter(([, v]) => v).map(([k, v]) => `<b>${esc(k)}</b>: ${esc(v)}`).join("<br>") : "<span class='muted'>Nothing saved.</span>";
      const verdict = j
        ? j.error
          ? `<p class="status bad">Judge error: ${esc(j.error)}</p>`
          : `<p><b>Score ${j.score}</b> (runs ${j.runs.map((x) => x.total).join(", ")}; ${esc(j.model)})<br>${esc(j.rationale)}</p>`
        : "";
      const flagged = j?.removed_lines?.length ? `<p class="status bad">Lines removed before judging: ${j.removed_lines.map(esc).join(" / ")}</p>` : "";
      return `<h3>Round ${r.round}: ${NAMES[r.round]}${s ? ` · ${s.words} words` : ""}</h3><div class="small">${fields}</div>${verdict}${flagged}`;
    })
    .join("");
  const p = d.pricing;
  box.innerHTML = `<div class="row"><h2 class="grow">${esc(d.team.code)} · ${esc(d.team.name)}</h2><button class="ghost" id="close-team">Close</button></div>
    <p class="small">Problem: ${esc(d.problem?.title ?? "not dealt")} · Crisis: ${esc(d.crisis?.title ?? "not dealt")}${p ? ` · Price card: ${esc(p.card.label)}, cost used ₹${(p.cost / 100).toFixed(2)}${p.profit !== null ? `, monthly profit ₹${(p.profit / 100).toLocaleString("en-IN")}` : ""}` : ""}</p>
    <div class="row"><label style="margin:0" for="penalty">Penalty points</label><input id="penalty" type="number" min="0" step="1" value="${d.team.penalty}" style="width:100px" />
    <label class="row" style="margin:0;font-weight:500"><input type="checkbox" id="dq" style="width:auto" ${d.team.disqualified ? "checked" : ""}/> Disqualified</label>
    <button id="save-team">Save</button></div><p class="status" id="s-team"></p>${rounds}`;
  $("#close-team").onclick = () => (box.hidden = true);
  $("#save-team").onclick = () =>
    act("s-team", () => api(`/api/admin/team/${encodeURIComponent(code)}`, { method: "POST", body: JSON.stringify({ penalty: Number($("#penalty").value), disqualified: $("#dq").checked }) }), "Saved.");
  box.scrollIntoView({ behavior: "smooth" });
}

setInterval(() => built && load(), 5000);
load();
