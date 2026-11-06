/* Scorecard rules for the RingCX Live View (2026-11-02), shared by the page and the server "scorer" function.
 *
 * Everything the Performance table, Previous days and the Report compute lives here: the status replay
 * (observe), each person's day totals, first login, lunch, ticket timeliness, ES and CSAT rates, email work,
 * the 100-point scorecard (applyV2), the board rows and their cells, and the replay of a finished day (scoreDay).
 * No DOM, localStorage or fetch: the caller loads the data and hands it over.
 *
 * Usage:
 *   page:  <script src="scoring.js"></script>, then BQEScoring.create(state)
 *   Deno:  import "./scoring.js"; const sc = globalThis.BQEScoring.create(state);
 *
 * state holds the inputs the rules read, by these names. The page passes getters/setters onto its own variables;
 * the server can pass a plain object. scoreDay() swaps some of them while it replays a day and puts them back.
 *   CONFIG          the page's CONFIG (thresholds, name lists)
 *   hist            the day's status history, built by observe() from RingCX realTimeData/agent snapshots
 *   abandons        the call detail report: { all: rows, prev: next-morning rows for overnight agents, at: load stamp }
 *   waits           zdwatch data: { rows: ticket waits, avail, work, workTimed, es, csat, other }
 *   pto             Time off and roster: { rows, schedule }
 *   loginByName     normName -> { late, conf } (first logins, for the Start part)
 *   intervalSec     refresh cadence in seconds (60 for server snapshots)
 *   unrankOverride  a past day's "Not ranked today" notes, or null for today's (reviews.list)
 *   reviews         { list: watch_reviews rows }
 *   rsLegs, rsLegsVer  RingSense transfer legs by session ID, and their version stamp
 *   supNames        normName -> name of RingCX supervisors (null until loaded)
 *   eve             { ymd, map }: overnight first logins from the evening before
 *   liveAgents      RingCX agents logged in now ([] on a finished day)
 *   isManager()     true when the viewer is a manager (login visibility); default false
 *   inQueue(name)   the page's queue filter; default everyone
 *   onNewDay()      called when observe() starts a new day (the page refills it from the server)
 *
 * Plain script that also runs as an ES module import (it sets globalThis.BQEScoring, and module.exports when there is one).
 * When this file changes, bump the ?v= on its script tag in index.html: open boards reload on an index.html change.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  root.BQEScoring = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function create(S) {
    var CONFIG = S.CONFIG;
    var inQueue = S.inQueue || function () { return true; };
    var isManagerViewer = S.isManager || function () { return false; };

    // ================ formatting and date helpers ================
    function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
    function fmtDur(sec) {
      sec = Math.max(0, Math.floor(sec || 0));
      var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
      return h ? h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0") : m + ":" + String(s).padStart(2, "0");
    }
    function fmtShort(sec) { return sec >= 3600 ? Math.round(sec / 360) / 10 + "h" : Math.round(sec / 60) + " min"; }
    // Every clock time on the page is Pacific, matching RingCX and the roster, whatever the viewer's PC is set to.
    function fmtClock(ms) { return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }) + " PT"; }
    // "Core", "core", "Core Overflow" -> "CORE", "CORE Overflow". Applied to every queue name as it arrives.
    function queueLabel(name) { return String(name == null ? "" : name).replace(/\bcore\b/gi, "CORE"); }
    function todayKey() { var d = new Date(); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
    function ymdLabel(s) {
      var p = String(s).split("-"), d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
      return d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }) + " " + (+p[1]) + "/" + (+p[2]);
    }
    function normName(s) { return String(s || "").trim().replace(/\s+/g, " ").toLowerCase(); }
    function clockOf(min) { min = ((min % 1440) + 1440) % 1440; var h = Math.floor(min / 60), m = min % 60; return ((h % 12) || 12) + ":" + String(m).padStart(2, "0") + (h >= 12 ? " PM" : " AM"); }
    function nowIn(tz) {
      var parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
      var get = function (t) { return (parts.filter(function (p) { return p.type === t; })[0] || {}).value; };
      return { day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")), hm: get("hour") + ":" + get("minute") };
    }
    function fmtPhone(n) { var d = String(n || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""); return d.length === 10 ? "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6) : (n || ""); }
    function ptMidnightIso() {
      var p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", timeZoneName: "shortOffset" }).formatToParts(new Date());
      var g = function (t) { return (p.filter(function (x) { return x.type === t; })[0] || {}).value; };
      var m = /GMT([+-])(\d+)/.exec(g("timeZoneName") || "GMT-8");
      var off = (m ? m[1] : "-") + String(m ? m[2] : 8).padStart(2, "0") + "00";
      return g("year") + "-" + g("month") + "-" + g("day") + "T00:00:00.000" + off;
    }
    function parseCsv(text) {
      var rows = [], row = [], cur = "", q = false;
      for (var i = 0; i < text.length; i++) {
        var c = text[i];
        if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
        else if (c === '"') q = true;
        else if (c === ",") { row.push(cur); cur = ""; }
        else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
        else cur += c;
      }
      if (cur || row.length) { row.push(cur); rows.push(row); }
      var head = rows.shift() || [];
      return rows.filter(function (r) { return r.length > 1; }).map(function (r) { var o = {}; head.forEach(function (h, j) { o[h] = r[j]; }); return o; });
    }
    // "2026-10-14 10:43:51" US/Eastern -> "7:43 AM" Pacific (always 3 hours behind).
    function etToPtClock(s) {
      var m = /(\d+)-(\d+)-(\d+) (\d+):(\d+):(\d+)/.exec(s || "");
      if (!m) return s || "";
      var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 3, +m[5], +m[6]));
      var h = d.getUTCHours(), ap = h >= 12 ? "PM" : "AM";
      return ((h % 12) || 12) + ":" + String(d.getUTCMinutes()).padStart(2, "0") + " " + ap;
    }
    // Report time (US/Eastern, no offset) -> epoch ms.
    function etMs(s) {
      var m = /(\d+)-(\d+)-(\d+) (\d+):(\d+):(\d+)/.exec(s || "");
      if (!m) return NaN;
      var guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
      var tz = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" }).formatToParts(new Date(guess))
        .filter(function (x) { return x.type === "timeZoneName"; })[0];
      var o = /GMT([+-])(\d+)/.exec(tz ? tz.value : "GMT-5");
      return guess - (o ? (o[1] === "-" ? -1 : 1) * +o[2] : -5) * 3600000;
    }
    function ptYmd(back) {
      var t = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
      return new Date(Date.parse(t + "T12:00:00Z") - back * 86400000).toISOString().slice(0, 10);
    }
    function ptMidnightIsoOf(ymd) {
      var p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "shortOffset" }).formatToParts(new Date(ymd + "T12:00:00Z"));
      var m = /GMT([+-])(\d+)/.exec((p.filter(function (x) { return x.type === "timeZoneName"; })[0] || {}).value || "GMT-8");
      return ymd + "T00:00:00.000" + (m ? m[1] : "-") + String(m ? m[2] : 8).padStart(2, "0") + "00";
    }
    function dtsMinutes(s) { var m = /T?(\d{1,2}):(\d{2})/.exec(String(s || "").replace(/^\d{4}-\d{2}-\d{2}/, "")); return m ? +m[1] * 60 + +m[2] : null; }

    // ================ agent state model ================
    function base(a) { return String(a.agentBaseState || "").toUpperCase(); }
    function isOnCall(a) { var b = base(a); return !!a.callUii || b === "ENGAGED" || b === "TRANSITION" || !!a.pendingDisposition; }
    function isAvailable(a) { return !isOnCall(a) && base(a) === "AVAILABLE"; }
    function isNotReady(a) { return !isOnCall(a) && base(a) !== "AVAILABLE"; }
    // Wrap-up: RingCX sends the after-call state as TRANSITION (pendingDisposition stayed false in every
    // snapshot on 2026-10-14), so both read as "Transition" (use RingCX's name). Still red: part of handling the call.
    function isWrapUp(a) { return !!a.pendingDisposition || (base(a) === "TRANSITION" && !a.callUii); }
    function stateLabel(a) { return isWrapUp(a) ? "Transition" : (a.agentState || ""); }
    function isSupervisor(a) {
      var o = supHoursOverride(fullName(a));
      if (o === null && hasSupTag(fullName(a))) return false;
      return o !== null ? o : String(a.agentType || "").toUpperCase() === "SUPERVISOR";
    }
    // Supervisors only count as call-takers while Available or on a call that came from a queue.
    function fullName(a) { return (a.firstName || "") + " " + (a.lastName || ""); }
    function treatedAsSupervisor(a) {
      if (supHoursOverride(fullName(a)) !== null) return false;   // isSupervisor() already decided by the clock
      var name = fullName(a).trim().toLowerCase();
      return CONFIG.TREAT_AS_SUPERVISOR.some(function (n) { return n.toLowerCase() === name; });
    }
    // Supervisors (RingCX SUPERVISOR type, or on TREAT_AS_SUPERVISOR) sit in the Supervisors table
    // unless they are Available or Engaged, in which case they show with the agents.
    function inAgentSection(a) {
      return !(isSupervisor(a) || treatedAsSupervisor(a)) || isAvailable(a) || isOnCall(a);
    }

    // ================ shift days, overnight shifts, daylight saving ================
    // ---------------- people whose hours don't follow daylight saving ----------------
    // Their roster times are their standard-time Pacific hours (e.g. a fixed schedule in a zone with no
    // DST). While Pacific is on daylight time (PDT), those same hours land one hour later on Pacific clocks.
    function pacificIsDST() {
      var p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "shortOffset" }).formatToParts(new Date());
      var tz = (p.filter(function (x) { return x.type === "timeZoneName"; })[0] || {}).value || "";
      return /GMT-7\b/.test(tz);
    }
    // Day-by-day start times (Pacific) for people whose hours change by weekday and aren't in the Support Roster's single
    // Shift Start (2026-10-30). From the heatmap roster's per-day blocks, checked against their RingCX logins 10/22-10/30
    // (Saturdays followed the logins: Sharik 11:17 PM, Danish 4:02 PM). Weekday 0 = Sunday; a missing day = day off.
    // The times are Pacific daylight time; they work on India time, which has no DST, so in standard time (Nov to Mar)
    // each start is an hour earlier. Used for ticket deadlines (end of their next shift) and on-time start.
    var SHIFT_BLOCKS = {
      "Sharik Parvaiz": { 5: "18:00", 6: "23:00", 0: "21:00", 1: "21:00", 2: "21:00" },
      "Danish Manzoor": { 0: "19:00", 3: "21:00", 4: "21:00", 5: "23:00", 6: "16:00" }
    };
    function shiftBlocksFor(name) {
      var k = normName(name), key = Object.keys(SHIFT_BLOCKS).filter(function (x) { return normName(x) === k; })[0];
      return key ? SHIFT_BLOCKS[key] : null;
    }
    // Their start (Pacific minutes) on a weekday, null = day off. dst: whether Pacific is on daylight time that day.
    function blockStart(blocks, wd, dst) {
      var v = blocks[wd]; if (v == null) return null;
      return +v.slice(0, 2) * 60 + +v.slice(3, 5) - (dst ? 0 : 60);
    }
    function ymdIsDST(ymd) { return /-07/.test(ptMidnightIsoOf(ymd).slice(-5)); }
    // Overnight shifts count in the Pacific day they start (2026-10-30). Every SHIFT_BLOCKS shift starts after noon
    // and ends before the next noon, so for these people a "day" runs noon to noon: their history, calls, ticket work and
    // ticket waits are all taken from that window, on the live board and on past days.
    function isOvernight(name) { return !!shiftBlocksFor(name); }
    function shiftDayOf(ms) { return ymdOfMs(ms - 12 * 3600000); }
    function currentShiftYmd() { return S.hist.scoreYmd || shiftDayOf(Date.now()); }
    function shiftWindow(ymd) { return { from: Date.parse(ptMidnightIsoOf(ymd)) + 12 * 3600000, to: Date.parse(ptMidnightIsoOf(addDaysYmd(ymd, 1))) + 12 * 3600000 }; }
    function overnightNames() { return Object.keys(SHIFT_BLOCKS).map(normName); }
    // Snapshots kept to the overnight agents only, between from and to (ms), re-keyed to the fields order "want".
    function overnightPolls(polls, have, want, from, to) {
      var iF = have.indexOf("firstName"), iL = have.indexOf("lastName"), names = overnightNames();
      return polls.filter(function (q) { var ts = Date.parse(q.ts); return ts >= from && ts < to; }).map(function (q) {
        var rows = (q.a || []).filter(function (r) { return names.indexOf(normName((r[iF] || "") + " " + (r[iL] || ""))) >= 0; })
          .map(function (r) { return want.map(function (f) { var i = have.indexOf(f); return i < 0 ? null : r[i]; }); });
        return { ts: q.ts, a: rows };
      }).filter(function (q) { return q.a.length; });
    }
    function isOvernightCall(r) { return isOvernight(firstLast(r.connected_name || "")); }
    // Temporary schedules the roster doesn't show yet (Smartsheet can't be edited right now). Each lapses on its own
    // after "until" (Pacific date). Times are Pacific "HH:MM"; omit a field to keep the roster value.
    var SCHEDULE_OVERRIDES = {
      // Covering for Vina until she's back mid-November (Armando to Natasha, 2026-10-15).
      "Armando Sanchez": { shift: "06:00", lunch: "10:00", until: "2026-11-15" }
    };
    function scheduleOverride(s) {
      var k = normName(s.name), key = Object.keys(SCHEDULE_OVERRIDES).filter(function (x) { return normName(x) === k; })[0];
      if (!key) return s;
      var o = SCHEDULE_OVERRIDES[key], today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
      if (o.until && today > o.until) return s;
      var toMin = function (t) { return +t.slice(0, 2) * 60 + +t.slice(3, 5); };
      var out = {}; Object.keys(s).forEach(function (f) { out[f] = s[f]; });
      if (o.shift) out.shift = toMin(o.shift);
      if (o.lunch) out.lunch = toMin(o.lunch);
      out.temp = true;
      return out;
    }
    function dstAdjust(s) {
      var k = normName(s.name);
      if (!pacificIsDST() || !CONFIG.NO_DST.some(function (x) { return normName(x) === k; })) return s;
      return { name: s.name, days: s.days, noDst: true,
        shift: s.shift === null ? null : s.shift + 60, lunch: s.lunch === null ? null : s.lunch + 60 };
    }

    // ================ supervisors and login visibility ================
    // true/false for someone on SUPERVISOR_HOURS (by the Pacific clock now), null for everyone else.
    function supHoursOverride(name) {
      var k = normName(name), key = Object.keys(CONFIG.SUPERVISOR_HOURS || {}).filter(function (x) { return normName(x) === k; })[0];
      if (!key) return null;
      var w = CONFIG.SUPERVISOR_HOURS[key], n = nowIn("America/Los_Angeles"), m = +n.hm.slice(0, 2) * 60 + +n.hm.slice(3, 5);
      var toMin = function (t) { return +t.slice(0, 2) * 60 + +t.slice(3, 5); };
      return m >= toMin(w.from) && m < toMin(w.to);
    }
    function isSupervisorName(name, isSup) {
      var k = normName(name), o = supHoursOverride(name);
      if (o !== null) return o;
      if (hasSupTag(name)) return false;
      return !!isSup || !!(S.supNames && S.supNames[k]) || CONFIG.TREAT_AS_SUPERVISOR.some(function (x) { return normName(x) === k; });
    }
    function isL2Name(name) { var k = normName(name); return (CONFIG.L2_LOGINS_MANAGERS_ONLY || []).some(function (x) { return normName(x) === k; }); }
    // Supervisor for login purposes: RingCX type SUPERVISOR or TREAT_AS_SUPERVISOR, except people on
    // SUPERVISOR_HOURS (Peter), who count as agents here. Static, not by the clock.
    function isSupForLogins(name) {
      var k = normName(name);
      if (Object.keys(CONFIG.SUPERVISOR_HOURS || {}).some(function (x) { return normName(x) === k; }) || hasSupTag(name)) return false;
      return !!(S.supNames && S.supNames[k]) || CONFIG.TREAT_AS_SUPERVISOR.some(function (x) { return normName(x) === k; });
    }
    // Non-managers see agents' logins only (2026-10-15): L2s and supervisors are hidden.
    function hideLoginOf(name) { return !isManagerViewer() && (isL2Name(name) || isSupForLogins(name)); }
    // Remove any L2 login traces this browser kept earlier (sessions, day totals, logout gaps).
    function purgeL2Logins() {
      if (isManagerViewer()) return;
      Object.keys(S.hist.agents || {}).forEach(function (id) {
        var h = S.hist.agents[id];
        if (h && h.name && hideLoginOf(h.name)) { delete h.sessions; delete h.dayLogin; delete h.curSession; delete h.gaps; }
      });
    }
    function hasSupTag(name) { var k = normName(name); return (CONFIG.SUPERVISOR_TAG || []).some(function (x) { return normName(x) === k; }); }

    // ================ lunch ================
    // ---------------- lunch timing: from when they actually went ----------------
    // Lunch starts when an agent switches to Lunch, or logs out inside their lunch period
    // (scheduled lunch - LUNCH_EARLY_MIN .. + LUNCH_LATE_START_MIN, so a late lunch still counts).
    // They get LUNCH_MAX_MIN; LUNCH_OVER_WARN_MIN over = yellow, LUNCH_OVER_CRIT_MIN over = red.
    function ptMinOf(ms) {
      var f = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
      var g = function (t) { return +(f.filter(function (x) { return x.type === t; })[0] || {}).value; };
      return g("hour") * 60 + g("minute");
    }
    function schedFor(name) {
      var k = normName(name);
      return (S.pto.schedule || []).filter(function (s) { return normName(s.name) === k; })[0] || null;
    }
    // Returns today's lunch for this person { from, to (null = still out), active, dur (min), over (min) } or null.
    function lunchFor(h, s, isLiveNow) {
      if (!h) return null;
      var now = S.hist.endAt || Date.now(), runs = [], open = null;   // endAt: a past day being replayed (Yesterday)
      (h.ev || []).slice().sort(function (x, y) { return x.t - y.t; }).forEach(function (x) {
        if (x.tb === "LUNCH") open = x.t;
        else if (x.fb === "LUNCH" && open !== null) { runs.push({ from: open, to: x.t }); open = null; }
      });
      if (open !== null) runs.push({ from: open, to: isLiveNow && h.base === "LUNCH" ? null : (h.lastSeen || null) });
      else if (isLiveNow && h.base === "LUNCH" && h.start) runs.push({ from: h.start, to: null });   // went before we started watching
      if (s && s.lunch !== null) {
        var inPeriod = function (t) { var m = ptMinOf(t); return m >= s.lunch - CONFIG.LUNCH_EARLY_MIN && m <= s.lunch + CONFIG.LUNCH_LATE_START_MIN; };
        (h.gaps || []).forEach(function (g) { if (inPeriod(g.from)) runs.push({ from: g.from, to: g.to }); });
        // If this page wasn't watching when they disappeared, we only know they've been out since it came back.
        if (!isLiveNow && h.lastSeen && inPeriod(h.lastSeen)) runs.push({ from: Math.max(h.lastSeen, S.hist.watchStart || 0), to: null, unsure: h.lastSeen < (S.hist.watchStart || 0) - 60000 });
      }
      if (!runs.length) return null;
      runs.sort(function (x, y) { return x.from - y.from; });
      // Lunch on the Lunch status followed straight by a logout (or the reverse) is one lunch.
      // Group touching runs into blocks, then use the block still going now, else the longest one
      // (an earlier brief Lunch status must not hide a logout during the lunch window).
      var blocks = [], b = null;
      runs.forEach(function (x) {
        var end = b ? (b.to === null ? now : b.to) : 0;
        if (b && x.from - end <= 3 * 60000) b.to = x.to === null || b.to === null ? null : Math.max(b.to, x.to);
        else { b = { from: x.from, to: x.to, unsure: !!x.unsure }; blocks.push(b); }
      });
      var r = blocks.filter(function (x) { return x.to === null; })[0] ||
        blocks.slice().sort(function (x, y) { return (y.to - y.from) - (x.to - x.from); })[0];
      var dur = ((r.to === null ? now : r.to) - r.from) / 60000;
      return { from: r.from, to: r.to, active: r.to === null, dur: dur, over: dur - CONFIG.LUNCH_MAX_MIN, unsure: r.unsure };
    }
    function lunchLevel(L) { return !L ? null : (L.over >= CONFIG.LUNCH_OVER_CRIT_MIN ? "crit" : (L.over >= CONFIG.LUNCH_OVER_WARN_MIN ? "warn" : null)); }

    // ================ first login ================
    // First login and how late it was, from one person's day of history (Logins today, and the Yesterday section).
    // s = their roster row (or undefined), day = weekday 0-6 the history is for.
    // Overnight shifts (2026-10-23): someone logged in at Pacific midnight started the evening before, so their
    // first login is that evening's. The session's loginDts carries the real date; yesterday's server snapshots
    // add any earlier evening sessions (a logout and back within 2 hours counts as the same shift).
    function sessionKeys(h) { return Object.keys(h.sessions || {}).filter(function (k) { return k !== "session"; }).sort(); }
    function overnightKey(h, ymd) { var k = sessionKeys(h)[0]; return k && /^\d{4}-\d{2}-\d{2}/.test(k) && k.slice(0, 10) < ymd ? k : null; }
    // Pacific loginDts ("2026-10-22T22:44:00", no offset) -> epoch ms.
    function dtsMs(dts) { var d = String(dts).slice(0, 10); return Date.parse(ptMidnightIsoOf(d)) + (dtsMinutes(dts) || 0) * 60000; }
    function loginInfo(h, s, day) {
      var keys = sessionKeys(h);
      if (!keys.length) return null;
      var ovB = shiftBlocksFor(h.name);
      if (ovB) {   // overnight: their history holds just this shift; compare the first login with the shift day's start
        var sd = currentShiftYmd(), base = Date.parse(ptMidnightIsoOf(sd)), tot = 0, ls = 0;
        if (h.shiftDay && h.shiftDay !== sd) return null;   // that was an earlier shift; this one hasn't started
        keys.forEach(function (k) { tot += h.sessions[k].login || 0; ls = Math.max(ls, h.sessions[k].seen || 0); });
        var fm = Math.round((dtsMs(keys[0]) - base) / 60000), st = blockStart(ovB, new Date(sd + "T12:00:00Z").getUTCDay(), ymdIsDST(sd));
        return { keys: keys, first: fm, total: tot, lastSeen: Math.max(ls, h.lastSeen || 0), start: st, hidden: false, conf: "confirmed",
          eve: !S.hist.scoreYmd && sd < ptYmd(0), logins: keys.length, late: st !== null ? fm - st : null };
      }
      var first = dtsMinutes(keys[0]), total = 0, lastSeen = 0;
      keys.forEach(function (k) { total += h.sessions[k].login || 0; lastSeen = Math.max(lastSeen, h.sessions[k].seen || 0); });
      lastSeen = Math.max(lastSeen, h.lastSeen || 0);   // last refresh that still had them logged in
      var start = s && s.shift !== null && s.days.indexOf(day) >= 0 ? s.shift : null;
      var blocks = shiftBlocksFor(h.name);   // day-by-day shifts (Sharik, Danish)
      if (blocks) start = blockStart(blocks, day, pacificIsDST());
      // Logged in through midnight: the shift's first login was the evening before (exact from loginDts).
      if (lastSeen && overnightKey(h, ymdOfMs(lastSeen))) {
        var ev = !S.hist.keepAll && S.eve.ymd === ptYmd(0) ? S.eve.map[normName(h.name)] : null;
        var f0 = ev ? ev.first : dtsMinutes(keys[0]) - 1440;
        // Day-by-day shifts: the shift that started the evening before (minutes before today's midnight).
        if (blocks) { var yb = blockStart(blocks, (day + 6) % 7, pacificIsDST()); start = yb === null ? null : yb - 1440; }
        return { keys: keys, first: f0, total: total, lastSeen: lastSeen, start: start, hidden: false, conf: "confirmed", eve: true,
          logins: keys.length + (ev ? ev.logins - 1 : 0), late: start !== null ? f0 - start : null };
      }
      // How sure are we about the first login? (plan steps 1, 2, 5)
      //  confirmed : when the page first saw the earliest session, RingCX had no other login time today.
      //  est       : earlier sessions we never saw; their total login time puts the first login no later than
      //              (earliest seen start - that time). Gaps between sessions only make it earlier.
      //  call      : as above but a queue call pins it tighter: logged in by the earliest call.
      //  unknown   : earlier sessions we never saw and nothing to pin it down.
      // Uses the earliest session's own "before" (not the day total vs. sessions seen), so a mid-day
      // stretch with the page closed doesn't make a known first login look uncertain.
      var s0 = h.sessions[keys[0]], before = s0 && s0.before != null ? s0.before : null;
      var hidden = before !== null ? before > CONFIG.HIDDEN_SESSION_SEC : (h.dayLogin || 0) - total > CONFIG.HIDDEN_SESSION_SEC;
      var c = callIndex()[lastFirst(h.name)], callFirst = c ? c.first : null;
      var conf = "confirmed", estFirst = null;
      if (hidden) {
        // Ignore an impossible estimate (before midnight), which bad RingCX totals could produce.
        if (before !== null && first !== null && first - before / 60 >= 0) estFirst = Math.floor(first - before / 60);
        var bound = first, kind = "unknown";
        if (estFirst !== null) { bound = estFirst; kind = "est"; }
        if (callFirst !== null && (bound === null || callFirst < bound)) { bound = callFirst; kind = "call"; }
        first = bound; conf = kind;
      }
      var late = start !== null && first !== null ? first - start : null;
      return { keys: keys, first: first, total: total, lastSeen: lastSeen, start: start, hidden: hidden, conf: conf, late: late };
    }

    // ================ status history (observe) ================
    function observe(agents, fetchedAt, noSave) {
      purgeL2Logins();
      if (S.hist.day !== todayKey()) {
        S.hist = { day: todayKey(), since: fetchedAt, agents: {} };
        // An overnight shift running through the reset: refill it from the server (yesterday's evening snapshots).
        if (!noSave && Object.keys(SHIFT_BLOCKS).length && S.onNewDay) S.onNewDay();
      }
      // The whole day is kept (the history resets at midnight): the Email Support credit needs each person's RingCX
      // status at any minute of the day (2026-10-16). It used to keep 10 hours.
      var keepAfter = 0;
      // Was this page watching without a break? (Closed/hidden pages leave gaps that aren't real logouts.)
      var contiguous = S.hist.lastPoll && fetchedAt - S.hist.lastPoll <= 3 * S.intervalSec * 1000 + 60000;
      if (!contiguous) S.hist.watchStart = fetchedAt;
      var prevPoll = S.hist.lastPoll || 0;
      S.hist.lastPoll = fetchedAt;
      agents.forEach(function (a) {
        var id = String(a.agentId);
        var asOf = Date.parse(a.lastUpdate) || fetchedAt;
        var start = asOf - (a.stateTime || 0) * 1000;
        var b = isOnCall(a) ? "ONCALL" : base(a);
        var label = stateLabel(a);
        var ovSd = isOvernight(fullName(a)) ? shiftDayOf(fetchedAt) : null;   // overnight: noon-to-noon shift day
        if (ovSd && S.hist.agents[id] && S.hist.agents[id].shiftDay && S.hist.agents[id].shiftDay !== ovSd) delete S.hist.agents[id];
        var h = S.hist.agents[id] || (S.hist.agents[id] = { ev: [] });
        if (ovSd) { h.shiftDay = ovSd; var cdy = ymdOfMs(fetchedAt); (h.rnaDays = h.rnaDays || {})[cdy] = Math.max(h.rnaDays[cdy] || 0, a.rna || 0); }
        // RNA rings (2026-10-27): RingCX's RNA count is a day total, so each rise between two refreshes is a ring this
        // agent didn't answer. Kept so the status list can show each one (rnaRings() matches it to the call report).
        // end = when their status timer restarted after the ring, if it did between the two refreshes.
        var rnaNow = a.rna || 0;
        if (rnaNow > (h.rna || 0)) {
          h.rnaEv = (h.rnaEv || []).concat([{ lo: h.rna == null ? null : (h.lastSeen || null), hi: fetchedAt, end: start > (h.lastSeen || 0) ? start : null, n: rnaNow - (h.rna || 0) }]);
        }
        if (h.label != null) {
          if (label !== h.label) {
            h.ev.push({ t: start, fb: h.base, tb: b, fl: h.label, tl: label });   // fl/tl = exact status names
          } else if (start - h.start > 20000) {
            // Same status, but its timer restarted: the agent left and came back between refreshes.
            // A handled call or new RNA explains that innocently; otherwise count it as a brief flip.
            var explained = (a.callsHandled || 0) > (h.calls || 0) || (a.rna || 0) > (h.rna || 0);
            if (!explained) h.ev.push({ t: start, fb: h.base, tb: "BRIEF", hidden: true, fl: h.label, tl: label });
          }
        }
        // Time accounting for the leaderboard: credit the gap since the last refresh to the status
        // the agent was in (capped, so a sleeping laptop doesn't credit hours).
        // A real logout: gone for OFFLINE_MIN+ while this page kept watching the whole time.
        // Also real when a later refresh already saw them gone, even if watching broke off before they came back
        // (Armando, 2026-10-15: a 10:01 lunch logout was lost to a tracker outage around 11:05).
        if (h.lastSeen && fetchedAt - h.lastSeen > CONFIG.OFFLINE_MIN * 60000 && (h.lastSeen >= (S.hist.watchStart || 0) - 60000 || h.lastSeen < prevPoll - 1000)) {
          h.gaps = (h.gaps || []).concat([{ from: h.lastSeen, to: fetchedAt }]);
        }
        if (h.lastSeen) {
          var gap = Math.min((fetchedAt - h.lastSeen) / 1000, 3 * S.intervalSec);
          h.seenSec = (h.seenSec || 0) + gap;
          if (h.base === "LUNCH" || h.base === "ON-BREAK") h.offSec = (h.offSec || 0) + gap;   // left out of Ready (2026-10-30)
          if (h.base === "AVAILABLE" || h.base === "ONCALL" || (CONFIG.READY_STATUSES || []).indexOf(String(h.label || "").toUpperCase()) >= 0) h.readySec = (h.readySec || 0) + gap;   // + work statuses that count as ready (2026-11-06)
          if (h.base === "AVAILABLE") h.availSec = (h.availSec || 0) + gap;   // Agents table "Avail today"
        }
        if (!h.firstSeen) h.firstSeen = fetchedAt;
        h.lastSeen = fetchedAt;
        // Login time is per login session in RingCX (summed); RNA is a running day total (max is taken).
        // Each session keeps its latest values so the day figures survive a logout/login.
        if (!hideLoginOf(fullName(a))) {   // L2 login sessions are not kept on non-managers' pages (2026-10-15)
        var sk = String(a.loginDts || "session");
        h.sessions = h.sessions || {};
        // before = RingCX time in OTHER sessions when this one was first seen. Sessions run one after another,
        // so all of that time came before this session: first login <= this session's start - before.
        var prevS = h.sessions[sk];
        h.sessions[sk] = { login: a.loggedInDuration || a.loginTime || 0, rna: a.rna || 0, seen: fetchedAt,
          before: prevS && prevS.before != null ? prevS.before : (a.loggedInDuration ? Math.max(0, (a.loginTime || 0) - a.loggedInDuration) : null) };
        h.agentId = String(a.agentId);
        // RingCX's loginTime is the agent's logged-in total for the WHOLE day (all sessions);
        // loggedInDuration is only the current session. A gap between them = sessions this page never saw.
        h.dayLogin = Math.max(h.dayLogin || 0, a.loginTime || 0);
        h.curSession = a.loggedInDuration || 0;
        }
        h.name = fullName(a); h.sup = isSupervisor(a) || treatedAsSupervisor(a);
        // Which queue each agent was on for each call (call lists: the queue before a transfer).
        if (a.callUii && +a.gateId > 0) { S.hist.callGates = S.hist.callGates || {}; (S.hist.callGates[a.callUii] = S.hist.callGates[a.callUii] || {})[id] = String(a.gateId); }
        if (b === "LUNCH") h.lunchDay = S.hist.day;   // seen at lunch today (Lunch panel: "done")
        h.label = label; h.base = b; h.start = start; h.calls = a.callsHandled || 0; h.rna = a.rna || 0;
        h.ev = h.ev.filter(function (e) { return e.t > keepAfter; });
      });
    }

    // ================ calls ================
    // ---------------- top / bottom performers today ----------------
    // Composite score (2026-10-14):
    //   calls answered per logged-in hour x 10
    //   - 5 per RNA today
    //   + 10 x share of observed time spent Available or Engaged (neutral 0.5 until 30 min observed)
    // Everyone who answered queue calls today is scored (supervisors only in "Show all", never in Top/Bottom 5), plus anyone in the
    // Agents section logged in at least BOARD_MIN_LOGIN_SEC.
    // ---------------- today's totals per person (one source for every table) ----------------
    // RingCX's live counters (calls, talk, RNA, logged in) reset at each login, so a re-login made the
    // Agents table and Performance disagree. Everything now shows today's totals:
    //   RNA and logged-in time = sum of every login session this browser saw today (incl. the current one);
    //   calls and talk = today's call report, or the live session if that is higher (report lags a few min).
    // Transferred calls are credited per leg (RingSense legs, see callLegs): each agent gets the call and
    // their own talk time. The report alone credits the whole call to the first agent.
    var callIdx = { at: -2, legsVer: -1, map: {} };
    function callIndex() {
      if (callIdx.at !== S.abandons.at || callIdx.legsVer !== S.rsLegsVer || callIdx.sd !== currentShiftYmd()) {
        var map = {}, done = {}, out = {};
        // Outbound calls they dialed today (RingCX manual dials), counted apart from queue calls (2026-10-23).
        (S.abandons.all || []).forEach(function (r) {
          if (r.source_type !== "MANUAL OUTBOUND" || !r.connected_name) return;
          (out[r.connected_name] = out[r.connected_name] || {})[r.UII] = 1;
        });
        var curSd = currentShiftYmd();
        function credit(name, uii, talk, ptMin, tms) {
          if (isOvernight(firstLast(name)) && isFinite(tms) && shiftDayOf(tms) !== curSd) return;   // another shift's call
          var c = map[name] || (map[name] = { uiis: {}, talk: 0, first: null });
          if (!c.uiis[uii]) { c.uiis[uii] = 1; c.talk += talk; }
          if (ptMin !== null && ptMin >= 0 && (c.first === null || ptMin < c.first)) c.first = ptMin;
        }
        (S.abandons.all || []).concat(S.abandons.prev || []).forEach(function (r) {
          if (r.source_type !== "ACD-INBOUND" || !r.connected_name || done[r.UII] || hungUpRinging(r)) return;
          done[r.UII] = 1;
          var legs = transferLegs(r);
          if (legs) { legs.forEach(function (l) { credit(lastFirst(l.name), r.UII, l.dur, ptMinutes(Date.parse(l.start)), Date.parse(l.start)); }); return; }
          // Earliest moment they were on a queue call today (Pacific minutes): proof they were logged in by then.
          var m = /(\d+):(\d+):\d+$/.exec(String(r.connected_dts || r.call_start_dts || ""));
          credit(r.connected_name, r.UII, +r.connected_duration || 0, m ? (+m[1] - 3) * 60 + +m[2] : null, etMs(r.connected_dts || r.call_start_dts));
        });
        callIdx = { at: S.abandons.at, legsVer: S.rsLegsVer, sd: curSd, map: map, out: out };
      }
      return callIdx.map;
    }
    function outboundCount(name) { callIndex(); return Object.keys(callIdx.out[lastFirst(name)] || {}).length; }
    // Calls cell: inbound queue calls answered / outbound calls dialed / follow-ups (call tickets from an earlier day
    // they publicly replied to or solved today). Inbound opens their call list.
    function followupsFor(name) { var w = workFor(name); return w ? w.followups : null; }
    function callsCell(name, inbound, outbound, fu, noLink) {
      var tip = inbound + " inbound queue calls answered · " + outbound + " outbound calls dialed · " +
        (fu === null || fu === undefined ? "follow-ups not loaded (or not tracked that day)" : fu + " follow-ups: call tickets from an earlier day they publicly replied to or solved");
      return "<span title='" + esc(tip) + "'>" + (inbound && !noLink ? "<a href='#' data-agent-calls='" + esc(name) + "' title='Show this agent&#39;s calls today, with recordings'>" + inbound + "</a>" : inbound) +
        "<span class='muted'>/" + (outbound && !noLink ? "<a href='#' data-agent-out='" + esc(name) + "' title='Show their outbound calls today'>" + outbound + "</a>" : outbound) + "/" +
        (fu === null || fu === undefined ? "–" : (fu && !noLink ? "<a href='#' data-agent-fu='" + esc(name) + "' title='Show the older call tickets they worked today'>" + fu + "</a>" : fu)) + "</span></span>";
    }
    function ptMinutes(ms) {
      if (!isFinite(ms)) return null;
      var p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
      var g = function (t) { return +((p.filter(function (x) { return x.type === t; })[0] || {}).value || 0); };
      return g("hour") * 60 + g("minute");
    }
    function lastFirst(n) { var p = String(n || "").trim().split(" "); return p.slice(1).join(" ") + ", " + p[0]; }
    function dayStats(a) {
      var h = S.hist.agents[String(a.agentId)] || {}, login = 0, rna = 0;
      Object.keys(h.sessions || {}).forEach(function (k) { login += h.sessions[k].login; rna = Math.max(rna, h.sessions[k].rna || 0); });
      login = Math.max(login, a.loggedInDuration || a.loginTime || 0);
      rna = Math.max(0, Math.max(rna, a.rna || 0) - rnaExcused(h));   // rings RingCX dropped itself don't count (2026-10-27)
      var c = callIndex()[lastFirst(fullName(a))];
      var reportCalls = c ? Object.keys(c.uiis).length : 0;
      return { login: login, rna: rna, calls: Math.max(reportCalls, a.callsHandled || 0), talk: Math.max(c ? c.talk : 0, a.totalTalkTime || 0) };
    }
    // A queue call the report marks CONNECTED but that nobody spoke on: an agent was rung, the caller hung up
    // first, 0s talk and no recording. RingCX's live Abandoned counter counts these (2026-10-15: list them
    // as abandoned, not answered). The recording check keeps handed-off calls out (0s for the first agent, but
    // recorded): since 2026-06-11, 165 of 382 zero-talk caller hang-ups had no recording, 209 of the 225 over 2 min had one.
    function hungUpRinging(r) {
      return r.source_type === "ACD-INBOUND" && r.call_result === "CONNECTED" && !(+r.connected_duration) &&
        (r.call_term_party === "CALLER" || r.call_term_party === "SYSTEM") && !r.recording_url;   // SYSTEM/DROP too (RingCX counts it, 2026-10-15)
    }
    // ---------------- RNA rings (2026-10-27) ----------------
    // Each rise in RingCX's RNA count (h.rnaEv, from observe) is matched to that ring's call report row: the agent as
    // connected_name with 0s talk, connected between the two refreshes. A ring RingCX ended itself (SYSTEM, while it
    // rang, no recording) is listed but not counted against the agent (2026-10-27: a 7:11 ring, dropped
    // after 7s). Every RNA shows as its own line in the status changes, counted or not.
    var rnaMemo = {};
    function rnaRings(h) {
      if (!h || !h.rnaEv || !h.rnaEv.length) return [];
      if (rnaMemo.at !== S.abandons.at) rnaMemo = { at: S.abandons.at };
      var key = (h.agentId || h.name) + "|" + h.rnaEv.length;
      if (rnaMemo[key]) return rnaMemo[key];
      var me = normName(h.name), rows = {}, used = {}, out = [];
      (S.abandons.all || []).forEach(function (r) {
        var u = String(r.UII || "").replace(/^'/, "");
        if (u && !rows[u] && r.connected_name && normName(firstLast(r.connected_name)) === me && !(+r.connected_duration)) rows[u] = r;
      });
      var cands = Object.keys(rows).map(function (u) { return { u: u, r: rows[u], t: etMs(rows[u].connected_dts) }; }).filter(function (c) { return isFinite(c.t); });
      h.rnaEv.forEach(function (e) {
        var lo = e.lo == null ? -Infinity : e.lo - 90000, hi = e.hi + 30000, near = e.end || e.hi;
        for (var i = 0; i < e.n; i++) {
          var best = null;
          cands.forEach(function (c) {
            if (!used[c.u] && c.t >= lo && c.t <= hi && (!best || Math.abs(c.t - near) < Math.abs(best.t - near))) best = c;
          });
          if (best) used[best.u] = 1;
          out.push(rnaRing(e, best, h));
        }
      });
      out.sort(function (x, y) { return x.t - y.t; });
      rnaMemo[key] = out;
      return out;
    }
    function rnaRing(e, c, h) {
      var ring = { t: e.end || e.hi, counted: true, sec: null, uii: "", from: "", queue: "",
        what: e.lo == null ? "Before tracking started; not found in the call report"
          : Date.now() - e.hi < 5 * 60000 ? "Not in the call report yet (it refreshes every 2 min)"
          : "No matching ring in the call report (it lists only the first agent a call reached)" };
      if (!c) return ring;
      var r = c.r, end = etMs(r.call_end_dts);
      ring.t = c.t; ring.uii = c.u; ring.from = fmtPhone(r.ANI); ring.queue = r.source_name || "";
      if (hungUpRinging(r)) {
        ring.sec = isFinite(end) ? Math.max(0, Math.round((end - c.t) / 1000)) : null;
        if (r.call_term_party === "SYSTEM") { ring.counted = false; ring.what = "RingCX dropped the call while it rang"; }
        else ring.what = "Caller hung up while it rang";
        return ring;
      }
      // Who took it next: another agent the live data showed on this call (hist.callGates).
      var others = Object.keys((S.hist.callGates || {})[c.u] || {}).filter(function (id) { return id !== String(h.agentId) && S.hist.agents[id] && S.hist.agents[id].name; });
      if (others.length) ring.what = "Went to " + others.map(function (id) { return S.hist.agents[id].name; }).join(", ");
      else if (r.recording_url || (+r.call_duration || 0) - (+r.queue_time || 0) > 30) ring.what = "Went to another agent";
      else ring.what = "Call ended after the ring (" + String(r.call_term_party || "?").toLowerCase() + ")";
      return ring;
    }
    // RNAs that count against the agent: RingCX's day total minus the rings it dropped itself.
    function rnaExcused(h) { return rnaRings(h).filter(function (r) { return !r.counted; }).length; }
    function firstLast(n) { var p = String(n || "").split(","); return p.length > 1 ? (p[1].trim() + " " + p[0].trim()) : n; }
    function rsSession(r) { var m = /dialogs\/([^\/?]+)\/segments/.exec(r.recording_url || ""); return m ? m[1] : ""; }
    function transferLegs(r) { var l = S.rsLegs[rsSession(r)]; return l && l.length > 1 ? l : null; }

    // ================ tickets, email work and the scorecard ================
    // Is this ticket row theirs? By a first.last@bqe.com email first (Jira shows Armando as "Armando Aceves"), then by name.
    function waitIsFor(name, x) {
      var k = normName(name), words = k.split(" "), joined = words.join("");
      var alias = Object.keys(CONFIG.EMAIL_ALIASES || {}).filter(function (n) { return normName(n) === k; })[0];
      if (alias && String(x.email || "").toLowerCase() === CONFIG.EMAIL_ALIASES[alias].toLowerCase()) return true;
      var local = String(x.email || "").toLowerCase().split("@")[0].replace(/[^a-z]/g, "");
      if (local && local === joined) return true;
      var nw = normName(x.name).split(" ");
      return normName(x.name) === k || (nw.length === words.length && words.every(function (w) { return nw.indexOf(w) >= 0; }));
    }
    function addDaysYmd(ymd, n) { return new Date(Date.parse(ymd + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10); }
    function ymdOfMs(ms) { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(ms)); }
    function onPtoDay(name, ymd) { var k = normName(name); return (S.pto.rows || []).some(function (r) { return normName(r.name) === k && r.start <= ymd && r.end >= ymd; }); }
    // End of the first shift that starts after t (roster start + SHIFT_HOURS; skips days off and PTO). No roster row:
    // 8 AM Pacific, Monday to Friday. keepPto: count PTO days as working days (the PTO coverage deadline).
    function shiftDeadline(name, t, keepPto) {
      var s = schedForLoose(name), start0 = ymdOfMs(t), blocks = shiftBlocksFor(name);
      for (var i = 0; i < 21; i++) {
        var ymd = addDaysYmd(start0, i), wd = new Date(ymd + "T12:00:00Z").getUTCDay(), startMin;
        if (blocks) { startMin = blockStart(blocks, wd, ymdIsDST(ymd)); if (startMin === null) continue; }
        else { if (s && s.shift !== null ? s.days.indexOf(wd) < 0 : (wd === 0 || wd === 6)) continue; startMin = s && s.shift !== null ? s.shift : 8 * 60; }
        if (!keepPto && onPtoDay(name, ymd)) continue;
        var start = Date.parse(ptMidnightIsoOf(ymd)) + startMin * 60000;
        if (start >= t) return start + CONFIG.SHIFT_HOURS * 3600000;
      }
      return t + 24 * 3600000;
    }
    // On Hold (no due date / past due date) starts counting on ONHOLD_FROM (2026-10-16: "It will take effect then,
    // not count today"). Before that day they're listed but never late.
    var ONHOLD_FROM = "2026-10-17";
    function onHoldCounts(x, asOf) { return !/^On Hold/.test(String(x.label || "")) || ymdOfMs(asOf) >= ONHOLD_FROM; }
    // As of asOf: tickets that were still waiting after their deadline (-5 each; -10 if still waiting 2+ days past it)
    // and how many are waiting on them right now.
    // ES ticket the assignee updated in Jira (comment, field change, work logged) on the day being scored: the server
    // marks x.touched when a check that day saw it (zdwatch). 2026-10-27: not late, even without a status change.
    function esWorkedThatDay(x) { return x.src === "es" && !!x.touched; }
    function ticketTimeliness(name, asOf) {
      if (!S.waits.rows) return null;
      var mine = S.waits.rows.filter(function (x) { return x.entered && waitIsFor(name, x); });
      var late = [], pen = 0;
      mine.forEach(function (x) {
        if (!onHoldCounts(x, asOf)) return;
        var dl = shiftDeadline(name, x.entered);
        if (dl > asOf || x.last < dl) return;   // not due yet, or handled before the deadline
        if (esWorkedThatDay(x)) return;   // an ES ticket they updated that day isn't late, even if its status didn't change (2026-10-27)
        var bad = Math.min(x.last, asOf) - dl > 2 * 86400000;
        late.push({ x: x, dl: dl, bad: bad }); pen += bad ? 10 : 5;
      });
      var nowList = mine.filter(function (x) { return x.last >= asOf - 15 * 60000; });
      return { pts: Math.max(0, 15 - pen), late: late, waiting: nowList.length, mine: mine };
    }
    // 30-day ES escalation rate (2026-10-16): Jira ES tickets they created ÷ Zendesk tickets assigned to them, over
    // the last 30 days (the server works it out once a day). 10 points at or below the team's rate, 0 at double it,
    // in proportion between. Under minTickets handled = not enough to judge (full points).
    function esFor(name) {
      var e = S.waits.es; if (!e || !e.rows) return null;
      var hits = e.rows.filter(function (r) { return waitIsFor(name, { name: r[0], email: r[1] }); });
      if (!hits.length) return { es: 0, tickets: 0, rate: null, team: e.teamRate, pts: 10, since: e.since, min: e.minTickets };
      var es = hits.reduce(function (s, r) { return s + (+r[2] || 0); }, 0), tickets = Math.max.apply(null, hits.map(function (r) { return +r[3] || 0; }));
      var rate = tickets >= (e.minTickets || 20) ? es / tickets : null, t = e.teamRate;
      var pts = rate === null || !t ? 10 : (rate <= t ? 10 : (rate >= 2 * t ? 0 : 10 * (2 * t - rate) / t));
      return { es: es, tickets: tickets, rate: rate, team: t, pts: Math.round(pts), since: e.since, min: e.minTickets };
    }
    // 60-day CSAT (2026-10-16): good / (good + bad) Zendesk ratings on their tickets, last 60 days (the server
    // works it out once a day). 10 points at or above the help-desk rate, 0 at the floor (70%), in proportion between.
    // Fewer than minRatings ratings = not enough to judge (full points).
    function csatFor(name) {
      var c = S.waits.csat; if (!c || !c.rows) return null;
      var hits = c.rows.filter(function (r) { return waitIsFor(name, { name: r[0], email: r[1] }); });
      var good = hits.reduce(function (s, r) { return s + (+r[2] || 0); }, 0), bad = hits.reduce(function (s, r) { return s + (+r[3] || 0); }, 0);
      var n = good + bad, min = c.minRatings || 5, floor = c.floor || 0.7, team = c.teamPct;
      var pct = n >= min ? good / n : null;
      var pts = pct === null || !team || team <= floor ? 10 : (pct >= team ? 10 : (pct <= floor ? 0 : 10 * (pct - floor) / (team - floor)));
      return { good: good, bad: bad, n: n, pct: pct, team: team, floor: floor, min: min, pts: Math.round(pts), frac: pts / 10, since: c.since };
    }
    // ---------------- the scorecard (2026-10-30; replaces the v5.62 card) ----------------
    // Ready 25, RNA / pickup 10, start 5, lunch 5, ticket timeliness 23, Tickets/hr 15, ES 5, CSAT 12 = 100 (weights 2026-10-30).
    var W = { ready: 25, rna: 10, start: 5, lunch: 5, tickets: 23, vol: 15, es: 5, csat: 12 };
    // Ticket timeliness: share of their due or handled tickets that were late. A ticket is "owned" once (however many
    // snapshots or statuses it had that day) once its deadline passed or they handled it; it adds 2 to "late" when 2+ days past (1 otherwise); the late
    // share is capped at 100%, so the part never goes below 0. The deadline restarts when the ticket was given to them
    // (assigned). An ES ticket counts as handled that day only for a comment or status change by them (touched2).
    function tkStart(x) { return Math.max(x.entered, x.assigned || 0); }
    function ticketTimeliness2(name, asOf) {
      if (!S.waits.rows) return null;
      var byT = {}, mine = [];
      (isOvernight(name) && S.waits.other && S.waits.other.rows ? S.waits.rows.concat(S.waits.other.rows) : S.waits.rows).forEach(function (x) {
        if (!x.entered || !waitIsFor(name, x)) return;
        mine.push(x);
        if (!onHoldCounts(x, asOf)) return;
        var dl = shiftDeadline(name, tkStart(x));
        // Owned once its deadline passed, or once they handled it (out of the waiting state) even before the deadline:
        // handling tickets early counts in their favor (2026-10-30). Still waiting and not due yet = not counted.
        if (dl > asOf && x.last >= asOf - 15 * 60000) return;
        var late = x.last >= dl && !(x.src === "es" && x.touched2);
        var bad = late && Math.min(x.last, asOf) - dl > 2 * 86400000, w = late ? (bad ? 2 : 1) : 0;
        var k = x.src + "|" + x.id, o = byT[k];
        if (!o || w > o.w) byT[k] = { x: x, dl: dl, w: w, bad: bad };
      });
      var list = Object.keys(byT).map(function (k) { return byT[k]; });
      var lateW = list.reduce(function (s, o) { return s + o.w; }, 0), owned = list.length;
      var share = Math.min(1, lateW / Math.max(owned, 5));
      var late = list.filter(function (o) { return o.w; });
      return { pts: Math.round(W.tickets * (1 - share)), owned: owned, lateW: lateW, late: late, badN: late.filter(function (o) { return o.bad; }).length,
        mine: mine, waiting: mine.filter(function (x) { return x.last >= asOf - 15 * 60000; }).length };
    }
    // PTO coverage (2026-11-03): Zendesk and ES tickets waiting on someone who is out today, so someone else has to act.
    // Due by the end of the shift they would have worked (roster start + SHIFT_HOURS, PTO days counted as working days),
    // counted from today's midnight at the earliest. Handled = out of the waiting state, or given to someone else.
    // Result: "due", "late" (still waiting past it), "handled", "handledlate". The person's own score is untouched
    // (their deadline still skips PTO days).
    function ptoCoverage(asOf) {
      if (!S.waits.rows || !S.pto.rows) return null;
      var today = ymdOfMs(asOf), midnight = Date.parse(ptMidnightIsoOf(today)), seen = {};
      return S.pto.rows.filter(function (p) {
        var k = normName(p.name);
        if (!k || p.start > today || p.end < today || seen[k]) return false;
        return (seen[k] = true);
      }).map(function (p) {
        var rows = S.waits.rows.filter(function (x) { return x.entered && waitIsFor(p.name, x); }).map(function (x) {
          var dl = shiftDeadline(p.name, Math.max(tkStart(x), midnight), true), still = x.last >= asOf - 15 * 60000;
          // Given to someone else: the same ticket waiting on another person from the check after this one.
          var to = still ? null : S.waits.rows.filter(function (y) { return y.src === x.src && String(y.id) === String(x.id) && !waitIsFor(p.name, y) && y.first >= x.last; })[0];
          return { x: x, dl: dl, still: still, to: to ? to.name : "", res: still ? (dl > asOf ? "due" : "late") : (x.last >= dl ? "handledlate" : "handled") };
        }).sort(function (a, b) { return (b.still - a.still) || a.dl - b.dl || a.x.entered - b.x.entered; });
        return { name: p.name, type: p.type || "PTO", hours: p.hours || null, end: p.end, rows: rows };
      }).sort(function (a, b) { return b.rows.length - a.rows.length || a.name.localeCompare(b.name); });
    }
    // ES: weighted count (zdwatch esWeighted: Feature Request / Migration left out, Workaround / Cannot Reproduce /
    // By Design half) over Zendesk tickets, 30 days. 5 at or below ES2_FULL, 0 at or above ES2_ZERO; under minTickets2 = full.
    function es2For(name) {
      var e = S.waits.es; if (!e || !e.rows || !e.minTickets2) return null;   // saved before the weighted count existed
      var hits = e.rows.filter(function (r) { return waitIsFor(name, { name: r[0], email: r[1] }); });
      var w = hits.reduce(function (s, r) { return s + (+r[4] || 0); }, 0), tickets = Math.max.apply(null, hits.map(function (r) { return +r[3] || 0; }).concat([0]));
      var rate = tickets >= e.minTickets2 ? w / tickets : null, lo = CONFIG.ES2_FULL, hi = CONFIG.ES2_ZERO;
      var pts = rate === null ? 5 : (rate <= lo ? 5 : (rate >= hi ? 0 : 5 * (hi - rate) / (hi - lo)));
      return { w: w, tickets: tickets, rate: rate, pts: Math.round(pts), min: e.minTickets2, since: e.since };
    }
    // Tickets/hr (10 points): calls answered + email/webform tickets taken + follow-ups (tickets they publicly replied
    // to or solved without taking them that day: earlier call tickets and email/webform), per logged-in hour.
    // Each ticket counts once. Scored against their group's average that day (phone agents, or the Email Team; total
    // tickets / total hours of everyone in the group logged in 2h+): 10 at or above it, 0 at half of it, in proportion
    // between. Under 2 logged-in hours = not judged (full points). Comparing with the same day keeps slow days fair.
    function tphUnits(r) {
      var w = r.work || { tookEmail: 0, tookWeb: 0, ewList: [] };
      var emailFol = (w.ewList || []).filter(function (t) { return !t[2] && (t[3] || t[4]); }).length;
      var u = { calls: r.answered || 0, taken: (w.tookEmail || 0) + (w.tookWeb || 0), fol: (r.followups || 0) + emailFol };
      u.total = u.calls + u.taken + u.fol; u.hrs = (r.login || 0) / 3600; u.rate = u.hrs > 0 ? u.total / u.hrs : 0;
      return u;
    }
    function tph2(rows) {
      rows.forEach(function (r) { r.tph = tphUnits(r); });
      var judged = rows.filter(function (r) { return !r.sup && !r.unranked && (r.login || 0) >= CONFIG.TPH_MIN_LOGIN_SEC; });
      var units = judged.reduce(function (s, r) { return s + r.tph.total; }, 0), hrs = judged.reduce(function (s, r) { return s + r.tph.hrs; }, 0);
      var avg = hrs > 0 ? units / hrs : 0;
      rows.forEach(function (r) {
        var u = r.tph; u.avg = avg;
        if ((r.login || 0) < CONFIG.TPH_MIN_LOGIN_SEC) { u.pts = null; u.why = "Under " + CONFIG.TPH_MIN_LOGIN_SEC / 3600 + " logged-in hours: not judged, full points"; return; }
        if (!S.waits.work) { u.pts = null; u.why = "Email/webform work not loaded yet: not judged"; return; }
        if (!(avg > 0)) { u.pts = null; u.why = "No group average yet: not judged"; return; }
        u.pts = Math.round(W.vol * Math.max(0, Math.min(1, (u.rate / avg - 0.5) / 0.5)));
      });
    }
    // Puts the scorecard on each row: r.score, r.parts (ready, rna or pickup, start, lunch, tickets, es, vol, csat),
    // r.tk (ticket timeliness), r.es2 (ES), r.tph (Tickets/hr). Start, lunch and CSAT come from the row as built.
    function applyV2(rows, asOf) {
      // Not ranked: excluded by a manager, or under 2 logged-in hours so far (2026-10-30: early in a shift the parts that
      // need time to judge give full points, so a fresh login would top the board).
      rows.forEach(function (r) { r.unranked = unrankOf(r.name); r.early = (r.login || 0) < CONFIG.TPH_MIN_LOGIN_SEC; r.offRank = !!(r.unranked || r.early); });
      rows.forEach(function (r) {
        var p = r.parts || {}, v = {};
        v.ready = r.ready == null ? 25 : Math.round(25 * Math.max(0, Math.min(1, r.ready)));   // straight line: 0% = 0, 100% = 25 (2026-10-30)
        if (r.email) v.pickup = Math.round(r.readyMs ? 10 * (1 - (r.slow2Ms || 0) / r.readyMs) : 10);
        else v.rna = r.rna === 0 ? 10 : (r.rna === 1 ? 5 : 0);
        // Start and lunch keep their rules (on time / 5-14 min / 15+), scaled to 5 points each: full, half (3), none.
        v.start = p.start === 12 ? W.start : (p.start === 6 ? 3 : 0);
        v.lunch = p.lunch === 8 ? W.lunch : (p.lunch === 4 ? 3 : 0);
        v.csat = r.csat && r.csat.frac != null ? Math.round(W.csat * r.csat.frac) : W.csat;
        var tkAsOf = isOvernight(r.name) && S.hist.scoreYmd ? Math.min(Date.now(), shiftWindow(S.hist.scoreYmd).to) : asOf;
        r.tk = ticketTimeliness2(r.name, tkAsOf); v.tickets = r.tk ? r.tk.pts : W.tickets;
        r.es2 = es2For(r.name); v.es = r.es2 ? r.es2.pts : 5;
        r.parts = v;
      });
      tph2(rows);
      rows.forEach(function (r) {
        var v = r.parts; v.vol = r.tph && r.tph.pts != null ? r.tph.pts : W.vol;   // "vol": the key saved days use
        r.score = v.ready + (r.email ? v.pickup : v.rna) + v.start + v.lunch + v.tickets + v.es + v.vol + v.csat;
      });
    }
    function csatCell(r) {
      var c = r.csat;
      if (!c) return "<span class='muted' title='Not loaded yet'>–</span>";
      var tip = c.good + " good, " + c.bad + " bad rating" + (c.bad === 1 ? "" : "s") + " since " + ymdLabel(c.since) + (c.team ? "; help desk " + Math.round(c.team * 100) + "%" : "") +
        (c.pct === null ? ". Under " + c.min + " ratings: not enough to judge, full points." : ". " + (r.parts && r.parts.csat != null ? r.parts.csat : c.pts) + "/12 points (full at or above the help-desk rate, none at " + Math.round(c.floor * 100) + "%).");
      if (c.pct === null) return "<span class='muted' title='" + esc(tip) + "'>" + (c.n ? c.n + " rated" : "n/a") + "</span>";
      var cls = c.pct <= c.floor ? "hot" : (c.team && c.pct < c.team ? "warmn" : "good");
      return "<span class='" + cls + "' title='" + esc(tip) + "'>" + Math.round(c.pct * 100) + "%</span> <span class='muted tiny'>(" + c.n + ")</span>";
    }
    function esCell(r) {
      var e = r.es2;
      if (!e) return "<span class='muted' title='Not loaded yet'>–</span>";
      var tip = e.w + " counted ES escalation" + (e.w === 1 ? "" : "s") + " of " + e.tickets + " Zendesk tickets since " + ymdLabel(e.since) +
        " (Duplicate, Clarification and CloudOps count 1; Workaround, Cannot Reproduce and By Design count half)" +
        (e.rate === null ? ". Under " + e.min + " tickets: not enough to judge, full points." : ". " + e.pts + "/5 points (full at or below " + Math.round(CONFIG.ES2_FULL * 100) + "%, none at " + Math.round(CONFIG.ES2_ZERO * 100) + "%).");
      if (e.rate === null) return "<span class='muted' title='" + esc(tip) + "'>n/a</span>";
      var cls = e.rate >= CONFIG.ES2_ZERO ? "hot" : (e.rate > CONFIG.ES2_FULL ? "warmn" : "");
      return "<span class='" + cls + "' title='" + esc(tip) + "'>" + (e.rate * 100).toFixed(1) + "%</span>";
    }
    // ---------------- email / webform work counts in their favor (2026-10-16) ----------------
    // 1. Ready credit (Email Team only since 2026-10-27): a minute in Zendesk Email Support / online counts as ready on
    //    the call scorecard when RingCX shows them not ready (or logged out). Never twice: a minute RingCX already counts
    //    as ready adds nothing. Phone agents' Ready is RingCX time only.
    function isEmailAgent(name) {
      var k = normName(name), first = k.split(" ")[0];
      return CONFIG.EMAIL_AGENTS.some(function (e) { var en = normName(e); return en === k || (en.indexOf(" ") < 0 && en === first); });
    }
    // 2. Email / web tickets worked: tickets they publicly replied to or solved that day whose origin is email or
    //    webform (Origin tags; "phone" wins, so tickets made by RingCentral calls are never counted on top of calls).
    //    Shown like Calls, not scored.
    function rcxStateAt(h, ts) {
      if (!h) return "OUT";
      if (ts < (h.firstSeen || S.hist.since || 0) || (h.lastSeen && ts > h.lastSeen + 120000)) return "OUT";
      if ((h.gaps || []).some(function (g) { return ts > g.from && ts < g.to; })) return "OUT";
      var st = null, ev = h.ev || [];
      for (var i = 0; i < ev.length; i++) {
        if (ev[i].t <= ts) { if (ev[i].tb !== "BRIEF") st = ev[i].tb; }
        else { if (st === null) st = ev[i].fb; break; }
      }
      return st || h.base || "OUT";
    }
    function zdRowFor(name, p, f) {
      var iName = f.indexOf("name"), iEmail = f.indexOf("email");
      return (p.a || []).filter(function (r) { return waitIsFor(name, { name: r[iName], email: r[iEmail] }); })[0] || null;
    }
    // A person's Zendesk day from the server's every-minute statuses: first / last time online, time online, status now.
    function zdDay(name) {
      var av = S.waits.avail; if (!av || !av.polls || !av.polls.length) return null;
      var f = av.fields || [], iS = f.indexOf("status"), asOf = Date.now(), first = null, last = null, logged = 0, now = "offline", unsure = false;
      av.polls.forEach(function (p, i) {
        var row = zdRowFor(name, p, f), st = row ? String(row[iS]) : "offline";
        var ts = Date.parse(p.ts), next = i + 1 < av.polls.length ? Date.parse(av.polls[i + 1].ts) : Math.min(asOf, ts + 60000);
        var step = Math.max(0, Math.min(next - ts, 180000));
        if (i === av.polls.length - 1) now = st;
        if (st !== "offline") { if (first === null) { first = ts; unsure = i === 0; } last = ts; logged += step; }
      });
      return first === null ? null : { first: first, last: last, logged: logged, now: now, firstUnsure: unsure };
    }
    function emailCredit(name, h) {
      var av = S.waits.avail, out = { ready: 0, seen: 0 };
      if (!av || !av.polls) return out;
      var f = av.fields || [], iStatus = f.indexOf("status"), asOf = S.hist.endAt || Date.now();
      av.polls.forEach(function (p, i) {
        var row = zdRowFor(name, p, f);
        if (!row || CONFIG.EMAIL_READY.indexOf(String(row[iStatus])) < 0) return;
        var ts = Date.parse(p.ts), next = i + 1 < av.polls.length ? Date.parse(av.polls[i + 1].ts) : Math.min(asOf, ts + 60000);
        var step = Math.max(0, Math.min(next - ts, 180000)) / 1000, st = rcxStateAt(h, ts);
        if (st === "OUT") { out.ready += step; out.seen += step; }
        else if (st !== "AVAILABLE" && st !== "ONCALL") out.ready += step;
      });
      return out;
    }
    // Overnight agents: their ticket work inside the noon-to-noon window, from the timed events zdwatch keeps (days from
    // 2026-10-31 on). Days recorded before that have no times, so they keep the calendar day's counts.
    function overnightWork(name) {
      var win = shiftWindow(currentShiftYmd()), ev = [];
      (S.waits.work || []).concat((S.waits.other && S.waits.other.work) || []).forEach(function (r) {
        if (waitIsFor(name, { name: r[0], email: r[1] })) (r[10] || []).forEach(function (x) { ev.push(x); });
      });
      if (!ev.length) return null;
      var tk = {};
      ev.forEach(function (x) {
        if (x[3] * 1000 < win.from || x[3] * 1000 >= win.to) return;
        var o = tk[x[0]] || (tk[x[0]] = { id: x[0], origin: x[1], old: x[4], took: 0, replies: 0, solved: 0 });
        if (x[2] === "take") o.took = 1; else if (x[2] === "reply") o.replies++; else o.solved = 1;
      });
      var out = { email: 0, web: 0, tookEmail: 0, tookWeb: 0, followups: 0, fuList: [], ewList: [] };
      Object.keys(tk).forEach(function (k) {
        var o = tk[k], ew = o.origin === "email" || o.origin === "webform", worked = o.replies || o.solved;
        if (ew) {
          if (o.took) { if (o.origin === "email") out.tookEmail++; else out.tookWeb++; }
          if (worked) { if (o.origin === "email") out.email++; else out.web++; }
          out.ewList.push([o.id, o.origin, o.took, o.replies, o.solved, ""]);
        } else if (o.origin === "phone" && o.old && worked) { out.followups++; out.fuList.push([o.id, o.replies, o.solved, ""]); }
      });
      return out;
    }
    function workFor(name) {
      if (isOvernight(name)) { var ow = overnightWork(name); if (ow) return ow; }
      var w = S.waits.work; if (!w) return null;
      var hit = w.filter(function (r) { return waitIsFor(name, { name: r[0], email: r[1] }); });
      // followups stays null for a day saved before follow-ups were tracked (the server sends null).
      var tracked = !w.length || w.some(function (r) { return r[6] !== null && r[6] !== undefined; });
      return hit.reduce(function (o, r) { o.email += +r[2] || 0; o.web += +r[3] || 0; o.tookEmail += +r[4] || 0; o.tookWeb += +r[5] || 0; if (tracked) o.followups += +r[6] || 0;
          o.fuList = o.fuList.concat(r[7] || []); o.ewList = o.ewList.concat(r[8] || []); return o; },
        { email: 0, web: 0, tookEmail: 0, tookWeb: 0, followups: tracked ? 0 : null, fuList: [], ewList: [] });
    }
    // Tickets/hr (scored, 10 points; see tph2): calls answered + email/webform taken + follow-ups, per logged-in hour.
    // Phone: RingCX logged-in time; email agents: Zendesk logged-in time.
    function tookPerHr(r) {
      var u = r.tph || tphUnits(r);
      if (u.hrs < 0.25 || (!S.waits.work && !u.calls)) return "<span class='muted'>–</span>";
      var tip = u.total + " tickets in " + fmtDur(r.login) + ": " + u.calls + " calls + " + u.taken + " email/webform taken + " + u.fol + " follow-ups. " +
        (r.email ? "Email Team" : "Phone agents") + " average today: " + (u.avg || 0).toFixed(1) + "/hr. " +
        (u.pts == null ? (u.why || "Not judged") + "." : u.pts + "/15 points (full at or above the average, none at half of it).");
      var cls = u.pts == null ? "" : (u.pts === 0 ? "hot" : (u.pts < 10 ? "warmn" : ""));
      return "<span class='" + cls + "' title='" + esc(tip) + "'>" + u.rate.toFixed(1) + "</span>";
    }
    // Non-call tickets they took that day (assigned to them; email + webform origin), worked count on hover.
    function workCell(r, noLink) {
      if (!S.waits.work) return "<span class='muted' title='Not loaded yet'>–</span>";
      // Email/Fol (2026-10-23): new email + webform tickets they took / follow-ups (ones they publicly replied to or
      // solved without taking them that day), like In/Out/Fol for calls. Days saved before the ticket lists existed
      // show "–" for Fol.
      var w = r.work || { email: 0, web: 0, tookEmail: 0, tookWeb: 0, ewList: [] }, took = w.tookEmail + w.tookWeb, worked = w.email + w.web;
      var list = w.ewList || [], fol = list.length ? list.filter(function (t) { return !t[2] && (t[3] || t[4]); }).length : (worked ? null : 0);
      var tip = "Email " + took + ": new email and webform tickets they took (" + w.tookEmail + " email, " + w.tookWeb + " webform, assigned to them that day from New (unassigned) or given to them). " +
        "Fol " + (fol === null ? "not tracked that day" : fol) + ": follow-ups, email and webform tickets they publicly replied to or solved without taking them that day. " +
        "In all they worked " + worked + " (publicly replied to or solved). Tickets created from calls are left out.";
      var inner = (took || "0") + "<span class='muted'>/" + (fol === null ? "–" : fol) + "</span>";
      if (!noLink && (took || worked)) inner = "<a href='#' data-agent-ew='" + esc(r.name) + "'>" + inner + "</a>";
      return "<span title='" + esc(tip) + "'>" + inner + "</span>";
    }
    // Roster row for a name; Zendesk shows some email agents by first name only ("Mohsin", "Bisma").
    function schedForLoose(name) {
      var s = schedFor(name); if (s) return s;
      var k = normName(name), hits = (S.pto.schedule || []).filter(function (x) { return normName(x.name).indexOf(k + " ") === 0; });
      return hits.length === 1 ? hits[0] : null;
    }
    // Email Team scorecard from the server's every-minute Zendesk statuses (waits.avail): Ready 35 (Email Support or
    // online, out of logged-in time), pickup speed 15 (share of ready time when nothing in Email::New (unassigned) had
    // waited over EMAIL_PICKUP_MIN), start 12, lunch 8 (the Lunch status), tickets 20 and ES escalations 10 (same rules as everyone).
    // onCallBoard: names already on the call scorecard (their email time is credited there instead). Anyone else with
    // Email Support / online time that day (e.g. SHARIK on an email-only day) is added to the email agents.
    function emailRows(onCallBoard) {
      var av = S.waits.avail; if (!av || !av.polls || !av.polls.length) return null;
      var f = av.fields || [], iName = f.indexOf("name"), iStatus = f.indexOf("status");
      var asOf = S.hist.endAt || Date.now(), polls = av.polls, out = [];
      var wd = new Date(ymdOfMs(asOf) + "T12:00:00Z").getUTCDay();
      // Only the named Email Team is ranked (2026-10-27). Anyone else online in Zendesk used to be added too, which
      // ranked a new Zendesk user who isn't on the team. Add new email agents to CONFIG.EMAIL_AGENTS.
      var who = CONFIG.EMAIL_AGENTS.slice();
      // Anyone RingCX saw that day is a phone agent (on the call scorecard, or soon to be), not an email-only one.
      // Roster (Smartsheet) people are phone agents too, even before their first RingCX login of the day.
      var phone = (onCallBoard || []).concat(Object.keys(S.hist.agents).map(function (id) { return S.hist.agents[id].name; }).filter(Boolean))
        .concat((S.pto.schedule || []).map(function (x) { return x.name; }));
      who = who.filter(function (n) {
        var k = normName(n), words = k.split(" "), single = words.length < 2;   // Zendesk shows some people by first name only ("SHARIK")
        if (CONFIG.EMAIL_AGENTS.some(function (e) { return normName(e) === k; })) return true;
        // Zendesk can shorten the surname ("Leah de" = Leah De Asis): every Zendesk word in the phone name counts as a match.
        return !phone.some(function (c) {
          var cw = normName(c).split(" ");
          return waitIsFor(c, { name: n, email: "" }) || normName(c) === k || (single && cw[0] === k) ||
            (!single && words.every(function (w) { return cw.indexOf(w) >= 0; }));
        });
      });
      who.forEach(function (who) {
        var k = normName(who), logged = 0, ready = 0, slow = 0, offMs = 0, first = null, firstUnsure = false, lunch = [], cur = null, now = "offline";
        // Pickup counts only once the oldest New ticket has waited EMAIL_PICKUP_MIN of THIS agent's ready time
        // (overnight piles and pre-login waits don't count).
        var slow2 = 0, qOld = null, qAcc = 0;
        polls.forEach(function (p, i) {
          var ts = Date.parse(p.ts), next = i + 1 < polls.length ? Date.parse(polls[i + 1].ts) : Math.min(asOf, ts + 60000);
          var step = Math.max(0, Math.min(next - ts, 3 * 60000));   // a gap in the checks credits at most 3 min
          var row = (p.a || []).filter(function (r) { return normName(r[iName]) === k; })[0];
          var st = row ? String(row[iStatus]) : "offline";
          if (i === polls.length - 1) now = st;
          if (st !== "offline") {
            logged += step; if (first === null) { first = ts; firstUnsure = i === 0; }
          }
          var q = p.q, oldest = q && q[0] > 0 && q[1] ? q[1] : null;
          if (oldest !== qOld) { qOld = oldest; qAcc = 0; }
          if (CONFIG.EMAIL_READY.indexOf(st) >= 0) {
            ready += step;
            if (oldest && ts - oldest > CONFIG.EMAIL_PICKUP_MIN * 60000) slow += step;
            if (oldest) { if (qAcc >= CONFIG.EMAIL_PICKUP_MIN * 60000) slow2 += step; qAcc += step; }
          }
          if (st === "Lunch" || st === "Break") offMs += step;   // left out of Ready (2026-10-30)
          if (st === "Lunch") { if (cur && ts - cur.to <= 3 * 60000) cur.to = ts + step; else { cur = { from: ts, to: ts + step }; lunch.push(cur); } }
        });
        if (!logged) return;
        var s = schedForLoose(who), start = s && s.shift !== null && s.days.indexOf(wd) >= 0 ? s.shift : null;
        var late = start !== null && first !== null && !firstUnsure ? ptMinOf(first) - start : null;
        var lateMin = late !== null && late > CONFIG.LOGIN_GRACE_MIN ? late : 0;
        var L = lunch.sort(function (a, b) { return (b.to - b.from) - (a.to - a.from); })[0];
        var over = L ? (L.to - L.from) / 60000 - CONFIG.LUNCH_MAX_MIN : 0;
        var ll = over >= CONFIG.LUNCH_OVER_CRIT_MIN ? "crit" : (over >= CONFIG.LUNCH_OVER_WARN_MIN ? "warn" : null);
        var share = logged >= 30 * 60000 && logged - offMs > 0 ? Math.min(1, ready / (logged - offMs)) : null;
        var tk = ticketTimeliness(who, asOf);
        var parts = {
          ready: Math.round(share == null ? 30 : 30 * Math.max(0, Math.min(1, (share - 0.5) / 0.35))),
          pickup: Math.round(ready ? 15 * (1 - slow / ready) : 15),
          start: lateMin >= CONFIG.LOGIN_LATE_CRIT_MIN ? 0 : (lateMin > 0 ? 6 : 12),
          lunch: ll === "crit" ? 0 : (ll === "warn" ? 4 : 8),
          tickets: tk ? tk.pts : null
        };
        var esr = esFor(who), csr = csatFor(who);
        parts.es = esr ? esr.pts : 10;
        parts.csat = csr ? csr.pts : 10;
        out.push({ name: who, email: true, work: workFor(who), esr: esr, answered: 0, perHr: null, talk: null, outbound: outboundCount(who), followups: followupsFor(who), score: parts.ready + parts.pickup + parts.start + parts.lunch + (tk ? tk.pts : 15) + parts.es + parts.csat, parts: parts, tk: tk, csat: csr,
          ready: share, readyMs: ready, slowMs: slow, login: logged / 1000, first: first, firstUnsure: firstUnsure, start: start, lateMin: lateMin,
          lunchOver: over >= CONFIG.LUNCH_OVER_WARN_MIN ? Math.round(over) : 0, lunchLvl: ll, lunchFrom: L ? L.from : null, lunchTo: L ? L.to : null, now: now,
          slow2Ms: slow2 });
      });
      applyV2(out, asOf);
      return out.sort(function (a, b) { return b.score - a.score; });
    }
    function scoreGrade(s) { return s >= 90 ? "good" : (s >= 65 ? "" : (s >= 45 ? "warmn" : "hot")); }   // 90+ green, 65-89 white, 45-64 yellow, 0-44 red (2026-10-30)
    function scoreTitle(r) {
      var p = r.parts, tk = r.tk, e = r.es2, v = r.tph || {};
      return "Ready " + p.ready + "/25" + (r.ready == null ? " (not enough time watched yet)" : "") + (r.email ? " · Pickup " + p.pickup + "/10" : " · RNA " + p.rna + "/10") + " · Start " + p.start + "/5 · Lunch " + p.lunch + "/5 · " +
        "Tickets " + p.tickets + "/23" + (tk ? " (" + tk.late.length + " late of " + tk.owned + " due or handled" + (tk.badN ? ", " + tk.badN + " 2+ days late counted twice" : "") + ")" : " (not loaded yet)") + " · " +
        "Tickets/hr " + p.vol + "/15" + (v.pts == null ? " (not judged)" : " (" + (v.rate || 0).toFixed(1) + " vs group " + (v.avg || 0).toFixed(1) + ")") + " · " +
        "ES " + p.es + "/5" + (e && e.rate !== null ? " (" + (e.rate * 100).toFixed(1) + "%)" : "") + " · CSAT " + p.csat + "/12. 100 = every part met.";
    }
    function ticketCell(r) {
      var t = r.tk;
      if (!t) return "<span class='muted' title='Ticket data not loaded yet'>–</span>";
      var tip = t.late.map(function (l) { return (l.x.src === "es" ? l.x.id : "#" + l.x.id) + " " + l.x.label + ", due by " + fmtClock(l.dl) + (l.bad ? " (2+ days late)" : ""); }).join("; ");
      return "<a href='#' data-tk-open='" + esc(normName(r.name)) + "' title='" + esc(tip || "Nothing past its deadline") + " · " + t.waiting + " waiting on them now. Click for the list.'>" +
        (t.late.length ? "<span class='" + (t.late.some(function (l) { return l.bad; }) ? "hot" : "warmn") + "'>" + t.late.length + " late</span>" : "<span class='muted'>ok</span>") +
        (t.waiting ? " <span class='muted tiny'>(" + t.waiting + ")</span>" : "") + "</a>";
    }

    // The same list for the Agent View's "Tickets waiting on me" (2026-10-30), saved with the live scores so agents see
    // exactly what supervisors see: [src, id, state, waiting since, deadline, result, subject]. Result: "late" (still
    // waiting past its deadline), "late2" (2+ days past), "handledlate", "handled", "due" (not due yet), "worked" (ES they
    // commented on or moved that day), "onhold" (On Hold not counted yet), "" (past deadline, not counted).
    function ticketExport(r, asOf) {
      var t = r.tk; if (!t) return null;
      var lateKeys = {}; t.late.forEach(function (l) { lateKeys[l.x.src + l.x.id] = l; });
      return t.mine.slice().sort(function (a, b) { return a.entered - b.entered; }).map(function (x) {
        var l = lateKeys[x.src + x.id], dl = shiftDeadline(r.name, tkStart(x)), still = x.last >= asOf - 15 * 60000;
        if (l && l.x !== x) l = null;   // the same ticket waiting again later is its own row
        var res = !onHoldCounts(x, asOf) ? "onhold" : (!l && x.src === "es" && x.touched2 && dl <= asOf ? "worked"
          : (l ? (still ? (l.bad ? "late2" : "late") : "handledlate") : (still ? (dl > asOf ? "due" : "") : "handled")));
        return [x.src, x.id, x.label, tkStart(x), dl, res, String(x.subject || "").slice(0, 90)];
      });
    }

    // Email Team rows share the ranked board (2026-10-23). They have no queue calls, so Calls/hr and Talk show "–";
    // the RNA column shows their slow pickup (Email::New waiting over EMAIL_PICKUP_MIN while they were ready), the
    // email scorecard's 15 points in place of RNA; Start is their first time online in Zendesk.
    function emailTag(r) {
      return r.email ? " <span class='chip info' title='Email Team: scored from Zendesk statuses" + (r.now ? " · Zendesk now: " + esc(r.now) : "") + "'>Email</span>" : "";
    }
    function emailRnaCell(r) {
      var tip = "Email Team: slow pickup, ready time while the oldest New (unassigned) ticket had already waited " + CONFIG.EMAIL_PICKUP_MIN + " min of their own ready time (counts in place of RNA)";
      return r.slow2Ms ? "<span class='warmn' title='" + esc(tip) + "'>slow " + fmtDur(r.slow2Ms / 1000) + "</span>" : "<span class='muted' title='" + esc(tip) + "'>0</span>";
    }
    function emailStartCell(r) {
      if (r.first === null) return "<span class='muted'>–</span>";
      var tip = "First online in Zendesk " + fmtClock(r.first) + (r.start !== null ? " · scheduled " + clockOf(r.start) : "") + (r.firstUnsure ? " · online before the server started checking, so not counted" : "");
      if (r.lateMin) return "<span class='" + (r.lateMin >= CONFIG.LOGIN_LATE_CRIT_MIN ? "hot" : "warmn") + "' title='" + esc(tip) + "'>" + fmtShort(r.lateMin * 60) + " late</span>";
      return "<span class='muted' title='" + esc(tip) + "'>" + (r.firstUnsure ? "?" : "ok") + "</span>";
    }
    var dash = "<span class='muted'>–</span>";
    function boardRows() {
      var calls = callIndex();   // "Last, First" -> { uiis, talk }
      var people = {};
      Object.keys(S.hist.agents).forEach(function (id) {
        var h = S.hist.agents[id]; if (!h.name) return;
        if (isOvernight(h.name) && h.shiftDay && h.shiftDay !== currentShiftYmd()) return;   // their last shift belongs to another day
        var login = 0, rna = 0;
        Object.keys(h.sessions || {}).forEach(function (k) { login += h.sessions[k].login; rna = Math.max(rna, h.sessions[k].rna || 0); });
        if (h.rnaDays) rna = Object.keys(h.rnaDays).reduce(function (s, d) { return s + h.rnaDays[d]; }, 0);   // overnight: one count per calendar day
        people[h.name] = { id: id, name: h.name, sup: h.sup, login: login, rna: Math.max(0, rna - rnaExcused(h)), ready: h.readySec || 0, seen: h.seenSec || 0, off: h.offSec || 0 };
      });
      // Live session values are fresher than history for anyone logged in right now.
      S.liveAgents.forEach(function (a) {
        var p = people[fullName(a)];
        if (p) p.onDuty = inAgentSection(a);
      });
      var out = [];
      Object.keys(people).forEach(function (n) {
        var p = people[n], parts = n.split(" "), key = parts.slice(1).join(" ") + ", " + parts[0];
        var c = calls[key] || { uiis: {}, talk: 0 };
        var answered = Object.keys(c.uiis).length;
        // Same totals the Agents table shows for anyone logged in right now.
        var live = S.liveAgents.filter(function (x) { return fullName(x) === n; })[0];
        // (Overnight agents skip both: RingCX's day totals reset at midnight, halfway through their shift.)
        if (live && !isOvernight(n)) { var ds = dayStats(live); answered = ds.calls; c = { uiis: c.uiis, talk: ds.talk }; p.rna = ds.rna; p.login = ds.login; }
        // Logged-in time: RingCX's own total for the whole day (every session), when it's higher than what this page saw.
        if (!isOvernight(n)) p.login = Math.max(p.login, (S.hist.agents[p.id] || {}).dayLogin || 0);
        p.sup = isSupervisorName(n, p.sup);   // by name too: a history entry can miss the flag
        if ((CONFIG.MANAGER_IDS || []).indexOf(String(p.id)) >= 0) return;   // managers are never ranked
        if ((CONFIG.NOT_RANKED_IDS || []).indexOf(String(p.id)) >= 0) return;
        // Ranked once they answer a queue call or work a ticket (took, replied to or solved one today; 2026-10-30), else
        // after BOARD_MIN_LOGIN_SEC logged in.
        var wk = workFor(n), ticketWork = !!wk && (wk.tookEmail + wk.tookWeb + wk.email + wk.web + (wk.followups || 0)) > 0;
        var eligible = answered > 0 || (!p.sup && ticketWork) || (p.onDuty !== false && !p.sup && p.login >= CONFIG.BOARD_MIN_LOGIN_SEC);
        if (!eligible || p.login < 60) return;
        var perHr = answered / (p.login / 3600);
        // Phone agents' Ready comes from RingCX only (2026-10-27): Zendesk "online" all day was crediting their
        // ticket follow-up time as ready. The Zendesk credit stays for the Email Team (CONFIG.EMAIL_AGENTS).
        var credit = isEmailAgent(n) ? emailCredit(n, S.hist.agents[p.id]) : { ready: 0, seen: 0 }, seenAll = p.seen + credit.seen;
        // Lunch and Break time don't count for or against Ready (2026-10-30): it's measured against the rest of the logged-in time.
        var readyBase = seenAll - (p.off || 0);
        var readyShare = seenAll >= 1800 && readyBase > 0 ? Math.min(1, (p.ready + credit.ready) / readyBase) : 0.5;
        p.seen = seenAll;
        // Lunch overrun today (timed from when they actually went): -5 at 5+ min over, -10 at 15+.
        var L = lunchFor(S.hist.agents[p.id], schedFor(n), !!live), ll = lunchLevel(L);
        var lunchPenalty = ll === "crit" ? CONFIG.LUNCH_PENALTY_CRIT : (ll === "warn" ? CONFIG.LUNCH_PENALTY_WARN : 0);
        // Late first login (Logins today): -5 at 5+ min, -10 at 15+. Only CONFIRMED times count;
        // "on a call by" / "earlier session not seen" can't be proven late, so they cost nothing.
        var lg = S.loginByName[normName(n)] || {}, lateMin = lg.conf === "confirmed" && lg.late !== null && lg.late > CONFIG.LOGIN_GRACE_MIN ? lg.late : 0;
        var latePenalty = lateMin >= CONFIG.LOGIN_LATE_CRIT_MIN ? CONFIG.LATE_PENALTY_CRIT : (lateMin > 0 ? CONFIG.LATE_PENALTY_WARN : 0);
        // Fixed 100-point scorecard (2026-10-16): agents can't control how many calls they're offered, so calls
        // don't score. CSAT 10 added in v5.62 (Ready 35 -> 30, tickets 20 -> 15). Ready 35 (full at 85%+, none at 50%), no RNA 15 (1 = 7, 2+ = 0), on-time start 12 (5-15 min = 6,
        // more = 0; unconfirmed counts as on time), lunch within the hour 8 (5-15 over = 4, more = 0), tickets 30.
        var ready = p.seen >= 1800 ? readyShare : null;
        var tk = ticketTimeliness(n, S.hist.endAt || Date.now());
        var parts = {
          ready: Math.round(ready == null ? 30 : 30 * Math.max(0, Math.min(1, (ready - 0.5) / 0.35))),
          rna: p.rna === 0 ? 15 : (p.rna === 1 ? 7 : 0),
          start: lateMin >= CONFIG.LOGIN_LATE_CRIT_MIN ? 0 : (lateMin > 0 ? 6 : 12),
          lunch: ll === "crit" ? 0 : (ll === "warn" ? 4 : 8),
          tickets: tk ? tk.pts : null
        };
        var esr = esFor(n), csr = csatFor(n);
        parts.es = esr ? esr.pts : 10;
        parts.csat = csr ? csr.pts : 10;
        var score = parts.ready + parts.rna + parts.start + parts.lunch + (tk ? tk.pts : 15) + parts.es + parts.csat;
        out.push({ name: n, id: p.id,
          sup: p.sup, answered: answered, talk: c.talk, perHr: perHr, rna: p.rna, ready: ready, login: p.login, score: score, parts: parts, tk: tk, esr: esr, csat: csr,
          work: workFor(n), emailCreditSec: credit.ready, outbound: outboundCount(n), followups: followupsFor(n),
          lunchOver: L && L.over >= CONFIG.LUNCH_OVER_WARN_MIN ? Math.round(L.over) : 0, lunchLvl: ll, lateMin: lateMin, lateConf: lg.conf || null,
          lunchFrom: L ? L.from : null, lunchTo: L ? L.to : null });
      });
      applyV2(out, S.hist.endAt || Date.now());   // Tickets/hr average = every phone agent that day, before the queue filter
      return out.filter(function (r) { return inQueue(r.name); }).sort(function (a, b) { return b.score - a.score || b.answered - a.answered; });
    }

    // One Performance row's cells after the name (Score .. Logged in). Shared by the board and the agents' own
    // scorecard (saveLiveScores), so both always show the same numbers.
    var BOARD_COLS = ["Score", "In/Out/Fol", "Calls/hr", "Email/Fol", "Tickets/hr", "Talk", "RNA", "Ready", "Start", "Lunch", "Tickets", "ES 30d", "CSAT 60d", "Logged in"];
    function boardCells(r) {
      return [
        "<td class='num' title='" + esc(scoreTitle(r)) + "'><b class='" + scoreGrade(r.score) + "'>" + Math.round(r.score) + "</b></td>",
        "<td class='num'>" + callsCell(r.name, r.answered, r.outbound, r.followups) + "</td>",
        "<td class='num'>" + (r.email ? dash : r.perHr.toFixed(1)) + "</td>",
        "<td class='num'>" + workCell(r) + "</td>", "<td class='num'>" + tookPerHr(r) + "</td>", "<td class='num'>" + (r.email ? dash : fmtDur(r.talk)) + "</td>",
        "<td class='num'>" + (r.email ? emailRnaCell(r) : (r.rna ? "<span class='" + (r.rna >= 2 ? "hot" : "warmn") + "'>" + r.rna + "</span>" : "0")) + "</td>",
        "<td class='num'>" + (r.ready == null ? "<span class='muted'>–</span>" : Math.round(r.ready * 100) + "%") + "</td>",
        "<td class='num'>" + (r.email ? emailStartCell(r) : r.lateMin ? "<span class='" + (r.lateMin >= CONFIG.LOGIN_LATE_CRIT_MIN ? "hot" : "warmn") + "' title='First login " + Math.round(r.lateMin) + " min after scheduled start (confirmed)'>" + fmtShort(r.lateMin * 60) + " late</span>"
          : "<span class='muted' title='" + (r.lateConf && r.lateConf !== "confirmed" ? "First login not confirmed (see Logins today), so not counted" : "On time, or no schedule") + "'>" + (r.lateConf && r.lateConf !== "confirmed" ? "?" : "ok") + "</span>") + "</td>",
        "<td class='num'>" + (r.lunchOver ? "<span class='" + (r.lunchLvl === "crit" ? "hot" : "warmn") + "' title='Lunch ran " + r.lunchOver + " min over the hour'>+" + r.lunchOver + "m</span>" : "<span class='muted'>ok</span>") + "</td>",
        "<td class='num'>" + ticketCell(r) + "</td>", "<td class='num'>" + esCell(r) + "</td>", "<td class='num'>" + csatCell(r) + "</td>",
        "<td class='num'>" + fmtDur(r.login) + "</td>"
      ];
    }

    // ================ not ranked today ================
    var UNRANK_SIG = "unrank";   // the page's "Not ranked today" notes (watch_reviews signature)
    function unrankOf(name) {
      var k = "unrank|" + normName(name);
      return (S.unrankOverride || S.reviews.list || []).filter(function (r) { return r.signature === UNRANK_SIG && r.agent_key === k; })[0] || null;
    }

    // ================ past days and saved days ================
    // The day's server snapshots are replayed through observe() into a separate history, and that day's call
    // report stands in for today's, then boardRows() scores it with exactly today's rules. All of it runs
    // synchronously with today's state swapped out and put back in a finally, so nothing else sees the swap.
    function scoreDay(ymd, fields, polls, calls, dayWaits, dayUnrank, extra) {
      extra = extra || { polls: [], calls: [], other: null };
      if (!polls.length) return { empty: true };
      var saved = { hist: S.hist, abandons: S.abandons, agents: S.liveAgents, loginByName: S.loginByName, intervalSec: S.intervalSec, waits: S.waits, unrank: S.unrankOverride };
      S.unrankOverride = dayUnrank || [];
      S.waits = { rows: dayWaits && dayWaits.rows, avail: dayWaits && dayWaits.avail, work: dayWaits && dayWaits.work, workTimed: !!(dayWaits && dayWaits.workTimed), es: dayWaits && dayWaits.es, csat: dayWaits && dayWaits.csat, other: extra.other };   // that day's server checks (null = not tracked yet that day); other = next morning (overnight)
      try {
        S.intervalSec = 60;   // the snapshots' cadence
        var t0 = Date.parse(polls[0].ts), t1 = Date.parse(polls[polls.length - 1].ts);
        S.hist = { day: todayKey(), since: t0, agents: {}, source: "server", endAt: t1 + 60000, keepAll: true, scoreYmd: ymd };
        polls.concat(extra.polls).forEach(function (p) {
          observe((p.a || []).map(function (row) { var o = {}; fields.forEach(function (f, i) { o[f] = row[i]; }); return o; }), Date.parse(p.ts), true);
        });
        S.liveAgents = [];   // nobody is "live" on a finished day
        S.abandons = { all: calls.concat(extra.calls), at: -Date.now() };   // a key callIndex() hasn't seen, so it rebuilds from this day's calls
        var sched = {}, wd = new Date(ymd + "T12:00:00Z").getUTCDay();
        (S.pto.schedule || []).forEach(function (s) { sched[normName(s.name)] = s; });
        S.loginByName = {};
        Object.keys(S.hist.agents).forEach(function (id) {
          var h = S.hist.agents[id]; if (!h.name) return;
          var li = loginInfo(h, sched[normName(h.name)], wd);
          if (li) S.loginByName[normName(h.name)] = { late: li.late, conf: li.conf, first: li.first, start: li.start };
        });
        var rows = boardRows();
        rows.forEach(function (r) { r.li = S.loginByName[normName(r.name)] || null; });
        var answered = 0, abandoned = 0, talk = 0, seen = {};
        calls.forEach(function (r) {
          if (r.source_type !== "ACD-INBOUND" || seen[r.UII]) return;
          seen[r.UII] = 1;
          if (r.call_result === "ABANDON" || hungUpRinging(r)) abandoned++;
          else if (r.connected_name) { answered++; talk += +r.connected_duration || 0; }
        });
        var byName = {};   // that day's history per person, for the status / activity drill-downs
        Object.keys(S.hist.agents).forEach(function (id) { var h = S.hist.agents[id]; if (h.name) { h.rings = rnaRings(h); byName[normName(h.name)] = h; } });   // rings: matched to that day's calls while they're swapped in
        return { rows: rows, email: emailRows(rows.map(function (r) { return r.name; })), answered: answered, abandoned: abandoned, talk: talk, from: t0, to: t1, byName: byName };
      } finally {
        S.hist = saved.hist; S.abandons = saved.abandons; S.liveAgents = saved.agents; S.loginByName = saved.loginByName; S.intervalSec = saved.intervalSec; S.waits = saved.waits; S.unrankOverride = saved.unrank;
        callIdx.at = -2;   // today's call index rebuilds on next use
      }
    }
    // Every Performance column for one row, so saved days can be averaged later (baseline, 2026-10-30).
    function dayStatsOf(r) {
      var w = r.work || {}, ew = w.ewList || [], tk = r.tk, e = r.es2, c = r.csat, u = r.tph || {};
      var rd = function (x, n) { return x === null || x === undefined || !isFinite(x) ? null : Math.round(x * Math.pow(10, n)) / Math.pow(10, n); };
      return {
        inb: r.answered || 0, out: r.outbound || 0, fol: r.followups == null ? null : r.followups,
        took: (w.tookEmail || 0) + (w.tookWeb || 0), efol: ew.filter(function (t) { return !t[2] && (t[3] || t[4]); }).length,
        callsHr: r.email ? null : rd(r.perHr, 2), tph: rd(u.rate, 2), talk: r.email ? null : Math.round(r.talk || 0),
        rna: r.email ? null : (r.rna || 0), slowMin: r.email ? Math.round((r.slow2Ms || 0) / 60000) : null,
        ready: rd(r.ready, 3), lateMin: r.lateMin ? Math.round(r.lateMin) : 0, lunchOver: r.lunchOver || 0,
        tkLate: tk ? tk.late.length : null, tkDue: tk ? tk.owned : null,
        es: e && e.rate !== null ? rd(e.rate, 4) : null, csat: c && c.pct !== null ? rd(c.pct, 4) : null, csatN: c ? c.n : null,
        login: Math.round(r.login || 0),
        // Exact times for the Agent View's hovers (2026-11-02), as PT minutes of the day: first login, scheduled start,
        // and the lunch the Lunch column judged (lunchTo null = no end seen).
        firstMin: r.li && r.li.first != null ? r.li.first : (r.first ? ptMinOf(r.first) : null),
        startMin: r.li ? (r.li.start == null ? null : r.li.start) : (r.start == null ? null : r.start),
        lunchFrom: r.lunchFrom ? ptMinOf(r.lunchFrom) : null, lunchTo: r.lunchTo ? ptMinOf(r.lunchTo) : null
      };
    }
    function dayRecord(ymd, d) {
      if (!d || d.empty) return null;
      var rows = d.rows.concat(d.email || []).filter(function (r) { return !r.sup; });
      var scores = rows.filter(function (r) { return !r.offRank; }).map(function (r) { return r.score; });
      return {
        v: 12, partial: d.from - Date.parse(ptMidnightIsoOf(ymd)) > 30 * 60000,
        team: { answered: d.answered, abandoned: d.abandoned, talk: Math.round(d.talk), outbound: rows.reduce(function (t, r) { return t + (r.outbound || 0); }, 0),
          scored: rows.length, avg: scores.length ? scores.reduce(function (t, v) { return t + v; }, 0) / scores.length : null },
        agents: rows.map(function (r) {
          return { name: r.name, email: !!r.email, score: Math.round(r.score * 10) / 10, parts: r.parts || {}, answered: r.answered || 0, outbound: r.outbound || 0,
            took: r.work ? (r.work.tookEmail || 0) + (r.work.tookWeb || 0) : 0, late: r.lateMin ? 1 : 0, longLunch: r.lunchOver ? 1 : 0,
            unranked: r.unranked ? String(r.unranked.reason || "").slice(0, 200) : undefined, early: r.early && !r.unranked ? 1 : undefined, s: dayStatsOf(r) };
        })
      };
    }
    // Hover text for the agent's own scorecard (Agent View, 2026-10-30): their own numbers and points only. No group
    // averages, help-desk rates or anyone else's work, unlike the supervisor hovers.
    function agentTip(r, col) {
      var p = r.parts || {}, w = r.work || {}, ew = w.ewList || [], u = r.tph || {}, tk = r.tk, e = r.es2, c = r.csat;
      var efol = ew.filter(function (x) { return !x[2] && (x[3] || x[4]); }).length, took = (w.tookEmail || 0) + (w.tookWeb || 0);
      var pl = function (n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); };
      switch (col) {
        case "Score":
          return "Ready " + p.ready + "/25 · " + (r.email ? "Pickup " + p.pickup : "RNA " + p.rna) + "/10 · Start " + p.start + "/5 · Lunch " + p.lunch + "/5 · " +
            "Tickets " + p.tickets + "/23 · Tickets/hr " + p.vol + "/15 · ES " + p.es + "/5 · CSAT " + p.csat + "/12 = " + Math.round(r.score) + " of 100.";
        case "In/Out/Fol":
          return r.email ? "" : pl(r.answered || 0, "queue call") + " answered · " + pl(r.outbound || 0, "outbound call") + " · " +
            (r.followups == null ? "follow-ups not loaded" : pl(r.followups, "follow-up") + " (earlier call tickets you replied to or solved today)") + ".";
        case "Calls/hr":
          return r.email ? "" : pl(r.answered || 0, "queue call") + " answered in " + fmtDur(r.login) + " logged in.";
        case "Email/Fol":
          return pl(took, "email or webform ticket") + " you took today · " + pl(efol, "follow-up") + " (email and webform tickets you replied to or solved without taking them today).";
        case "Tickets/hr":
          return (u.total || 0) + " tickets in " + fmtDur(r.login) + ": " + (u.calls || 0) + " calls + " + (u.taken || 0) + " email/webform taken + " + (u.fol || 0) + " follow-ups. " +
            (u.pts == null ? "Not judged yet (under 2 logged-in hours): 15/15." : p.vol + "/15 points.");
        case "Talk":
          return r.email ? "" : "Talk time on your answered calls today.";
        case "RNA":
          return r.email ? "Ready time while the oldest New (unassigned) ticket had already waited 30 min of your ready time: " + Math.round((r.slow2Ms || 0) / 60000) + " min. " + p.pickup + "/10 points."
            : pl(r.rna || 0, "call") + " missed or declined. 0 = 10 points, 1 = 5, 2 or more = 0. " + p.rna + "/10.";
        case "Ready":
          return r.ready == null ? "Not judged until you've been logged in 30 minutes." :
            Math.round(r.ready * 100) + "% of your logged-in time (Lunch and Break left out) was " + (r.email ? "Email Support or online" : "Available, Engaged or Transition") + ". 25 × " + Math.round(r.ready * 100) + "% = " + p.ready + "/25.";
        case "Start":
          return r.lateMin ? "First login " + Math.round(r.lateMin) + " min after your scheduled start. 5-14 min late = 3/5, more = 0. " + p.start + "/5." : "On time. " + p.start + "/5.";
        case "Lunch":
          return r.lunchOver ? "Lunch ran " + r.lunchOver + " min over the hour. 5-14 min over = 3/5, 15 or more = 0. " + p.lunch + "/5." : "Within the hour. " + p.lunch + "/5.";
        case "Tickets":
          return !tk ? "" : pl(tk.late.length, "late ticket") + " of " + tk.owned + " due or handled" + (tk.badN ? " (" + tk.badN + " 2+ days late, counted twice)" : "") +
            ". 23 × (1 − late ÷ due, at least 5 due) = " + p.tickets + "/23. " + tk.waiting + " waiting on you now.";
        case "ES 30d":
          return !e ? "" : (e.rate === null ? "Under " + e.min + " tickets in 30 days: not judged, 5/5." :
            e.w + " counted ES escalations of " + e.tickets + " tickets, last 30 days = " + (e.rate * 100).toFixed(1) + "%. 6% or less = 5 points, 15% or more = 0. " + p.es + "/5.");
        case "CSAT 60d":
          return !c ? "" : (c.pct === null ? "Under " + c.min + " ratings in 60 days: not judged, 12/12." :
            c.good + " good and " + c.bad + " bad ratings, last 60 days = " + Math.round(c.pct * 100) + "%. 70% or lower = 0 points. " + p.csat + "/12.");
        case "Logged in":
          return "Your logged-in time today.";
      }
      return "";
    }

    return {
      SHIFT_BLOCKS: SHIFT_BLOCKS,
      SCHEDULE_OVERRIDES: SCHEDULE_OVERRIDES,
      ONHOLD_FROM: ONHOLD_FROM,
      W: W,
      dash: dash,
      BOARD_COLS: BOARD_COLS,
      esc: esc,
      fmtDur: fmtDur,
      fmtShort: fmtShort,
      fmtClock: fmtClock,
      queueLabel: queueLabel,
      todayKey: todayKey,
      ymdLabel: ymdLabel,
      normName: normName,
      clockOf: clockOf,
      nowIn: nowIn,
      fmtPhone: fmtPhone,
      ptMidnightIso: ptMidnightIso,
      parseCsv: parseCsv,
      etToPtClock: etToPtClock,
      etMs: etMs,
      ptYmd: ptYmd,
      ptMidnightIsoOf: ptMidnightIsoOf,
      dtsMinutes: dtsMinutes,
      base: base,
      isOnCall: isOnCall,
      isAvailable: isAvailable,
      isNotReady: isNotReady,
      isWrapUp: isWrapUp,
      stateLabel: stateLabel,
      isSupervisor: isSupervisor,
      fullName: fullName,
      treatedAsSupervisor: treatedAsSupervisor,
      inAgentSection: inAgentSection,
      pacificIsDST: pacificIsDST,
      shiftBlocksFor: shiftBlocksFor,
      blockStart: blockStart,
      ymdIsDST: ymdIsDST,
      isOvernight: isOvernight,
      shiftDayOf: shiftDayOf,
      currentShiftYmd: currentShiftYmd,
      shiftWindow: shiftWindow,
      overnightNames: overnightNames,
      overnightPolls: overnightPolls,
      isOvernightCall: isOvernightCall,
      scheduleOverride: scheduleOverride,
      dstAdjust: dstAdjust,
      supHoursOverride: supHoursOverride,
      isSupervisorName: isSupervisorName,
      isL2Name: isL2Name,
      isSupForLogins: isSupForLogins,
      hideLoginOf: hideLoginOf,
      purgeL2Logins: purgeL2Logins,
      hasSupTag: hasSupTag,
      ptMinOf: ptMinOf,
      schedFor: schedFor,
      lunchFor: lunchFor,
      lunchLevel: lunchLevel,
      sessionKeys: sessionKeys,
      overnightKey: overnightKey,
      dtsMs: dtsMs,
      loginInfo: loginInfo,
      observe: observe,
      callIndex: callIndex,
      outboundCount: outboundCount,
      followupsFor: followupsFor,
      callsCell: callsCell,
      ptMinutes: ptMinutes,
      lastFirst: lastFirst,
      dayStats: dayStats,
      hungUpRinging: hungUpRinging,
      rnaRings: rnaRings,
      rnaRing: rnaRing,
      rnaExcused: rnaExcused,
      firstLast: firstLast,
      rsSession: rsSession,
      transferLegs: transferLegs,
      waitIsFor: waitIsFor,
      addDaysYmd: addDaysYmd,
      ymdOfMs: ymdOfMs,
      onPtoDay: onPtoDay,
      shiftDeadline: shiftDeadline,
      onHoldCounts: onHoldCounts,
      esWorkedThatDay: esWorkedThatDay,
      ticketTimeliness: ticketTimeliness,
      esFor: esFor,
      csatFor: csatFor,
      tkStart: tkStart,
      ticketTimeliness2: ticketTimeliness2,
      es2For: es2For,
      tphUnits: tphUnits,
      tph2: tph2,
      applyV2: applyV2,
      csatCell: csatCell,
      esCell: esCell,
      isEmailAgent: isEmailAgent,
      rcxStateAt: rcxStateAt,
      zdRowFor: zdRowFor,
      zdDay: zdDay,
      emailCredit: emailCredit,
      overnightWork: overnightWork,
      workFor: workFor,
      tookPerHr: tookPerHr,
      workCell: workCell,
      schedForLoose: schedForLoose,
      emailRows: emailRows,
      scoreGrade: scoreGrade,
      scoreTitle: scoreTitle,
      ticketCell: ticketCell,
      ticketExport: ticketExport,
      ptoCoverage: ptoCoverage,
      emailTag: emailTag,
      emailRnaCell: emailRnaCell,
      emailStartCell: emailStartCell,
      boardRows: boardRows,
      boardCells: boardCells,
      unrankOf: unrankOf,
      scoreDay: scoreDay,
      dayStatsOf: dayStatsOf,
      dayRecord: dayRecord,
      agentTip: agentTip
    };
  }

  return { create: create };
});
